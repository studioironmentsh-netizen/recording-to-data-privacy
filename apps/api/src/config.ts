export interface Config {
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
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
  };
}
