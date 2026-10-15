# Sprint Max — מדידת מהירות ריצה במובייל

אפליקציית PWA (עובדת כמו אפליקציה בטלפון: אפשר להוסיף למסך הבית) למדידה חוזרת של **מהירות הריצה המקסימלית** בזמן שהטלפון עליכם.

## מה היא עושה
- מודדת מהירות חיה + **שיא הריצה** מ־**Sensor Fusion**: GPS (~1Hz) משולב עם מד־תאוצה/ג׳ירו (~75Hz) ומסונן ב־Kalman — תופס שיאי ספרינט ש־GPS לבד מפספס.
- **במד המהירות** מוצגת רק מהירות ממקטע ריצה רציף של **לפחות ~5 שנ׳** עם תבנית ריצה (כיס או יד). נפנוף יד ונסיעה ברכב לא מוצגים ולא נספרים.
- **השיא הרשמי** = ממוצע המהירות הגבוה ביותר על חלון מתגלגל של ~1.5 שנ׳ **בתוך** מקטע הריצה הארוך (עם אימות GPS).
- מיקום מומלץ לטלפון: **כיס מכנסיים / חגורת מותן**; אפשר גם **יד יציבה בזמן ריצה**.
- מסנן תנועות לא־ריצה: מקצב צעדים, bounce, tilt, והתאמה ל־GPS.
- אחרי כמה ריצות תקינות בונה **פרופיל אישי** — קפיצה למהירות רכב בלי טלטול ריצה תיפסל.
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

## טבלאות JSON מקומיות (מקצוענים)
כל מסד המקצוענים סטטי תחת [`data/`](data/) — **בלי משיכה חיה מהרשת בזמן שימוש**:

| קובץ | תוכן |
|---|---|
| `data/catalog.json` | היררכיה: ענף → ליגה/קטגוריה → קבצי ליגה |
| `data/leagues/athletics-stars.json` | אתלטיקה — כוכבי ספרינט |
| `data/leagues/premier-league.json` | פרמייר ליג לפי קבוצות |
| `data/leagues/la-liga.json` | לה ליגה לפי קבוצות |
| `data/leagues/israeli-premier.json` | ליגת העל לפי קבוצות |
| `data/leagues/football-world.json` | כוכבים מליגות נוספות |
| `data/leagues/nba.json` | NBA לפי קבוצות |

מבנה ליגה:

```json
{
  "id": "premier-league",
  "teams": [
    {
      "id": "arsenal",
      "name": "ארסנל",
      "athletes": [
        { "id": "saka", "name": "בוקאיו סאקה", "maxSpeedKmh": 34.4 }
      ]
    }
  ]
}
```

המהירויות הן הערכות לפי פרסומים ציבוריים — עדכנו אותן בקלות בעורך ה־JSON במסך **מקצוענים**.

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
Mobile-first PWA: GPS + IMU sensor-fusion running speed (Kalman-filtered peak km/h), GPS-lock required to start, anti-cheat (still phone / no tilt = car), editable JSON athlete tables, Hebrew RTL share.

Field-test fusion debug: open with `?fusionDebug=1` and watch `[fusion]` logs (raw GPS vs fused speed) in the browser console.
