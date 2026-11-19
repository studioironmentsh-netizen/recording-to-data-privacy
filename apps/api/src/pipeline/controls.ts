import { spawn } from "node:child_process";

export type FieldClass = "VERIFIED" | "MISSING" | "UNCLEAR" | "HUMAN_CONFIRM" | "REJECTED_INFERENCE";
export interface Presentation { class: FieldClass; control_codes: string[]; completion_required: boolean; confirmation_required: boolean; value_removed: boolean }
export interface Presented {
  displayed: any; // STAGEB-EXTRACTION doc after active evidence controls (rejected values removed)
  presentation: Record<string, Presentation>;
  controls: { class_counts: Record<string, number> };
}

/** Port for the deterministic evidence controls + form presenter (research code, run unchanged in Python). */
export interface ControlsPort {
  present(doc: unknown, transcript: string): Promise<Presented>;
}

export class PythonControls implements ControlsPort {
  private pythonExe: string;
  private script: string;
  private timeoutMs: number;
  constructor(pythonExe: string, script: string, timeoutMs = 20000) {
    this.pythonExe = pythonExe;
    this.script = script;
    this.timeoutMs = timeoutMs;
  }
  present(doc: unknown, transcript: string): Promise<Presented> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.pythonExe, ["-I", this.script], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true, env: { ...process.env, PYTHONUTF8: "1" } });
      const out: Buffer[] = [];
      const timer = setTimeout(() => { child.kill(); reject(new Error("CONTROLS_TIMEOUT")); }, this.timeoutMs);
      child.stdout.on("data", (c: Buffer) => out.push(c));
      child.on("error", () => { clearTimeout(timer); reject(new Error("CONTROLS_UNAVAILABLE")); });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) return reject(new Error("CONTROLS_FAILED"));
        try { resolve(JSON.parse(Buffer.concat(out).toString("utf8")) as Presented); } catch { reject(new Error("CONTROLS_BAD_OUTPUT")); }
      });
      child.stdin.end(JSON.stringify({ doc, transcript, ba03_approved: true }));
    });
  }
}
