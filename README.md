# Static League Standings (CSV → GitHub Pages)

This repository builds a static website that shows your league **standings** and **all games**
from a simple CSV file (`games.csv`). The site is automatically deployed to **GitHub Pages**
on every push to `main` and once per day via a scheduled workflow.

## Files
- `games.csv` — your editable "database" of matches (columns below)
- `build_site.py` — reads `games.csv` and outputs `dist/index.html` + `dist/standings.csv`
- `requirements.txt` — Python dependencies
- `.github/workflows/deploy.yml` — CI that builds and deploys the site to Pages

## CSV format (`games.csv`)
Columns (case-sensitive):
- Round (1..15)
- GameInRound (1..8)
- Date (optional)
- HomeTeam (required)
- AwayTeam (required)
- HomeGoals (required integer)
- AwayGoals (required integer)
- Stadium (optional)

You can leave future games blank; only rows with both team names and numeric goal values are counted.

## Local build (optional)
```bash
pip install -r requirements.txt
python build_site.py games.csv
# open dist/index.html in your browser
```

## Deploy to GitHub Pages
1. Create a new **public** GitHub repo (or private with Pages enabled for your plan).
2. Push these files to a `main` branch.
3. In the repo: **Settings → Pages** →
   - Source: **GitHub Actions** (no branch selection needed with this workflow).
4. The workflow will run and publish to Pages. The URL appears under **Deployments → github-pages**.

Every time you edit `games.csv` and push, the site rebuilds automa
