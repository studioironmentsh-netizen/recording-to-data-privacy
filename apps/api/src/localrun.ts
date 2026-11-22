// Building blocks of scripts/local-e2e.ts (local audio file -> the SAME pipeline, with no way to send anything).
// Not imported by the server or the production pipeline.
import { connect } from "node:net";
import { Store, type OutboxEntry, type Form } from "./store.ts";
import { OutboundDisabledError, type WhatsApp } from "./whatsapp.ts";

/** Synthetic sender of local runs. It is NOT in ALLOWED_TECHNICIAN_WA_IDS, so the outbox can never resolve a recipient for it. */
export const LOCAL_SENDER = "local-test";
export const LOCAL_OUTBOX_MARK = "LOCAL_TEST_NEVER_DELIVER";

/** WhatsApp port for local runs: serves ONE local file as "downloaded media"; every send throws (and is counted). No network. */
export class LocalFileWhatsApp implements WhatsApp {
  sendAttempts = 0;
  private bytes: Buffer;
  private mime: string;
  constructor(bytes: Buffer, mime = "audio/ogg") {
    this.bytes = bytes;
    this.mime = mime;
  }
  private refuse(): never {
    this.sendAttempts++;
    throw new OutboundDisabledError();
  }
  async sendText(_to: string, _text: string): Promise<void> { this.refuse(); }
  async sendForm(_to: string, _formId: string, _revision: number): Promise<string> { return this.refuse(); }
  async sendFormButtons(_to: string, _body: string, _formId: string, _revision: number): Promise<string> { return this.refuse(); }
  async fetchMedia(_mediaId: string) { return { bytes: this.bytes, mime: this.mime }; }
}

/**
 * Store for local runs. A form is saved exactly as in production, but its outbox entry is BORN terminal (DROPPED) in the same
 * transaction: there is never a PENDING moment, and no code path (dueOutbox, releaseWindowClosed, recoverOutbox, supersede) revives DROPPED.
 */
export class LocalTestStore extends Store {
  override saveDraftAndEnqueue(form: Form, entry: OutboxEntry, receiptId?: string, completedAt?: number): void {
    super.saveDraftAndEnqueue(form, { ...entry, status: "DROPPED", lastError: LOCAL_OUTBOX_MARK }, receiptId, completedAt);
  }
  override enqueueText(_entry: OutboxEntry): void {
    throw new Error("local test run: no text may be queued");
  }
}

/** The JSON store supports one process: refuse to run while the server (webhook or inspector port) is up. */
export function assertNoServerOn(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = connect({ host: "127.0.0.1", port });
    s.once("connect", () => { s.destroy(); reject(new Error(`a server is already listening on 127.0.0.1:${port}: stop it before a local run`)); });
    s.once("error", () => resolve());
  });
}
