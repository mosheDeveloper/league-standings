# Sprint Max — מדידת מהירות ריצה במובייל

אפליקציית PWA (עובדת כמו אפליקציה בטלפון: אפשר להוסיף למסך הבית) למדידה חוזרת של **מהירות הריצה המקסימלית** בזמן שהטלפון עליכם.

## מה היא עושה
- מודדת מהירות חיה + **שיא הריצה** מ־GPS.
- מזהה רמאות מסוג נסיעה ברכב: מקצב צעדים, bounce, ו־**tilt** של הטלפון.
- אחרי כמה ריצות מאושרות בונה **פרופיל אישי** — קפיצה למהירות רכב בלי טלטול ריצה תיפסל.
- בסוף הריצה מציבה אתכם מול טבלת ספורטאים שבחרתם.
- שיתוף: `אתה יותר מהיר מ-[שם]. מהירות הריצה המקסימאלית היא: XXX`.
- התחברות בפייסבוק / אינסטגרם (הרשאת חברים), או **המשך כאורח**. עמוד **שיאים**: מדינה, עולם, חברים (חברים דורשים חיבור לרשתות).

## התחברות Meta
ב־[`data/auth.json`](data/auth.json) הזינו `facebookAppId` מאפליקציית Meta, עם הרשאות `public_profile` ו־`user_friends`.
`user_friends` מחזיר רק חברים שגם הם התחברו ל־Sprint Max (דרישת פייסבוק).
בלי App ID כפתורי מטא נופלים להתחברות מקומית עם חברים לדוגמה. **אורח** נכנס בלי רשימת חברים, ובמסך שיאי חברים מופיעה הודעה שצריך להתחבר כדי להשוות. קהילת השיאים ב־[`data/records.json`](data/records.json).

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
Mobile-first PWA: GPS + motion running speed, max km/h, GPS-lock required to start, anti-cheat (still phone / no tilt = car), editable JSON athlete tables, Hebrew RTL share.
