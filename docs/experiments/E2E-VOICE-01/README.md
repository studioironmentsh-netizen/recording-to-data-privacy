# E2E-VOICE-01 — הודעה קולית → STT מקומי → Claude → טופס → שני כפתורים

סטטוס: **מימוש מקומי הושלם; Claude אמיתי ו-WhatsApp אמיתי לא נבדקו.** ראו דוח המסירה לפרטים.

## זרימה (`apps/api/src/pipeline/`)
webhook (חתימה, allowlist, dedup, 200 מיידי) → `VoicePipeline.processVoice` → הורדת מדיה לקובץ זמני → `PythonSttWorker` (`python/stt_worker.py`)
→ `StructuredExtractor` (פרומפט קפוא, ≤3 קריאות, פענוח דטרמיניסטי, `validate-extraction.ts`, salvage ברמת שדה) → בקרות K1–K8 + presenter (`python/controls_cli.py`)
→ `formview.ts` (שלושה מצבי תצוגה, M-2) → `sendFormMessage` (שני כפתורים: אשר / תקן או הוסף).
כפתור "תקן או הוסף" פותח הקשר תיקון (10 דק׳); ההקלטה הבאה יוצרת revision חדש (מיזוג רק של שדות מאומתים).

## הרצה
- סביבת STT: `python -m venv apps/api/python/.venv-stt` ואז `pip install --only-binary=:all: -r apps/api/python/requirements-stt.txt`
- אימות המודל: `python apps/api/python/verify_model.py <model_dir>`
- בדיקות: `cd apps/api && npm.cmd run typecheck && npm.cmd test`
- E2E מקומי (STT אמיתי, Meta/Claude מדומים): `node scripts/e2e-local-mock.ts <model_dir> <audio>...`
- שרת: `PIPELINE_ENABLED=true`, `STT_MODEL_DIR=<abs>` ב-`.env` (ראו `.env.example`). עם `EXTRACTOR_MODE=mock` השרת מתמלל בלבד ואינו קורא ל-Claude.

## פתיחת Claude אמיתי (רק אחרי אישור משה)
כל ארבעת התנאים נדרשים, אחרת השרת מסרב לעלות: `EXTRACTOR_MODE=real`, `ANTHROPIC_LIVE_APPROVAL=<ביטוי האישור המדויק, ראו llm.ts>`,
`ANTHROPIC_KEY_ROTATION_CONFIRMED=yes`, `ANTHROPIC_API_KEY=<מפתח חדש>`. פנקס `data/anthropic_ledger.json` חוסם מעל 60 קריאות / $10.
