import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { loadConfig, type Config } from "./config.ts";
import { parseWebhook } from "./events.ts";
import { handleEvent, type Deps } from "./handlers.ts";
import { errMsg, log, registerSecrets } from "./logger.ts";
import { verifySignature } from "./signature.ts";
import { Store } from "./store.ts";
import { GraphWhatsApp, sweepTempAudio } from "./whatsapp.ts";
import { PythonControls } from "./pipeline/controls.ts";
import { StructuredExtractor } from "./pipeline/extractor.ts";
import { AnthropicLlm, evaluateLiveGate } from "./pipeline/llm.ts";
import { OutboxRunner } from "./pipeline/outbox.ts";
import { VoicePipeline } from "./pipeline/pipeline.ts";
import { PythonSttWorker } from "./pipeline/stt.ts";

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
    const receivedAtMs = Date.now();
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
        log("info", "webhook_post_received", { method: "POST", path: url.pathname });
        const raw = await readBody(req);
        if (!verifySignature(raw, req.headers["x-hub-signature-256"] as string | undefined, cfg.appSecret)) {
          log("warn", "signature_invalid");
          return end(401);
        }
        log("info", "webhook_signature_ok");
        let events;
        try { events = parseWebhook(JSON.parse(raw.toString("utf8"))); }
        catch { log("warn", "payload_unparseable"); return end(400); }
        end(200); // ack fast so Meta does not retry; process afterwards
        const n = { audio: 0, button: 0, status: 0, other: 0 };
        for (const ev of events) n[ev.kind]++;
        log("info", "webhook_parsed", { events: events.length, ...n });
        const work = Promise.all(events.map((ev) => handleEvent(ev, deps, receivedAtMs)));
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

export function buildDeps(cfg: Config, env: NodeJS.ProcessEnv = process.env): Deps {
  registerSecrets(cfg.accessToken, cfg.appSecret, cfg.verifyToken, env.ANTHROPIC_API_KEY ?? "");
  const store = new Store(cfg.dataDir);
  const wa = new GraphWhatsApp(cfg);
  const p = cfg.pipeline;
  if (!p) return { cfg, store, wa };
  const stt = new PythonSttWorker({
    pythonExe: p.pythonExe, workerScript: p.sttWorkerScript, modelDir: p.sttModelDir, maxQueue: p.sttMaxQueue, jobTimeoutMs: p.sttJobTimeoutMs,
    startupTimeoutMs: p.sttStartupTimeoutMs, maxAudioSeconds: p.sttMaxAudioSeconds, onEvent: (e, f) => log("info", e, f),
  });
  let extractor: StructuredExtractor | null = null;
  if (p.extractorMode === "real") {
    const gate = evaluateLiveGate(env);
    if (!gate.live) throw new Error(`LIVE_GATE_CLOSED: missing ${gate.missing.join("; ")}`); // refuse to start; never fall back silently
    extractor = new StructuredExtractor(AnthropicLlm.create(env, cfg.dataDir), new PythonControls(p.pythonExe, p.controlsScript));
  } // else: transcribe-only dry run, no Claude calls
  const swept = sweepTempAudio(cfg.dataDir); // orphaned audio from a crashed run never survives a restart
  log("info", "pipeline_configured", { extractor: p.extractorMode, live_calls_enabled: extractor !== null, swept_temp_files: swept });
  void stt.warmUp().catch(() => log("error", "stt_warmup_failed"));
  const outbox = new OutboxRunner({ cfg, store, wa });
  const pipeline = new VoicePipeline({ cfg, store, wa, stt, extractor, outbox });
  const rec = pipeline.recoverAfterRestart(); // dead receipts -> durable "please resend" notice; stuck sends -> retried
  log("info", "recovery_done", { receipts_failed: rec.receipts, outbox_requeued: rec.outbox });
  outbox.start();
  void outbox.drain();
  return { cfg, store, wa, pipeline, outbox };
}

if (import.meta.main) {
  const cfg = loadConfig();
  createApp(buildDeps(cfg)).listen(cfg.port, "127.0.0.1", () => log("info", "server_listening", { port: cfg.port }));
}
