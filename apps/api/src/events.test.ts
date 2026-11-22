// parseWebhook: delivery-status errors from Meta are kept (known fields only); everything else is parsed as before. Pure unit tests, no I/O.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseStatusErrors, parseWebhook } from "./events.ts";

const wrap = (value: object) => ({ object: "whatsapp_business_account", entry: [{ id: "1", changes: [{ field: "messages", value }] }] });
const statuses = (...st: object[]) => wrap({ statuses: st });
const st = (over: object = {}) => ({ id: "wamid.OUT1", status: "failed", timestamp: "1700000000", recipient_id: "15550001111", ...over });
const only = (body: unknown) => { const ev = parseWebhook(body); assert.equal(ev.length, 1); const e = ev[0]!; assert.equal(e.kind, "status"); return e as Extract<typeof e, { kind: "status" }>; };

const FULL = { code: 131026, title: "Message undeliverable", message: "Message undeliverable", error_data: { details: "Unable to deliver the message. Recipient may be unreachable." }, href: "https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes/" };

describe("status errors", () => {
  it("a failed status keeps every documented error field", () => {
    const e = only(statuses(st({ errors: [FULL] })));
    assert.equal(e.status, "failed");
    assert.equal(e.messageId, "wamid.OUT1");
    assert.equal(e.timestamp, 1700000000);
    assert.deepEqual(e.errors, [{ code: 131026, title: "Message undeliverable", message: "Message undeliverable", details: "Unable to deliver the message. Recipient may be unreachable.", href: FULL.href }]);
  });
  it("partial error objects are kept without crashing", () => {
    assert.deepEqual(only(statuses(st({ errors: [{ code: 130429 }] }))).errors, [{ code: 130429 }]);
    assert.deepEqual(only(statuses(st({ errors: [{ title: "T", error_data: {} }] }))).errors, [{ title: "T" }]);
  });
  it("a failed status without errors still parses (and has no errors key)", () => {
    const e = only(statuses(st()));
    assert.equal(e.status, "failed");
    assert.ok(!("errors" in e));
    assert.ok(!("errors" in only(statuses(st({ errors: [] })))));
  });
  it("delivered, read and sent still parse exactly as before", () => {
    for (const s of ["delivered", "read", "sent"]) {
      const e = only(statuses(st({ status: s })));
      assert.deepEqual(e, { kind: "status", messageId: "wamid.OUT1", from: "15550001111", status: s, timestamp: 1700000000 });
    }
  });
  it("unexpected types never throw and never leak into the event", () => {
    for (const errors of ["boom", 7, null, {}, [null, 3, "x", []], [{ code: { a: 1 }, title: 5, message: ["m"], error_data: "str", href: 9 }], [{ error_data: null }]]) {
      const e = only(statuses(st({ errors })));
      assert.ok(!("errors" in e), `errors dropped for ${JSON.stringify(errors)}`);
    }
    assert.deepEqual(only(statuses(st({ errors: [{ code: "131047", title: "t" }] }))).errors, [{ code: 131047, title: "t" }], "numeric string code accepted");
    assert.equal(parseStatusErrors([{ code: "12ab" }]), undefined);
    assert.equal(parseStatusErrors([{ code: Infinity }]), undefined);
  });
  it("only known fields are kept: unknown properties are never copied", () => {
    const e = only(statuses(st({ errors: [{ code: 1, title: "t", access_token: "SHOULD_NOT_APPEAR", error_data: { details: "d", messaging_product: "whatsapp", raw: { x: 1 } }, extra: { deep: true } }] })));
    assert.deepEqual(e.errors, [{ code: 1, title: "t", details: "d" }]);
    assert.ok(!JSON.stringify(e).includes("SHOULD_NOT_APPEAR"));
  });
  it("text is bounded, control characters flattened, long digit runs masked, non-https links dropped", () => {
    const e = only(statuses(st({ errors: [{ title: "x".repeat(1000), message: "line1\nline2\t3", error_data: { details: "recipient 972501234567 failed " + "y".repeat(1000) }, href: "javascript:alert(1)" }] })));
    const err = e.errors![0]!;
    assert.equal(err.title!.length, 200);
    assert.equal(err.message, "line1 line2 3");
    assert.ok(err.details!.length <= 500);
    assert.ok(!err.details!.includes("972501234567") && err.details!.startsWith("recipient *** failed"));
    assert.ok(!("href" in err));
  });
  it("at most 5 errors are kept", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ code: 100 + i }));
    assert.equal(only(statuses(st({ errors: many }))).errors!.length, 5);
  });
  it("a malformed status entry does not drop the other events of the same webhook", () => {
    const ev = parseWebhook(wrap({ statuses: [st({ errors: "boom" }), { nope: true }, st({ id: "wamid.OUT2", status: "delivered" })] }));
    assert.deepEqual(ev.map((e) => e.kind === "status" && e.messageId), ["wamid.OUT1", "wamid.OUT2"]);
  });
});

describe("other event kinds are unchanged", () => {
  it("audio, button and other are parsed exactly as before", () => {
    const ev = parseWebhook(wrap({ messages: [
      { id: "wamid.A", from: "1", type: "audio", audio: { id: "9", mime_type: "audio/ogg", voice: true } },
      { id: "wamid.B", from: "1", type: "interactive", context: { id: "wamid.C" }, interactive: { type: "button_reply", button_reply: { id: "ap:F1:1", title: "אשר" } } },
      { id: "wamid.D", from: "1", type: "text", text: { body: "x" } },
    ] }));
    assert.deepEqual(ev, [
      { kind: "audio", messageId: "wamid.A", from: "1", mediaId: "9", mime: "audio/ogg", voice: true },
      { kind: "button", messageId: "wamid.B", from: "1", buttonId: "ap:F1:1", title: "אשר", contextId: "wamid.C" },
      { kind: "other", messageId: "wamid.D", from: "1", type: "text" },
    ]);
  });
  it("non-WhatsApp payloads still yield no events", () => {
    assert.deepEqual(parseWebhook({ object: "page", entry: [] }), []);
    assert.deepEqual(parseWebhook(null), []);
  });
});
