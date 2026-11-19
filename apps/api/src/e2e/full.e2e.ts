// LOCAL FULL-CHAIN E2E (opt-in: `npm run test:e2e`). REAL: webhook server, signature check, GraphWhatsApp adapter, media download,
// Ivrit Turbo STT worker (real model), NORM-2.0, validator, evidence controls, store, outbox, button handlers.
// SIMULATED boundaries only: Meta (MockGraph over HTTP) and Claude (a transcript-aware FAKE; no API call, no cost).
// Requires: STT_MODEL_DIR (absolute, pinned model) and E2E_AUDIO_DIR (dummy research recordings). Skipped otherwise.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, writeFileSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { Config } from "../config.ts";
import { signedButtonId } from "../forms.ts";
import { registerSecrets, setSink } from "../logger.ts";
import { PythonControls } from "../pipeline/controls.ts";
import { StructuredExtractor } from "../pipeline/extractor.ts";
import { MockLlm, mockReply, type LlmRequest } from "../pipeline/llm.ts";
import { MockGraph } from "../pipeline/mockgraph.ts";
import { OutboxRunner } from "../pipeline/outbox.ts";
import { VoicePipeline } from "../pipeline/pipeline.ts";
import { PythonSttWorker } from "../pipeline/stt.ts";
import { API_ROOT, CONTROLS_SCRIPT, PYTHON, docWith, modelReply } from "../pipeline/testkit.ts";
import { createApp } from "../server.ts";
import { sign } from "../signature.ts";
import { Store } from "../store.ts";
import { GraphWhatsApp } from "../whatsapp.ts";

const MODEL_DIR = process.env.STT_MODEL_DIR ?? "";
const AUDIO_DIR = process.env.E2E_AUDIO_DIR ?? "";
const READY = MODEL_DIR !== "" && existsSync(join(MODEL_DIR, "MODEL_MANIFEST.json")) && AUDIO_DIR !== "" && existsSync(AUDIO_DIR) && existsSync(PYTHON);

const TECH = "15550001111";
const SECRET = "e2e-app-secret-value";
const TOKEN = "e2e-access-token-value";

/** Claude FAKE keyed on the real transcript's structure ("אצל <name> ברחוב <street> [number]"). Quotes are exact substrings. */
function transcriptAwareReply(req: LlmRequest) {
  const tr = /<<<TRANSCRIPT\r?\n([\s\S]*?)\r?\nTRANSCRIPT>>>/.exec(req.prompt)![1]!;
  const strings: Record<string, [string, string]> = {};
  const name = /אצל ([א-ת]+ [א-ת]+)/.exec(tr);
  if (name) strings.customer_name = [name[1]!, name[1]!];
  const addr = /ברחוב ([א-ת]+(?: [א-ת]+)?(?: \d+)?)/.exec(tr);
  if (addr) strings.customer_address = [addr[1]!, addr[1]!];
  const words = tr.split(/\s+/).filter(Boolean).slice(0, 6).join(" ");
  strings.work_summary = [words, words];
  return mockReply(modelReply(docWith(strings)));
}

