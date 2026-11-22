// INBOUND_MEDIA_ONLY: a real-looking voice message is downloaded and the job stops before STT. All mocks: FakeWA / MockStt / MockLlm.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { loadConfig, parseInboundMediaOnly, type Config } from "../config.ts";
import { registerSecrets, setSink } from "../logger.ts";
import { buildDeps, createApp } from "../server.ts";
import { sign } from "../signature.ts";
import { Store } from "../store.ts";
import { PythonControls } from "./controls.ts";
import { StructuredExtractor } from "./extractor.ts";
import { MockLlm, mockReply } from "./llm.ts";
import { OutboxRunner } from "./outbox.ts";
import { VoicePipeline, sniffAudioContainer } from "./pipeline.ts";
import { MockStt } from "./stt.ts";
import { CONTROLS_SCRIPT, FakeWA, PYTHON, TRANSCRIPT, fixtureDoc, modelReply } from "./testkit.ts";

const TECH = "15550001111";
const OTHER = "15550002222";
const SECRET = "mediaonly-test-app-secret";
const TOKEN = "mediaonly-test-access-token";
const WHATSAPP_ENV = { WHATSAPP_VERIFY_TOKEN: "v-token", WHATSAPP_ACCESS_TOKEN: TOKEN, WHATSAPP_APP_SECRET: SECRET, WHATSAPP_PHONE_NUMBER_ID: "1" };

class CountingWA extends FakeWA {
  fetches = 0;
  override async fetchMedia(id: string) { this.fetches++; return super.fetchMedia(id); }
}

describe("INBOUND_MEDIA_ONLY configuration", () => {
  it("defaults to false; only the exact value true enables it", () => {
    assert.equal(parseInboundMediaOnly({}), false);
    for (const v of ["", "false", "TRUE", "True", "1", "yes", " true"]) assert.equal(parseInboundMediaOnly({ INBOUND_MEDIA_ONLY: v }), false, v);
    assert.equal(parseInboundMediaOnly({ INBOUND_MEDIA_ONLY: "true" }), true);
    assert.equal(loadConfig({ ...WHATSAPP_ENV }).inboundMediaOnly, false);
  });
  it("media-only forces outbound OFF even when OUTBOUND_ENABLED=true; default mode is unchanged", () => {
    assert.equal(loadConfig({ ...WHATSAPP_ENV, OUTBOUND_ENABLED: "true", INBOUND_MEDIA_ONLY: "true" }).outboundEnabled, false);
    assert.equal(loadConfig({ ...WHATSAPP_ENV, OUTBOUND_ENABLED: "true" }).outboundEnabled, true);
    assert.equal(loadConfig({ ...WHATSAPP_ENV, OUTBOUND_ENABLED: "true", INBOUND_MEDIA_ONLY: "false" }).outboundEnabled, true);
  });
});

describe("sniffAudioContainer", () => {
  it("recognises containers from magic bytes only", () => {
    assert.equal(sniffAudioContainer(Buffer.from("OggS\0\0\0\0")), "ogg");
    assert.equal(sniffAudioContainer(Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from("ftypM4A ")])), "mp4/m4a");
    assert.equal(sniffAudioContainer(Buffer.from("RIFF\0\0\0\0WAVEfmt ")), "wav");
    assert.equal(sniffAudioContainer(Buffer.from([0xff, 0xfb, 0x90, 0x00])), "mp3");
    assert.equal(sniffAudioContainer(Buffer.from("zzzz")), "unknown");
    assert.equal(sniffAudioContainer(Buffer.alloc(0)), "unknown");
  });
});

let lines: string[] = [];
let dir: string;
let cfg: Config;
let store: Store;
let wa: CountingWA;
let stt: MockStt;
let llm: MockLlm;
let pipeline: VoicePipeline;
let outbox: OutboxRunner;
let base: string;
let server: ReturnType<typeof createApp>;
let pending: Promise<unknown> = Promise.resolve();
let n = 0;
const logs = () => lines.map((l) => JSON.parse(l));
const events = () => logs().map((l) => l.event);

function makeCfg(over: Partial<Config>): Config {
  return {
    port: 0, outboundEnabled: false, verifyToken: "v-token-mo", accessToken: TOKEN, appSecret: SECRET, phoneNumberId: "1", allowedTechnicians: new Set([TECH]),
    graphVersion: "v23.0", dataDir: dir, mediaMaxBytes: 1024 * 1024, mediaKeepSeconds: 0,
    pipeline: { pythonExe: PYTHON, sttWorkerScript: "", controlsScript: CONTROLS_SCRIPT, sttModelDir: "C:\\x", sttMaxAudioSeconds: 60, sttMaxQueue: 2, sttJobTimeoutMs: 5000, sttStartupTimeoutMs: 5000, extractorMode: "mock", ackEnabled: true, patchTtlMs: 600000 },
    ...over,
  };
}

