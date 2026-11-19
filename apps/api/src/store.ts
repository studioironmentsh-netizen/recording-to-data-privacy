import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StoredFields } from "./pipeline/formview.ts";

export type FormStatus = "draft" | "approved" | "editing";
export interface Form {
  formId: string; revision: number; status: FormStatus;
  // Present only for forms created by the voice pipeline (legacy spike forms have none of these).
  number?: number; techId?: string; fields?: StoredFields; captureDate?: string; partial?: boolean; mock?: boolean;
  mode?: "FULL" | "PARTIAL"; flagged?: string[]; // flagged_fields: names only, never content
}
export interface PatchTarget { formId: string; revision: number; expiresAt: number }

export type ReceiptStatus = "PROCESSING" | "REVIEW_READY" | "NEEDS_INFO" | "FAILED";
/** One per inbound voice message: created BEFORE any AI call, so retries/duplicates share it (SALV-R13). */
export interface Receipt { id: string; techKey: string; kind: "NEW" | "PATCH"; status: ReceiptStatus; formId?: string; revision?: number; receivedAt: number; updatedAt: number; failure?: string }

/** Immutable approved snapshot (append-only; unique (formId, versionSeq)). */
export interface FormVersion { formId: string; versionSeq: number; revision: number; fields: StoredFields; flagged: string[]; mode: "FULL" | "PARTIAL"; approvedAt: number; opKey: string }

export type OutboxStatus = "PENDING" | "SENDING" | "SENT" | "WINDOW_CLOSED" | "SUPERSEDED" | "EXHAUSTED" | "DROPPED";
export interface OutboxEntry {
  key: string; // fixed event key: form:<formId>:<revision> | text:<id>
  techKey: string; kind: "FORM" | "TEXT"; formId?: string; revision?: number; text?: string;
  status: OutboxStatus; attempts: number; nextAt: number; createdAt: number;
  textPartsSent?: boolean; // long forms: the full text was already delivered, only the buttons message remains
  sentWamid?: string; submittedAt?: number; lastError?: string; receiptReceivedAt?: number;
}
export interface SentRecord { formId: string; revision: number; submittedAt?: number; receivedAt?: number; deliveredAt?: number; statuses?: string[] }

interface State {
  forms: Record<string, Form>;
  sent: Record<string, SentRecord>; // outbound wamid -> form/revision
  processed: Record<string, number>; // inbound wamid -> epoch ms
  counter?: number; // short form number
  patch?: Record<string, PatchTarget>; // technician key -> form waiting for a correction message (PATCH_TARGET)
  receipts?: Record<string, Receipt>;
  versions?: Record<string, FormVersion[]>;
  outbox?: Record<string, OutboxEntry>;
  tech?: Record<string, { lastInboundAt: number }>;
}

export type ApproveResult =
  | { ok: true; version: FormVersion }
  | { ok: false; reason: "UNKNOWN" | "STALE" | "ALREADY" };

