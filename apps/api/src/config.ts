export interface PipelineConfig {
  pythonExe: string; // isolated venv interpreter (absolute)
  sttWorkerScript: string;
  controlsScript: string;
  sttModelDir: string; // absolute path to the pinned model directory
  sttMaxAudioSeconds: number;
  sttMaxQueue: number;
  sttJobTimeoutMs: number;
  sttStartupTimeoutMs: number;
  extractorMode: "mock" | "real";
  ackEnabled: boolean;
  patchTtlMs: number;
}

export interface Config {
  pipeline?: PipelineConfig; // absent => legacy behaviour (download, hash, delete)
  port: number;
  verifyToken: string;
  accessToken: string;
  appSecret: string;
  phoneNumberId: string;
  allowedTechnicians: Set<string>;
  graphVersion: string;
  dataDir: string;
  mediaMaxBytes: number;
  mediaKeepSeconds: number;
}

import { isAbsolute, resolve } from "node:path";

export function loadPipelineConfig(env: NodeJS.ProcessEnv, apiRoot: string): PipelineConfig | undefined {
  if (env.PIPELINE_ENABLED !== "true") return undefined;
  const abs = (k: string): string => {
    const v = env[k];
    if (!v || !isAbsolute(v)) throw new Error(`Missing or non-absolute config: ${k}`);
    return v;
  };
  return {
    pythonExe: env.STT_PYTHON_EXE && isAbsolute(env.STT_PYTHON_EXE) ? env.STT_PYTHON_EXE : resolve(apiRoot, "python/.venv-stt/Scripts/python.exe"),
    sttWorkerScript: resolve(apiRoot, "python/stt_worker.py"),
    controlsScript: resolve(apiRoot, "python/controls_cli.py"),
    sttModelDir: abs("STT_MODEL_DIR"),
    sttMaxAudioSeconds: Number(env.STT_MAX_AUDIO_SECONDS ?? 180),
    sttMaxQueue: Number(env.STT_MAX_QUEUE ?? 4),
    sttJobTimeoutMs: Number(env.STT_JOB_TIMEOUT_MS ?? 150000),
    sttStartupTimeoutMs: Number(env.STT_STARTUP_TIMEOUT_MS ?? 180000),
    extractorMode: env.EXTRACTOR_MODE === "real" ? "real" : "mock",
    ackEnabled: env.ACK_ENABLED !== "false",
    patchTtlMs: Number(env.PATCH_TTL_MS ?? 10 * 60 * 1000),
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, apiRoot: string = process.cwd()): Config {
  const req = (k: string): string => {
    const v = env[k];
    if (!v || v.startsWith("replace_with")) throw new Error(`Missing config: ${k}`);
    return v;
  };
  return {
    port: Number(env.PORT ?? 3000),
    verifyToken: req("WHATSAPP_VERIFY_TOKEN"),
    accessToken: req("WHATSAPP_ACCESS_TOKEN"),
    appSecret: req("WHATSAPP_APP_SECRET"),
    phoneNumberId: req("WHATSAPP_PHONE_NUMBER_ID"),
    allowedTechnicians: new Set(
      (env.ALLOWED_TECHNICIAN_WA_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    ),
    graphVersion: env.GRAPH_API_VERSION ?? "v23.0",
    dataDir: env.DATA_DIR ?? "./data",
    mediaMaxBytes: Number(env.MEDIA_MAX_BYTES ?? 16 * 1024 * 1024),
    mediaKeepSeconds: Number(env.MEDIA_KEEP_SECONDS ?? 0),
    pipeline: loadPipelineConfig(env, apiRoot),
  };
}
