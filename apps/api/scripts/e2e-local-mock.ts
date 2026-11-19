// Local mock E2E: REAL local STT (Ivrit Turbo) + REAL validator/controls, MOCK Meta and MOCK Claude (no network, no cost).
// Usage: node scripts/e2e-local-mock.ts <model_dir_abs> <audio_file> [<audio_file> ...]
// Prints only timings/counters (never transcripts). The mock "Claude" builds a minimal valid answer from the transcript, so
// extraction latency here is ~0: add the measured/historical Claude latency when judging the 60 s target.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config.ts";
import { setSink } from "../src/logger.ts";
import { PythonControls } from "../src/pipeline/controls.ts";
import { StructuredExtractor } from "../src/pipeline/extractor.ts";
import { MockLlm, mockReply, type LlmRequest } from "../src/pipeline/llm.ts";
import { VoicePipeline } from "../src/pipeline/pipeline.ts";
import { PythonSttWorker } from "../src/pipeline/stt.ts";
import { CONTROLS_SCRIPT, FakeWA, PYTHON, docWith, modelReply } from "../src/pipeline/testkit.ts";
import { Store } from "../src/store.ts";
import { join as j } from "node:path";

const [modelDir, ...audio] = process.argv.slice(2);
if (!modelDir || audio.length === 0) { console.error("usage: e2e-local-mock.ts <model_dir> <audio>..."); process.exit(2); }

const dir = mkdtempSync(join(tmpdir(), "e2e-mock-"));
const lines: any[] = [];
setSink((l) => lines.push(JSON.parse(l)));

const apiRoot = j(import.meta.dirname, "..");
const cfg: Config = {
  port: 0, verifyToken: "x", accessToken: "x", appSecret: "x", phoneNumberId: "1", allowedTechnicians: new Set(["15550001111"]), graphVersion: "v23.0",
  dataDir: dir, mediaMaxBytes: 16 * 1024 * 1024, mediaKeepSeconds: 0,
  pipeline: { pythonExe: PYTHON, sttWorkerScript: j(apiRoot, "python/stt_worker.py"), controlsScript: CONTROLS_SCRIPT, sttModelDir: modelDir, sttMaxAudioSeconds: 180, sttMaxQueue: 4, sttJobTimeoutMs: 150000, sttStartupTimeoutMs: 180000, extractorMode: "mock", ackEnabled: false, patchTtlMs: 600000 },
};
const stt = new PythonSttWorker({ pythonExe: PYTHON, workerScript: cfg.pipeline!.sttWorkerScript, modelDir, maxQueue: 4, jobTimeoutMs: 150000, startupTimeoutMs: 180000, maxAudioSeconds: 180, onEvent: (e, f) => lines.push({ event: e, ...f }) });
const wa = new FakeWA();
const llm = new MockLlm([]);
(llm as any).script = Array.from({ length: audio.length }, () => (req: LlmRequest) => {
  const t = /<<<TRANSCRIPT\n([\s\S]*?)\nTRANSCRIPT>>>/.exec(req.prompt)![1]!;
  const words = t.split(/\s+/).filter(Boolean).slice(0, 6).join(" ");
  return mockReply(modelReply(docWith({ work_summary: [words, words] })));
});
const pipeline = new VoicePipeline({ cfg, store: new Store(dir), wa, stt, extractor: new StructuredExtractor(llm, new PythonControls(PYTHON, CONTROLS_SCRIPT)), mockWatermark: true });

const t0 = Date.now();
await stt.warmUp();
console.log(JSON.stringify({ cold_start_ms: Date.now() - t0 }));
for (const [i, file] of audio.entries()) {
  wa.media.set(String(i), readFileSync(file));
  const received = Date.now();
  await pipeline.processVoice({ kind: "audio", messageId: `wamid.E2E${i}`, from: "15550001111", mediaId: String(i), mime: "audio/ogg; codecs=opus", voice: true }, { msg: `E2E${i}` }, received);
  const done = lines.filter((l) => l.event === "form_sent").pop();
  console.log(JSON.stringify({ run: i, wall_ms: Date.now() - received, forms_sent: wa.forms.length, ...Object.fromEntries(Object.entries(done ?? {}).filter(([k]) => k.endsWith("_ms") || k === "audio_s" || k === "ai_calls")) }));
}
for (const l of lines.filter((x) => x.level === "warn" || x.level === "error")) console.log(JSON.stringify(l));
await stt.close();
