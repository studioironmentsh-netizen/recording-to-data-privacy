# SPK-META-01 — תוצאות (ביניים)

תאריך: 2026-11-19 · ענף: `spike/meta-whatsapp`

## החלטה נוכחית: **NO-GO זמני / שער Meta לא נסגר**
שלוש בדיקות הקבלה החיות לא בוצעו (BLOCKED). אין הוכחה בפועל. הקוד והבדיקות המקומיות מוכנים לריצה חיה.

## מה נבנה (`apps/api`)
שרת `node:http` + TypeScript (Node 24 type stripping; תלויות: `typescript`, `@types/node`, מנעולות exact).
- אימות GET Webhook (השוואה בזמן קבוע) · אימות חתימת POST (HMAC-SHA256 על raw body)
- פענוח `messages`: audio, `button_reply`, other; סטטוסים מתעלמים
- allowlist טכנאים (`ALLOWED_TECHNICIAN_WA_IDS`) · dedup לפי wamid · ack 200 מיידי
- מדיה: lookup → הורדה עם Bearer → מגבלת גודל → sha256 → קובץ זמני נמחק מיד
- שליחת טופס עם 2 כפתורים (`scripts/send-form.ts`), id כפתור = `ap|ed:<form_id>:<revision>` + אימות מול `context.id`
- לחיצה ישנה/לא תואמת/לא מוכרת → נדחית, ללא שינוי מצב
- לוגים מובנים; מספרים מוסתרים, סודות מנוקים, בלי תוכן הודעות

## בדיקות שהורצו בפועל
`npm test` + `tsc --noEmit`: **16/16 עברו** (Mock של Graph API; שרת HTTP אמיתי מקומי עם חתימות אמיתיות).

| בדיקה | תוצאה |
|---|---|
| L-01…L-09 (מקומי) | PASS (mock) — לא נחשב PASS לשער |
| H-01 HTTPS ציבורי | **BLOCKED** |
| META-01 הודעת קול חיה | **NOT RUN** (תלוי ב-H-01) |
| META-02 כפתורים חיים | **NOT RUN** |
| META-03 שיוך לטופס חי | **NOT RUN** |

## ראיות
פלט `npm test` (16 עברו). ראיות חיות — אין עדיין.

## מגבלות Meta ידועות
- כפתורי תשובה: עד 3, כותרת ≤20 תווים. מחוץ לחלון 24 שעות נדרש Template (לא נבדק; מחוץ ל-scope).
- URL מדיה תקף ~5 דקות; media id ~7 ימים. מקורות: תיעוד Meta ([Media](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/media), [Supported features and limits](https://developers.facebook.com/documentation/business-messaging/whatsapp/direct-send/supported-features-and-limits/)); אומת חלקית בחיפוש.
- **לא אומת מול Meta:** נוכחות `context.id` בלחיצת כפתור (הקוד סובל היעדרו, אך אז השיוך נשען על ה-id בלבד); התאמת `sha256` שמדווח ע"י Meta ל-hex של הבייטים (נרשם ללוג, לא חוסם).
- אחסון JSON בקובץ — לניסוי בלבד, ללא נעילה בין תהליכים.
- Dedup מסמן הודעה כמטופלת לפני העיבוד: כשל באמצע = אין ניסיון חוזר.

## עלויות
₪0 עד כה. שיחות שירות (תגובה בתוך 24 שעות) בדרך כלל לא מחויבות; יש לאמת מול תמחור Meta העדכני. מנהרת HTTPS: Cloudflare quick tunnel / ngrok חינמי — ללא חיוב.

## סיכונים
תלות בחלון 24 שעות · Token זמני של DEV פג · כתובת מנהרה משתנה בכל הפעלה (דורש עדכון Callback URL) · חשיפת שרת לאינטרנט (מוגן חתימה; מאזין על 127.0.0.1 והמנהרה מקומית).

## נדרש ממפעילה (BLOCKED)
1. **צרי `apps/api/.env`** (מועתק מ-`.env.example`) עם ערכים אמיתיים: `WHATSAPP_VERIFY_TOKEN` (מחרוזת אקראית שתבחרי), `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_APP_SECRET` (Meta → App settings → Basic), `WHATSAPP_PHONE_NUMBER_ID`, `ALLOWED_TECHNICIAN_WA_IDS` (מספר הטלפון שלך ללא +). אל תדביקי אותם בצ'אט.
2. **התקיני מנהרה:** `winget install Cloudflare.cloudflared` (חינמי, ללא חשבון). אשרי לי להתקין, או הריצי בעצמך.
3. בטרמינל אחד: `cd apps/api; npm.cmd start`. בשני: `cloudflared tunnel --url http://127.0.0.1:3000` והעתיקי את כתובת `https://….trycloudflare.com`.
4. ב-Meta → WhatsApp → Configuration → Webhook: Callback URL = `<הכתובת>/webhook`, Verify token = הערך מה-.env, לחצי Verify and save, והירשמי לשדה **messages**.
5. מהטלפון: שלחי הודעת קול למספר הבדיקה של Meta; לאחר מכן (תוך שעה, בחלון 24 שעות) אמרי לי ואריץ `send-form` לבדיקות META-02/03.

## המלצה
המשך לריצה חיה לאחר ביצוע 1–4. אם META-01/02/03 כלשהי תיכשל — עצירה ותיעוד לפני המשך פיתוח התלוי ב-WhatsApp. GO סופי רק לאחר 3 PASS חיים.
