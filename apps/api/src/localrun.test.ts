// SPK-META-04: local-run building blocks. All mocks: MockStt / MockLlm / FakeWA. No Meta, no Anthropic, no STT model.
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Config } from "./config.ts";
import { setSink } from "./logger.ts";
import { assertNoServerOn, LOCAL_OUTBOX_MARK, LOCAL_SENDER, LocalFileWhatsApp, LocalTestStore } from "./localrun.ts";
import { PythonControls } from "./pipeline/controls.ts";
import { StructuredExtractor } from "./pipeline/extractor.ts";
import { MockLlm, mockReply } from "./pipeline/llm.ts";
import { OutboxRunner } from "./pipeline/outbox.ts";
import { VoicePipeline } from "./pipeline/pipeline.ts";
import { MockStt } from "./pipeline/stt.ts";
import { techKey } from "./pipeline/techkey.ts";
import { CONTROLS_SCRIPT, FakeWA, PYTHON, TRANSCRIPT, fixtureDoc, modelReply } from "./pipeline/testkit.ts";
import { OutboundDisabledError } from "./whatsapp.ts";

const REAL_TECH = "15550001111"; // an allowlisted technician (fake number)

const baseCfg = (dir: string, outboundEnabled: boolean): Config => ({
  port: 0, outboundEnabled, verifyToken: "v", accessToken: "t-local", appSecret: "s-local", phoneNumberId: "1", allowedTechnicians: new Set([REAL_TECH]),
  graphVersion: "v23.0", dataDir: dir, mediaMaxBytes: 1024 * 1024, mediaKeepSeconds: 0,
  pipeline: { pythonExe: PYTHON, sttWorkerScript: "", controlsScript: CONTROLS_SCRIPT, sttModelDir: "C:\\x", sttMaxAudioSeconds: 60, sttMaxQueue: 2, sttJobTimeoutMs: 5000, sttStartupTimeoutMs: 5000, extractorMode: "mock", ackEnabled: false, patchTtlMs: 600000 },
});

async function localRun(dir: string) {
  setSink(() => {});
  const cfg = baseCfg(dir, false);
  const store = new LocalTestStore(dir);
  const wa = new LocalFileWhatsApp(Buffer.from("OggS-synthetic"));
  const llm = new MockLlm([mockReply(modelReply(fixtureDoc("V-X01")))]);
  const stt = new MockStt(async () => ({ text: TRANSCRIPT, audioDurationS: 5, decodeS: 0.01, transcribeS: 0.1 }));
  const extractor = new StructuredExtractor(llm, new PythonControls(PYTHON, CONTROLS_SCRIPT), { sleep: async () => {}, jitter: () => 0 });
  const outbox = new OutboxRunner({ cfg, store, wa });
  const pipeline = new VoicePipeline({ cfg, store, wa, stt, extractor, outbox });
  await pipeline.processVoice({ kind: "audio", messageId: "local-abc12345", from: LOCAL_SENDER, mediaId: "0", mime: "audio/ogg", voice: true }, { msg: "local" }, Date.now());
  return { store, wa, cfg };
}

describe("LocalFileWhatsApp", () => {
  it("serves the local file and refuses (and counts) every send", async () => {
    const wa = new LocalFileWhatsApp(Buffer.from("abc"));
    assert.equal((await wa.fetchMedia("0")).bytes.toString(), "abc");
    await assert.rejects(wa.sendText("x", "y"), OutboundDisabledError);
    await assert.rejects(wa.sendForm("x", "F1", 1), OutboundDisabledError);
    await assert.rejects(wa.sendFormButtons("x", "y", "F1", 1), OutboundDisabledError);
    assert.equal(wa.sendAttempts, 3);
  });
});

describe("local run through the real pipeline (mock providers)", () => {
  it("saves the form and receipt with timing, sends nothing, and the outbox entry is born DROPPED", async () => {
    const dir = mkdtempSync(join(tmpdir(), "local-"));
    const { store, wa } = await localRun(dir);
    const form = store.listForms()[0]!;
    assert.ok(form, "form saved");
    const receipt = store.getReceipt("local-abc12345")!;
    assert.ok(["REVIEW_READY", "NEEDS_INFO"].includes(receipt.status));
    assert.equal(typeof receipt.processingDurationMs, "number");
    assert.equal(wa.sendAttempts, 0, "pipeline never attempted a send");
    const entry = store.getOutbox(`form:${form.formId}:1`)!;
    assert.equal(entry.status, "DROPPED");
    assert.equal(entry.lastError, LOCAL_OUTBOX_MARK);
    assert.equal(store.dueOutbox(Date.now() + 10 ** 9).length, 0, "nothing is ever due");
  });

  it("a later run with outbound ENABLED and the real technician writing again never delivers the test form", async () => {
    const dir = mkdtempSync(join(tmpdir(), "local-"));
    const { store } = await localRun(dir);
    const form = store.listForms()[0]!;
    const key = `form:${form.formId}:1`;
    const later = baseCfg(dir, true); // settings changed in the future: outbound ON
    const wa2 = new FakeWA();
    const runner = new OutboxRunner({ cfg: later, store, wa: wa2, mockWatermark: false });
    // every release/recovery path the system has
    store.touchInbound(techKey(REAL_TECH), Date.now());
    assert.equal(store.releaseWindowClosed(techKey(REAL_TECH), Date.now()), 0);
    assert.equal(store.releaseWindowClosed(techKey(LOCAL_SENDER), Date.now()), 0);
    assert.equal(store.recoverOutbox(), 0);
    runner.start();
    await runner.drain();
    runner.stop();
    assert.deepEqual(wa2.forms, []);
    assert.deepEqual(wa2.texts, []);
    assert.equal(store.getOutbox(key)!.status, "DROPPED");
  });

  it("even if someone forced the entry back to PENDING, no recipient can be resolved for the synthetic sender", async () => {
    const dir = mkdtempSync(join(tmpdir(), "local-"));
    const { store } = await localRun(dir);
    const form = store.listForms()[0]!;
    const key = `form:${form.formId}:1`;
    store.updateOutbox(key, { status: "PENDING", nextAt: 0 }); // simulated worst case
    store.touchInbound(techKey(LOCAL_SENDER), Date.now());
    const wa2 = new FakeWA();
    await new OutboxRunner({ cfg: baseCfg(dir, true), store, wa: wa2, mockWatermark: false }).drain();
    assert.deepEqual(wa2.forms, [], "nothing sent");
    assert.deepEqual(wa2.texts, []);
    assert.equal(store.getOutbox(key)!.status, "DROPPED");
    assert.equal(store.getOutbox(key)!.lastError, "UNKNOWN_RECIPIENT");
  });

  it("LocalTestStore refuses to queue texts", () => {
    const s = new LocalTestStore(mkdtempSync(join(tmpdir(), "local-")));
    assert.throws(() => s.enqueueText({ key: "k", techKey: "t", kind: "TEXT", text: "x", status: "PENDING", attempts: 0, nextAt: 0, createdAt: 0 }));
  });
});

describe("assertNoServerOn", () => {
  it("rejects when something listens on the port and resolves when the port is free", async () => {
    const srv = createServer();
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as AddressInfo).port;
    await assert.rejects(assertNoServerOn(port), /already listening/);
    await new Promise<void>((r) => srv.close(() => r()));
    await assertNoServerOn(port);
  });
});
