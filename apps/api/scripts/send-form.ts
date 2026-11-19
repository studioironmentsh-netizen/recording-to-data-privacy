// Usage: npm run send-form -- <to_wa_id> <form_id> [revision]
import { loadConfig } from "../src/config.ts";
import { errMsg, log, maskPhone, registerSecrets } from "../src/logger.ts";
import { Store } from "../src/store.ts";
import { GraphWhatsApp } from "../src/whatsapp.ts";

const [to, formId, rev] = process.argv.slice(2);
if (!to || !formId) {
  console.error("usage: send-form <to> <form_id> [revision]");
  process.exit(2);
}
const cfg = loadConfig();
registerSecrets(cfg.accessToken, cfg.appSecret, cfg.verifyToken);
const store = new Store(cfg.dataDir);
try {
  if (!cfg.allowedTechnicians.has(to)) throw new Error("recipient not in allowlist");
  const revision = rev ? Number(rev) : (store.getForm(formId)?.revision ?? 1);
  store.upsertForm(formId, revision);
  const wamid = await new GraphWhatsApp(cfg).sendForm(to, formId, revision);
  store.recordSent(wamid, formId, revision);
  log("info", "form_sent", { to: maskPhone(to), form_id: formId, revision });
} catch (e) {
  log("error", "send_form_failed", { error: errMsg(e) });
  process.exit(1);
}