describe("full local chain with the real STT worker", { skip: READY ? false : "set STT_MODEL_DIR and E2E_AUDIO_DIR to run" }, () => {
  let lines: any[] = [];
  let dir: string, base: string, ogg: Record<string, Buffer> = {};
  let graph: MockGraph, store: Store, server: ReturnType<typeof createApp>, stt: PythonSttWorker, outbox: OutboxRunner;
  let pending: Promise<unknown> = Promise.resolve();
  let seq = 0;
  const timings: Record<string, Record<string, number>> = {};

  const post = async (body: unknown) => {
    const raw = JSON.stringify(body);
    const res = await fetch(base, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": sign(raw, SECRET) }, body: raw });
    await pending;
    return res;
  };
  const env = (msg: object) => ({ object: "whatsapp_business_account", entry: [{ id: "1", changes: [{ field: "messages", value: { messages: [msg] } }] }] });
  const voice = (rec: string) => {
    const id = String(9000 + ++seq);
    graph.media.set(id, ogg[rec]!);
    return env({ id: `wamid.E2EV${seq}`, from: TECH, type: "audio", audio: { id, mime_type: "audio/ogg; codecs=opus", voice: true } });
  };
  const click = (id: string, ctx: string) => env({ id: `wamid.E2EB${++seq}`, from: TECH, type: "interactive", context: { id: ctx }, interactive: { type: "button_reply", button_reply: { id, title: "x" } } });
  const lastForm = () => { const f = Object.values((store as any).load().forms as Record<string, any>); return f[f.length - 1] as any; };
  const sentId = (formId: string, rev: number) => Object.entries((store as any).load().sent as Record<string, any>).find(([, v]) => v.formId === formId && v.revision === rev)![0];
  const stage = (): Record<string, number> => lines.filter((l) => l.event === "form_sent").pop() ?? {};

  before(async () => {
    registerSecrets(SECRET, TOKEN);
    setSink((l) => lines.push(JSON.parse(l)));
    dir = mkdtempSync(join(tmpdir(), "e2e-full-"));
    mkdirSync(join(dir, "src"), { recursive: true });
    for (const rec of ["HEB-001", "HEB-002", "HEB-003"]) { // dummy research recordings, re-encoded to OGG/Opus like WhatsApp voice notes
      const dst = join(dir, `${rec}.ogg`);
      execFileSync(PYTHON, ["-I", join(API_ROOT, "python", "dev_to_ogg.py"), join(AUDIO_DIR, `${rec}.m4a`), dst]);
      ogg[rec] = readFileSync(dst);
    }
    graph = new MockGraph(TOKEN);
    await graph.start();
    const cfg: Config = {
      port: 0, verifyToken: "v-e2e-token", accessToken: TOKEN, appSecret: SECRET, phoneNumberId: "1", allowedTechnicians: new Set([TECH]), graphVersion: "v23.0", dataDir: dir,
      mediaMaxBytes: 16 * 1024 * 1024, mediaKeepSeconds: 0, graphBaseUrl: graph.baseUrl,
      pipeline: { pythonExe: PYTHON, sttWorkerScript: join(API_ROOT, "python/stt_worker.py"), controlsScript: CONTROLS_SCRIPT, sttModelDir: MODEL_DIR, sttMaxAudioSeconds: 180, sttMaxQueue: 4, sttJobTimeoutMs: 150000, sttStartupTimeoutMs: 180000, extractorMode: "mock", ackEnabled: false, patchTtlMs: 600000 },
    };
    store = new Store(dir);
    const wa = new GraphWhatsApp(cfg);
    stt = new PythonSttWorker({ pythonExe: PYTHON, workerScript: cfg.pipeline!.sttWorkerScript, modelDir: MODEL_DIR, maxQueue: 4, jobTimeoutMs: 150000, startupTimeoutMs: 180000, maxAudioSeconds: 180, onEvent: (e, f) => lines.push({ event: e, ...f }) });
    const llm = new MockLlm([]);
    (llm as any).script = Array.from({ length: 12 }, () => transcriptAwareReply);
    outbox = new OutboxRunner({ cfg, store, wa, mockWatermark: false });
    const pipeline = new VoicePipeline({ cfg, store, wa, stt, extractor: new StructuredExtractor(llm, new PythonControls(PYTHON, CONTROLS_SCRIPT), { sleep: async () => {} }), outbox });
    server = createApp({ cfg, store, wa, pipeline, outbox }, (p) => { pending = p; });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/webhook`;
    const t0 = Date.now();
    await stt.warmUp(); // cold start, measured separately
    timings.cold_start = { ms: Date.now() - t0 };
  });
  after(async () => {
    await stt.close(); server.close(); await graph.stop();
    writeFileSync(join(dir, "timings.json"), JSON.stringify(timings, null, 1));
    console.log("E2E_TIMINGS " + JSON.stringify(timings));
  });

  it("voice -> real media download -> real STT -> validation -> saved draft -> outbox -> two signed buttons -> approve -> immutable version", async () => {
    const m0 = graph.interactive.length;
    await post(voice("HEB-001"));
    assert.equal(graph.interactive.length - m0, 1, "exactly one form message submitted to Meta");
    const f = lastForm();
    const msg = graph.interactive[graph.interactive.length - 1];
    assert.deepEqual(msg.interactive.action.buttons.map((b: any) => b.reply.title), ["אשר", "תקן או הוסף"]);
    assert.ok(f.fields.customer_name.shown === "VALUE" && f.fields.customer_address.shown === "VALUE", "name and address were taken from the real transcript");
    assert.deepEqual(readdirSync(join(dir, "tmp-media")), [], "temporary audio removed");
    const s = stage();
    timings.run1_voice_to_form = { audio_s: (s as any).audio_s, stt_ms: (s as any).stt_ms, extraction_ms: (s as any).extraction_ms, validation_ms: (s as any).validation_ms, outbound_ms: (s as any).outbound_ms, total_ms: (s as any).total_ms };
    for (const k of ["t_media_download_completed_ms", "t_stt_started_ms", "t_stt_completed_ms", "t_extraction_started_ms", "t_extraction_completed_ms", "t_validation_completed_ms", "t_draft_saved_ms", "t_outbound_submitted_ms"]) assert.ok(k in s, k);
    // delivery receipt (here simulated by the test; on the live run it is Meta's webhook)
    const wamid = sentId(f.formId, 1);
    await post({ object: "whatsapp_business_account", entry: [{ id: "1", changes: [{ field: "messages", value: { statuses: [{ id: wamid, status: "delivered", timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: TECH }] } }] }] });
    assert.equal(typeof lines.find((l) => l.event === "delivery_status")?.e2e_delivery_ms, "number");
    await post(click(signedButtonId("approve", f.formId, 1, SECRET), wamid));
    const v = store.getVersions(f.formId);
    assert.equal(v.length, 1);
    assert.equal(store.getForm(f.formId)!.status, "approved");
  });

  it("correction: edit -> second real recording -> revision 2 (merge of verified fields) -> approve", async () => {
    await post(voice("HEB-002"));
    const f = lastForm();
    assert.equal(f.revision, 1);
    const ctx1 = sentId(f.formId, 1);
    await post(click(signedButtonId("edit", f.formId, 1, SECRET), ctx1));
    assert.equal(store.getForm(f.formId)!.status, "editing");
    await post(voice("HEB-003"));
    const after = store.getForm(f.formId)!;
    const s = stage();
    timings.run3_correction = { audio_s: (s as any).audio_s, stt_ms: (s as any).stt_ms, total_ms: (s as any).total_ms };
    assert.equal(after.revision, 2, JSON.stringify(lines.filter((l) => l.level && l.level !== "info").map((l) => [l.event, l.code])));
    assert.equal(store.getOutbox(`form:${f.formId}:2`)!.status, "SENT");
    await post(click(signedButtonId("approve", f.formId, 1, SECRET), ctx1)); // old button
    assert.equal(store.getVersions(f.formId).length, 0, "stale revision does not approve");
    await post(click(signedButtonId("approve", f.formId, 2, SECRET), sentId(f.formId, 2)));
    assert.equal(store.getVersions(f.formId).length, 1);
  });
});
