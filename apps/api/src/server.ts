import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { loadConfig, type Config } from "./config.ts";
import { parseWebhook } from "./events.ts";
import { handleEvent, type Deps } from "./handlers.ts";
import { errMsg, log, registerSecrets } from "./logger.ts";
import { verifySignature } from "./signature.ts";
import { Store } from "./store.ts";
import { GraphWhatsApp } from "./whatsapp.ts";

const MAX_BODY = 1024 * 1024;

function safeEq(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let n = 0;
    req.on("data", (c: Buffer) => {
      n += c.length;
      if (n > MAX_BODY) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** `done` (tests only) resolves when all events of a POST have been handled. */
export function createApp(deps: Deps, done?: (p: Promise<unknown>) => void) {
  const { cfg } = deps;
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const end = (code: number, body = "") => { res.statusCode = code; res.end(body); };
    try {
      if (url.pathname !== "/webhook") return end(404);
      if (req.method === "GET") {
        const mode = url.searchParams.get("hub.mode");
        const token = url.searchParams.get("hub.verify_token") ?? "";
        const challenge = url.searchParams.get("hub.challenge") ?? "";
        if (mode === "subscribe" && safeEq(token, cfg.verifyToken)) {
          log("info", "webhook_verified");
          return end(200, challenge);
        }
        log("warn", "webhook_verify_rejected");
        return end(403);
      }
      if (req.method === "POST") {
        const raw = await readBody(req);
        if (!verifySignature(raw, req.headers["x-hub-signature-256"] as string | undefined, cfg.appSecret)) {
          log("warn", "signature_invalid");
          return end(401);
        }
        let events;
        try { events = parseWebhook(JSON.parse(raw.toString("utf8"))); }
        catch { log("warn", "payload_unparseable"); return end(400); }
        end(200); // ack fast so Meta does not retry; process afterwards
        const work = Promise.all(events.map((ev) => handleEvent(ev, deps)));
        done?.(work);
        return;
      }
      end(405);
    } catch (e) {
      log("error", "request_failed", { error: errMsg(e) });
      if (!res.headersSent) end(500);
    }
  });
}

export function buildDeps(cfg: Config): Deps {
  registerSecrets(cfg.accessToken, cfg.appSecret, cfg.verifyToken);
  return { cfg, store: new Store(cfg.dataDir), wa: new GraphWhatsApp(cfg) };
}

if (import.meta.main) {
  const cfg = loadConfig();
  createApp(buildDeps(cfg)).listen(cfg.port, "127.0.0.1", () => log("info", "server_listening", { port: cfg.port }));
}
