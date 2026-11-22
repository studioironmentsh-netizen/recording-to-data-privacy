// Allowlist applies to real inbound messages (audio / button / other); status receipts are not gated by it; unknown kinds are denied.
// Local mocks only (FakeWA + a local HTTP server). No Meta, no AI.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import type { Config } from "./config.ts";
import { requiresAllowlist } from "./handlers.ts";
import { registerSecrets, setSink } from "./logger.ts";
import { createApp } from "./server.ts";
import { sign } from "./signature.ts";
import { Store } from "./store.ts";
import { FakeWA } from "./pipeline/testkit.ts";

const TECH = "15550001111"; // allowlisted (fake)
const STRANGER = "15559998887"; // not allowlisted (fake)
const SECRET = "auth-test-app-secret";
const TOKEN = "auth-test-access-token";
const LONG_ID = "wamid.HBgLMTU1NTk5OTg4ODcVAgASGBQzQTc5NzY0RjE3REEyM0Q2MzFEMwA=";

class CountingWA extends FakeWA {
  fetches = 0;
  override async fetchMedia(id: string) { this.fetches++; return super.fetchMedia(id); }
}

let lines: string[] = [];
let store: Store;
let wa: CountingWA;
let base: string;
let server: ReturnType<typeof createApp>;
let pending: Promise<unknown> = Promise.resolve();
const logs = () => lines.map((l) => JSON.parse(l));
const named = (e: string) => logs().filter((l) => l.event === e);

