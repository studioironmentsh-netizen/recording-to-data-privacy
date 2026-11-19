import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { BUTTON_TITLES, encodeButtonId, signedButtonId } from "./forms.ts";

export class GraphError extends Error {
  readonly status?: number;
  readonly graphCode?: number;
  constructor(message: string, status?: number, graphCode?: number) {
    super(message);
    this.status = status;
    this.graphCode = graphCode;
  }
  /** Meta error 131047: the 24-hour customer service window is closed (free-form message not allowed). */
  get windowClosed(): boolean { return this.graphCode === 131047; }
  /** Retrying can help: network failures, 429 and 5xx. Other 4xx are permanent. */
  get retryable(): boolean { return this.status === undefined || this.status === 429 || this.status >= 500; }
}
export const BODY_MAX = 1024; // WhatsApp reply-button body limit

export interface WhatsApp {
  sendText(to: string, text: string): Promise<void>;
  sendForm(to: string, formId: string, revision: number): Promise<string>;
  /** Sends ONE interactive message with exactly two buttons (אשר / תקן או הוסף) carrying signed ids. Body <= 1024 chars. Returns its message id. */
  sendFormButtons(to: string, body: string, formId: string, revision: number): Promise<string>;
  fetchMedia(mediaId: string): Promise<{ bytes: Buffer; mime: string; sha256Reported?: string }>;
}

export class GraphWhatsApp implements WhatsApp {
  private cfg: Config;
  private fetchFn: typeof fetch;
  constructor(cfg: Config, fetchFn: typeof fetch = fetch) {
    this.cfg = cfg;
    this.fetchFn = fetchFn;
  }
  private base() { return `${this.cfg.graphBaseUrl ?? "https://graph.facebook.com"}/${this.cfg.graphVersion}`; }
  private auth() { return { Authorization: `Bearer ${this.cfg.accessToken}` }; }

  private async fail(res: Response, what: string): Promise<never> {
    let detail = "";
    let code: number | undefined;
    try {
      const j = (await res.json()) as any;
      const e = j?.error;
      detail = `code=${e?.code} subcode=${e?.error_subcode} type=${e?.type}`;
      code = typeof e?.code === "number" ? e.code : undefined;
    } catch { /* ignore */ }
    throw new GraphError(`${what} failed: http ${res.status} ${detail}`, res.status, code);
  }

  private async post(payload: object): Promise<any> {
    const res = await this.fetchFn(`${this.base()}/${this.cfg.phoneNumberId}/messages`, {
      method: "POST",
      headers: { ...this.auth(), "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) return this.fail(res, "send");
    return res.json();
  }

  async sendText(to: string, text: string): Promise<void> {
    await this.post({ messaging_product: "whatsapp", to, type: "text", text: { body: text } });
  }

  async sendForm(to: string, formId: string, revision: number): Promise<string> {
    return this.sendInteractive(to, `טופס ניסיוני ${formId} (גרסה ${revision}). נא לאשר או לתקן.`, formId, revision, false);
  }

  async sendFormButtons(to: string, body: string, formId: string, revision: number): Promise<string> {
    if (body.length > BODY_MAX) throw new GraphError("button body too long");
    return this.sendInteractive(to, body, formId, revision, true);
  }

  async sendFormMessage(to: string, text: string, formId: string, revision: number): Promise<string> {
    let body = text;
    if (text.length > BODY_MAX) {
      // Reply-button bodies are limited to 1024 chars: send the full form as text, then the buttons with a short body.
      for (let i = 0; i < text.length; i += 3800) await this.sendText(to, text.slice(i, i + 3800));
      body = `טופס ${formId} (גרסה ${revision}). אשר או תקן?`;
    }
    return this.sendFormButtons(to, body, formId, revision);
  }

  private async sendInteractive(to: string, body: string, formId: string, revision: number, signed: boolean): Promise<string> {
    const j = await this.post({
      messaging_product: "whatsapp", to, type: "interactive",
      interactive: {
        type: "button",
        body: { text: body },
        action: {
          buttons: (["approve", "edit"] as const).map((a) => ({
            type: "reply",
            reply: { id: signed ? signedButtonId(a, formId, revision, this.cfg.appSecret) : encodeButtonId(a, formId, revision), title: BUTTON_TITLES[a] },
          })),
        },
      },
    });
    const wamid = j?.messages?.[0]?.id;
    if (typeof wamid !== "string") throw new GraphError("send returned no message id");
    return wamid;
  }

  async fetchMedia(mediaId: string) {
    if (!/^[0-9]{1,40}$/.test(mediaId)) throw new GraphError("invalid media id");
    const meta = await this.fetchFn(`${this.base()}/${mediaId}`, { headers: this.auth() });
    if (!meta.ok) return this.fail(meta, "media lookup");
    const m = (await meta.json()) as any;
    const url = new URL(String(m.url));
    const local = this.cfg.graphBaseUrl !== undefined && (url.hostname === "127.0.0.1" || url.hostname === "localhost"); // test/mock endpoint only
    if (url.protocol !== "https:" && !(local && url.protocol === "http:")) throw new GraphError("media url not https");
    const res = await this.fetchFn(url, { headers: this.auth() });
    if (!res.ok) return this.fail(res, "media download");
    const len = Number(res.headers.get("content-length") ?? 0);
    if (len > this.cfg.mediaMaxBytes) throw new GraphError("media too large");
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > this.cfg.mediaMaxBytes) throw new GraphError("media too large");
    return { bytes, mime: String(m.mime_type ?? ""), sha256Reported: typeof m.sha256 === "string" ? m.sha256 : undefined };
  }
}

/** Writes media to a private temp file for the STT worker; caller must call the returned cleanup() in `finally`. */
export function writeTempAudio(dataDir: string, bytes: Buffer, name: string): { path: string; cleanup: () => void } {
  const dir = join(dataDir, "tmp-media");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.audio`);
  writeFileSync(path, bytes, { mode: 0o600 });
  return { path, cleanup: () => { try { unlinkSync(path); } catch { /* already gone */ } } };
}

/** Crash recovery: removes audio files left behind by a previous process (called once at startup). Returns how many were removed. */
export function sweepTempAudio(dataDir: string): number {
  const dir = join(dataDir, "tmp-media");
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const f of readdirSync(dir)) if (f.endsWith(".audio") || f.endsWith(".bin")) { try { unlinkSync(join(dir, f)); n++; } catch { /* ignore */ } }
  return n;
}

/** Writes bytes to a temp file, returns evidence, deletes per keepSeconds. */
export function stashTemporarily(dataDir: string, bytes: Buffer, keepSeconds: number) {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const dir = join(dataDir, "tmp-media");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sha256.slice(0, 16)}.bin`);
  writeFileSync(path, bytes, { mode: 0o600 });
  const rm = () => { try { unlinkSync(path); } catch { /* already gone */ } };
  if (keepSeconds <= 0) rm();
  else setTimeout(rm, keepSeconds * 1000).unref();
  return { sha256, size: bytes.length, deleted: keepSeconds <= 0 };
}
