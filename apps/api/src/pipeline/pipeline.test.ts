import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import type { Config } from "../config.ts";
import { encodeButtonId } from "../forms.ts";
import { registerSecrets, setSink } from "../logger.ts";
import { createApp } from "../server.ts";
import { sign } from "../signature.ts";
import { Store } from "../store.ts";
import { GraphWhatsApp, sweepTempAudio, writeTempAudio } from "../whatsapp.ts";
import { PythonControls } from "./controls.ts";
import { StructuredExtractor } from "./extractor.ts";
import { MockLlm, mockReply } from "./llm.ts";
import { VoicePipeline } from "./pipeline.ts";
import { MockStt, SttError } from "./stt.ts";
import { CONTROLS_SCRIPT, FakeWA, PYTHON, TRANSCRIPT, docWith, fixtureDoc, modelReply } from "./testkit.ts";

const TECH = "15550001111";
const OTHER = "15550002222";
const SECRET = "pipeline-test-app-secret";
const TOKEN = "pipeline-test-access-token";

let lines: string[] = [];
let dir: string;
let store: Store;
let wa: FakeWA;
let stt: MockStt;
let llm: MockLlm;
let base: string;
let server: ReturnType<typeof createApp>;
let pending: Promise<unknown> = Promise.resolve();
let sttText = TRANSCRIPT;
let sttFail: SttError | null = null;
let n = 0;

const logs = () => lines.map((l) => JSON.parse(l));
const tmpFiles = () => (existsSync(join(dir, "tmp-media")) ? readdirSync(join(dir, "tmp-media")) : []);

