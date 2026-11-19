import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

export interface SttResult { text: string; audioDurationS: number; decodeS: number; transcribeS: number }

export type SttErrorCode =
  | "AUDIO_INVALID" | "AUDIO_TOO_LONG" | "STT_FAILED" | "STT_TIMEOUT" | "STT_QUEUE_FULL"
  | "STT_WORKER_CRASHED" | "STT_UNAVAILABLE" | "BAD_REQUEST";

export class SttError extends Error {
  readonly code: SttErrorCode;
  constructor(code: SttErrorCode) {
    super(code);
    this.code = code;
  }
}

/** Port: the rest of the system only knows this interface. */
export interface SttPort {
  transcribe(audioPath: string, jobId: string): Promise<SttResult>;
  close(): Promise<void>;
}

export interface WorkerOptions {
  pythonExe: string;
  workerScript: string;
  modelDir: string; // absolute
  maxQueue: number; // waiting jobs (beyond the one running)
  jobTimeoutMs: number;
  startupTimeoutMs: number;
  maxAudioSeconds: number;
  cpuThreads?: number;
  maxConsecutiveStartFailures?: number;
  onEvent?: (event: string, fields: Record<string, string | number | boolean>) => void; // content-free
}

interface Pending { resolve: (r: SttResult) => void; reject: (e: SttError) => void; timer: NodeJS.Timeout }

/**
 * Persistent Python worker: the model is loaded once per worker lifecycle. One job runs at a time (the worker is
 * sequential), up to `maxQueue` more wait; further jobs are rejected immediately (bounded resources).
 * A timeout or crash kills the worker; the next job starts a fresh one (no automatic retry of the failed job).
 */
export class PythonSttWorker implements SttPort {
  private o: WorkerOptions;
  private child: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<void> | null = null;
  private pending = new Map<string, Pending>();
  private queue: Array<{ audioPath: string; jobId: string; resolve: Pending["resolve"]; reject: Pending["reject"] }> = [];
  private running = false;
  private startFailures = 0;
  private closed = false;
  constructor(o: WorkerOptions) {
    this.o = o;
  }

  private emit(event: string, fields: Record<string, string | number | boolean> = {}) {
    this.o.onEvent?.(event, fields);
  }

