import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import type { Config } from "./config.ts";
import { decodeButtonId, encodeButtonId, BUTTON_TITLES } from "./forms.ts";
import { errMsg, registerSecrets, setSink } from "./logger.ts";
import { createApp } from "./server.ts";
import { sign } from "./signature.ts";
import { Store } from "./store.ts";
import type { WhatsApp } from "./whatsapp.ts";

const TECH = "15550001111";
const SECRET = "test-app-secret-value";
const TOKEN = "test-access-token-value";
const VERIFY = "test-verify-token-value";

class FakeWA implements WhatsApp {
  texts: string[] = [];
  media = new Map<string, Buffer>();
  async sendText(_to: string, text: string) { this.texts.push(text); }
  async sendForm() { return "wamid.FAKE"; }
  async sendFormMessage() { return "wamid.FAKE"; }
  async fetchMedia(id: string) {
    const b = this.media.get(id);
    if (!b) throw new Error(`media lookup failed: http 401 Bearer ${TOKEN}`);
    return { bytes: b, mime: "audio/ogg; codecs=opus" };
  }
}

let lines: string[] = [];
let dir: string;
let store: Store;
let wa: FakeWA;
let base: string;
let server: ReturnType<typeof createApp>;
let pending: Promise<unknown> = Promise.resolve();

