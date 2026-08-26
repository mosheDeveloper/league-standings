# Sprint Max — מדידת מהירות ריצה במובייל

אפליקציית PWA (עובדת כמו אפליקציה בטלפון: אפשר להוסיף למסך הבית) למדידה חוזרת של **מהירות הריצה המקסימלית** בזמן שהטלפון עליכם.

## מה היא עושה
- מודדת מהירות חיה + **שיא הריצה** מ־GPS.
- מזהה רמאות מסוג נסיעה ברכב: מקצב צעדים, bounce, ו־**tilt** של הטלפון.
- אחרי כמה ריצות מאושרות בונה **פרופיל אישי** — קפיצה למהירות רכב בלי טלטול ריצה תיפסל.
- בסוף הריצה מציבה אתכם מול טבלת ספורטאים שבחרתם.
- שיתוף: `אתה יותר מהיר מ-[שם]. מהירות הריצה המקסימאלית היא: XXX`.

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

במחשב בלי GPS: **סימולציית ריצה** / **סימולציית רכב**. בטלפון: החזיקו את הכפתור הגדול (HTTPS נדרש ל־GPS).

## Tests
```bash
npm test
```

## Deploy
Push to `main` publishes the PWA to GitHub Pages via `.github/workflows/deploy.yml` (runs unit tests first). Enable **Settings → Pages → GitHub Actions**.

## English
Mobile-first PWA: GPS + motion running speed, max km/h, anti-cheat (cadence/tilt, GPS spikes, ~45 km/h cap, learned profile), editable JSON athlete tables, Hebrew RTL share line, installable (manifest + service worker), demo mode for desktop.
