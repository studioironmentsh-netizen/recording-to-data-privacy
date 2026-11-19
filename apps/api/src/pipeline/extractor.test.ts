import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { PythonControls } from "./controls.ts";
import { StructuredExtractor, buildPrompt, loadPromptTemplate, parseSingleJsonObject, MODEL_ID, type ExtractionOutcome } from "./extractor.ts";
import { approvability, mergePatch, renderForm, toStoredFields } from "./formview.ts";
import { AnthropicLlm, BudgetLedger, BUDGET, LIVE_APPROVAL_PHRASE, LlmError, MockLlm, evaluateLiveGate, mockReply } from "./llm.ts";
import { CONTROLS_SCRIPT, PYTHON, TRANSCRIPT, docWith, fixtureDoc, modelReply, setField } from "./testkit.ts";

const controls = new PythonControls(PYTHON, CONTROLS_SCRIPT);
const noSleep = async () => {};
const mk = (llm: MockLlm, cfg = {}) => new StructuredExtractor(llm, controls, { sleep: noSleep, jitter: () => 0, ...cfg });
const ok = (r: ExtractionOutcome) => { assert.ok(r.ok, `expected ok, got ${JSON.stringify(r)}`); return r; };

describe("prompt + deterministic parsing (P1)", () => {
  it("uses the frozen comparison prompt and inserts the transcript verbatim (even with $ patterns)", () => {
    const p = buildPrompt(loadPromptTemplate(), "מחיר $& 250 $1");
    assert.ok(p.includes("מחיר $& 250 $1"));
    assert.ok(!p.includes("{{TRANSCRIPT}}"));
    assert.equal(MODEL_ID, "claude-opus-5-5");
  });
  it("strips BOM, code fences and surrounding prose; never repairs", () => {
    const o = '{"a":"}{"}';
    assert.deepEqual(parseSingleJsonObject("﻿```json\n" + o + "\n```"), { a: "}{" });
    assert.deepEqual(parseSingleJsonObject("הנה התשובה: " + o + " תודה"), { a: "}{" });
    assert.equal(parseSingleJsonObject('{"a": 1'), null);
    assert.equal(parseSingleJsonObject("[1,2]"), null);
    assert.equal(parseSingleJsonObject(""), null);
  });
});

