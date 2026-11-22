// Integration tests: REAL webhook server + REAL pipeline/store/outbox/GraphWhatsApp/validator/controls.
// Only the external boundaries are simulated: Meta (MockGraph over HTTP), STT (MockStt, the real worker is covered elsewhere) and Claude (MockLlm).
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import type { Config } from "../config.ts";
import { signedButtonId, encodeButtonId } from "../forms.ts";
import { registerSecrets, setSink } from "../logger.ts";
import { createApp } from "../server.ts";
import { sign } from "../signature.ts";
import { Store } from "../store.ts";
import { GraphWhatsApp } from "../whatsapp.ts";
import { PythonControls } from "./controls.ts";
import { StructuredExtractor } from "./extractor.ts";
import { BudgetLedger, MockLlm, mockReply, budgetCapUsd, LlmError } from "./llm.ts";
import { MockGraph } from "./mockgraph.ts";
import { OutboxRunner, RETRY_SCHEDULE_MS, HOURLY_MS, SERVICE_WINDOW_MS } from "./outbox.ts";
import { VoicePipeline } from "./pipeline.ts";
import { MockStt } from "./stt.ts";
import { techKey } from "./techkey.ts";
import { CONTROLS_SCRIPT, PYTHON, TRANSCRIPT, docWith, fixtureDoc, modelReply } from "./testkit.ts";

const TECH = "15550001111";
const SECRET = "outbox-test-app-secret";
const TOKEN = "outbox-test-access-token";
const KEY = techKey(TECH);

let lines: string[] = [];
let dir: string;
let store: Store;
let graph: MockGraph;
let llm: MockLlm;
let outbox: OutboxRunner;
let pipeline: VoicePipeline;
let base: string;
let server: ReturnType<typeof createApp>;
let pending: Promise<unknown> = Promise.resolve();
const clock = { offset: 0, get t() { return Date.now() + this.offset; }, set t(v: number) { this.offset = v - Date.now(); } }; // real time + adjustable shift
let sttText = TRANSCRIPT;
let n = 0;
let patchTtlMs = 600000;
let cfg: Config;

