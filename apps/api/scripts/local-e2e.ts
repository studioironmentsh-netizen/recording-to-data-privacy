// LOCAL E2E: one local audio file -> the production pipeline (real STT worker, real Claude extractor, validators, store) with NO Meta and NO outbound.
// Usage (from apps/api, server STOPPED):
//   npm run local-e2e -- <audio_file>            dry run: checks only, no STT, no Claude, writes nothing
//   npm run local-e2e -- <audio_file> --run      runs the pipeline: ONE real Claude extraction (up to 3 attempts, counted in the global ledger)
// Safety is hard-coded here, not read from .env: outbound OFF, ACK OFF, synthetic sender outside the allowlist, outbox entry born DROPPED.
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { randomBytes } from "node:crypto";
import { loadConfig, type Config } from "../src/config.ts";
import { log, maskPhone, registerSecrets, shortId } from "../src/logger.ts";
import { assertNoServerOn, LOCAL_SENDER, LocalFileWhatsApp, LocalTestStore } from "../src/localrun.ts";
import { PythonControls } from "../src/pipeline/controls.ts";
import { StructuredExtractor } from "../src/pipeline/extractor.ts";
import { AnthropicLlm, BudgetLedger, BUDGET, budgetCapUsd, evaluateLiveGate } from "../src/pipeline/llm.ts";
import { OutboxRunner } from "../src/pipeline/outbox.ts";
import { VoicePipeline } from "../src/pipeline/pipeline.ts";
import { PythonSttWorker } from "../src/pipeline/stt.ts";

const [audioPath, ...flags] = process.argv.slice(2);
const RUN = flags.includes("--run");
const die = (msg: string): never => { console.error(`ABORT: ${msg}`); process.exit(2); };
if (!audioPath) die("usage: local-e2e <audio_file> [--run]");

const env = process.env;
const base = loadConfig(env);
if (!base.pipeline) die("PIPELINE_ENABLED=true and STT_MODEL_DIR are required");
const p = { ...base.pipeline!, ackEnabled: false };
const cfg: Config = { ...base, outboundEnabled: false, graphBaseUrl: undefined, localInspect: undefined, pipeline: p }; // hard-coded isolation
registerSecrets(cfg.accessToken, cfg.appSecret, cfg.verifyToken, env.ANTHROPIC_API_KEY ?? "");

const gate = evaluateLiveGate(env);
let ledger: ReturnType<BudgetLedger["snapshot"]> | null = null;
try { ledger = new BudgetLedger(cfg.dataDir, budgetCapUsd(env)).snapshot(); } catch { ledger = null; }
const fileOk = existsSync(audioPath!) && statSync(audioPath!).isFile();
const size = fileOk ? statSync(audioPath!).size : 0;
const inspectPort = base.localInspect?.port;

console.log("local-e2e preflight (no values printed):");
console.log(`  mode                : ${RUN ? "RUN" : "DRY RUN (no STT, no Claude, nothing written)"}`);
console.log(`  outbound / ack      : forced OFF in this script`);
console.log(`  audio file          : ${fileOk ? `${basename(audioPath!)} (${size} bytes)` : "MISSING"}`);
console.log(`  claude live gate    : ${gate.live ? "open" : `CLOSED (missing: ${gate.missing.join("; ")})`}`);
console.log(`  budget ledger       : ${ledger ? `${ledger.calls}/${BUDGET.maxCalls} calls, $${ledger.usd.toFixed(2)} of $${budgetCapUsd(env)}` : "unreadable"}`);
if (!fileOk) die("audio file not found");
if (size > cfg.mediaMaxBytes) die("audio file exceeds MEDIA_MAX_BYTES");
try {
  await assertNoServerOn(cfg.port);
  if (inspectPort) await assertNoServerOn(inspectPort);
} catch (e) { die((e as Error).message); }
console.log("  server              : not running (ok)");
if (!RUN) { console.log("\nDry run only. Add --run to execute ONE real extraction."); process.exit(0); }
if (!gate.live) die("Claude live gate is closed");

const wa = new LocalFileWhatsApp(readFileSync(audioPath!));
const store = new LocalTestStore(cfg.dataDir);
const stt = new PythonSttWorker({
  pythonExe: p.pythonExe, workerScript: p.sttWorkerScript, modelDir: p.sttModelDir, maxQueue: p.sttMaxQueue, jobTimeoutMs: p.sttJobTimeoutMs,
  startupTimeoutMs: p.sttStartupTimeoutMs, maxAudioSeconds: p.sttMaxAudioSeconds, onEvent: (e, f) => log("info", e, f),
});
const extractor = new StructuredExtractor(AnthropicLlm.create(env, cfg.dataDir), new PythonControls(p.pythonExe, p.controlsScript));
const outbox = new OutboxRunner({ cfg, store, wa }); // never started; inert while outbound is off
const pipeline = new VoicePipeline({ cfg, store, wa, stt, extractor, outbox });

const messageId = `local-${randomBytes(4).toString("hex")}`;
let exit = 0;
try {
  await stt.warmUp();
  const receivedAt = Date.now(); // local measurement starts here (no webhook, media "download" = reading the local file)
  await pipeline.processVoice({ kind: "audio", messageId, from: LOCAL_SENDER, mediaId: "0", mime: "audio/ogg", voice: true }, { msg: shortId(messageId), from: maskPhone(LOCAL_SENDER) }, receivedAt);
  const r = store.getReceipt(messageId);
  const form = r?.formId ? store.getForm(r.formId) : undefined;
  const entry = form ? store.getOutbox(`form:${form.formId}:${form.revision}`) : undefined;
  const after = new BudgetLedger(cfg.dataDir, budgetCapUsd(env)).snapshot();
  console.log("\nresult:");
  console.log(`  receipt             : ${r?.status ?? "MISSING"}${r?.failure ? ` (${r.failure})` : ""}`);
  console.log(`  form                : ${form ? `${form.formId} rev ${form.revision} mode ${form.mode}` : "none"}`);
  console.log(`  processing duration : ${r?.processingDurationMs ?? "n/a"} ms (local file -> saved form)`);
  console.log(`  outbox entry        : ${entry ? `${entry.status} attempts=${entry.attempts}` : "none"}`);
  console.log(`  send attempts       : ${wa.sendAttempts}`);
  console.log(`  ledger              : ${after.calls}/${BUDGET.maxCalls} calls, $${after.usd.toFixed(2)}`);
  if (form) console.log(`\ninspect (start the server, then): GET http://127.0.0.1:${inspectPort ?? 3001}/local/forms/${form.formId}`);
  if (!form || wa.sendAttempts !== 0 || entry?.status !== "DROPPED") exit = 1;
} catch (e) {
  console.error("local run failed:", (e as Error).message);
  exit = 1;
} finally {
  await stt.close();
}
process.exit(exit);