  /** Start (or reuse) the worker and wait for its `ready` event. */
  warmUp(): Promise<void> {
    if (this.closed) return Promise.reject(new SttError("STT_UNAVAILABLE"));
    if (this.ready) return this.ready;
    if (this.startFailures >= (this.o.maxConsecutiveStartFailures ?? 3)) return Promise.reject(new SttError("STT_UNAVAILABLE"));
    this.ready = new Promise<void>((resolve, reject) => {
      const t0 = Date.now();
      const child = spawn(this.o.pythonExe, ["-I", this.o.workerScript], {
        env: {
          ...process.env,
          STT_MODEL_DIR: this.o.modelDir,
          STT_MAX_AUDIO_SECONDS: String(this.o.maxAudioSeconds),
          ...(this.o.cpuThreads ? { STT_CPU_THREADS: String(this.o.cpuThreads) } : {}),
          PYTHONUTF8: "1",
        },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      this.child = child;
      child.stderr.on("data", () => { /* never logged: may contain paths; only exit codes are reported */ });
      let settled = false;
      const fail = (code: SttErrorCode) => {
        if (settled) return;
        settled = true;
        clearTimeout(startTimer);
        this.startFailures++;
        this.killWorker();
        reject(new SttError(code));
      };
      const startTimer = setTimeout(() => fail("STT_UNAVAILABLE"), this.o.startupTimeoutMs);
      createInterface({ input: child.stdout }).on("line", (line) => {
        let msg: any;
        try { msg = JSON.parse(line); } catch { return; }
        if (msg.event === "ready") {
          if (settled) return;
          settled = true;
          clearTimeout(startTimer);
          this.startFailures = 0;
          this.emit("stt_worker_ready", { model_load_s: Number(msg.model_load_s), startup_ms: Date.now() - t0 });
          resolve();
        } else if (msg.event === "fatal") {
          this.emit("stt_worker_fatal", { code: String(msg.code) });
          fail("STT_UNAVAILABLE");
        } else if (typeof msg.id === "string") {
          this.onResponse(msg);
        }
      });
      child.on("error", () => fail("STT_UNAVAILABLE"));
      child.on("exit", (code) => {
        this.emit("stt_worker_exit", { code: code ?? -1 });
        if (this.child === child) { this.child = null; this.ready = null; }
        if (!settled) fail("STT_UNAVAILABLE");
        this.rejectAllPending("STT_WORKER_CRASHED");
      });
    });
    this.ready.catch(() => { this.ready = null; });
    return this.ready;
  }

  private onResponse(msg: any) {
    const p = this.pending.get(msg.id);
    if (!p) return; // late answer for a job that already timed out
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) {
      p.resolve({ text: String(msg.text ?? ""), audioDurationS: Number(msg.audio_duration_s), decodeS: Number(msg.decode_s), transcribeS: Number(msg.transcribe_s) });
    } else {
      const code = ["AUDIO_INVALID", "AUDIO_TOO_LONG", "BAD_REQUEST"].includes(msg.code) ? (msg.code as SttErrorCode) : "STT_FAILED";
      p.reject(new SttError(code));
    }
    this.running = false;
    void this.pump();
  }

  private rejectAllPending(code: SttErrorCode) {
    for (const [id, p] of this.pending) { clearTimeout(p.timer); p.reject(new SttError(code)); this.pending.delete(id); }
    this.running = false;
    void this.pump();
  }

  private killWorker() {
    const c = this.child;
    this.child = null;
    this.ready = null;
    if (c && !c.killed) c.kill();
  }

  transcribe(audioPath: string, jobId: string): Promise<SttResult> {
    if (this.closed) return Promise.reject(new SttError("STT_UNAVAILABLE"));
    if (this.queue.length >= this.o.maxQueue) return Promise.reject(new SttError("STT_QUEUE_FULL"));
    return new Promise<SttResult>((resolve, reject) => {
      this.queue.push({ audioPath, jobId, resolve, reject });
      void this.pump();
    });
  }

  private async pump(): Promise<void> {
    if (this.running || this.queue.length === 0) return;
    this.running = true;
    const job = this.queue.shift()!;
    try {
      await this.warmUp();
    } catch (e) {
      this.running = false;
      job.reject(e instanceof SttError ? e : new SttError("STT_UNAVAILABLE"));
      void this.pump();
      return;
    }
    const child = this.child;
    if (!child) { this.running = false; job.reject(new SttError("STT_WORKER_CRASHED")); void this.pump(); return; }
    const timer = setTimeout(() => {
      if (!this.pending.delete(job.jobId)) return;
      this.emit("stt_job_timeout", {});
      job.reject(new SttError("STT_TIMEOUT"));
      this.killWorker(); // a stuck decode cannot be interrupted safely; next job starts a fresh worker
      this.running = false;
      void this.pump();
    }, this.o.jobTimeoutMs);
    this.pending.set(job.jobId, { resolve: job.resolve, reject: job.reject, timer });
    child.stdin.write(JSON.stringify({ id: job.jobId, op: "transcribe", audio_path: job.audioPath }) + "\n");
  }

  async close(): Promise<void> {
    this.closed = true;
    const c = this.child;
    this.rejectAllPending("STT_UNAVAILABLE");
    for (const j of this.queue.splice(0)) j.reject(new SttError("STT_UNAVAILABLE"));
    if (c && !c.killed) {
      try { c.stdin.write(JSON.stringify({ id: "x", op: "shutdown" }) + "\n"); } catch { /* ignore */ }
      setTimeout(() => { if (!c.killed) c.kill(); }, 1500).unref();
    }
  }
}

/** Deterministic test double. */
export class MockStt implements SttPort {
  calls = 0;
  private script: (audioPath: string) => Promise<SttResult> | SttResult;
  constructor(script: (audioPath: string) => Promise<SttResult> | SttResult) {
    this.script = script;
  }
  async transcribe(audioPath: string): Promise<SttResult> {
    this.calls++;
    return this.script(audioPath);
  }
  async close() {}
}