async function start(over: Partial<Config>) {
  dir = mkdtempSync(join(tmpdir(), "mo-"));
  cfg = makeCfg(over);
  store = new Store(dir);
  wa = new CountingWA();
  stt = new MockStt(async () => ({ text: TRANSCRIPT, audioDurationS: 5, decodeS: 0.01, transcribeS: 0.1 }));
  llm = new MockLlm([mockReply(modelReply(fixtureDoc("V-X01")))]);
  const extractor = new StructuredExtractor(llm, new PythonControls(PYTHON, CONTROLS_SCRIPT), { sleep: async () => {}, jitter: () => 0 });
  outbox = new OutboxRunner({ cfg, store, wa, mockWatermark: false });
  pipeline = new VoicePipeline({ cfg, store, wa, stt, extractor, outbox });
  server = createApp({ cfg, store, wa, pipeline, outbox }, (p) => { pending = p; });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/webhook`;
}

const envelope = (msg: object) => ({ object: "whatsapp_business_account", entry: [{ id: "1", changes: [{ field: "messages", value: { messages: [msg] } }] }] });
async function post(body: unknown) {
  const raw = JSON.stringify(body);
  const res = await fetch(base, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": sign(raw, SECRET) }, body: raw });
  await pending;
  pending = Promise.resolve();
  return res;
}
function voice(from = TECH, wamid = `wamid.MO${++n}`, register = true) {
  const media = String(3000 + n);
  if (register) wa.media.set(media, Buffer.concat([Buffer.from("OggS"), Buffer.alloc(100)]));
  return { wamid, body: envelope({ id: wamid, from, type: "audio", audio: { id: media, mime_type: "audio/ogg; codecs=opus", voice: true } }) };
}
const tmpFiles = () => (existsSync(join(dir, "tmp-media")) ? readdirSync(join(dir, "tmp-media")) : []);

describe("media-only mode: stops right after the media download", () => {
  before(async () => {
    registerSecrets(SECRET, TOKEN);
    setSink((l) => lines.push(l));
    // outbound deliberately ENABLED in this config: media-only must still send nothing (defense in depth inside the pipeline)
    await start({ inboundMediaOnly: true, outboundEnabled: true });
  });
  after(() => server.close());
  beforeEach(() => { lines = []; wa.texts = []; wa.forms = []; wa.fetches = 0; stt.calls = 0; llm.requests.length = 0; });

  it("downloads, logs the distinct events in order, and stops before STT / extractor / form / outbound", async () => {
    const { wamid, body } = voice();
    assert.equal((await post(body)).status, 200);
    const ev = events();
    const order = ["webhook_post_received", "webhook_signature_ok", "webhook_parsed", "sender_allowed", "media_download_succeeded", "media_only_stopped_before_stt"];
    let at = -1;
    for (const e of order) { const i = ev.indexOf(e, at + 1); assert.ok(i > at, `${e} logged after the previous step`); at = i; }
    assert.equal(logs().find((l) => l.event === "webhook_parsed").audio, 1);
    const dl = logs().find((l) => l.event === "media_download_succeeded");
    assert.equal(typeof dl.media_download_ms, "number");
    assert.equal(dl.container, "ogg");
    assert.equal(dl.mime, "audio/ogg; codecs=opus");
    assert.equal(dl.size, 104);
    assert.equal(dl.voice, true);
    assert.equal(wa.fetches, 1);
    assert.equal(stt.calls, 0, "STT never started");
    assert.equal(llm.requests.length, 0, "extractor / Claude never reached");
    assert.deepEqual(store.listForms(), [], "no form saved");
    assert.deepEqual(store.outboxAll(), [], "no outbox entry");
    assert.deepEqual(wa.texts, [], "no ACK or notice");
    assert.deepEqual(wa.forms, [], "no form message");
    assert.deepEqual(tmpFiles(), [], "no audio file on disk");
    assert.ok(!events().some((e) => ["stt_failed", "pipeline_failed", "extraction_failed", "form_saved_outbound_disabled", "form_sent", "ack_failed"].includes(e)));
    // receipt is terminal and not a failure; nothing dangerous remains for a restart
    const r = store.getReceipt(wamid)!;
    assert.equal(r.status, "MEDIA_ONLY");
    assert.equal(r.failure, undefined);
    assert.equal(r.processingCompletedAt, undefined);
    assert.deepEqual(store.recoverReceipts(), [], "restart recovery finds nothing in PROCESSING");
    const rec = pipeline.recoverAfterRestart();
    assert.equal(rec.receipts, 0);
    assert.deepEqual(store.outboxAll(), [], "no 'please resend' notice is queued");
  });

  it("logs contain no signed URL, token, secret, number or transcript", async () => {
    const v = voice(TECH, "wamid.HBgLMTU1NTUwMDAxMTExFQIAEhggQTc5NzY0RjE3REEyM0Q2MzFEMwA="); // realistic length: the logger shortens it
    await post(v.body);
    const all = lines.join("\n");
    for (const bad of [TOKEN, SECRET, TECH, "http", v.wamid, TRANSCRIPT.slice(0, 12)]) assert.ok(!all.includes(bad), `log must not contain ${bad}`);
  });

  it("a redelivery of the same message is a duplicate: no second download, no reprocessing", async () => {
    const { body } = voice();
    await post(body);
    await post(body);
    assert.equal(wa.fetches, 1);
    assert.equal(logs().filter((l) => l.event === "duplicate_ignored").length, 1);
    assert.equal(logs().filter((l) => l.event === "media_only_stopped_before_stt").length, 1);
  });

  it("an unauthorized sender is rejected before any download", async () => {
    await post(voice(OTHER).body);
    assert.equal(wa.fetches, 0);
    assert.ok(events().includes("unauthorized_sender"));
    assert.ok(!events().includes("sender_allowed") && !events().includes("media_download_succeeded"));
  });

  it("a failed download is reported as before (receipt FAILED), still without STT or sends", async () => {
    const { wamid, body } = voice(TECH, undefined, false); // media id unknown to the mock Graph -> download error
    await post(body);
    assert.equal(store.getReceipt(wamid)!.status, "FAILED");
    assert.ok(events().includes("pipeline_failed"));
    assert.ok(!events().includes("media_download_succeeded"));
    assert.equal(stt.calls, 0);
    assert.deepEqual(wa.texts, []);
  });
});

describe("default mode (INBOUND_MEDIA_ONLY unset/false) is unchanged", () => {
  for (const flag of [undefined, false] as const) {
    it(`flag ${String(flag)}: STT runs, the form is saved, no media-only logs`, async () => {
      registerSecrets(SECRET, TOKEN);
      setSink((l) => lines.push(l));
      lines = [];
      await start(flag === undefined ? { outboundEnabled: false } : { outboundEnabled: false, inboundMediaOnly: false });
      try {
        const { wamid, body } = voice();
        await post(body);
        assert.equal(stt.calls, 1);
        assert.equal(llm.requests.length, 1);
        assert.equal(store.listForms().length, 1);
        assert.ok(["REVIEW_READY", "NEEDS_INFO"].includes(store.getReceipt(wamid)!.status));
        assert.ok(!events().some((e) => ["media_download_succeeded", "media_only_stopped_before_stt", "sender_allowed"].includes(e)));
        assert.deepEqual(tmpFiles(), []);
      } finally {
        server.close();
      }
    });
  }
});

describe("buildDeps in media-only mode", () => {
  it("builds no Claude extractor (even with EXTRACTOR_MODE=real and a closed gate) and never starts the STT worker", () => {
    const d = mkdtempSync(join(tmpdir(), "mo-deps-"));
    const out: string[] = [];
    setSink((l) => out.push(l));
    const c = makeCfg({ dataDir: d, inboundMediaOnly: true, outboundEnabled: false, pipeline: { ...makeCfg({}).pipeline!, extractorMode: "real" } });
    const deps = buildDeps(c, {}); // empty env: the live gate is closed; normal mode would throw LIVE_GATE_CLOSED here
    deps.outbox!.stop();
    const names = out.map((l) => JSON.parse(l).event);
    assert.ok(names.includes("pipeline_configured"));
    assert.equal(JSON.parse(out.find((l) => JSON.parse(l).event === "pipeline_configured")!).live_calls_enabled, false);
    assert.ok(!names.includes("stt_worker_ready") && !names.includes("stt_warmup_failed"));
    assert.equal(JSON.parse(out.find((l) => JSON.parse(l).event === "outbound_mode")!).inbound_media_only, true);
    assert.throws(() => buildDeps(makeCfg({ dataDir: d, pipeline: { ...makeCfg({}).pipeline!, extractorMode: "real" } }), {}), /LIVE_GATE_CLOSED/, "normal mode still refuses to start with a closed gate");
  });
});
