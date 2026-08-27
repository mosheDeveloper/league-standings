# Sprint Max — מדידת מהירות ריצה במובייל

אפליקציית PWA (עובדת כמו אפליקציה בטלפון: אפשר להוסיף למסך הבית) למדידה חוזרת של **מהירות הריצה המקסימלית** בזמן שהטלפון עליכם.

## מה היא עושה
- מודדת מהירות חיה + **שיא הריצה** מ־GPS.
- מזהה רמאות מסוג נסיעה ברכב: מקצב צעדים, bounce, ו־**tilt** של הטלפון.
- אחרי כמה ריצות מאושרות בונה **פרופיל אישי** — קפיצה למהירות רכב בלי טלטול ריצה תיפסל.
- בסוף הריצה מציבה אתכם מול טבלת ספורטאים שבחרתם.
- שיתוף: `אתה יותר מהיר מ-[שם]. מהירות הריצה המקסימאלית היא: XXX`.
- התחברות בפייסבוק / אינסטגרם (הרשאת חברים), או **המשך כאורח**. עמוד **שיאים**: מדינה, עולם, חברים (חברים דורשים חיבור לרשתות).

## התחברות ופרסום Meta
1. צרו אפליקציה ב־[Meta for Developers](https://developers.facebook.com/apps) עם מוצר **Facebook Login**.
2. הוסיפו את דומיין GitHub Pages (ו־`localhost` לבדיקות) תחת App Domains / Website / Valid OAuth Redirect URIs.
3. הזינו את ה־**App ID** (מזהה ציבורי) ב־[`data/auth.json`](data/auth.json) כ־`facebookAppId`, או במסך ההתחברות באפליקציה («מזהה אפליקציית Meta»).
4. הרשאות: `public_profile`, `email`, `user_friends` (בפרודקשן `user_friends` דורש App Review). מחזיר רק חברים שגם התחברו ל־Sprint Max.
5. **פרסום ל־Facebook**: אחרי App ID, כפתור Facebook פותח את Share Dialog הרשמי של Meta (`FB.ui`) — המשתמש מאשר והפוסט עולה לפיד.
6. **Instagram**: התחברות דרך אותו Meta Login (שאיבת פרופיל/חברים). פרסום לסטורי אישי בלי חשבון Business נעשה דרך שיתוף המערכת עם כרטיס התמונה (אין Compose API ציבורי לחשבון אישי מהדפדפן).
7. בלי App ID כפתורי Meta **חסומים** — אין יותר התחברות מדומה. **אורח** נשאר בלי לוח חברים.
8. סנכרון שיאים בין מכשירים (אופציונלי): פרסו `workers/community.js` ל־Cloudflare Worker + KV, והעתיקו את ה־URL ל־`communityEndpoint` ב־`auth.json`.

## טבלאות JSON לעריכה
כל הטבלאות בתיקיית [`data/`](data/):

| קובץ | תוכן |
|---|---|
| `data/tables.json` | קטלוג הטבלאות |
| `data/football-stars.json` | כוכבי כדורגל |
| `data/premier-league.json` | פרמייר ליג |
| `data/israeli-football.json` | כדורגל ישראלי |
| `data/athletics.json` | ספרינטרים |
| `data/nba.json` | כוכבי NBA |

מבנה ספורטאי:

```json
{ "id": "mbappe", "name": "קיליאן מבאפה", "team": "ריאל מדריד", "maxSpeedKmh": 38.0 }
```

המהירויות הן הערכות לפי פרסומים ציבוריים — עדכנו אותן בקלות. באפליקציה יש גם עורך JSON (נשמר במכשיר כשכבה מעל הקובץ).

## הרצה מקומית
```bash
python3 -m http.server 4173
# פתיחה: http://localhost:4173
```

בטלפון עם GPS דולק: כפתור ההתחלה נפתח רק אחרי נעילת מיקום. בלי קליטה תופיע התרעה לשפר מיקום. נסיעה ברכב נחסמת אם הטלפון כמעט לא זז.

## Tests
```bash
npm test
```

## Deploy
Push to `main` publishes the PWA to GitHub Pages via `.github/workflows/deploy.yml` (runs unit tests first). Enable **Settings → Pages → GitHub Actions**.

## English
Mobile-first PWA: GPS + motion running speed, max km/h, GPS-lock required to start, anti-cheat (still phone / no tilt = car), editable JSON athlete tables, Hebrew RTL share.
