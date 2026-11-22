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
  graphBaseUrl?: string; // test/mock Graph endpoint only; ignored when NODE_ENV=production
  port: number;
  /** Outbound WhatsApp messaging (ACK, failure notices, forms, outbox, button replies). Safe default: false; only the exact value "true" enables it. */
  outboundEnabled: boolean;
  /** Diagnostic mode (default false): an allowlisted voice message is downloaded from Meta and the job STOPS before STT/Claude/forms. Implies outbound OFF. */
  inboundMediaOnly?: boolean;
  /** Read-only local form inspector on its OWN loopback port (never the webhook listener). Absent unless explicitly enabled. */
  localInspect?: { port: number };
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

/** Fail-closed: absent, empty or any non-"true" value ("True", "1", "yes", " true") keeps outbound OFF. */
export function parseOutboundEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.OUTBOUND_ENABLED === "true";
}

/** Fail-closed like OUTBOUND_ENABLED: only the exact value "true" turns the media-only diagnostic mode on. */
export function parseInboundMediaOnly(env: NodeJS.ProcessEnv): boolean {
  return env.INBOUND_MEDIA_ONLY === "true";
}

export function loadLocalInspect(env: NodeJS.ProcessEnv, webhookPort: number): { port: number } | undefined {
  if (env.LOCAL_INSPECT_ENABLED !== "true") return undefined;
  const port = Number(env.LOCAL_INSPECT_PORT ?? 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid LOCAL_INSPECT_PORT");
  if (port === webhookPort) throw new Error("LOCAL_INSPECT_PORT must differ from PORT (the webhook port is tunnelled)");
  return { port };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, apiRoot: string = process.cwd()): Config {
  const req = (k: string): string => {
    const v = env[k];
    if (!v || v.startsWith("replace_with")) throw new Error(`Missing config: ${k}`);
    return v;
  };
  const port = Number(env.PORT ?? 3000);
  const mediaOnly = parseInboundMediaOnly(env);
  return {
    port,
    outboundEnabled: parseOutboundEnabled(env) && !mediaOnly, // media-only never sends anything, whatever OUTBOUND_ENABLED says
    inboundMediaOnly: mediaOnly,
    localInspect: loadLocalInspect(env, port),
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
    graphBaseUrl: env.NODE_ENV !== "production" && env.GRAPH_BASE_URL ? env.GRAPH_BASE_URL.replace(/\/+$/, "") : undefined,
  };
}
