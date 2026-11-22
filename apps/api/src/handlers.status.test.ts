// Delivery-status handling: Meta's failure reason is logged; other statuses and dedup are unchanged. Local mocks only (no Meta, no sends).
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import type { Config } from "./config.ts";
import { describeStatusErrors } from "./handlers.ts";
import { registerSecrets, setSink } from "./logger.ts";
import { createApp } from "./server.ts";
import { sign } from "./signature.ts";
import { Store } from "./store.ts";
import { FakeWA } from "./pipeline/testkit.ts";

const TECH = "15550001111";
const SECRET = "status-test-app-secret";
const TOKEN = "status-test-access-token";
const LONG_ID = "wamid.HBgLMTU1NTUwMDAxMTExFQIAERgSQTc5NzY0RjE3REEyM0Q2MzFEMwA=";

let lines: string[] = [];
let store: Store;
let wa: FakeWA;
let base: string;
let server: ReturnType<typeof createApp>;
let pending: Promise<unknown> = Promise.resolve();
const logs = () => lines.map((l) => JSON.parse(l));
const named = (e: string) => logs().filter((l) => l.event === e);

before(async () => {
  registerSecrets(SECRET, TOKEN);
  setSink((l) => lines.push(l));
  const dir = mkdtempSync(join(tmpdir(), "status-"));
  const cfg: Config = {
    port: 0, outboundEnabled: false, verifyToken: "v", accessToken: TOKEN, appSecret: SECRET, phoneNumberId: "1", allowedTechnicians: new Set([TECH]),
    graphVersion: "v23.0", dataDir: dir, mediaMaxBytes: 1024 * 1024, mediaKeepSeconds: 0,
  };
  store = new Store(dir);
  wa = new FakeWA();
  server = createApp({ cfg, store, wa }, (p) => { pending = p; });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/webhook`;
});
after(() => server.close());
beforeEach(() => { lines = []; wa.texts = []; wa.forms = []; });

async function post(body: unknown) {
  const raw = JSON.stringify(body);
  const res = await fetch(base, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": sign(raw, SECRET) }, body: raw });
  await pending;
  pending = Promise.resolve();
  return res;
}
const status = (id: string, st: string, extra: object = {}) =>
  ({ object: "whatsapp_business_account", entry: [{ id: "1", changes: [{ field: "messages", value: { statuses: [{ id, status: st, timestamp: "1700000123", recipient_id: TECH, ...extra }] } }] }] });
const FULL_ERR = { code: 131026, title: "Message undeliverable", message: "Message undeliverable", error_data: { details: "Unable to deliver the message." }, href: "https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes/" };

describe("failed delivery status", () => {
  it("logs Meta's error details for a message we sent, with form and revision", async () => {
    store.recordSent(LONG_ID, "F1002", 1, { submittedAt: Date.now() - 5200 });
    await post(status(LONG_ID, "failed", { errors: [FULL_ERR] }));
    const f = named("delivery_failed");
    assert.equal(f.length, 1);
    assert.equal(f[0].level, "warn");
    assert.equal(f[0].known_message, true);
    assert.equal(f[0].form_id, "F1002");
    assert.equal(f[0].revision, 1);
    assert.equal(f[0].meta_errors, 1);
    assert.equal(f[0].error_code, 131026);
    assert.equal(f[0].error_title, "Message undeliverable");
    assert.equal(f[0].error_message, "Message undeliverable");
    assert.equal(f[0].error_details, "Unable to deliver the message.");
    assert.equal(f[0].error_href, FULL_ERR.href);
    assert.equal(f[0].meta_timestamp, 1700000123);
    assert.equal(f[0].from, "***111");
    assert.equal(named("delivery_status")[0].status, "failed", "the existing delivery_status log is kept");
    assert.ok(store.getSent(LONG_ID)!.statuses!.includes("failed"));
  });
  it("without errors from Meta it says so and invents nothing", async () => {
    store.recordSent("wamid.OUT_NOERR", "F1003", 1);
    await post(status("wamid.OUT_NOERR", "failed"));
    const f = named("delivery_failed")[0];
    assert.equal(f.meta_errors, "not_provided");
    for (const k of ["error_code", "error_title", "error_message", "error_details", "error_href"]) assert.ok(!(k in f), `${k} must be absent`);
  });
  it("several errors: count, first error and the list of codes", async () => {
    store.recordSent("wamid.OUT_MANY", "F1004", 1);
    await post(status("wamid.OUT_MANY", "failed", { errors: [{ code: 131026, title: "A" }, { code: 130472 }, { title: "no code" }] }));
    const f = named("delivery_failed")[0];
    assert.equal(f.meta_errors, 3);
    assert.equal(f.error_code, 131026);
    assert.equal(f.error_codes, "131026,130472,?");
  });
  it("a failure for a message we have no record of is still reported (known_message=false) and still flagged unknown", async () => {
    await post(status("wamid.NOT_OURS_FAILED", "failed", { errors: [FULL_ERR] }));
    const f = named("delivery_failed")[0];
    assert.equal(f.known_message, false);
    assert.equal(f.form_id, null);
    assert.equal(f.error_code, 131026);
    assert.equal(named("status_unknown_message").length, 1);
  });
  it("the same failed status delivered twice is processed once (dedup unchanged)", async () => {
    store.recordSent("wamid.OUT_DUP", "F1005", 1);
    const body = status("wamid.OUT_DUP", "failed", { errors: [FULL_ERR] });
    await post(body);
    await post(body);
    assert.equal(named("delivery_failed").length, 1);
    assert.equal(named("delivery_status").length, 1);
  });
});

describe("other statuses are unchanged", () => {
  for (const s of ["sent", "delivered", "read"]) {
    it(`${s}: delivery_status is logged and no delivery_failed is emitted`, async () => {
      store.recordSent(`wamid.OUT_${s}`, "F1006", 1, { submittedAt: Date.now() - 1000 });
      await post(status(`wamid.OUT_${s}`, s));
      assert.equal(named("delivery_failed").length, 0);
      const d = named("delivery_status");
      assert.equal(d.length, 1);
      assert.equal(d[0].status, s);
      assert.equal(d[0].form_id, "F1006");
      assert.ok(store.getSent(`wamid.OUT_${s}`)!.statuses!.includes(s));
    });
  }
  it("an unknown message with a normal status stays status_unknown_message", async () => {
    await post(status("wamid.NOBODY", "delivered"));
    assert.equal(named("status_unknown_message").length, 1);
    assert.equal(named("delivery_failed").length, 0);
  });
});

describe("privacy of the new log", () => {
  it("never logs tokens, secrets, raw payload, unknown fields, the full recipient number or the full message id", async () => {
    store.recordSent("wamid.OUT_PRIV", "F1007", 1);
    await post(status("wamid.OUT_PRIV", "failed", { errors: [{ code: 1, title: "t", message: "number 972501234567 rejected " + TOKEN, error_data: { details: "d", messaging_product: "whatsapp" }, access_token: "LEAK_ME", extra: { a: 1 } }] }));
    const all = lines.join("\n");
    for (const bad of [TOKEN, SECRET, "LEAK_ME", "972501234567", TECH, "messaging_product", "recipient_id", "x-hub-signature"]) assert.ok(!all.includes(bad), `log must not contain ${bad}`);
    const f = named("delivery_failed")[0];
    assert.ok(String(f.error_message).includes("***"));
    assert.ok(!all.includes(LONG_ID));
  });
  it("a status never triggers any outbound message", async () => {
    store.recordSent("wamid.OUT_NOSEND", "F1008", 1);
    await post(status("wamid.OUT_NOSEND", "failed", { errors: [FULL_ERR] }));
    assert.deepEqual(wa.texts, []);
    assert.deepEqual(wa.forms, []);
  });
});

describe("describeStatusErrors", () => {
  it("is explicit when Meta sent nothing", () => {
    assert.deepEqual(describeStatusErrors(undefined), { meta_errors: "not_provided" });
    assert.deepEqual(describeStatusErrors([]), { meta_errors: "not_provided" });
  });
});
