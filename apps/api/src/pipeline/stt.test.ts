import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { FAKE_WORKER, PYTHON } from "./testkit.ts";
import { PythonSttWorker, SttError, type WorkerOptions } from "./stt.ts";

const workers: PythonSttWorker[] = [];
function make(over: Partial<WorkerOptions> = {}, env: Record<string, string> = {}): PythonSttWorker {
  Object.assign(process.env, env);
  const w = new PythonSttWorker({ pythonExe: PYTHON, workerScript: FAKE_WORKER, modelDir: "C:\\fake", maxQueue: 2, jobTimeoutMs: 8000, startupTimeoutMs: 15000, maxAudioSeconds: 60, ...over });
  workers.push(w);
  return w;
}
const code = async (p: Promise<unknown>) => { try { await p; return "OK"; } catch (e) { return e instanceof SttError ? e.code : "OTHER"; } };
after(async () => { for (const w of workers) await w.close(); delete process.env.FAKE_STARTUP; });

describe("STT worker lifecycle (protocol fake, no model)", () => {
  it("starts, reports readiness once, and transcribes", async () => {
    const events: string[] = [];
    const w = make({ onEvent: (e) => events.push(e) });
    await w.warmUp();
    assert.deepEqual(events.filter((e) => e === "stt_worker_ready"), ["stt_worker_ready"]);
    const r = await w.transcribe("a.ogg", "j1");
    assert.equal(r.text, "שלום עולם");
    await w.transcribe("b.ogg", "j2");
    assert.equal(events.filter((e) => e === "stt_worker_ready").length, 1, "model/worker loaded once, not per message");
  });

  it("maps invalid audio to AUDIO_INVALID and keeps the worker alive", async () => {
    const w = make();
    assert.equal(await code(w.transcribe("bad.ogg", "j1")), "AUDIO_INVALID");
    assert.equal(await code(w.transcribe("ok.ogg", "j2")), "OK");
  });

  it("crash: pending job fails with STT_WORKER_CRASHED, next job restarts the worker", async () => {
    const events: string[] = [];
    const w = make({ onEvent: (e) => events.push(e) });
    assert.equal(await code(w.transcribe("crash.ogg", "j1")), "STT_WORKER_CRASHED");
    assert.equal(await code(w.transcribe("ok.ogg", "j2")), "OK");
    assert.equal(events.filter((e) => e === "stt_worker_ready").length, 2);
  });

  it("timeout: job fails with STT_TIMEOUT, worker is replaced, later jobs succeed", async () => {
    const w = make({ jobTimeoutMs: 700 });
    assert.equal(await code(w.transcribe("hang.ogg", "j1")), "STT_TIMEOUT");
    assert.equal(await code(w.transcribe("ok.ogg", "j2")), "OK");
  });

  it("bounded queue: one running + maxQueue waiting, the rest rejected immediately", async () => {
    const w = make({ maxQueue: 1 });
    await w.warmUp();
    const a = w.transcribe("slow1.ogg", "a"); // running (picked up synchronously)
    await new Promise((r) => setTimeout(r, 50));
    const b = w.transcribe("slow2.ogg", "b"); // waiting
    const c = w.transcribe("slow3.ogg", "c"); // over the bound
    assert.equal(await code(c), "STT_QUEUE_FULL");
    assert.equal(await code(a), "OK");
    assert.equal(await code(b), "OK");
  });

  it("startup failure: STT_UNAVAILABLE, and after repeated failures it stays unavailable (no restart storm)", async () => {
    const w = make({ maxConsecutiveStartFailures: 2 }, { FAKE_STARTUP: "fail" });
    assert.equal(await code(w.transcribe("a.ogg", "1")), "STT_UNAVAILABLE");
    assert.equal(await code(w.transcribe("a.ogg", "2")), "STT_UNAVAILABLE");
    assert.equal(await code(w.warmUp()), "STT_UNAVAILABLE");
    delete process.env.FAKE_STARTUP;
  });

  it("startup timeout is enforced", async () => {
    const w = make({ startupTimeoutMs: 200 }, { FAKE_STARTUP: "slow" });
    assert.equal(await code(w.warmUp()), "STT_UNAVAILABLE");
    delete process.env.FAKE_STARTUP;
  });

  it("missing interpreter is reported as STT_UNAVAILABLE", async () => {
    const w = make({ pythonExe: "C:\\does\\not\\exist\\python.exe" });
    assert.equal(await code(w.transcribe("a.ogg", "1")), "STT_UNAVAILABLE");
  });

  it("closed worker rejects new jobs", async () => {
    const w = make();
    await w.close();
    assert.equal(await code(w.transcribe("a.ogg", "1")), "STT_UNAVAILABLE");
  });
});
