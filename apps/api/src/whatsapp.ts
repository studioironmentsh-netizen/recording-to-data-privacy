import { createHash } from "node:crypto";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { BUTTON_TITLES, encodeButtonId } from "./forms.ts";

export class GraphError extends Error {}

export interface WhatsApp {
  sendText(to: string, text: string): Promise<void>;
  sendForm(to: string, formId: string, revision: number): Promise<string>;
  fetchMedia(mediaId: string): Promise<{ bytes: Buffer; mime: string; sha256Reported?: string }>;
}

export class GraphWhatsApp implements WhatsApp {
  private cfg: Config;
  private fetchFn: typeof fetch;
  constructor(cfg: Config, fetchFn: typeof fetch = fetch) {
    this.cfg = cfg;
    this.fetchFn = fetchFn;
  }
  private base() { return `https://graph.facebook.com/${this.cfg.graphVersion}`; }
  private auth() { return { Authorization: `Bearer ${this.cfg.accessToken}` }; }

  private async fail(res: Response, what: string): Promise<never> {
    let detail = "";
    try {
      const j = (await res.json()) as any;
      const e = j?.error;
      detail = `code=${e?.code} subcode=${e?.error_subcode} type=${e?.type}`;
    } catch { /* ignore */ }
    throw new GraphError(`${what} failed: http ${res.status} ${detail}`);
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
    const j = await this.post({
      messaging_product: "whatsapp", to, type: "interactive",
      interactive: {
        type: "button",
        body: { text: `טופס ניסיוני ${formId} (גרסה ${revision}). נא לאשר או לתקן.` },
        action: {
          buttons: (["approve", "edit"] as const).map((a) => ({
            type: "reply",
            reply: { id: encodeButtonId(a, formId, revision), title: BUTTON_TITLES[a] },
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
    if (url.protocol !== "https:") throw new GraphError("media url not https");
    const res = await this.fetchFn(url, { headers: this.auth() });
    if (!res.ok) return this.fail(res, "media download");
    const len = Number(res.headers.get("content-length") ?? 0);
    if (len > this.cfg.mediaMaxBytes) throw new GraphError("media too large");
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > this.cfg.mediaMaxBytes) throw new GraphError("media too large");
    return { bytes, mime: String(m.mime_type ?? ""), sha256Reported: typeof m.sha256 === "string" ? m.sha256 : undefined };
  }
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