before(async () => {
  registerSecrets(SECRET, TOKEN);
  setSink((l) => lines.push(l));
  const dir = mkdtempSync(join(tmpdir(), "auth-"));
  const cfg: Config = {
    port: 0, outboundEnabled: false, verifyToken: "v", accessToken: TOKEN, appSecret: SECRET, phoneNumberId: "1", allowedTechnicians: new Set([TECH]),
    graphVersion: "v23.0", dataDir: dir, mediaMaxBytes: 1024 * 1024, mediaKeepSeconds: 0,
  };
  store = new Store(dir);
  wa = new CountingWA();
  server = createApp({ cfg, store, wa }, (p) => { pending = p; });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/webhook`;
});
after(() => server.close());
beforeEach(() => { lines = []; wa.fetches = 0; });

const value = (v: object) => ({ object: "whatsapp_business_account", entry: [{ id: "1", changes: [{ field: "messages", value: v }] }] });
async function post(body: unknown) {
  const raw = JSON.stringify(body);
  const res = await fetch(base, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": sign(raw, SECRET) }, body: raw });
  await pending;
  pending = Promise.resolve();
  return res;
}
const msg = (m: object) => value({ messages: [m] });
const processedCount = () => Object.keys((store as any).load().processed).length;

describe("requiresAllowlist (fail-closed)", () => {
  it("only status is exempt; every message kind and any unknown kind needs the allowlist", () => {
    assert.equal(requiresAllowlist("status"), false);
    for (const k of ["audio", "button", "other"] as const) assert.equal(requiresAllowlist(k), true, k);
    assert.equal(requiresAllowlist("some_future_kind" as any), true);
    assert.equal(requiresAllowlist(undefined as any), true);
  });
});

describe("messages from a sender outside the allowlist", () => {
  it("audio: rejected with kind=audio, nothing claimed, nothing downloaded", async () => {
    const before = processedCount();
    await post(msg({ id: LONG_ID, from: STRANGER, type: "audio", audio: { id: "555", mime_type: "audio/ogg", voice: true } }));
    const l = named("unauthorized_sender");
    assert.equal(l.length, 1);
    assert.equal(l[0].kind, "audio");
    assert.equal(wa.fetches, 0);
    assert.equal(processedCount(), before, "no claim recorded");
    assert.ok(!logs().some((x) => x.event === "audio_received"));
  });
  it("text: rejected with kind=other type=text", async () => {
    await post(msg({ id: "wamid.T1", from: STRANGER, type: "text", text: { body: "secret words" } }));
    const l = named("unauthorized_sender");
    assert.equal(l.length, 1);
    assert.equal(l[0].kind, "other");
    assert.equal(l[0].type, "text");
  });
  it("a hostile message type string is reduced to 'unknown' in the log", async () => {
    await post(msg({ id: "wamid.T2", from: STRANGER, type: "Evil Type\nwith newline", text: {} }));
    assert.equal(named("unauthorized_sender")[0].type, "unknown");
  });
  it("button: rejected with kind=button, no state change", async () => {
    store.upsertForm("FORM_AUTH", 1);
    await post(msg({ id: "wamid.B1", from: STRANGER, type: "interactive", interactive: { type: "button_reply", button_reply: { id: "ap:FORM_AUTH:1", title: "x" } } }));
    assert.equal(named("unauthorized_sender")[0].kind, "button");
    assert.equal(store.getForm("FORM_AUTH")!.status, "draft");
  });
  it("the log has exactly {kind, from(masked)[, type]}: no message id, no full number, no content", async () => {
    await post(msg({ id: LONG_ID, from: STRANGER, type: "text", text: { body: "private content" } }));
    const raw = lines.join("\n");
    const l = named("unauthorized_sender")[0];
    assert.deepEqual(Object.keys(l).filter((k) => !["t", "level", "event"].includes(k)).sort(), ["from", "kind", "type"]);
    assert.equal(l.from, "***887");
    for (const bad of [STRANGER, LONG_ID, "HBgLMTU1", "private content", TOKEN, SECRET]) assert.ok(!raw.includes(bad), `log must not contain ${bad}`);
  });
});

describe("messages from an allowlisted sender are unchanged", () => {
  it("text: accepted and ignored as before", async () => {
    await post(msg({ id: "wamid.OK1", from: TECH, type: "text", text: { body: "hi" } }));
    assert.equal(named("unauthorized_sender").length, 0);
    assert.equal(named("message_ignored")[0].type, "text");
  });
  it("audio: reaches the audio handler (legacy path: download, hash, delete)", async () => {
    wa.media.set("777", Buffer.from("OggS-bytes"));
    await post(msg({ id: "wamid.OK2", from: TECH, type: "audio", audio: { id: "777", mime_type: "audio/ogg", voice: true } }));
    assert.equal(wa.fetches, 1);
    assert.equal(named("audio_received").length, 1);
  });
});

describe("status events are not gated by the technician allowlist", () => {
  const status = (id: string, recipient: string, st = "delivered") => value({ statuses: [{ id, status: st, timestamp: "1700000000", recipient_id: recipient }] });
  it("a receipt for a message we sent, addressed to a non-technician recipient, is recorded (no unauthorized_sender)", async () => {
    store.recordSent("wamid.OUT_AUTH", "FORM_S", 1, { submittedAt: Date.now() });
    await post(status("wamid.OUT_AUTH", STRANGER));
    assert.equal(named("unauthorized_sender").length, 0);
    assert.equal(named("delivery_status").length, 1);
    assert.ok(store.getSent("wamid.OUT_AUTH")!.statuses!.includes("delivered"));
  });
  it("a receipt for a message we never sent is ignored safely (unknown), not 'unauthorized'", async () => {
    await post(status("wamid.NOT_OURS", STRANGER));
    assert.equal(named("unauthorized_sender").length, 0);
    assert.equal(named("status_unknown_message").length, 1);
  });
  it("a receipt for an allowlisted recipient behaves as before", async () => {
    store.recordSent("wamid.OUT_AUTH2", "FORM_S2", 1, { submittedAt: Date.now() });
    await post(status("wamid.OUT_AUTH2", TECH, "read"));
    assert.equal(named("delivery_status").length, 1);
    await post(status("wamid.OUT_AUTH2", TECH, "read")); // same status twice: processed once (dedup unchanged)
    assert.equal(named("delivery_status").length, 1);
  });
  it("a status never triggers any send", async () => {
    store.recordSent("wamid.OUT_AUTH3", "FORM_S3", 1);
    await post(status("wamid.OUT_AUTH3", STRANGER));
    assert.deepEqual(wa.texts, []);
    assert.deepEqual(wa.forms, []);
  });
});