describe("extraction, validation and controls (mock Claude)", () => {
  it("accepts a valid answer in ONE call and maps it to a form with the three display states", async () => {
    const llm = new MockLlm([mockReply(modelReply(fixtureDoc("V-X01")))]);
    const r = ok(await mk(llm).extract(TRANSCRIPT));
    assert.equal(r.attempts.length, 1);
    assert.equal(llm.requests.length, 1);
    assert.equal(llm.requests[0]!.model, "claude-opus-5-5");
    assert.equal(llm.requests[0]!.effort, "low");
    assert.ok(llm.requests[0]!.prompt.includes(TRANSCRIPT));
    const f = toStoredFields(r.presented, r.rejectedFields);
    assert.equal(f.customer_name!.text, "דן לוי");
    assert.equal(f.customer_phone!.text, "0521234567");
    assert.match(f.parts_price!.text, /100 ₪ כולל מע״מ/);
    assert.match(f.visit_price!.text, /250 ₪ לא כולל מע״מ/);
    assert.equal(f.next_visit!.shown, "UNCLEAR", "weekday expression needs confirmation -> displayed as לא ברור");
    assert.equal(f.customer_external_number!.shown, "EMPTY");
    assert.ok(approvability(f).ok);
  });

  it("recovers from malformed answers within the shared quota of 3 calls (no merge between answers)", async () => {
    const llm = new MockLlm([mockReply("not json at all"), mockReply('{"extracted_fields": {}}'), mockReply(modelReply(fixtureDoc("V-X01")))]);
    const r = ok(await mk(llm).extract(TRANSCRIPT));
    assert.deepEqual(r.attempts.map((a) => a.outcome), ["UNPARSEABLE_OR_ENVELOPE", "UNPARSEABLE_OR_ENVELOPE", "ACCEPTED"]);
  });

  it("never exceeds 3 AI calls per message (even if configured higher)", async () => {
    const llm = new MockLlm(Array.from({ length: 10 }, () => mockReply("garbage")));
    const r = await mk(llm, { attemptsMax: 10 }).extract(TRANSCRIPT);
    assert.equal(r.ok, false);
    assert.equal(llm.requests.length, 3);
    assert.equal(BUDGET.perReceiptMax, 3);
  });

  it("technical failures (timeout/429/5xx) are retried with backoff and counted in the same quota", async () => {
    const sleeps: number[] = [];
    const llm = new MockLlm([new LlmError("TIMEOUT"), new LlmError("RATE_LIMIT", 5), mockReply(modelReply(fixtureDoc("V-X01")))]);
    const r = ok(await mk(llm, { sleep: async (ms: number) => { sleeps.push(ms); } }).extract(TRANSCRIPT));
    assert.equal(r.attempts.length, 3);
    assert.deepEqual(sleeps, [2000, 5000]); // 2 s exponential step, then Retry-After
    const llm2 = new MockLlm([new LlmError("SERVER"), new LlmError("SERVER"), new LlmError("SERVER"), mockReply("unused")]);
    const r2 = await mk(llm2).extract(TRANSCRIPT);
    assert.equal(r2.ok, false);
    assert.equal(llm2.requests.length, 3);
  });

  it("auth/config rejection and refusal are NOT retried", async () => {
    const a = new MockLlm([new LlmError("AUTH"), mockReply("x")]);
    assert.deepEqual(await mk(a).extract(TRANSCRIPT).then((r) => (r.ok ? "ok" : r.code)), "LLM_REJECTED");
    assert.equal(a.requests.length, 1);
    const b = new MockLlm([mockReply("", { stopReason: "refusal" }), mockReply("x")]);
    assert.deepEqual(await mk(b).extract(TRANSCRIPT).then((r) => (r.ok ? "ok" : r.code)), "LLM_REFUSAL");
    assert.equal(b.requests.length, 1);
  });

  it("truncation: one retry at the ceiling only, then final failure", async () => {
    const llm = new MockLlm([mockReply("{", { stopReason: "max_tokens" }), mockReply("{", { stopReason: "max_tokens" }), mockReply("x")]);
    const r = await mk(llm).extract(TRANSCRIPT);
    assert.equal(r.ok, false);
    assert.deepEqual(llm.requests.map((q) => q.maxTokens), [16000, 32000]);
  });

  it("field-level schema failure: the field is rejected and marked, the other fields are kept (S-FIELD)", async () => {
    const d = fixtureDoc("V-X01");
    d.extracted_fields.spare_parts.value[0].quantity = 5; // number instead of string
    const r = ok(await mk(new MockLlm([mockReply(modelReply(d))])).extract(TRANSCRIPT));
    assert.ok(r.rejectedFields.includes("spare_parts"));
    const f = toStoredFields(r.presented, r.rejectedFields);
    assert.equal(f.spare_parts!.text, "לא ברור — לתיקון");
    assert.equal(f.customer_name!.text, "דן לוי");
  });

  it("hallucinated evidence (quote not in the transcript) is rejected, never shown as a value", async () => {
    const d = fixtureDoc("V-X01");
    d.field_states.customer_phone.evidence_quote = "הטלפון 0509999999";
    d.extracted_fields.customer_phone.value = "0509999999";
    const r = ok(await mk(new MockLlm([mockReply(modelReply(d))])).extract(TRANSCRIPT));
    const f = toStoredFields(r.presented, r.rejectedFields);
    assert.equal(f.customer_phone!.shown, "UNCLEAR");
    assert.ok(!JSON.stringify(f).includes("0509999999"));
  });

  it("invented price/address not supported by the transcript cannot become a value", async () => {
    const d = fixtureDoc("V-X01");
    setField(d, "customer_address", "רחוב הרצל 99", "PRESENT", "הרצל 99");
    setField(d, "visit_price", { amount: "900", currency: "ILS" }, "PRESENT", "900 שקל");
    const r = ok(await mk(new MockLlm([mockReply(modelReply(d))])).extract(TRANSCRIPT));
    const f = toStoredFields(r.presented, r.rejectedFields);
    assert.notEqual(f.customer_address!.shown, "VALUE");
    assert.notEqual(f.visit_price!.shown, "VALUE");
  });

  it("systematic rejection (N3) triggers one more attempt, a clean answer is then accepted (no merge)", async () => {
    const bad = fixtureDoc("V-X01");
    for (const k of ["customer_name", "customer_phone", "customer_address", "work_summary", "spare_parts", "parts_price", "visit_price"]) bad.field_states[k].evidence_quote = "ציטוט שלא נאמר"; // >=3 fields and >=50% of the filled ones
    const llm = new MockLlm([mockReply(modelReply(bad)), mockReply(modelReply(fixtureDoc("V-X01")))]);
    const r = ok(await mk(llm).extract(TRANSCRIPT));
    assert.equal(r.attempts.length, 2);
    assert.match(r.attempts[0]!.outcome, /^N[13]_/); // N1 (nothing verified) or N3 (systematic): both allow one more attempt (SALV-R9)
    assert.equal(toStoredFields(r.presented, r.rejectedFields).customer_name!.text, "דן לוי");
  });

  it("a valid answer with no business content opens no draft and is not retried (BA-02)", async () => {
    const llm = new MockLlm([mockReply(modelReply(fixtureDoc("V-X02"))), mockReply("unused")]);
    const r = await mk(llm).extract("אה בסדר תודה");
    assert.equal(r.ok ? "ok" : r.code, "NO_BUSINESS_CONTENT");
    assert.equal(llm.requests.length, 1);
  });

  it("explicit self-correction keeps the final value and records the correction (preserved uncertainty)", async () => {
    const tr = "הייתי אצל רונית כהן ברחוב האלון 7 העבודה עלתה מאתיים לא רגע 250 שקל";
    const d = docWith({ customer_name: ["רונית כהן", "רונית כהן"], customer_address: ["האלון 7", "האלון 7"] });
    setField(d, "visit_price", { amount: "250", currency: "ILS" }, "PRESENT", "250 שקל");
    d.field_states.visit_price.self_correction_events = [{ from_value: "200", to_value: "250" }];
    const r = ok(await mk(new MockLlm([mockReply(modelReply(d))])).extract(tr));
    assert.equal(r.presented.displayed.field_states.visit_price.self_correction_events[0].to_value, "250");
    assert.match(toStoredFields(r.presented, r.rejectedFields).visit_price!.text, /^250 ₪/);
  });

  it("explicit uncertainty states are preserved: NOT_DECIDED price -> 'טרם נקבע', past-modal part -> לא ברור (BA-03)", async () => {
    const tr = "אצל מיכל ברק רחוב הגפן 2 היה צריך להחליף כבל המחיר אני צריך עוד לסגור";
    const d = docWith({ customer_name: ["מיכל ברק", "מיכל ברק"], customer_address: ["הגפן 2", "הגפן 2"] });
    setField(d, "visit_price", null, "NOT_DECIDED", "המחיר אני צריך עוד לסגור");
    setField(d, "spare_parts", null, "UNCLEAR", "היה צריך להחליף כבל", "AMBIGUOUS_REFERENCE");
    d.field_states.work_summary = { uncertainty_reason: "KNOWN", evidence_quote: "היה צריך להחליף כבל", summary_items: [{ kind: "FUTURE_ACTION", text: "נדרשה החלפת כבל, לא ידוע אם בוצעה" }] };
    d.extracted_fields.work_summary = { value: "נדרשה החלפת כבל", evidence_state: "PRESENT", needs_clarification: false };
    d.clarification_requests = [{ field_keys: ["spare_parts"], reason_code: "NEEDS_CONFIRMATION", candidate: null }];
    const r = ok(await mk(new MockLlm([mockReply(modelReply(d))])).extract(tr));
    const f = toStoredFields(r.presented, r.rejectedFields);
    assert.equal(f.visit_price!.text, "טרם נקבע");
    assert.equal(f.spare_parts!.text, "לא ברור — נדרשה החלפת כבל, לא ידוע אם בוצעה");
  });
});

