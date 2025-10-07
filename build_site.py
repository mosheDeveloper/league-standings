
import os, sys, pandas as pd, numpy as np, datetime as dt
from pathlib import Path

def load_games(path: str) -> pd.DataFrame:
    df = pd.read_csv(path)
    needed = ["Round","GameInRound","HomeTeam","AwayTeam","HomeGoals","AwayGoals"]
    for col in needed:
        if col not in df.columns:
            raise ValueError(f"Missing required column: {col}")
    df["HomeGoals"] = pd.to_numeric(df["HomeGoals"], errors="coerce")
    df["AwayGoals"] = pd.to_numeric(df["AwayGoals"], errors="coerce")
    df = df.dropna(subset=["HomeTeam","AwayTeam","HomeGoals","AwayGoals"])
    df = df[(df["HomeTeam"].astype(str).str.strip()!="") & (df["AwayTeam"].astype(str).str.strip()!="")]
    df["Round"] = pd.to_numeric(df["Round"], errors="coerce")
    return df

def per_match_points(row):
    hg, ag = int(row["HomeGoals"]), int(row["AwayGoals"])
    if hg > ag:   return 3, 0, "H"
    if hg < ag:   return 0, 3, "A"
    return 1, 1, "D"

def compute_standings(df: pd.DataFrame) -> pd.DataFrame:
    if df.empty:
        return pd.DataFrame(columns=["Team","Played","Wins","Draws","Losses","GF","GA","GD","Points"])

    df[["HomePts","AwayPts","Outcome"]] = df.apply(per_match_points, axis=1, result_type="expand")

    home = df.groupby("HomeTeam").agg(
        Played=("HomeTeam","count"),
        Wins=("Outcome", lambda s: (s=="H").sum()),
        Draws=("Outcome", lambda s: (s=="D").sum()),
        Losses=("Outcome", lambda s: (s=="A").sum()),
        GF=("HomeGoals","sum"),
        GA=("AwayGoals","sum"),
        Points=("HomePts","sum"),
    ).reset_index().rename(columns={"HomeTeam":"Team"})

    away = df.groupby("AwayTeam").agg(
        Played=("AwayTeam","count"),
        Wins=("Outcome", lambda s: (s=="A").sum()),
        Draws=("Outcome", lambda s: (s=="D").sum()),
        Losses=("Outcome", lambda s: (s=="H").sum()),
        GF=("AwayGoals","sum"),
        GA=("HomeGoals","sum"),
        Points=("AwayPts","sum"),
    ).reset_index().rename(columns={"AwayTeam":"Team"})

    all_stats = pd.concat([home, away], ignore_index=True)
    tbl = all_stats.groupby("Team", as_index=False).sum(numeric_only=True)
    tbl["GD"] = tbl["GF"] - tbl["GA"]
    tbl = tbl.sort_values(by=["Points","GD","GF","Team"], ascending=[False, False, False, True]).reset_index(drop=True)
    return tbl[["Team","Played","Wins","Draws","Losses","GF","GA","GD","Points"]]

def per_round_table(df: pd.DataFrame) -> pd.DataFrame:
    cols = ["Round","Date","HomeTeam","AwayTeam","HomeGoals","AwayGoals","Stadium"]
    have_cols = [c for c in cols if c in df.columns]
    out = df.copy()
    if "Round" in out.columns:
        out = out.sort_values(["Round","Date"], na_position="last")
    return out[have_cols]

def df_to_html_table(df: pd.DataFrame) -> str:
    return df.to_html(index=False, border=0, classes="table", justify="center", escape=False)

def build_index(games_csv: str, out_dir: str):
    os.makedirs(out_dir, exist_ok=True)
    now = dt.datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC")

    try:
        games = load_games(games_csv)
    except Exception as e:
        # Escape braces in CSS by doubling them inside this f-string
        index_html = f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>League Standings</title>
  <style>
    body {{ font-family: system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif; margin: 24px; }}
    .wrap {{ max-width: 1100px; margin: 0 auto; }}
    .error {{ background: #ffecec; color: #b00020; padding: 12px 16px; border-radius: 8px; }}
  </style>
</head>
<body>
  <div class="wrap">
    <h1>🏆 League Standings</h1>
    <p class="error"><strong>Error:</strong> {str(e)}</p>
    <p>Make sure your <code>games.csv</code> has the columns: Round, GameInRound, Date, HomeTeam, AwayTeam, HomeGoals, AwayGoals, Stadium</p>
    <p><small>Last build: {now}</small></p>
  </div>
</body>
</html>"""
        Path(out_dir, "index.html").write_text(index_html, encoding="utf-8")
        return

    standings = compute_standings(games)
    rounds_view = per_round_table(games)

    standings_path = Path(out_dir, "standings.csv")
    standings.to_csv(standings_path, index=False, encoding="utf-8-sig")

    css = """
    :root { --bg:#0b1020; --card:#121933; --muted:#a6b1d5; --text:#ecf1ff; --accent:#6ea2ff; }
    * { box-sizing:border-box; }
    body { margin:0; background:var(--bg); color:var(--text); font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif; }
    .wrap { max-width:1200px; margin: 32px auto; padding: 0 16px; }
    h1 { font-size: clamp(24px, 3vw, 40px); margin: 0 0 16px; }
    .sub { color: var(--muted); margin-bottom: 24px; }
    .card { background: var(--card); border-radius: 16px; padding: 16px; box-shadow: 0 8px 24px rgba(0,0,0,.25); }
    .grid { display: grid; grid-template-columns: 1fr; gap: 16px; }
    @media (min-width: 900px) { .grid { grid-template-columns: 1fr 1fr; } }
    .table { width:100%; border-collapse: collapse; font-size: 14px; }
    .table thead th { text-align: left; padding: 10px 12px; position: sticky; top:0; background: #0f204a; color: #cfe0ff; }
    .table tbody td { padding: 10px 12px; border-top: 1px solid #26345e; }
    .table tbody tr:hover { background: #18244a; }
    .pill { display:inline-block; padding:2px 8px; border-radius:999px; background:#1b2a59; color:#cfe0ff; font-size:12px; }
    a.dl { text-decoration: none; color: var(--accent); }
    footer { color: var(--muted); margin-top: 18px; font-size: 13px; }
    """

    standings_html = df_to_html_table(standings)
    rounds_html = df_to_html_table(rounds_view)

    index_html = f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>League Standings</title>
  <style>{css}</style>
</head>
<body>
  <div class="wrap">
    <h1>🏆 League Standings</h1>
    <div class="sub">Auto-built from <code>games.csv</code>. <span class="pill">Last build: {dt.datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC")}</span></div>

    <div class="card" style="margin-bottom:16px">
      <h2 style="margin:0 0 8px">Table</h2>
      <div style="overflow:auto">{standings_html}</div>
      <p style="margin-top:12px"><a class="dl" href="./standings.csv" download>⬇️ Download standings.csv</a></p>
    </div>

    <div class="card">
      <h2 style="margin:0 0 8px">Games (all rounds)</h2>
      <div style="overflow:auto">{rounds_html}</div>
    </div>

    <footer>GF = Goals For, GA = Goals Against, GD = Goal Difference.</footer>
  </div>
</body>
</html>"""

    Path(out_dir, "index.html").write_text(index_html, encoding="utf-8")

if __name__ == "__main__":
    games_csv = sys.argv[1] if len(sys.argv) > 1 else "games.csv"
    out_dir = sys.argv[2] if len(sys.argv) > 2 else "dist"
    build_index(games_csv, out_dir)
    print(f"Built site into: {out_dir}")
