# E2E-VOICE-01 — הודעה קולית → STT מקומי → Claude → טופס → שני כפתורים

סטטוס: **LOCAL_PIPELINE_COMPLETE** · בדיקות חיות מול Meta/Claude: **NOT_TESTED**. מרשם פערים: `docs/GAP_REGISTER.md`. בקשות שינוי: `docs/change-requests/`.

## זרימה (`apps/api/src/`)
webhook (חתימה, allowlist, dedup, 200 מיידי) → `pipeline.processVoice` (receipt לפני כל קריאת AI) → `whatsapp.fetchMedia` (שלב כפול של Graph) → קובץ זמני
→ `stt.PythonSttWorker` (`python/stt_worker.py`, המודל נטען פעם אחת) → `extractor.StructuredExtractor` (פרומפט קפוא, ≤3 קריאות, NORM-2.0, validator, salvage, מפסק מעגל)
→ בקרות K1–K8 + presenter (`python/controls_cli.py`) → `formview` (שלושה מצבי תצוגה, M-2, FULL/PARTIAL + flagged_fields)
→ `store.saveDraftAndEnqueue` (עסקה אחת) → `outbox.OutboxRunner` (retry, חלון 24 ש׳, מסירה מאוחרת) → `GraphWhatsApp.sendFormButtons` (שני כפתורים חתומים).
לחיצה: `handlers` ← אימות חתימת כפתור + בעלות + revision ← `store.approve` (אטומי, FormVersion בלתי משתנה) או פתיחת הקשר תיקון (10 דק׳) ← ההקלטה הבאה ⇒ revision חדש (מיזוג שדות מאומתים בלבד).
`statuses` של Meta ⇒ `delivery_status` + `e2e_delivery_ms`.

## בדיקות
| פקודה (מתוך `apps/api`) | מה היא מריצה |
|---|---|
| `npm.cmd run typecheck` | tsc |
| `npm.cmd test` | 123 בדיקות: יחידה/אינטגרציה (STT worker עם fake פרוטוקול, MockGraph ב-HTTP, מתאם Graph אמיתי, store/outbox אמיתיים, validator ובקרות אמיתיים) |
| `npm.cmd run test:e2e` (עם `STT_MODEL_DIR`, `E2E_AUDIO_DIR`) | שרשרת מקומית מלאה עם **STT אמיתי** והקלטות דמה; Meta ו-Claude מדומים |
| `npm.cmd run preflight` | בדיקת מוכנות לקריאה בלבד; אינה שולחת דבר ואינה מפעילה LIVE |
| `node scripts/e2e-local-mock.ts <model> <audio>...` | מדידת תזמון מקומית |

## הפעלה לניסוי חי (אחרי הסרת חסימת Meta)
1. `.env` (ללא ערכים בצ'אט): `PIPELINE_ENABLED=true`, `STT_MODEL_DIR=<abs>`, ו-`ANTHROPIC_BUDGET_USD=<יתרה מאומתת, עד 10>`.
2. שלב א׳ (חינם): `EXTRACTOR_MODE=mock` — קול אמיתי ← תמלול בלבד. הרצת `npm.cmd run preflight`. הודעת קול אחת מהטלפון; בלוג: `pipeline_done` עם `stt_ms`.
3. שלב ב׳ (Claude): לאחר ש(א) אושרה יתרה/מפתח בטוח בקונסולה, (ב) משה אישר, מוסיפים `EXTRACTOR_MODE=real`, `ANTHROPIC_API_KEY`, `ANTHROPIC_KEY_ROTATION_CONFIRMED=yes`, `ANTHROPIC_LIVE_APPROVAL=<הביטוי ב-llm.ts>`. `preflight` חייב להיות ללא FAIL/BLOCKED. הודעת קול אחת בחלון 24 ש׳ ← טופס ← "אשר" / "תקן או הוסף".
4. הוכחה: לוגים `form_sent`, `delivery_status` (delivered), `button_click` + צילום מסך. רק אז סימון LIVE_* כ-PASS.
5. מעבר למפתח של משה: שינוי `ANTHROPIC_API_KEY` ב-`.env` בלבד; הפנקס ב-`data/anthropic_ledger.json` נשמר ואין איפוס מונים.

## מצב בדיקה בטוח (SPK-META-02)
- `OUTBOUND_ENABLED` (ברירת מחדל: כבוי; רק הערך המדויק `true` מפעיל). כבוי = אין שום הודעת WhatsApp יוצאת: לא ACK, לא הודעות כשל, לא טופס, לא ניסיונות חוזרים, לא תשובות ללחיצות. העיבוד והשמירה ממשיכים כרגיל. החסימה היא ב-`GraphWhatsApp.post` (נקודת השליחה היחידה) ובנוסף ב-`pipeline.ts`, `outbox.ts` ו-`handlers.ts`. טפסים שנשמרו במצב כבוי נשארים בתור (PENDING) ויישלחו בהפעלה הבאה עם `true` אם החלון של 24 ש׳ פתוח.
- בדיקה מקומית (קריאה בלבד): `LOCAL_INSPECT_ENABLED=true` (+ `LOCAL_INSPECT_PORT`, ברירת מחדל 3001) מפעיל מאזין נפרד על 127.0.0.1: `GET /local/forms`, `GET /local/forms/<formId>`. אינו על פורט ה-webhook ולכן אינו עובר במנהרה; דוחה Host לא מקומי וכותרות פרוקסי.
- זמן עיבוד: ב-`receipts[id]` נשמרים `receivedAt`, `processingCompletedAt`, `processingDurationMs` (נקבעים פעם אחת בשמירת הטיוטה המוצלחת).
- תמלול: **אינו נשמר** (D16, דף הפרטיות ובדיקה קיימת). אין בנתונים תמלול לבדיקה; הראיה לשלב היא המדדים בלוג.