describe("M-2 approval rule and patch merge (form view)", () => {
  const fields = (name: boolean, addr: boolean, phone: boolean) => {
    const strings: Record<string, [string, string]> = {};
    if (name) strings.customer_name = ["דן לוי", "דן לוי"];
    if (addr) strings.customer_address = ["הדקל 3", "הדקל 3"];
    if (phone) strings.customer_phone = ["0521234567", "0521234567"];
    strings.work_summary = ["בדיקה", "בדיקה"];
    return docWith(strings);
  };
  it("name + (address or phone) is approvable; name alone or address alone is not; nothing is invented", async () => {
    const run = async (n: boolean, a: boolean, p: boolean) => {
      const r = ok(await mk(new MockLlm([mockReply(modelReply(fields(n, a, p)))])).extract("דן לוי הדקל 3 0521234567 בדיקה"));
      return approvability(toStoredFields(r.presented, r.rejectedFields));
    };
    assert.equal((await run(true, true, false)).ok, true);
    assert.equal((await run(true, false, true)).ok, true);
    const a = await run(true, false, false);
    assert.equal(a.ok, false);
    assert.deepEqual(a.missing, ["כתובת או טלפון"]);
    assert.deepEqual((await run(false, true, true)).missing, ["שם לקוח"]);
  });
  it("patch merge replaces only verified new values", async () => {
    const prev = toStoredFields(ok(await mk(new MockLlm([mockReply(modelReply(fixtureDoc("V-X01")))])).extract(TRANSCRIPT)).presented, []);
    const tr2 = "הכתובת היא הדקל 5";
    const r2 = ok(await mk(new MockLlm([mockReply(modelReply(docWith({ customer_address: ["הדקל 5", "הדקל 5"] })))])).extract(tr2));
    const m = mergePatch(prev, toStoredFields(r2.presented, r2.rejectedFields));
    assert.deepEqual(m.changed, ["customer_address"]);
    assert.equal(m.fields.customer_name!.text, "דן לוי");
    assert.equal(m.fields.customer_address!.text, "הדקל 5");
  });
  it("renders MSG-02 header, MSG-39 for partial forms and the capture date as default visit date", () => {
    const f = { customer_name: { shown: "VALUE", text: "דן לוי", value: "דן לוי" }, customer_address: { shown: "UNCLEAR", text: "לא ברור — לתיקון" } } as any;
    for (const [k] of [["customer_phone"], ["customer_external_number"], ["visit_date_statement"], ["work_summary"], ["spare_parts"], ["parts_price"], ["visit_price"], ["next_visit"]]) f[k!] = { shown: "EMPTY", text: "—" };
    const t = renderForm({ number: 1042, revision: 2, fields: f, captureDate: "19.11.2026", partial: true, mockWatermark: false });
    assert.match(t, /^טופס #1042 · דן לוי · 19\.11\.2026 · גרסה 2/);
    assert.match(t, /לתיקון/);
    assert.match(t, /תאריך ביקור: 19\.11\.2026/);
    assert.ok(!t.includes("מספר לקוח"));
  });
});

describe("real client request shape (fake SDK client, no network)", () => {
  it("sends the approved model/effort/limits, no sampling params, no prefill, and settles the ledger", async () => {
    const seen: any[] = [];
    const fake = { messages: { create: async (params: any, opts: any) => { seen.push({ params, opts }); return { content: [{ type: "text", text: "{}" }], stop_reason: "end_turn", usage: { input_tokens: 4000, output_tokens: 1000 }, model: "claude-opus-5-5" }; } } };
    const ledger = new BudgetLedger(mkdtempSync(join(tmpdir(), "ledger-")));
    const llm = AnthropicLlm.fromClientForTests(fake as any, ledger);
    const r = await llm.complete({ model: MODEL_ID, maxTokens: 16000, effort: "low", prompt: "P", timeoutMs: 1234 });
    assert.equal(r.text, "{}");
    assert.deepEqual(seen[0].params, { model: "claude-opus-5-5", max_tokens: 16000, output_config: { effort: "low" }, messages: [{ role: "user", content: "P" }] });
    assert.equal(seen[0].opts.timeout, 1234);
    assert.ok(!("temperature" in seen[0].params) && !("fallbacks" in seen[0].params), "no sampling params, no fallback model (FP-11)");
    const snap = ledger.snapshot();
    assert.equal(snap.calls, 1);
    assert.ok(Math.abs(snap.usd - (4000 * 4 + 1000 * 20) / 1e6) < 1e-9, "ledger settled to the actual token cost");
  });
});

describe("live gate and budget (no accidental paid calls)", () => {
  const full = { EXTRACTOR_MODE: "real", ANTHROPIC_LIVE_APPROVAL: LIVE_APPROVAL_PHRASE, ANTHROPIC_KEY_ROTATION_CONFIRMED: "yes", ANTHROPIC_API_KEY: "sk-ant-test-0000000000000000000000" };
  it("is closed by default and for every partial combination", () => {
    assert.equal(evaluateLiveGate({}).live, false);
    for (const drop of Object.keys(full)) {
      const env = { ...full } as Record<string, string>;
      delete env[drop];
      const g = evaluateLiveGate(env);
      assert.equal(g.live, false, `dropping ${drop} must close the gate`);
      assert.equal(g.missing.length, 1);
    }
    assert.equal(evaluateLiveGate({ ...full, ANTHROPIC_KEY_ROTATION_CONFIRMED: "no" }).live, false);
    assert.equal(evaluateLiveGate({ ...full, ANTHROPIC_LIVE_APPROVAL: "yes" }).live, false);
    assert.equal(evaluateLiveGate({ ...full, ANTHROPIC_API_KEY: "replace_with_local_value" }).live, false);
  });
  it("opens only when everything is present; the report never contains values", () => {
    assert.equal(evaluateLiveGate(full).live, true);
    assert.ok(!JSON.stringify(evaluateLiveGate({ ...full, EXTRACTOR_MODE: "mock" })).includes("sk-ant"));
  });
  it("the real client cannot be constructed while the gate is closed and makes no network call", async () => {
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => { calls++; throw new Error("network forbidden in test"); }) as typeof fetch;
    try {
      assert.throws(() => AnthropicLlm.create({ ANTHROPIC_API_KEY: full.ANTHROPIC_API_KEY, EXTRACTOR_MODE: "real" }, tmpdir()), (e: any) => e instanceof LlmError && e.code === "GATE_CLOSED");
    } finally { globalThis.fetch = realFetch; }
    assert.equal(calls, 0);
  });
  it("budget ledger refuses beyond 60 calls or USD 10 (reserved before every call)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ledger-"));
    const l = new BudgetLedger(dir);
    for (let i = 0; i < 60; i++) { l.reserve(1000); l.settle(1000, 3000, 800); }
    assert.throws(() => l.reserve(1000), (e: any) => e.code === "BUDGET");
    assert.equal(l.snapshot().calls, 60);
    const l2 = new BudgetLedger(mkdtempSync(join(tmpdir(), "ledger-")));
    for (let i = 0; i < 31; i++) l2.reserve(16000); // 31 * 0.32 = 9.92
    assert.throws(() => l2.reserve(16000), (e: any) => e.code === "BUDGET");
    assert.ok(existsSync(join(dir, "anthropic_ledger.json")));
  });
  it("the extractor stops (no further calls) when the budget gate trips", async () => {
    const llm = new MockLlm([new LlmError("BUDGET"), mockReply("unused")]);
    const r = await mk(llm).extract(TRANSCRIPT);
    assert.equal(r.ok ? "ok" : r.code, "LLM_BUDGET");
    assert.equal(llm.requests.length, 1);
  });
});