const logs = () => lines.map((l) => JSON.parse(l));
const envelope = (msg: object) => ({ object: "whatsapp_business_account", entry: [{ id: "1", changes: [{ field: "messages", value: { messages: [msg] } }] }] });
const statuses = (st: object[]) => ({ object: "whatsapp_business_account", entry: [{ id: "1", changes: [{ field: "messages", value: { statuses: st } }] }] });
async function post(body: unknown) {
  const raw = JSON.stringify(body);
  const res = await fetch(base, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": sign(raw, SECRET) }, body: raw });
  await pending;
  pending = Promise.resolve();
  return res;
}
function voice(from = TECH) {
  const id = String(5000 + ++n);
  graph.media.set(id, Buffer.from("OggS-synthetic"));
  return envelope({ id: `wamid.IV${n}`, from, type: "audio", audio: { id, mime_type: "audio/ogg; codecs=opus", voice: true } });
}
const text = (from = TECH) => envelope({ id: `wamid.IT${++n}`, from, type: "text", text: { body: "x" } });
const click = (id: string, ctx?: string, wamid = `wamid.IB${++n}`) =>
  envelope({ id: wamid, from: TECH, type: "interactive", context: ctx ? { id: ctx } : undefined, interactive: { type: "button_reply", button_reply: { id, title: "x" } } });
const stateSent = (formId: string, rev = 1) => Object.entries((store as any).load().sent as Record<string, any>).find(([, v]) => v.formId === formId && v.revision === rev)?.[0];
const setReply = (doc: any) => { (llm as any).script = [mockReply(modelReply(doc))]; };
const tmpFiles = () => (existsSync(join(dir, "tmp-media")) ? readdirSync(join(dir, "tmp-media")) : []);
async function newForm(doc: any = fixtureDoc("V-X01"), transcript = TRANSCRIPT) {
  sttText = transcript;
  setReply(doc);
  await post(voice());
  const forms = Object.values((store as any).load().forms as Record<string, any>);
  return forms[forms.length - 1] as any;
}

before(async () => {
  registerSecrets(SECRET, TOKEN);
  setSink((l) => lines.push(l));
  dir = mkdtempSync(join(tmpdir(), "outbox-"));
  graph = new MockGraph(TOKEN);
  await graph.start();
  cfg = {
    port: 0, verifyToken: "v-token-outbox", accessToken: TOKEN, appSecret: SECRET, phoneNumberId: "1", allowedTechnicians: new Set([TECH]), graphVersion: "v23.0", dataDir: dir,
    mediaMaxBytes: 1024 * 1024, mediaKeepSeconds: 0, outboundEnabled: true, graphBaseUrl: graph.baseUrl,
    pipeline: { pythonExe: PYTHON, sttWorkerScript: "", controlsScript: CONTROLS_SCRIPT, sttModelDir: "C:\\x", sttMaxAudioSeconds: 60, sttMaxQueue: 2, sttJobTimeoutMs: 5000, sttStartupTimeoutMs: 5000, extractorMode: "mock", ackEnabled: false, get patchTtlMs() { return patchTtlMs; } } as any,
  };
  store = new Store(dir);
  const wa = new GraphWhatsApp(cfg); // the REAL adapter, over HTTP to the mock Meta boundary
  const stt = new MockStt(async () => ({ text: sttText, audioDurationS: 10, decodeS: 0.01, transcribeS: 0.1 }));
  llm = new MockLlm([]);
  const extractor = new StructuredExtractor(llm, new PythonControls(PYTHON, CONTROLS_SCRIPT), { sleep: async () => {}, jitter: () => 0 });
  outbox = new OutboxRunner({ cfg, store, wa, now: () => clock.t, mockWatermark: false });
  pipeline = new VoicePipeline({ cfg, store, wa, stt, extractor, outbox });
  server = createApp({ cfg, store, wa, pipeline, outbox }, (p) => { pending = p; });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/webhook`;
});
after(async () => { server.close(); await graph.stop(); });
beforeEach(() => {
  lines = []; sttText = TRANSCRIPT; graph.failures = []; graph.skip = 0; patchTtlMs = 600000; clock.offset = 0;
  for (const e of store.outboxAll()) if (e.status === "PENDING" || e.status === "WINDOW_CLOSED" || e.status === "SENDING") store.updateOutbox(e.key, { status: "DROPPED" }); // tests are independent
  store.touchInbound(KEY, Date.now());
  store.clearPatchTarget(KEY);
});

describe("inbound -> form -> outbound through the real adapter (mock Meta over HTTP)", () => {
  it("downloads media with the two-step Graph flow, saves one draft, delivers it once with two signed buttons", async () => {
    const m0 = graph.interactive.length;
    const f = await newForm(docWith({ customer_name: ["דן לוי", "דן לוי"], customer_phone: ["0521234567", "0521234567"], work_summary: ["בדיקה", "בדיקה"] }), "דן לוי טלפון 0521234567 בדיקה");
    assert.equal(graph.interactive.length - m0, 1);
    const msg = graph.interactive[graph.interactive.length - 1];
    assert.equal(msg.to, TECH);
    assert.deepEqual(msg.interactive.action.buttons.map((b: any) => b.reply.title), ["אשר", "תקן או הוסף"]);
    assert.deepEqual(msg.interactive.action.buttons.map((b: any) => b.reply.id), [signedButtonId("approve", f.formId, 1, SECRET), signedButtonId("edit", f.formId, 1, SECRET)]);
    assert.match(msg.interactive.body.text, /דן לוי/);
    const ob = store.getOutbox(`form:${f.formId}:1`)!;
    assert.equal(ob.status, "SENT");
    assert.equal(f.mode, "FULL");
    assert.deepEqual(f.flagged, []);
    const r = store.getReceipt(`wamid.IV${n}`)!;
    assert.equal(r.status, "REVIEW_READY");
    assert.equal(r.formId, f.formId);
    assert.deepEqual(tmpFiles(), []);
  });

  it("a duplicate webhook delivery creates neither a second visit/draft nor a second message", async () => {
    const f0 = Object.keys((store as any).load().forms).length, m0 = graph.interactive.length;
    sttText = TRANSCRIPT; setReply(fixtureDoc("V-X01"));
    const ev = voice();
    await post(ev); await post(ev);
    assert.equal(Object.keys((store as any).load().forms).length - f0, 1);
    assert.equal(graph.interactive.length - m0, 1);
  });
});

describe("SALV-R15 outbox: draft saved first, safe retry, no duplicates", () => {
  it("a failed send keeps the draft, schedules a retry, and delivers exactly one form after the retry", async () => {
    graph.failures = [{ status: 503 }];
    const m0 = graph.interactive.length;
    const f = await newForm();
    assert.ok(store.getForm(f.formId), "draft saved although the send failed");
    const e = store.getOutbox(`form:${f.formId}:1`)!;
    assert.equal(e.status, "PENDING");
    assert.equal(e.attempts, 1);
    assert.equal(graph.interactive.length, m0);
    assert.equal(logs().find((l) => l.event === "form_saved_delivery_pending")?.outbox, "PENDING");
    await outbox.drain(); // not due yet: nothing happens
    assert.equal(graph.interactive.length, m0);
    clock.t += RETRY_SCHEDULE_MS[0]! + 1000;
    await outbox.drain();
    await outbox.drain(); // idempotent: a second pass sends nothing more
    assert.equal(graph.interactive.length - m0, 1);
    assert.equal(store.getOutbox(`form:${f.formId}:1`)!.status, "SENT");
  });

  it("follows the 1 min / 5 min / 15 min / hourly schedule", async () => {
    graph.failures = [{ status: 500 }, { status: 500 }, { status: 500 }, { status: 500 }];
    const f = await newForm();
    const key = `form:${f.formId}:1`;
    const delays: number[] = [];
    delays.push(store.getOutbox(key)!.nextAt - clock.t);
    for (let i = 0; i < 3; i++) { clock.t = store.getOutbox(key)!.nextAt + 1; await outbox.drain(); delays.push(store.getOutbox(key)!.nextAt - clock.t); }
    assert.deepEqual(delays.map((d) => Math.round(d / 1000)), [60, 300, 900, 3600]);
    assert.equal(HOURLY_MS, 3600000);
    clock.t = store.getOutbox(key)!.nextAt + 1;
    await outbox.drain(); // 5th attempt succeeds
    assert.equal(store.getOutbox(key)!.status, "SENT");
  });

  it("a permanent rejection (4xx) is not retried: EXHAUSTED + operational alert without content; the draft stays", async () => {
    graph.failures = [{ status: 400, code: 100 }];
    const f = await newForm();
    assert.equal(store.getOutbox(`form:${f.formId}:1`)!.status, "EXHAUSTED");
    assert.ok(store.getForm(f.formId));
    const alert = logs().find((l) => l.event === "outbox_exhausted");
    assert.equal(alert?.alert, "OPERATIONAL");
    assert.ok(!lines.join("\n").includes("דן לוי"));
  });

  it("closed service window (Meta 131047): the form waits and is delivered with the technician's next message (M-4)", async () => {
    graph.failures = [{ status: 400, code: 131047 }];
    const m0 = graph.interactive.length;
    const f = await newForm();
    assert.equal(store.getOutbox(`form:${f.formId}:1`)!.status, "WINDOW_CLOSED");
    assert.equal(graph.interactive.length, m0);
    await post(text()); // the technician writes again: window reopens, blocked delivery is released
    for (let i = 0; i < 20 && graph.interactive.length === m0; i++) await new Promise((r) => setTimeout(r, 25));
    assert.equal(graph.interactive.length - m0, 1);
    assert.equal(store.getOutbox(`form:${f.formId}:1`)!.status, "SENT");
  });

  it("no free-form message is attempted when the last inbound message is older than 24 h", async () => {
    const f = await newForm();
    store.updateOutbox(`form:${f.formId}:1`, { status: "PENDING", nextAt: 0, sentWamid: undefined });
    store.touchInbound(KEY, clock.t - SERVICE_WINDOW_MS - 1000);
    const m0 = graph.interactive.length;
    await outbox.drain();
    assert.equal(graph.interactive.length, m0);
    assert.equal(store.getOutbox(`form:${f.formId}:1`)!.status, "WINDOW_CLOSED");
    store.touchInbound(KEY, Date.now());
  });

  it("long forms: the full text is sent once, then the two buttons; a failed buttons message does not repeat the text", async () => {
    const d = docWith({ customer_name: ["דן לוי", "דן לוי"], customer_phone: ["0521234567", "0521234567"] });
    const longText = ("בדיקה ארוכה מאוד של המערכת ").repeat(60).trim();
    const tr = `דן לוי טלפון 0521234567 ${longText}`;
    d.extracted_fields.work_summary = { value: longText, evidence_state: "PRESENT", needs_clarification: false };
    d.field_states.work_summary = { uncertainty_reason: "KNOWN", evidence_quote: longText, summary_items: [{ kind: "ACTION_DONE", text: longText.slice(0, 60) }] };
    const t0 = graph.texts.length, i0 = graph.interactive.length;
    graph.skip = 1; // the text part goes through, the buttons message fails once
    graph.failures = [{ status: 503 }];
    const f = await newForm(d, tr);
    const key = `form:${f.formId}:1`;
    assert.equal(store.getOutbox(key)!.status, "PENDING");
    assert.equal(store.getOutbox(key)!.textPartsSent, true);
    assert.equal(graph.texts.length - t0, 1);
    clock.t += RETRY_SCHEDULE_MS[0]! + 1000;
    await outbox.drain();
    assert.equal(store.getOutbox(key)!.status, "SENT");
    assert.equal(graph.texts.length - t0, 1, "the long text is not sent a second time");
    assert.equal(graph.interactive.length - i0, 1);
    const last = graph.interactive[graph.interactive.length - 1];
    assert.ok(last.interactive.body.text.length <= 1024);
    assert.equal(last.interactive.action.buttons.length, 2);
  });

  it("a newer revision supersedes an undelivered older one (only the latest is ever sent)", () => {
    const s = new Store(mkdtempSync(join(tmpdir(), "sup-")));
    const form = (rev: number): any => ({ formId: "FS1", revision: rev, status: "draft", number: 1, fields: {}, captureDate: "x", mode: "FULL", flagged: [] });
    const entry = (rev: number): any => ({ key: `form:FS1:${rev}`, techKey: KEY, kind: "FORM", formId: "FS1", revision: rev, status: "PENDING", attempts: 0, nextAt: 0, createdAt: rev });
    s.saveDraftAndEnqueue(form(1), entry(1));
    s.saveDraftAndEnqueue(form(2), entry(2));
    s.saveDraftAndEnqueue(form(2), entry(2)); // repeated enqueue with the same key: no second message
    const all = s.outboxAll();
    assert.equal(all.length, 2);
    assert.equal(all.find((e) => e.revision === 1)!.status, "SUPERSEDED");
    assert.equal(all.find((e) => e.revision === 2)!.status, "PENDING");
  });
});

describe("approval: atomic, idempotent, immutable; signed buttons", () => {
  it("two simultaneous approve clicks create exactly one immutable FormVersion", async () => {
    const f = await newForm();
    const id = signedButtonId("approve", f.formId, 1, SECRET);
    const ctx = stateSent(f.formId)!;
    await Promise.all([post(click(id, ctx)), post(click(id, ctx))]);
    const v = store.getVersions(f.formId);
    assert.equal(v.length, 1);
    assert.equal(v[0]!.versionSeq, 1);
    assert.equal(store.getForm(f.formId)!.status, "approved");
    const snapshot = JSON.stringify(v[0]);
    await post(click(signedButtonId("edit", f.formId, 1, SECRET), ctx)); // nothing may change an approved version
    await post(click(id, ctx));
    assert.equal(JSON.stringify(store.getVersions(f.formId)[0]), snapshot);
    assert.equal(store.getVersions(f.formId).length, 1);
  });

  it("an unsigned or forged button id is ignored (no state change)", async () => {
    const f = await newForm();
    const ctx = stateSent(f.formId)!;
    await post(click(encodeButtonId("approve", f.formId, 1), ctx)); // legacy unsigned id on a pipeline form
    await post(click(`ap:${f.formId}:1:000000000000`, ctx)); // right shape, wrong signature
    const other = signedButtonId("approve", "F1", 1, SECRET).replace("F1", f.formId); // signature of another form
    await post(click(other, ctx));
    assert.equal(store.getForm(f.formId)!.status, "draft");
    assert.equal(logs().filter((l) => l.event === "button_bad_signature").length, 3);
  });

  it("approval of a PARTIAL form keeps flagged_fields (names only) in the immutable version", async () => {
    const d = fixtureDoc("V-X01");
    d.extracted_fields.spare_parts.value[0].quantity = 7; // S-FIELD: rejected + marked
    const f = await newForm(d);
    assert.equal(f.mode, "PARTIAL");
    assert.ok(f.flagged.includes("spare_parts"));
    await post(click(signedButtonId("approve", f.formId, 1, SECRET), stateSent(f.formId)));
    const v = store.getVersions(f.formId)[0]!;
    assert.equal(v.mode, "PARTIAL");
    assert.deepEqual(v.flagged, f.flagged);
  });
});

describe("correction flow, context expiry and failures in the middle of a save", () => {
  const nameOnly = () => docWith({ customer_name: ["דן לוי", "דן לוי"], work_summary: ["בדיקה", "בדיקה"] });

  it("edit -> correction message -> revision 2 -> approve saves a version that includes the correction", async () => {
    const f = await newForm(nameOnly(), "דן לוי בדיקה");
    await post(click(signedButtonId("edit", f.formId, 1, SECRET), stateSent(f.formId)));
    sttText = "הטלפון 0521234567";
    setReply(docWith({ customer_phone: ["0521234567", "0521234567"] }));
    await post(voice());
    assert.equal(store.getForm(f.formId)!.revision, 2);
    assert.equal(store.getOutbox(`form:${f.formId}:2`)!.status, "SENT");
    await post(click(signedButtonId("approve", f.formId, 2, SECRET), stateSent(f.formId, 2)));
    const v = store.getVersions(f.formId);
    assert.equal(v.length, 1);
    assert.equal(v[0]!.revision, 2);
    assert.equal(v[0]!.fields.customer_phone!.text, "0521234567");
    assert.equal(v[0]!.fields.customer_name!.text, "דן לוי");
  });

  it("a correction that cannot be parsed keeps the previous revision and the correction context", async () => {
    const f = await newForm(nameOnly(), "דן לוי בדיקה");
    await post(click(signedButtonId("edit", f.formId, 1, SECRET), stateSent(f.formId)));
    const before = JSON.stringify(store.getForm(f.formId)!.fields);
    (llm as any).script = [mockReply("junk"), mockReply("junk"), mockReply("junk")];
    const t0 = graph.texts.length;
    await post(voice());
    assert.equal(store.getForm(f.formId)!.revision, 1);
    assert.equal(JSON.stringify(store.getForm(f.formId)!.fields), before);
    assert.ok(store.getPatchTarget(KEY), "context kept so the technician can resend");
    assert.ok(graph.texts.slice(t0).some((m) => m.text.body.startsWith("לא הצלחתי לעדכן את הטופס")));
  });

  it("an expired correction context: the next recording becomes a NEW form, not a patch", async () => {
    const f = await newForm(nameOnly(), "דן לוי בדיקה");
    patchTtlMs = 20;
    await post(click(signedButtonId("edit", f.formId, 1, SECRET), stateSent(f.formId)));
    await new Promise((r) => setTimeout(r, 60));
    const count = Object.keys((store as any).load().forms).length;
    sttText = "הטלפון 0521234567"; setReply(docWith({ customer_phone: ["0521234567", "0521234567"] }));
    await post(voice());
    assert.equal(Object.keys((store as any).load().forms).length, count + 1, JSON.stringify(logs().map((l) => [l.event, l.code, l.error])));
    assert.equal(store.getForm(f.formId)!.revision, 1);
  });

  it("a failure in the middle of the save commits nothing: no draft, no outbox entry, the technician is told, the next attempt works", async () => {
    const f0 = Object.keys((store as any).load().forms).length, o0 = store.outboxAll().length, m0 = graph.interactive.length;
    const original = store.saveDraftAndEnqueue.bind(store);
    let once = true;
    (store as any).saveDraftAndEnqueue = (...a: any[]) => { if (once) { once = false; throw new Error("disk full"); } return (original as any)(...a); };
    sttText = TRANSCRIPT; setReply(fixtureDoc("V-X01"));
    const t0 = graph.texts.length;
    await post(voice());
    assert.equal(Object.keys((store as any).load().forms).length, f0);
    assert.equal(store.outboxAll().length, o0);
    assert.equal(graph.interactive.length, m0);
    assert.ok(graph.texts.slice(t0).some((m) => m.text.body.startsWith("לא הצלחתי ליצור טופס")));
    assert.equal(store.getReceipt(`wamid.IV${n}`)!.status, "FAILED");
    setReply(fixtureDoc("V-X01"));
    await post(voice());
    assert.equal(graph.interactive.length - m0, 1);
    (store as any).saveDraftAndEnqueue = original;
  });

  it("a failure while editing leaves the earlier revision deliverable and approvable", async () => {
    const f = await newForm();
    await post(click(signedButtonId("edit", f.formId, 1, SECRET), stateSent(f.formId)));
    const original = store.saveDraftAndEnqueue.bind(store);
    (store as any).saveDraftAndEnqueue = () => { throw new Error("boom"); };
    sttText = "הכתובת הדקל 9"; setReply(docWith({ customer_address: ["הדקל 9", "הדקל 9"] }));
    await post(voice());
    (store as any).saveDraftAndEnqueue = original;
    const cur = store.getForm(f.formId)!;
    assert.equal(cur.revision, 1);
    assert.equal(cur.fields!.customer_name!.text, "דן לוי");
  });
});

describe("delivery receipts, ordering and restart recovery", () => {
  it("status webhooks are recorded once; delivery latency is computed; unknown or early statuses are ignored", async () => {
    const f = await newForm();
    const wamid = stateSent(f.formId)!;
    const st = (status: string) => statuses([{ id: wamid, status, timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: TECH }]);
    await post(statuses([{ id: "wamid.UNKNOWN", status: "delivered", timestamp: "1", recipient_id: TECH }]));
    assert.ok(logs().some((l) => l.event === "status_unknown_message"));
    await post(st("sent")); await post(st("delivered")); await post(st("delivered")); await post(st("read"));
    const d = logs().filter((l) => l.event === "delivery_status");
    assert.deepEqual(d.map((x) => x.status), ["sent", "delivered", "read"]);
    const del = d.find((x) => x.status === "delivered");
    assert.equal(typeof del.e2e_delivery_ms, "number");
    assert.equal(typeof del.since_submit_ms, "number");
    assert.ok(store.getSent(wamid)!.deliveredAt);
  });

  it("a stale button (older revision) arriving after a newer revision is rejected without side effects", async () => {
    const f = await newForm(docWith({ customer_name: ["דן לוי", "דן לוי"], work_summary: ["בדיקה", "בדיקה"] }), "דן לוי בדיקה");
    const ctx1 = stateSent(f.formId)!;
    await post(click(signedButtonId("edit", f.formId, 1, SECRET), ctx1));
    sttText = "הטלפון 0521234567"; setReply(docWith({ customer_phone: ["0521234567", "0521234567"] }));
    await post(voice());
    await post(click(signedButtonId("approve", f.formId, 1, SECRET), ctx1));
    assert.ok(logs().some((l) => l.event === "button_stale"));
    assert.equal(store.getVersions(f.formId).length, 0);
  });

  it("restart recovery: dead receipts become a durable 'please resend', stuck sends are retried", async () => {
    store.beginReceipt("wamid.CRASHED", KEY, "NEW", Date.now());
    store.enqueueText({ key: "text:stuck", techKey: KEY, kind: "TEXT", text: "STUCK-MESSAGE", status: "SENDING", attempts: 1, nextAt: 0, createdAt: Date.now() });
    const rec = pipeline.recoverAfterRestart();
    assert.equal(rec.receipts >= 1, true);
    assert.equal(rec.outbox >= 1, true);
    assert.equal(store.getReceipt("wamid.CRASHED")!.status, "FAILED");
    const t0 = graph.texts.length;
    await outbox.drain();
    const bodies = graph.texts.slice(t0).map((m) => m.text.body);
    assert.ok(bodies.includes("STUCK-MESSAGE"));
    assert.ok(bodies.includes("לא הצלחתי ליצור טופס מההקלטה. נא לשלוח שוב."));
    await outbox.drain();
    assert.equal(graph.texts.length - t0, bodies.length, "each recovered message is delivered once");
  });
});

describe("budget: ledger and cap survive key changes", () => {
  it("counters live with the data, not with the key; the effective cap is min($10, configured balance)", () => {
    assert.equal(budgetCapUsd({}), 10);
    assert.equal(budgetCapUsd({ ANTHROPIC_BUDGET_USD: "3.5" }), 3.5);
    assert.equal(budgetCapUsd({ ANTHROPIC_BUDGET_USD: "50" }), 10);
    assert.throws(() => budgetCapUsd({ ANTHROPIC_BUDGET_USD: "abc" }), (e: any) => e instanceof LlmError);
    const d = mkdtempSync(join(tmpdir(), "ledger2-"));
    const a = new BudgetLedger(d, 3.5);
    for (let i = 0; i < 10; i++) { a.reserve(16000); a.settle(16000, 4000, 1500); }
    const b = new BudgetLedger(d, 3.5); // "another key": same ledger directory
    assert.equal(b.snapshot().calls, 10);
    assert.ok(b.snapshot().usd > 0.4 && b.snapshot().usd < 0.5);
    for (let i = 0; i < 9; i++) b.reserve(16000); // 9 * 0.32 = 2.88 + 0.46 < 3.5
    assert.throws(() => b.reserve(16000), (e: any) => e.code === "BUDGET");
  });
});
