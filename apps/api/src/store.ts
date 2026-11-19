import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StoredFields } from "./pipeline/formview.ts";

export type FormStatus = "draft" | "approved" | "editing";
export interface Form {
  formId: string; revision: number; status: FormStatus;
  // Present only for forms created by the voice pipeline (legacy spike forms have none of these).
  number?: number; techId?: string; fields?: StoredFields; captureDate?: string; partial?: boolean; mock?: boolean;
}
export interface PatchTarget { formId: string; revision: number; expiresAt: number }
interface State {
  forms: Record<string, Form>;
  sent: Record<string, { formId: string; revision: number }>; // outbound wamid -> form/revision
  processed: Record<string, number>; // inbound wamid -> epoch ms
  counter?: number; // short form number
  patch?: Record<string, PatchTarget>; // technician wa_id -> form waiting for a correction message (PATCH_TARGET)
}

// Spike-grade JSON file store. Re-reads on every operation so the server and
// the send-form CLI can share it. Replace with PostgreSQL later.
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
  /** Returns true if this message id is new (and claims it); false if duplicate. */
  claimMessage(id: string): boolean {
    const s = this.load();
    if (s.processed[id]) return false;
    s.processed[id] = Date.now();
    this.save(s);
    return true;
  }
  getForm(formId: string): Form | undefined {
    return this.load().forms[formId];
  }
  /** Creates or updates a form; a new revision resets status to draft. */
  upsertForm(formId: string, revision: number): Form {
    const s = this.load();
    const cur = s.forms[formId];
    if (cur && revision < cur.revision) throw new Error("revision cannot go backwards");
    const f: Form = cur && cur.revision === revision ? cur : { formId, revision, status: "draft" };
    s.forms[formId] = f;
    this.save(s);
    return f;
  }
  setStatus(formId: string, status: FormStatus): void {
    const s = this.load();
    if (s.forms[formId]) s.forms[formId].status = status;
    this.save(s);
  }
  recordSent(wamid: string, formId: string, revision: number): void {
    const s = this.load();
    s.sent[wamid] = { formId, revision };
    this.save(s);
  }
  nextNumber(): number {
    const s = this.load();
    s.counter = (s.counter ?? 1000) + 1;
    this.save(s);
    return s.counter;
  }
  /** Stores/overwrites a pipeline draft (no transcript or quote is ever part of a Form). */
  saveDraft(f: Form): void {
    const s = this.load();
    s.forms[f.formId] = f;
    this.save(s);
  }
  setPatchTarget(techId: string, t: PatchTarget): void {
    const s = this.load();
    (s.patch ??= {})[techId] = t;
    this.save(s);
  }
  getPatchTarget(techId: string): PatchTarget | undefined {
    return this.load().patch?.[techId];
  }
  clearPatchTarget(techId: string): void {
    const s = this.load();
    if (s.patch) delete s.patch[techId];
    this.save(s);
  }
  getSent(wamid: string) {
    return this.load().sent[wamid];
  }
}