before(async () => {
  registerSecrets(SECRET, TOKEN);
  setSink((l) => lines.push(l));
  dir = mkdtempSync(join(tmpdir(), "pipe-"));
  const cfg: Config = {
    port: 0, verifyToken: "v-token-pipeline", accessToken: TOKEN, appSecret: SECRET, phoneNumberId: "1", allowedTechnicians: new Set([TECH, OTHER]),
    graphVersion: "v23.0", dataDir: dir, mediaMaxBytes: 1024 * 1024, mediaKeepSeconds: 0,
    pipeline: { pythonExe: PYTHON, sttWorkerScript: "", controlsScript: CONTROLS_SCRIPT, sttModelDir: "C:\\x", sttMaxAudioSeconds: 60, sttMaxQueue: 2, sttJobTimeoutMs: 5000, sttStartupTimeoutMs: 5000, extractorMode: "mock", ackEnabled: true, patchTtlMs: 600000 },
  };
  store = new Store(dir);
  wa = new FakeWA();
  stt = new MockStt(async (p) => {
    assert.ok(existsSync(p), "audio temp file must exist while STT runs");
    if (sttFail) throw sttFail;
    return { text: sttText, audioDurationS: 12, decodeS: 0.05, transcribeS: 0.5 };
  });
  llm = new MockLlm([]);
  const extractor = new StructuredExtractor(llm, new PythonControls(PYTHON, CONTROLS_SCRIPT), { sleep: async () => {}, jitter: () => 0 });
  const pipeline = new VoicePipeline({ cfg, store, wa, stt, extractor, mockWatermark: false });
  server = createApp({ cfg, store, wa, pipeline }, (p) => { pending = p; });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/webhook`;
});
after(() => server.close());
beforeEach(() => { lines = []; wa.texts = []; wa.forms = []; sttText = TRANSCRIPT; sttFail = null; stt.calls = 0; });

const envelope = (msg: object) => ({ object: "whatsapp_business_account", entry: [{ id: "1", changes: [{ field: "messages", value: { messages: [msg] } }] }] });
async function post(body: unknown) {
  const raw = JSON.stringify(body);
  const res = await fetch(base, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": sign(raw, SECRET) }, body: raw });
  await pending;
  pending = Promise.resolve();
  return res;
}
function voice(from = TECH, wamid = `wamid.V${++n}`) {
  const media = String(1000 + n);
  wa.media.set(media, Buffer.from("OggS-synthetic-audio-bytes"));
  return envelope({ id: wamid, from, type: "audio", audio: { id: media, mime_type: "audio/ogg; codecs=opus", voice: true } });
}
const click = (id: string, ctx?: string, from = TECH, wamid = `wamid.B${++n}`) =>
  envelope({ id: wamid, from, type: "interactive", context: ctx ? { id: ctx } : undefined, interactive: { type: "button_reply", button_reply: { id, title: "x" } } });
const lastForm = () => wa.forms[wa.forms.length - 1]!;
/** wamid of the interactive message that carried the given form revision (as recorded by the pipeline). */
const sentIdFor = (formId: string, revision = 1): string =>
  Object.entries(JSON.parse(readFileSync(join(dir, "state.json"), "utf8")).sent as Record<string, { formId: string; revision: number }>).find(([, v]) => v.formId === formId && v.revision === revision)![0];

describe("local mock E2E: voice -> STT -> Claude(mock) -> form -> two buttons", () => {
  it("sends one form per voice message, cleans temp audio, records timings, and never logs content", async () => {
    (llm as any).script = [mockReply(modelReply(fixtureDoc("V-X01")))];
    await post(voice());
    assert.equal(wa.forms.length, 1);
    const f = lastForm();
    assert.match(f.text, /^טופס #\d+ · דן לוי · \d{2}\.\d{2}\.\d{4} · גרסה 1/);
    assert.match(f.text, /טלפון: 0521234567/);
    assert.equal(f.revision, 1);
    assert.ok(wa.texts.includes("קיבלתי את סיכום הביקור. מכין טופס לבדיקה."), "MSG-01 ack");
    assert.deepEqual(tmpFiles(), [], "temporary audio removed after success");
    const done = logs().find((l) => l.event === "form_sent");
    assert.ok(done);
    for (const k of ["queue_wait_ms", "media_download_ms", "stt_ms", "stt_transcribe_ms", "extraction_ms", "form_build_ms", "whatsapp_send_ms", "total_ms", "ai_calls"]) assert.ok(k in done, `timing field ${k}`);
    assert.equal(done.ai_calls, 1);
    const all = lines.join("\n");
    for (const secret of ["דן לוי", "הדקל", "0521234567", "קבל", TRANSCRIPT.slice(0, 15), TECH, SECRET, TOKEN]) assert.ok(!all.includes(secret), `log must not contain: ${secret}`);
    const st = JSON.stringify(JSON.parse(JSON.stringify(store.getForm(f.formId))));
    assert.ok(!st.includes("הייתי אצל") && !st.includes("evidence"), "no transcript/quote persisted");
    assert.ok(!st.includes(TECH), "WhatsApp number is not persisted with the form");
  });

  it("duplicate webhook delivery of the same voice message is processed once", async () => {
    (llm as any).script = [mockReply(modelReply(fixtureDoc("V-X01")))];
    const ev = voice(TECH, "wamid.DUPVOICE");
    await post(ev);
    await post(ev);
    assert.equal(stt.calls, 1);
    assert.equal(wa.forms.length, 1);
    assert.ok(logs().some((l) => l.event === "duplicate_ignored"));
  });

  it("unauthorized sender: no download, no STT, no reply", async () => {
    await post(voice("19990000000"));
    assert.equal(stt.calls, 0);
    assert.equal(wa.forms.length + wa.texts.length, 0);
  });

  it("STT failure: technician gets MSG-18, temp audio is removed, no Claude call", async () => {
    sttFail = new SttError("AUDIO_INVALID");
    const before = llm.requests.length;
    await post(voice());
    assert.ok(wa.texts.includes("לא הצלחתי ליצור טופס מההקלטה. נא לשלוח שוב."));
    assert.deepEqual(tmpFiles(), []);
    assert.equal(llm.requests.length, before);
  });

  it("media download failure is handled without leaving files", async () => {
    const ev = voice();
    wa.media.clear();
    await post(ev);
    assert.ok(wa.texts.includes("לא הצלחתי ליצור טופס מההקלטה. נא לשלוח שוב."));
    assert.deepEqual(tmpFiles(), []);
  });

  it("extraction failure after 3 calls: MSG-18, no draft, temp audio removed", async () => {
    (llm as any).script = [mockReply("junk"), mockReply("junk"), mockReply("junk")];
    const b = llm.requests.length;
    await post(voice());
    assert.equal(llm.requests.length - b, 3);
    assert.equal(wa.forms.length, 0);
    assert.ok(wa.texts.includes("לא הצלחתי ליצור טופס מההקלטה. נא לשלוח שוב."));
    assert.deepEqual(tmpFiles(), []);
  });

  it("recording without business content: MSG-20 (BA-02), no draft", async () => {
    sttText = "אה";
    const b = llm.requests.length;
    await post(voice());
    assert.ok(wa.texts.includes("לא זיהיתי מידע על ביקור. שלח שוב, או כתוב את הפרטים."));
    assert.equal(llm.requests.length, b, "no API call for an empty transcript");
    assert.equal(wa.forms.length, 0);
  });
});

describe("buttons on pipeline forms: M-2, duplicates, stale revisions, correction flow", () => {
  async function newForm(doc: any, transcript = TRANSCRIPT) {
    sttText = transcript;
    (llm as any).script = [mockReply(modelReply(doc))];
    await post(voice());
    const f = lastForm();
    return { formId: f.formId };
  }

  it("approve works once; the duplicate click is ignored", async () => {
    const f = await newForm(fixtureDoc("V-X01"));
    const id = encodeButtonId("approve", f.formId, 1);
    await post(click(id, sentIdFor(f.formId)));
    await post(click(id, sentIdFor(f.formId)));
    assert.equal(store.getForm(f.formId)?.status, "approved");
    assert.equal(logs().filter((l) => l.event === "button_click").length, 1);
    assert.ok(logs().some((l) => l.event === "button_already_handled"));
  });

  it("M-2: no address/phone -> approval refused with the missing list, status unchanged; name+phone only -> approvable", async () => {
    const f1 = await newForm(docWith({ customer_name: ["דן לוי", "דן לוי"], work_summary: ["בדיקה", "בדיקה"] }), "דן לוי בדיקה");
    const s1 = sentIdFor(f1.formId);
    await post(click(encodeButtonId("approve", f1.formId, 1), s1));
    assert.equal(store.getForm(f1.formId)?.status, "draft");
    assert.ok(wa.texts.some((t) => t.startsWith("לא ניתן לאשר: חסר כתובת או טלפון")));
    const f2 = await newForm(docWith({ customer_name: ["דן לוי", "דן לוי"], customer_phone: ["0521234567", "0521234567"] }), "דן לוי טלפון 0521234567");
    const s2 = sentIdFor(f2.formId);
    await post(click(encodeButtonId("approve", f2.formId, 1), s2));
    assert.equal(store.getForm(f2.formId)?.status, "approved");
  });

  it("two open drafts: each click maps to its own form/revision; a click on someone else's form is ignored", async () => {
    const a = await newForm(fixtureDoc("V-X01"));
    const b = await newForm(fixtureDoc("V-X01"));
    const sent = (id: string) => sentIdFor(id);
    await post(click(encodeButtonId("approve", b.formId, 1), sent(b.formId)));
    assert.equal(store.getForm(b.formId)?.status, "approved");
    assert.equal(store.getForm(a.formId)?.status, "draft");
    await post(click(encodeButtonId("approve", a.formId, 1), sent(a.formId), OTHER));
    assert.equal(store.getForm(a.formId)?.status, "draft");
    assert.ok(logs().some((l) => l.event === "button_foreign_form"));
  });

  it("'תקן או הוסף' opens a correction context; the next voice message creates revision 2; the old button is stale", async () => {
    const f = await newForm(docWith({ customer_name: ["דן לוי", "דן לוי"], work_summary: ["בדיקה", "בדיקה"] }), "דן לוי בדיקה");
    const s1 = sentIdFor(f.formId);
    await post(click(encodeButtonId("edit", f.formId, 1), s1));
    assert.equal(store.getForm(f.formId)?.status, "editing");
    assert.ok(wa.texts.includes("מחכה לתיקון לטופס אצל דן לוי"));
    sttText = "הטלפון 0521234567";
    (llm as any).script = [mockReply(modelReply(docWith({ customer_phone: ["0521234567", "0521234567"] })))];
    await post(voice());
    assert.equal(lastForm().formId, f.formId);
    assert.equal(lastForm().revision, 2);
    assert.match(lastForm().text, /טלפון: 0521234567/);
    assert.match(lastForm().text, /לקוח: דן לוי/);
    assert.equal(store.getForm(f.formId)?.status, "draft");
    await post(click(encodeButtonId("approve", f.formId, 1), s1)); // old revision
    assert.ok(logs().some((l) => l.event === "button_stale"));
    assert.equal(store.getForm(f.formId)?.status, "draft");
    const s2 = sentIdFor(f.formId, 2);
    await post(click(encodeButtonId("approve", f.formId, 2), s2));
    assert.equal(store.getForm(f.formId)?.status, "approved");
  });

  it("a correction that changes nothing valid answers MSG-17 and keeps the context", async () => {
    const f = await newForm(docWith({ customer_name: ["דן לוי", "דן לוי"], work_summary: ["בדיקה", "בדיקה"] }), "דן לוי בדיקה");
    const s1 = sentIdFor(f.formId);
    await post(click(encodeButtonId("edit", f.formId, 1), s1));
    sttText = "דן לוי בדיקה";
    (llm as any).script = [mockReply(modelReply(docWith({ customer_name: ["דן לוי", "דן לוי"] })))];
    const before = wa.forms.length;
    await post(voice());
    assert.equal(wa.forms.length, before);
    assert.ok(wa.texts.some((t) => t.startsWith("לא הצלחתי לעדכן את הטופס מההודעה")));
    assert.equal(store.getForm(f.formId)?.revision, 1);
  });

  it("unknown form id, bad context and malformed ids change nothing", async () => {
    const f = await newForm(fixtureDoc("V-X01"));
    await post(click(encodeButtonId("approve", "F9999", 1)));
    await post(click("nonsense"));
    await post(click(encodeButtonId("approve", f.formId, 1), "wamid.SOMETHINGELSE"));
    assert.equal(store.getForm(f.formId)?.status, "draft");
    const ev = logs().map((l) => l.event);
    assert.ok(ev.includes("button_unknown_form") && ev.includes("button_unrecognized") && ev.includes("button_context_mismatch"));
  });
});

describe("WhatsApp message shape (Graph API payload)", () => {
  function recorder() {
    const sent: any[] = [];
    const fetchFn = (async (_u: any, init: any) => {
      sent.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ messages: [{ id: `wamid.G${sent.length}` }] }), { status: 200 });
    }) as typeof fetch;
    const cfg: Config = { port: 0, verifyToken: "v", accessToken: TOKEN, appSecret: SECRET, phoneNumberId: "1", allowedTechnicians: new Set(), graphVersion: "v23.0", dataDir: dir, mediaMaxBytes: 1, mediaKeepSeconds: 0 };
    return { sent, g: new GraphWhatsApp(cfg, fetchFn) };
  }
  it("interactive form has exactly two buttons 'אשר' and 'תקן או הוסף' carrying form id and revision", async () => {
    const { sent, g } = recorder();
    await g.sendFormMessage("1555", "טופס קצר", "F1042", 3);
    assert.equal(sent.length, 1);
    const buttons = sent[0].interactive.action.buttons;
    assert.deepEqual(buttons.map((b: any) => b.reply.title), ["אשר", "תקן או הוסף"]);
    assert.deepEqual(buttons.map((b: any) => b.reply.id), [encodeButtonId("approve", "F1042", 3), encodeButtonId("edit", "F1042", 3)]);
    assert.equal(sent[0].interactive.body.text, "טופס קצר");
  });
  it("a form longer than the 1024-char button body is sent as text first, then the two buttons", async () => {
    const { sent, g } = recorder();
    await g.sendFormMessage("1555", "א".repeat(2500), "F1", 1);
    assert.equal(sent[0].type, "text");
    assert.equal(sent[sent.length - 1].type, "interactive");
    assert.equal(sent[sent.length - 1].interactive.action.buttons.length, 2);
    assert.ok(sent[sent.length - 1].interactive.body.text.length <= 1024);
  });
});

describe("crash recovery of temporary audio", () => {
  it("startup sweep removes orphaned audio files left by a crashed run", () => {
    const d = mkdtempSync(join(tmpdir(), "sweep-"));
    writeTempAudio(d, Buffer.from("x"), "orphan1");
    writeTempAudio(d, Buffer.from("y"), "orphan2");
    assert.equal(readdirSync(join(d, "tmp-media")).length, 2);
    assert.equal(sweepTempAudio(d), 2);
    assert.equal(readdirSync(join(d, "tmp-media")).length, 0);
    assert.equal(sweepTempAudio(join(d, "none")), 0);
  });
});
