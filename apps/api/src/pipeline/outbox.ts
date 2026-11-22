import type { Config } from "../config.ts";
import { errMsg, log } from "../logger.ts";
import type { Form, OutboxEntry, Store } from "../store.ts";
import { BODY_MAX, GraphError, type WhatsApp } from "../whatsapp.ts";
import { renderForm } from "./formview.ts";
import { techKey } from "./techkey.ts";

export const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** SALV-R15 defaults (engineering-decided): 1, 5, 15 minutes, then hourly, inside the 24 h service window. */
export const RETRY_SCHEDULE_MS = [60_000, 5 * 60_000, 15 * 60_000];
export const HOURLY_MS = 60 * 60_000;
export const MAX_ATTEMPTS = 8;

export function nextDelayMs(attempts: number): number {
  return RETRY_SCHEDULE_MS[attempts - 1] ?? HOURLY_MS;
}

export interface OutboxDeps { cfg: Config; store: Store; wa: WhatsApp; now?: () => number; mockWatermark?: boolean }

/** Renders the CURRENT stored revision of a pipeline form (what the technician must see), or null if it no longer applies. */
export function renderStored(form: Form, mockWatermark = true): string | null {
  if (!form.fields || form.number === undefined || !form.captureDate) return null;
  return renderForm({ number: form.number, revision: form.revision, fields: form.fields, captureDate: form.captureDate, partial: Boolean(form.partial), mockWatermark: Boolean(form.mock) && mockWatermark });
}

/**
 * Durable outbox (SALV-R15). A form is first committed to the store together with its outbox entry; this runner delivers it.
 * Delivery is at-least-once: the WhatsApp Cloud API has no idempotency key, so if the process dies after Meta accepted a message
 * but before the entry is marked SENT, the entry is retried after the restart (documented boundary; one extra form at worst).
 */
export class OutboxRunner {
  private d: OutboxDeps;
  private busy = false;
  private again = false;
  private timer: NodeJS.Timeout | null = null;
  constructor(d: OutboxDeps) {
    this.d = d;
  }
  private now(): number { return (this.d.now ?? Date.now)(); }

  private waIdOf(key: string): string | undefined {
    for (const id of this.d.cfg.allowedTechnicians) if (techKey(id) === key) return id;
    return undefined;
  }

  /** OUTBOUND_ENABLED gate: when false the outbox is inert (nothing is delivered, retried, timed or dropped; entries stay as saved). */
  private get enabled(): boolean { return this.d.cfg.outboundEnabled === true; }

  start(intervalMs = 15_000): void {
    this.stop();
    if (!this.enabled) return; // no retry timer exists in safe mode
    this.timer = setInterval(() => void this.drain(), intervalMs);
    this.timer.unref();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Delivers everything that is due. Single-flight: concurrent calls are coalesced into one more pass. */
  async drain(): Promise<void> {
    if (!this.enabled) return; // checked before touching the store: queued entries are preserved untouched
    if (this.busy) { this.again = true; return; }
    this.busy = true;
    try {
      do {
        this.again = false;
        for (const e of this.d.store.dueOutbox(this.now())) await this.deliver(e);
      } while (this.again);
    } finally {
      this.busy = false;
    }
  }

  private async deliver(e: OutboxEntry): Promise<void> {
    if (!this.enabled) return; // defense in depth: no state change, no send
    const { store, wa } = this.d;
    const now = this.now();
    const to = this.waIdOf(e.techKey);
    if (!to) { store.updateOutbox(e.key, { status: "DROPPED", lastError: "UNKNOWN_RECIPIENT" }); return; }
    const last = store.lastInbound(e.techKey);
    if (last === undefined || now - last > SERVICE_WINDOW_MS) { // free-form messages are only allowed inside the 24 h window
      store.updateOutbox(e.key, { status: "WINDOW_CLOSED" });
      log("warn", "outbox_window_closed", { key_kind: e.kind, attempts: e.attempts });
      return;
    }
    let form: Form | undefined;
    let text = e.text ?? "";
    if (e.kind === "FORM") {
      form = store.getForm(e.formId!);
      const rendered = form && form.revision === e.revision ? renderStored(form, this.d.mockWatermark ?? true) : null;
      if (!form || rendered === null || form.status === "approved") { store.updateOutbox(e.key, { status: "SUPERSEDED" }); return; } // a newer revision/approval makes it obsolete
      text = rendered;
    }
    store.updateOutbox(e.key, { status: "SENDING", attempts: e.attempts + 1 });
    try {
      if (e.kind === "TEXT") {
        await wa.sendText(to, text);
        store.updateOutbox(e.key, { status: "SENT", submittedAt: now });
        return;
      }
      let body = text;
      if (text.length > BODY_MAX) { // Meta limit for reply-button bodies: full form as text first (once), then the buttons
        if (!e.textPartsSent) {
          for (let i = 0; i < text.length; i += 3800) await wa.sendText(to, text.slice(i, i + 3800));
          store.updateOutbox(e.key, { textPartsSent: true });
        }
        body = `טופס ${form!.formId} (גרסה ${form!.revision}). אשר או תקן?`;
      }
      const wamid = await wa.sendFormButtons(to, body, form!.formId, form!.revision);
      store.recordSent(wamid, form!.formId, form!.revision, { submittedAt: now, receivedAt: e.receiptReceivedAt });
      store.updateOutbox(e.key, { status: "SENT", sentWamid: wamid, submittedAt: now });
    } catch (err) {
      const attempts = e.attempts + 1;
      const ge = err instanceof GraphError ? err : null;
      const msg = errMsg(err).slice(0, 120);
      if (ge?.windowClosed) {
        store.updateOutbox(e.key, { status: "WINDOW_CLOSED", lastError: msg });
        log("warn", "outbox_window_closed", { key_kind: e.kind, attempts });
      } else if ((ge && !ge.retryable) || attempts >= MAX_ATTEMPTS || now - e.createdAt > SERVICE_WINDOW_MS) {
        store.updateOutbox(e.key, { status: "EXHAUSTED", lastError: msg });
        log("error", "outbox_exhausted", { alert: "OPERATIONAL", key_kind: e.kind, attempts }); // no content; the draft stays saved
      } else {
        store.updateOutbox(e.key, { status: "PENDING", nextAt: now + nextDelayMs(attempts), lastError: msg });
        log("warn", "outbox_retry_scheduled", { key_kind: e.kind, attempts, retry_in_s: Math.round(nextDelayMs(attempts) / 1000) });
      }
    }
  }
}