// Spike-grade JSON file store. Every mutation is ONE load -> mutate -> atomic rename (tx), so a crash never leaves a half-written
// state and related changes (draft + outbox entry, approval + version) are committed together. Single-process only.
export class Store {
  private file: string;
  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "state.json");
  }
  private load(): State {
    if (!existsSync(this.file)) return { forms: {}, sent: {}, processed: {} };
    return JSON.parse(readFileSync(this.file, "utf8")) as State;
  }
  private save(s: State): void {
    const tmp = this.file + ".tmp";
    writeFileSync(tmp, JSON.stringify(s));
    renameSync(tmp, this.file);
  }
  /** Atomic transaction: the mutator may throw; nothing is saved in that case. */
  tx<T>(fn: (s: State) => T): T {
    const s = this.load();
    const r = fn(s);
    this.save(s);
    return r;
  }

  // ---- inbound dedup
  /** Returns true if this message id is new (and claims it); false if duplicate. */
  claimMessage(id: string): boolean {
    return this.tx((s) => {
      if (s.processed[id]) return false;
      s.processed[id] = Date.now();
      return true;
    });
  }

  // ---- forms (legacy + pipeline)
  getForm(formId: string): Form | undefined {
    return this.load().forms[formId];
  }
  /** Creates or updates a form; a new revision resets status to draft. */
  upsertForm(formId: string, revision: number): Form {
    return this.tx((s) => {
      const cur = s.forms[formId];
      if (cur && revision < cur.revision) throw new Error("revision cannot go backwards");
      const f: Form = cur && cur.revision === revision ? cur : { formId, revision, status: "draft" };
      s.forms[formId] = f;
      return f;
    });
  }
  setStatus(formId: string, status: FormStatus): void {
    this.tx((s) => { if (s.forms[formId]) s.forms[formId].status = status; });
  }
  nextNumber(): number {
    return this.tx((s) => (s.counter = (s.counter ?? 1000) + 1));
  }

  // ---- receipts
  beginReceipt(id: string, techKey: string, kind: "NEW" | "PATCH", receivedAt: number): Receipt {
    return this.tx((s) => {
      s.receipts ??= {};
      return (s.receipts[id] ??= { id, techKey, kind, status: "PROCESSING", receivedAt, updatedAt: Date.now() });
    });
  }
  getReceipt(id: string): Receipt | undefined { return this.load().receipts?.[id]; }
  finishReceipt(id: string, status: ReceiptStatus, extra: Partial<Receipt> = {}): void {
    this.tx((s) => { const r = s.receipts?.[id]; if (r) Object.assign(r, extra, { status, updatedAt: Date.now() }); });
  }
  /** Crash recovery: receipts still PROCESSING belong to a dead process (their audio is gone). Returns them, now FAILED. */
  recoverReceipts(): Receipt[] {
    return this.tx((s) => {
      const out: Receipt[] = [];
      for (const r of Object.values(s.receipts ?? {})) if (r.status === "PROCESSING") { r.status = "FAILED"; r.failure = "PROCESS_RESTARTED"; r.updatedAt = Date.now(); out.push(r); }
      return out;
    });
  }

  // ---- drafts + outbox (one atomic commit)
  /** SALV-R15: the draft and its outbox message are saved in the same transaction; older undelivered revisions are superseded. */
  saveDraftAndEnqueue(form: Form, entry: OutboxEntry, receiptId?: string): void {
    this.tx((s) => {
      s.forms[form.formId] = form;
      s.outbox ??= {};
      for (const e of Object.values(s.outbox)) {
        if (e.kind === "FORM" && e.formId === form.formId && e.key !== entry.key && (e.status === "PENDING" || e.status === "WINDOW_CLOSED")) e.status = "SUPERSEDED";
      }
      s.outbox[entry.key] ??= entry; // fixed key: a repeated enqueue never creates a second message
      const r = receiptId ? s.receipts?.[receiptId] : undefined;
      if (r) { r.status = form.mode === "PARTIAL" ? "NEEDS_INFO" : "REVIEW_READY"; r.formId = form.formId; r.revision = form.revision; r.updatedAt = Date.now(); }
    });
  }
  /** Approval: atomic, idempotent. Creates ONE immutable FormVersion; a second approval creates nothing. */
  approve(formId: string, revision: number, opKey: string, now: number): ApproveResult {
    return this.tx((s): ApproveResult => {
      const f = s.forms[formId];
      if (!f) return { ok: false, reason: "UNKNOWN" };
      if (f.revision !== revision) return { ok: false, reason: "STALE" };
      if (f.status !== "draft" || !f.fields) return { ok: false, reason: "ALREADY" };
      s.versions ??= {};
      const list = (s.versions[formId] ??= []);
      const v: FormVersion = { formId, versionSeq: list.length + 1, revision, fields: JSON.parse(JSON.stringify(f.fields)), flagged: [...(f.flagged ?? [])], mode: f.mode ?? "FULL", approvedAt: now, opKey };
      list.push(v);
      f.status = "approved";
      return { ok: true, version: v };
    });
  }
  getVersions(formId: string): FormVersion[] { return this.load().versions?.[formId] ?? []; }

  // ---- outbox
  enqueueText(entry: OutboxEntry): void {
    this.tx((s) => { s.outbox ??= {}; s.outbox[entry.key] ??= entry; });
  }
  outboxAll(): OutboxEntry[] { return Object.values(this.load().outbox ?? {}); }
  getOutbox(key: string): OutboxEntry | undefined { return this.load().outbox?.[key]; }
  dueOutbox(now: number): OutboxEntry[] {
    return this.outboxAll().filter((e) => e.status === "PENDING" && e.nextAt <= now).sort((a, b) => a.createdAt - b.createdAt);
  }
  updateOutbox(key: string, patch: Partial<OutboxEntry>): void {
    this.tx((s) => { const e = s.outbox?.[key]; if (e) Object.assign(e, patch); });
  }
  /** After a restart an entry stuck in SENDING is unknown: it is retried (at-least-once; the Cloud API has no idempotency key). */
  recoverOutbox(): number {
    return this.tx((s) => { let n = 0; for (const e of Object.values(s.outbox ?? {})) if (e.status === "SENDING") { e.status = "PENDING"; e.nextAt = 0; n++; } return n; });
  }
  /** M-4: when the technician writes again, deliveries that were blocked by the closed service window become due. */
  releaseWindowClosed(techKey: string, now: number): number {
    return this.tx((s) => { let n = 0; for (const e of Object.values(s.outbox ?? {})) if (e.techKey === techKey && e.status === "WINDOW_CLOSED") { e.status = "PENDING"; e.nextAt = now; n++; } return n; });
  }

  // ---- technician activity (service window)
  touchInbound(techKey: string, now: number): void {
    this.tx((s) => { s.tech ??= {}; s.tech[techKey] = { lastInboundAt: now }; });
  }
  lastInbound(techKey: string): number | undefined { return this.load().tech?.[techKey]?.lastInboundAt; }

  // ---- sent messages + delivery statuses
  recordSent(wamid: string, formId: string, revision: number, extra: Partial<SentRecord> = {}): void {
    this.tx((s) => { s.sent[wamid] = { formId, revision, ...extra }; });
  }
  getSent(wamid: string): SentRecord | undefined {
    return this.load().sent[wamid];
  }
  markDelivery(wamid: string, status: string, now: number): SentRecord | undefined {
    return this.tx((s) => {
      const r = s.sent[wamid];
      if (!r) return undefined;
      (r.statuses ??= []).push(status);
      if (status === "delivered" && r.deliveredAt === undefined) r.deliveredAt = now;
      return r;
    });
  }

  // ---- correction context
  setPatchTarget(techId: string, t: PatchTarget): void {
    this.tx((s) => { (s.patch ??= {})[techId] = t; });
  }
  getPatchTarget(techId: string): PatchTarget | undefined {
    return this.load().patch?.[techId];
  }
  clearPatchTarget(techId: string): void {
    this.tx((s) => { if (s.patch) delete s.patch[techId]; });
  }
}
