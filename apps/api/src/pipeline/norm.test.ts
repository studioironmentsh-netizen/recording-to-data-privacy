import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { CircuitBreaker } from "./breaker.ts";
import { PythonControls } from "./controls.ts";
import { StructuredExtractor } from "./extractor.ts";
import { MockLlm, mockReply } from "./llm.ts";
import { applyQuantityNormalization, contractOk, normalizeQuantity } from "./norm.ts";
import { CONTROLS_SCRIPT, FIXTURES, PYTHON, TRANSCRIPT, fixtureDoc, modelReply } from "./testkit.ts";

const controls = new PythonControls(PYTHON, CONTROLS_SCRIPT);

describe("NORM-2.0 (SRS 4.9.0 §12.3) against the specification vectors", () => {
  const v = JSON.parse(readFileSync(join(FIXTURES, "norm_vectors.json"), "utf8"));
  for (const c of v.normalize) {
    it(`${c.id}: ${c.why ?? ""}`.slice(0, 110), () => {
      const r = normalizeQuantity(c.value, c.quote, c.item, c.unit);
      assert.equal(r.value, c.expect);
      assert.equal(r.reason, c.reason);
    });
  }
  for (const c of v.contract_limit) it(`contract limit ${c.id} (${c.value})`, () => assert.equal(contractOk(c.value), c.ok));

  it("touches only word quantities of spare_parts; digits and every other field stay identical (QTY-R2, QTY-R8)", () => {
    const d = fixtureDoc("V-X01");
    d.extracted_fields.spare_parts.value = [{ name: "כבלים", quantity: "שתי" }, { name: "מפזר", quantity: "12" }, { name: "מסנן", quantity: "כמה" }];
    d.field_states.spare_parts.evidence_quote = "החלפתי שני כבלים וגם 12 מפזר וכמה מסנן";
    const before = JSON.stringify({ ...d.extracted_fields, spare_parts: null });
    assert.deepEqual(applyQuantityNormalization(d), { normalized: 1, rejected: 1 });
    assert.deepEqual(d.extracted_fields.spare_parts.value.map((p: any) => p.quantity), ["2", "12", null]);
    assert.equal(JSON.stringify({ ...d.extracted_fields, spare_parts: null }), before);
  });

  it("end to end: quantity 'שני' becomes '2' with no AI retry and the field is not rejected", async () => {
    const d = fixtureDoc("V-X01");
    d.extracted_fields.spare_parts.value = [{ name: "קבל", quantity: "שני" }];
    d.field_states.spare_parts.evidence_quote = "החלפתי שני קבל";
    d.field_states.spare_parts.item_timing = ["REPLACED"];
    for (const fs of Object.values<any>(d.field_states)) if (typeof fs.evidence_quote === "string") fs.evidence_quote = fs.evidence_quote.replace("החלפתי קבל", "החלפתי שני קבל");
    const llm = new MockLlm([mockReply(modelReply(d))]);
    const r = await new StructuredExtractor(llm, controls, { sleep: async () => {} }).extract(TRANSCRIPT.replace("החלפתי קבל", "החלפתי שני קבל"));
    assert.ok(r.ok);
    assert.equal(llm.requests.length, 1);
    assert.equal(r.quantityNormalized, 1);
    assert.equal(r.presented.displayed.extracted_fields.spare_parts.value[0].quantity, "2");
    assert.ok(!r.rejectedFields.includes("spare_parts"));
  });
});

describe("FP-03 circuit breaker", () => {
  it("opens after 5 failures within 60 s and closes after the cool-down or a success", () => {
    const b = new CircuitBreaker();
    for (let i = 0; i < 4; i++) b.recordFailure(1000 + i);
    assert.equal(b.isOpen(2000), false);
    b.recordFailure(1500);
    assert.equal(b.waitMs(2000), 59500);
    assert.equal(b.isOpen(1500 + 60001), false);
    b.recordFailure(100000);
    b.recordSuccess();
    assert.equal(b.isOpen(100001), false);
  });

  it("an open breaker pauses the receipt without consuming an AI attempt; beyond the deadline it ends as DEADLINE", async () => {
    const br = new CircuitBreaker();
    let t = 0;
    for (let i = 0; i < 5; i++) br.recordFailure(0);
    const slept: number[] = [];
    const ex = new StructuredExtractor(new MockLlm([mockReply(modelReply(fixtureDoc("V-X01")))]), controls, { breaker: br, now: () => t, sleep: async (ms: number) => { slept.push(ms); t += ms; }, jitter: () => 0 });
    const r = await ex.extract(TRANSCRIPT);
    assert.ok(r.ok);
    assert.deepEqual(slept, [60000]);
    assert.equal(r.attempts.length, 1);
    const br2 = new CircuitBreaker(5, 60000, 400000);
    for (let i = 0; i < 5; i++) br2.recordFailure(0);
    const llm2 = new MockLlm([mockReply("x")]);
    const r2 = await new StructuredExtractor(llm2, controls, { breaker: br2, now: () => 0, sleep: async () => {}, jitter: () => 0 }).extract(TRANSCRIPT);
    assert.equal(r2.ok ? "ok" : r2.code, "DEADLINE");
    assert.equal(llm2.requests.length, 0, "no API call while the breaker is open");
  });

  it("technical failures feed the breaker; 5 of them open it", async () => {
    const br = new CircuitBreaker();
    const mk = () => new StructuredExtractor(new MockLlm([new (class extends Error {})() as any]), controls, { breaker: br, sleep: async () => {}, jitter: () => 0, attemptsMax: 1 });
    void mk;
    const { LlmError } = await import("./llm.ts");
    for (let i = 0; i < 2; i++) await new StructuredExtractor(new MockLlm([new LlmError("SERVER"), new LlmError("SERVER"), new LlmError("SERVER")]), controls, { breaker: br, sleep: async () => {}, jitter: () => 0 }).extract(TRANSCRIPT);
    assert.equal(br.isOpen(Date.now()), true);
  });
});
