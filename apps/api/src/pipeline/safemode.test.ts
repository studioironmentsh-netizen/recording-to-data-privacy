// SPK-META-02: safe test mode (OUTBOUND_ENABLED), processing-time metadata and the read-only local inspector.
// Everything here is local: FakeWA / MockStt / MockLlm / a fake fetch. No Meta, Anthropic or STT service is contacted.
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { existsSync, mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { loadConfig, loadLocalInspect, parseOutboundEnabled, type Config } from "../config.ts";
import { signedButtonId } from "../forms.ts";
import { createInspector } from "../inspect.ts";
import { registerSecrets, setSink } from "../logger.ts";
import { createApp } from "../server.ts";
import { sign } from "../signature.ts";
import { Store, type Form, type OutboxEntry } from "../store.ts";
import { GraphWhatsApp, OutboundDisabledError } from "../whatsapp.ts";
import { PythonControls } from "./controls.ts";
import { StructuredExtractor } from "./extractor.ts";
import { MockLlm, mockReply } from "./llm.ts";
import { OutboxRunner } from "./outbox.ts";
import { VoicePipeline } from "./pipeline.ts";
import { MockStt, SttError } from "./stt.ts";
import { techKey } from "./techkey.ts";
import { CONTROLS_SCRIPT, FakeWA, PYTHON, TRANSCRIPT, fixtureDoc, modelReply } from "./testkit.ts";

const TECH = "15550001111";
const SECRET = "safemode-test-app-secret";
const TOKEN = "safemode-test-access-token";
const WHATSAPP_ENV = { WHATSAPP_VERIFY_TOKEN: "v-token", WHATSAPP_ACCESS_TOKEN: TOKEN, WHATSAPP_APP_SECRET: SECRET, WHATSAPP_PHONE_NUMBER_ID: "1" };

// ------------------------------------------------------------------ configuration (fail-closed)

describe("OUTBOUND_ENABLED parsing", () => {
  it("is OFF when absent, empty, invalid or merely truthy-looking; ON only for the exact value true", () => {
    assert.equal(parseOutboundEnabled({}), false);
    for (const v of ["", "false", "FALSE", "True", "TRUE", "1", "yes", "on", " true", "true ", "enabled", "null", "undefined"]) {
      assert.equal(parseOutboundEnabled({ OUTBOUND_ENABLED: v }), false, `value ${JSON.stringify(v)} must not enable outbound`);
    }
    assert.equal(parseOutboundEnabled({ OUTBOUND_ENABLED: "true" }), true);
  });
  it("loadConfig carries the same decision", () => {
    assert.equal(loadConfig({ ...WHATSAPP_ENV }).outboundEnabled, false);
    assert.equal(loadConfig({ ...WHATSAPP_ENV, OUTBOUND_ENABLED: "false" }).outboundEnabled, false);
    assert.equal(loadConfig({ ...WHATSAPP_ENV, OUTBOUND_ENABLED: "banana" }).outboundEnabled, false);
    assert.equal(loadConfig({ ...WHATSAPP_ENV, OUTBOUND_ENABLED: "true" }).outboundEnabled, true);
  });
});

describe("LOCAL_INSPECT configuration", () => {
  it("is disabled by default and for any non-true value", () => {
    assert.equal(loadLocalInspect({}, 3000), undefined);
    assert.equal(loadLocalInspect({ LOCAL_INSPECT_ENABLED: "1" }, 3000), undefined);
    assert.equal(loadConfig({ ...WHATSAPP_ENV }).localInspect, undefined);
  });
  it("uses its own port, never the (tunnelled) webhook port, and rejects invalid ports", () => {
    assert.deepEqual(loadLocalInspect({ LOCAL_INSPECT_ENABLED: "true" }, 3000), { port: 3001 });
    assert.deepEqual(loadLocalInspect({ LOCAL_INSPECT_ENABLED: "true", LOCAL_INSPECT_PORT: "4100" }, 3000), { port: 4100 });
    assert.throws(() => loadLocalInspect({ LOCAL_INSPECT_ENABLED: "true", LOCAL_INSPECT_PORT: "3000" }, 3000));
    assert.throws(() => loadLocalInspect({ LOCAL_INSPECT_ENABLED: "true", LOCAL_INSPECT_PORT: "abc" }, 3000));
    assert.throws(() => loadLocalInspect({ LOCAL_INSPECT_ENABLED: "true", LOCAL_INSPECT_PORT: "70000" }, 3000));
  });
});

// ------------------------------------------------------------------ the Graph adapter is the lowest boundary

describe("GraphWhatsApp outbound boundary", () => {
  const baseCfg = (outboundEnabled: boolean): Config => ({
    port: 0, outboundEnabled, verifyToken: "v", accessToken: TOKEN, appSecret: SECRET, phoneNumberId: "1", allowedTechnicians: new Set([TECH]),
    graphVersion: "v23.0", dataDir: tmpdir(), mediaMaxBytes: 1024, mediaKeepSeconds: 0,
  });
  const fakeFetch = () => {
    const calls: string[] = [];
    const f = (async (url: any) => {
      calls.push(String(url));
      if (String(url).endsWith("/messages")) return new Response(JSON.stringify({ messages: [{ id: "wamid.X" }] }), { status: 200 });
      if (String(url).includes("/777")) return new Response(JSON.stringify({ url: "https://media.example/f", mime_type: "audio/ogg" }), { status: 200 });
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    }) as typeof fetch;
    return { f, calls };
  };
  it("disabled: every send rejects with OutboundDisabledError BEFORE any network call; media download still works", async () => {
    const { f, calls } = fakeFetch();
    const g = new GraphWhatsApp(baseCfg(false), f);
    await assert.rejects(g.sendText(TECH, "x"), OutboundDisabledError);
    await assert.rejects(g.sendForm(TECH, "F1", 1), OutboundDisabledError);
    await assert.rejects(g.sendFormButtons(TECH, "x", "F1", 1), OutboundDisabledError);
    await assert.rejects(g.sendFormMessage(TECH, "x".repeat(2000), "F1", 1), OutboundDisabledError);
    assert.equal(calls.length, 0, "no request of any kind was made");
    const media = await g.fetchMedia("777"); // inbound download is not outbound messaging
    assert.equal(media.bytes.length, 3);
    assert.ok(calls.every((c) => !c.endsWith("/messages")));
  });
  it("enabled (mock fetch only): sends reach the transport", async () => {
    const { f, calls } = fakeFetch();
    await new GraphWhatsApp(baseCfg(true), f).sendText(TECH, "x");
    assert.equal(calls.filter((c) => c.endsWith("/messages")).length, 1);
  });
});

// ------------------------------------------------------------------ full pipeline with outbound disabled

let lines: string[] = [];
let dir: string;
let store: Store;
let wa: FakeWA;
let stt: MockStt;
let llm: MockLlm;
let outbox: OutboxRunner;
let pipeline: VoicePipeline;
let cfg: Config;
let base: string;
let server: ReturnType<typeof createApp>;
let pending: Promise<unknown> = Promise.resolve();
let sttText = TRANSCRIPT;
let sttFail: SttError | null = null;
let n = 0;
const logs = () => lines.map((l) => JSON.parse(l));

before(async () => {
  registerSecrets(SECRET, TOKEN);
  setSink((l) => lines.push(l));
  dir = mkdtempSync(join(tmpdir(), "safe-"));
  cfg = {
    port: 0, outboundEnabled: false, verifyToken: "v-token-safe", accessToken: TOKEN, appSecret: SECRET, phoneNumberId: "1", allowedTechnicians: new Set([TECH]),
    graphVersion: "v23.0", dataDir: dir, mediaMaxBytes: 1024 * 1024, mediaKeepSeconds: 0,
    pipeline: { pythonExe: PYTHON, sttWorkerScript: "", controlsScript: CONTROLS_SCRIPT, sttModelDir: "C:\\x", sttMaxAudioSeconds: 60, sttMaxQueue: 2, sttJobTimeoutMs: 5000, sttStartupTimeoutMs: 5000, extractorMode: "mock", ackEnabled: true, patchTtlMs: 600000 },
  };
  store = new Store(dir);
  wa = new FakeWA();
  stt = new MockStt(async (p) => {
    assert.ok(existsSync(p));
    if (sttFail) throw sttFail;
    return { text: sttText, audioDurationS: 12, decodeS: 0.05, transcribeS: 0.5 };
  });
  llm = new MockLlm([]);
  const extractor = new StructuredExtractor(llm, new PythonControls(PYTHON, CONTROLS_SCRIPT), { sleep: async () => {}, jitter: () => 0 });
  outbox = new OutboxRunner({ cfg, store, wa, mockWatermark: false });
  pipeline = new VoicePipeline({ cfg, store, wa, stt, extractor, outbox });
  server = createApp({ cfg, store, wa, pipeline, outbox }, (p) => { pending = p; });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());
beforeEach(() => { lines = []; wa.texts = []; wa.forms = []; sttText = TRANSCRIPT; sttFail = null; });

const envelope = (msg: object) => ({ object: "whatsapp_business_account", entry: [{ id: "1", changes: [{ field: "messages", value: { messages: [msg] } }] }] });
async function post(body: unknown) {
  const raw = JSON.stringify(body);
  const res = await fetch(`${base}/webhook`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": sign(raw, SECRET) }, body: raw });
  await pending;
  pending = Promise.resolve();
  return res;
}
function voice(wamid = `wamid.SAFE${++n}`) {
  const media = String(2000 + n);
  wa.media.set(media, Buffer.from("OggS-synthetic-audio-bytes"));
  return { wamid, body: envelope({ id: wamid, from: TECH, type: "audio", audio: { id: media, mime_type: "audio/ogg; codecs=opus", voice: true } }) };
}
const nothingSent = () => { assert.deepEqual(wa.texts, [], "no text message"); assert.deepEqual(wa.forms, [], "no form message"); };

describe("outbound disabled: the pipeline runs and saves, nothing is sent", () => {
  it("voice -> form saved; ACK, form, retries and timers never happen; the outbox entry is preserved unsent", async () => {
    (llm as any).script = [mockReply(modelReply(fixtureDoc("V-X01")))];
    const { wamid, body } = voice();
    await post(body);
    nothingSent();
    const forms = store.listForms();
    assert.equal(forms.length, 1);
    const f = forms[0]!;
    assert.equal(f.fields!.customer_name!.shown, "VALUE");
    const o = store.getOutbox(`form:${f.formId}:1`)!;
    assert.equal(o.status, "PENDING", "saved and scheduled, never delivered");
    assert.equal(o.attempts, 0);
    assert.ok(["REVIEW_READY", "NEEDS_INFO"].includes(store.getReceipt(wamid)!.status), "receipt shows a saved draft (NEEDS_INFO when some fields are flagged)");
    assert.ok(logs().some((l) => l.event === "form_saved_outbound_disabled"));
    assert.ok(!logs().some((l) => ["form_sent", "ack_failed", "outbox_retry_scheduled", "failure_notice_not_sent"].includes(l.event)));
    // timers and later drains stay inert
    outbox.start();
    assert.equal((outbox as any).timer, null, "no retry timer is created");
    await outbox.drain();
    nothingSent();
    assert.equal(store.getOutbox(`form:${f.formId}:1`)!.status, "PENDING");
    assert.equal(store.getOutbox(`form:${f.formId}:1`)!.attempts, 0);
  });

  it("failure notices are suppressed too: STT failure, no business content, extraction disabled", async () => {
    sttFail = new SttError("STT_FAILED");
    const a = voice();
    await post(a.body);
    assert.equal(store.getReceipt(a.wamid)!.status, "FAILED");
    assert.equal(store.getReceipt(a.wamid)!.processingCompletedAt, undefined, "failed processing is not recorded as completed");
    nothingSent();
    sttFail = null;
    sttText = "שלום";
    const b = voice();
    await post(b.body);
    assert.equal(store.getReceipt(b.wamid)!.failure, "NO_CONTENT");
    nothingSent();
    const off = new VoicePipeline({ cfg, store, wa, stt, extractor: null, outbox });
    sttText = TRANSCRIPT;
    const c = voice();
    await off.processVoice({ kind: "audio", messageId: c.wamid, from: TECH, mediaId: String(2000 + n), mime: "audio/ogg", voice: true }, { msg: "c" }, Date.now());
    assert.equal(store.getReceipt(c.wamid)!.failure, "EXTRACTION_DISABLED");
    nothingSent();
  });

  it("button clicks still change state but their confirmation replies are suppressed", async () => {
    (llm as any).script = [mockReply(modelReply(fixtureDoc("V-X01")))];
    await post(voice().body);
    const f = store.listForms().at(-1)!;
    await post(envelope({ id: `wamid.CLK${++n}`, from: TECH, type: "interactive", interactive: { type: "button_reply", button_reply: { id: signedButtonId("approve", f.formId, f.revision, SECRET), title: "x" } } }));
    assert.equal(store.getForm(f.formId)!.status, "approved");
    assert.equal(store.getVersions(f.formId).length, 1);
    nothingSent();
    assert.ok(logs().some((l) => l.event === "outbound_suppressed" && l.what === "button_reply"));
  });

  it("existing queued messages survive; startup recovery enqueues but sends nothing", async () => {
    const queued: OutboxEntry = { key: "text:preexisting", techKey: "tk", kind: "TEXT", text: "old queued", status: "PENDING", attempts: 2, nextAt: 0, createdAt: Date.now() - 1000, lastError: "e" };
    store.enqueueText(queued);
    const stuck: OutboxEntry = { key: "text:stuck", techKey: "tk", kind: "TEXT", text: "stuck", status: "SENDING", attempts: 1, nextAt: 0, createdAt: Date.now() };
    store.enqueueText(stuck);
    store.beginReceipt("wamid.DEAD", "tk", "NEW", Date.now());
    const rec = pipeline.recoverAfterRestart();
    assert.ok(rec.receipts >= 1);
    await outbox.drain();
    outbox.start();
    nothingSent();
    assert.deepEqual(store.getOutbox("text:preexisting"), queued, "pre-existing entry is byte-for-byte unchanged");
    assert.ok(store.getOutbox("text:recover:wamid.DEAD"), "recovery notice was queued durably, not sent");
    assert.equal(store.getOutbox("text:recover:wamid.DEAD")!.status, "PENDING");
    assert.equal((outbox as any).timer, null);
  });

  it("explicit true (mock sender only): the same pipeline sends ACK and the form", async () => {
    const dir2 = mkdtempSync(join(tmpdir(), "safe-on-"));
    const on: Config = { ...cfg, outboundEnabled: true, dataDir: dir2 };
    const s2 = new Store(dir2);
    s2.touchInbound(techKey(TECH), Date.now());
    const wa2 = new FakeWA();
    wa2.media.set("9", Buffer.from("x"));
    const ob = new OutboxRunner({ cfg: on, store: s2, wa: wa2, mockWatermark: false });
    (llm as any).script = [mockReply(modelReply(fixtureDoc("V-X01")))];
    const extractor = new StructuredExtractor(llm, new PythonControls(PYTHON, CONTROLS_SCRIPT), { sleep: async () => {}, jitter: () => 0 });
    const p2 = new VoicePipeline({ cfg: on, store: s2, wa: wa2, stt, extractor, outbox: ob });
    await p2.processVoice({ kind: "audio", messageId: "wamid.ON1", from: TECH, mediaId: "9", mime: "audio/ogg", voice: true }, { msg: "on" }, Date.now());
    assert.ok(wa2.texts.length >= 1, "ACK sent");
    assert.equal(wa2.forms.length, 1, "form sent");
  });
});

// ------------------------------------------------------------------ processing-time metadata

describe("processing time", () => {
  const form = (): Form => ({ formId: "F9001", revision: 1, status: "draft", number: 9001, techId: "tk", captureDate: "22.11.2026", mode: "FULL", flagged: [], fields: { customer_name: { shown: "VALUE", text: "דן לוי" } } });
  const entry = (rev = 1): OutboxEntry => ({ key: `form:F9001:${rev}`, techKey: "tk", kind: "FORM", formId: "F9001", revision: rev, status: "PENDING", attempts: 0, nextAt: 0, createdAt: 0 });

  it("duration = persistence time - webhook receipt time; survives a reload; later updates/approval do not change it", () => {
    const d = mkdtempSync(join(tmpdir(), "time-"));
    const s = new Store(d);
    s.beginReceipt("wamid.T1", "tk", "NEW", 1_000);
    s.saveDraftAndEnqueue(form(), entry(), "wamid.T1", 3_500);
    const r = new Store(d).getReceipt("wamid.T1")!; // fresh instance = reload from disk
    assert.equal(r.receivedAt, 1_000);
    assert.equal(r.processingCompletedAt, 3_500);
    assert.equal(r.processingDurationMs, 2_500);
    assert.equal(r.status, "REVIEW_READY");
    // a later save for the same receipt (e.g. a retry of the transaction) and approval leave the original measurement alone
    s.saveDraftAndEnqueue({ ...form(), revision: 2 }, entry(2), "wamid.T1", 90_000);
    s.setStatus("F9001", "approved");
    const after = new Store(d).getReceipt("wamid.T1")!;
    assert.equal(after.processingCompletedAt, 3_500);
    assert.equal(after.processingDurationMs, 2_500);
  });
  it("a clock that goes backwards never yields a negative duration", () => {
    const s = new Store(mkdtempSync(join(tmpdir(), "time-")));
    s.beginReceipt("wamid.T2", "tk", "NEW", 5_000);
    s.saveDraftAndEnqueue(form(), entry(), "wamid.T2", 4_000);
    assert.equal(s.getReceipt("wamid.T2")!.processingDurationMs, 0);
  });
  it("missing or failed processing has no completion timestamp", () => {
    const s = new Store(mkdtempSync(join(tmpdir(), "time-")));
    s.beginReceipt("wamid.T3", "tk", "NEW", 1_000);
    assert.equal(s.getReceipt("wamid.T3")!.processingCompletedAt, undefined);
    s.finishReceipt("wamid.T3", "FAILED", { failure: "STT_FAILED" });
    const r = s.getReceipt("wamid.T3")!;
    assert.equal(r.status, "FAILED");
    assert.equal(r.processingCompletedAt, undefined);
    assert.equal(r.processingDurationMs, undefined);
  });
  it("a real pipeline run records receipt time and a non-negative duration", async () => {
    (llm as any).script = [mockReply(modelReply(fixtureDoc("V-X01")))];
    const v = voice();
    await post(v.body);
    const r = store.getReceipt(v.wamid)!;
    assert.ok(typeof r.processingCompletedAt === "number" && r.processingCompletedAt >= r.receivedAt);
    assert.equal(r.processingDurationMs, r.processingCompletedAt! - r.receivedAt);
  });
});

// ------------------------------------------------------------------ local inspector

describe("local inspector", () => {
  let istore: Store, iserver: ReturnType<typeof createInspector>, ibase: string, iport: number;
  before(async () => {
    const d = mkdtempSync(join(tmpdir(), "insp-"));
    istore = new Store(d);
    istore.beginReceipt("wamid.RAWID123456", "tk", "NEW", 1_000);
    istore.saveDraftAndEnqueue({ formId: "F9100", revision: 1, status: "draft", number: 9100, techId: "tk", captureDate: "22.11.2026", mode: "PARTIAL", partial: true, flagged: ["visit_price"], fields: { customer_name: { shown: "VALUE", text: "דן לוי", value: "SECRET-INTERNAL-VALUE" }, visit_price: { shown: "UNCLEAR", text: "לתיקון" } } }, { key: "form:F9100:1", techKey: "tk", kind: "FORM", formId: "F9100", revision: 1, status: "PENDING", attempts: 0, nextAt: 0, createdAt: 0 }, "wamid.RAWID123456", 4_000);
    istore.beginReceipt("wamid.FAILED1", "tk", "NEW", 10);
    istore.finishReceipt("wamid.FAILED1", "FAILED", { failure: "STT_FAILED" });
    iserver = createInspector(istore);
    await new Promise<void>((r) => iserver.listen(0, "127.0.0.1", r));
    iport = (iserver.address() as AddressInfo).port;
    ibase = `http://127.0.0.1:${iport}`;
  });
  after(() => iserver.close());

  const raw = (method: string, path: string, headers: Record<string, string> = {}) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port: iport, method, path, headers }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode!, body: b }));
    });
    req.on("error", reject);
    req.end();
  });

  it("lists forms and shows a full, redacted detail view with timing", async () => {
    const list = await (await fetch(`${ibase}/local/forms`)).json() as any;
    assert.equal(list.forms.length, 1);
    assert.equal(list.forms[0].processing_duration_ms, 3_000);
    const res = await fetch(`${ibase}/local/forms/F9100`);
    assert.equal(res.status, 200);
    const text = await res.text();
    const d = JSON.parse(text);
    assert.equal(d.form_id, "F9100");
    assert.equal(d.mode, "PARTIAL");
    assert.deepEqual(d.validation, { partial: true, flagged_fields: ["visit_price"] });
    assert.deepEqual(d.fields.customer_name, { shown: "VALUE", text: "דן לוי" });
    assert.deepEqual(d.fields.visit_price, { shown: "UNCLEAR", text: "לתיקון" }, "uncertain data stays unknown, nothing is invented");
    assert.equal(d.receipts[0].processing_duration_ms, 3_000);
    assert.equal(d.receipts[0].webhook_received_at, new Date(1_000).toISOString());
    assert.equal(d.receipts[0].processing_completed_at, new Date(4_000).toISOString());
    assert.match(d.receipts[0].message_ref, /^[0-9a-f]{12}$/);
    assert.equal(d.transcript, null);
    assert.equal(d.transcript_stored, false);
    assert.deepEqual(d.outbound, { status: "PENDING", attempts: 0 });
    assert.ok(!text.includes("RAWID123456") && !text.includes("wamid."), "raw message id is never returned");
    assert.ok(!text.includes("SECRET-INTERNAL-VALUE"), "internal verified values are not returned, only displayed text");
    assert.ok(!text.includes(TOKEN) && !text.includes(SECRET));
  });
  it("404 for unknown forms and unknown paths; malformed ids never reach the store", async () => {
    assert.equal((await fetch(`${ibase}/local/forms/NOPE`)).status, 404);
    assert.equal((await fetch(`${ibase}/other`)).status, 404);
    assert.equal((await fetch(`${ibase}/local/forms/..%2Fstate.json`)).status, 404);
  });
  it("is read-only: every non-GET method is rejected and nothing changes", async () => {
    const before = JSON.stringify(istore.listForms());
    for (const m of ["POST", "PUT", "PATCH", "DELETE"]) assert.equal((await raw(m, "/local/forms/F9100")).status, 405, m);
    assert.equal(JSON.stringify(istore.listForms()), before);
    assert.equal(istore.getForm("F9100")!.status, "draft");
  });
  it("refuses non-local Host headers and proxied requests", async () => {
    assert.equal((await raw("GET", "/local/forms", { host: "opening-beings.trycloudflare.com" })).status, 403);
    assert.equal((await raw("GET", "/local/forms", { host: `127.0.0.1:${iport}`, "x-forwarded-for": "203.0.113.5" })).status, 403);
    assert.equal((await raw("GET", "/local/forms", { host: `127.0.0.1:${iport}`, "cf-connecting-ip": "203.0.113.5" })).status, 403);
    assert.equal((await raw("GET", "/local/forms", { host: `127.0.0.1:${iport}` })).status, 200);
  });
  it("the webhook listener (the one behind the tunnel) does not serve /local/*", async () => {
    for (const p of ["/local/forms", "/local/forms/F9100"]) {
      assert.equal((await fetch(`${base}${p}`)).status, 404);
      assert.equal((await fetch(`${base}${p}`, { method: "POST", body: "{}" })).status, 404);
    }
  });
  it("shows a pipeline-produced form end to end (mock providers)", async () => {
    (llm as any).script = [mockReply(modelReply(fixtureDoc("V-X01")))];
    await post(voice().body);
    const f = store.listForms().at(-1)!;
    const srv = createInspector(store);
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const p = (srv.address() as AddressInfo).port;
    const d = await (await fetch(`http://127.0.0.1:${p}/local/forms/${f.formId}`)).json() as any;
    srv.close();
    assert.equal(d.mock_extraction, true, "labelled as produced by the mock extractor");
    assert.equal(d.fields.customer_name.shown, "VALUE");
    assert.equal(typeof d.receipts[0].processing_duration_ms, "number");
    assert.equal(d.outbound.attempts, 0);
  });
});