before(async () => {
  registerSecrets(SECRET, TOKEN, VERIFY);
  setSink((l) => lines.push(l));
  dir = mkdtempSync(join(tmpdir(), "spk-"));
  const cfg: Config = {
    port: 0, verifyToken: VERIFY, accessToken: TOKEN, appSecret: SECRET, phoneNumberId: "1",
    allowedTechnicians: new Set([TECH]), graphVersion: "v23.0", dataDir: dir,
    mediaMaxBytes: 1024 * 1024, mediaKeepSeconds: 0,
  };
  store = new Store(dir);
  wa = new FakeWA();
  server = createApp({ cfg, store, wa }, (p) => { pending = p; });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/webhook`;
});
after(() => server.close());
beforeEach(() => { lines = []; wa.texts = []; });

function envelope(msg: object) {
  return { object: "whatsapp_business_account", entry: [{ id: "1", changes: [{ field: "messages", value: { messages: [msg] } }] }] };
}
async function post(body: unknown, opts: { sig?: string | null; secret?: string } = {}) {
  const raw = JSON.stringify(body);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.sig !== null) headers["x-hub-signature-256"] = opts.sig ?? sign(raw, opts.secret ?? SECRET);
  const res = await fetch(base, { method: "POST", headers, body: raw });
  await pending;
  pending = Promise.resolve();
  return res;
}
const logs = () => lines.map((l) => JSON.parse(l));
const click = (id: string, wamid: string, ctx?: string, from = TECH) =>
  envelope({ id: wamid, from, type: "interactive", context: ctx ? { id: ctx } : undefined,
    interactive: { type: "button_reply", button_reply: { id, title: "x" } } });

function seedForm(formId: string, rev: number, wamid: string) {
  store.upsertForm(formId, rev);
  store.recordSent(wamid, formId, rev);
}

describe("L-01 webhook verification", () => {
  it("accepts the right token and echoes challenge", async () => {
    const r = await fetch(`${base}?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=123`);
    assert.equal(r.status, 200);
    assert.equal(await r.text(), "123");
  });
  it("rejects wrong / missing token", async () => {
    assert.equal((await fetch(`${base}?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1`)).status, 403);
    assert.equal((await fetch(`${base}?hub.mode=subscribe&hub.challenge=1`)).status, 403);
  });
});

describe("L-02 signature", () => {
  const body = envelope({ id: "wamid.S1", from: TECH, type: "text" });
  it("accepts valid", async () => assert.equal((await post(body)).status, 200));
  it("rejects wrong secret, missing, malformed", async () => {
    assert.equal((await post(body, { secret: "other" })).status, 401);
    assert.equal((await post(body, { sig: null })).status, 401);
    assert.equal((await post(body, { sig: "sha256=zz" })).status, 401);
  });
  it("rejects when body is altered after signing", async () => {
    const sig = sign(JSON.stringify(body), SECRET);
    assert.equal((await post({ ...body, extra: 1 }, { sig })).status, 401);
  });
});

describe("L-03/L-04/L-08 audio", () => {
  const audio = (id: string, from = TECH, media = "111") =>
    envelope({ id, from, type: "audio", audio: { id: media, mime_type: "audio/ogg; codecs=opus", voice: true } });

  it("downloads, hashes and deletes temp media", async () => {
    wa.media.set("111", Buffer.from("OggS-fake-audio-bytes"));
    await post(audio("wamid.A1"));
    const ev = logs().find((l) => l.event === "audio_received");
    assert.ok(ev);
    assert.equal(ev.size, 21);
    assert.equal(ev.voice, true);
    assert.equal(ev.deleted, true);
    const tmp = join(dir, "tmp-media");
    assert.deepEqual(existsSync(tmp) ? readdirSync(tmp) : [], []);
  });
  it("ignores unauthorized sender without downloading", async () => {
    wa.media.set("111", Buffer.from("x"));
    await post(audio("wamid.A2", "19990000000"));
    assert.ok(logs().some((l) => l.event === "unauthorized_sender"));
    assert.ok(!logs().some((l) => l.event === "audio_received"));
  });
  it("L-09: download failure is logged without secrets", async () => {
    await post(audio("wamid.A3", TECH, "999"));
    const all = lines.join("\n");
    assert.ok(logs().some((l) => l.event === "handler_failed"));
    assert.ok(!all.includes(TOKEN) && !all.includes(SECRET) && !all.includes(TECH));
  });
});

describe("L-05/L-06/L-07 buttons", () => {
  it("attributes clicks exactly with two open drafts", async () => {
    seedForm("FORM_A", 1, "wamid.OUT_A1");
    seedForm("FORM_B", 1, "wamid.OUT_B1");
    await post(click(encodeButtonId("approve", "FORM_B", 1), "wamid.IN1", "wamid.OUT_B1"));
    await post(click(encodeButtonId("edit", "FORM_A", 1), "wamid.IN2", "wamid.OUT_A1"));
    const clicks = logs().filter((l) => l.event === "button_click");
    assert.deepEqual(clicks.map((c) => [c.form_id, c.revision, c.action, c.context_verified]),
      [["FORM_B", 1, "approve", true], ["FORM_A", 1, "edit", true]]);
    assert.equal(store.getForm("FORM_B")?.status, "approved");
    assert.equal(store.getForm("FORM_A")?.status, "editing");
  });
  it("rejects stale revision and leaves state untouched", async () => {
    seedForm("FORM_C", 1, "wamid.OUT_C1");
    store.upsertForm("FORM_C", 2);
    await post(click(encodeButtonId("approve", "FORM_C", 1), "wamid.IN3", "wamid.OUT_C1"));
    assert.ok(logs().some((l) => l.event === "button_stale"));
    assert.equal(store.getForm("FORM_C")?.status, "draft");
    assert.equal(wa.texts.length, 1);
  });
  it("rejects context mismatch (button id for A, context of B)", async () => {
    seedForm("FORM_D", 1, "wamid.OUT_D1");
    seedForm("FORM_E", 1, "wamid.OUT_E1");
    await post(click(encodeButtonId("approve", "FORM_D", 1), "wamid.IN4", "wamid.OUT_E1"));
    assert.ok(logs().some((l) => l.event === "button_context_mismatch"));
    assert.equal(store.getForm("FORM_D")?.status, "draft");
  });
  it("rejects unknown form, malformed id, repeated click on handled form", async () => {
    await post(click(encodeButtonId("approve", "NOPE", 1), "wamid.IN5"));
    await post(click("garbage", "wamid.IN6"));
    seedForm("FORM_F", 1, "wamid.OUT_F1");
    await post(click(encodeButtonId("approve", "FORM_F", 1), "wamid.IN7", "wamid.OUT_F1"));
    await post(click(encodeButtonId("edit", "FORM_F", 1), "wamid.IN8", "wamid.OUT_F1"));
    const ev = logs().map((l) => l.event);
    assert.ok(ev.includes("button_unknown_form") && ev.includes("button_unrecognized") && ev.includes("button_already_handled"));
    assert.equal(store.getForm("FORM_F")?.status, "approved");
  });
  it("dedups a redelivered message id", async () => {
    seedForm("FORM_G", 1, "wamid.OUT_G1");
    const msg = click(encodeButtonId("approve", "FORM_G", 1), "wamid.IN9", "wamid.OUT_G1");
    await post(msg);
    await post(msg);
    assert.equal(logs().filter((l) => l.event === "button_click").length, 1);
    assert.equal(logs().filter((l) => l.event === "duplicate_ignored").length, 1);
  });
});

describe("button id codec & Meta limits", () => {
  it("round-trips and validates", () => {
    assert.deepEqual(decodeButtonId(encodeButtonId("edit", "F-1", 12)), { action: "edit", formId: "F-1", revision: 12 });
    assert.equal(decodeButtonId("ap:F:0"), null);
    assert.throws(() => encodeButtonId("approve", "bad id", 1));
  });
  it("titles fit WhatsApp 20-char limit; id fits 256", () => {
    for (const t of Object.values(BUTTON_TITLES)) assert.ok(t.length <= 20);
    assert.ok(encodeButtonId("approve", "x".repeat(64), 999999999).length <= 256);
  });
  it("errMsg scrubs registered secrets", () => {
    assert.ok(!errMsg(new Error(`oops ${TOKEN}`)).includes(TOKEN));
  });
});
