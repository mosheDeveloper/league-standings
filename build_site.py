
import os, sys, json, pandas as pd, numpy as np, datetime as dt
from pathlib import Path

def read_json_df(path: str) -> pd.DataFrame:
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    return pd.DataFrame(data)

def load_games(path: str) -> pd.DataFrame:
    df = read_json_df(path)
    needed = ["Round","GameInRound","Date","HomeTeam","AwayTeam","HomeGoals","AwayGoals"]
    for col in needed:
        if col not in df.columns:
            raise ValueError(f"Missing required column: {col}")
    df["HomeGoals"] = pd.to_numeric(df["HomeGoals"], errors="coerce")
    df["AwayGoals"] = pd.to_numeric(df["AwayGoals"], errors="coerce")
    for c in ["HomeTeam","AwayTeam","Date"]:
        df[c] = df[c].astype(str).str.strip()
    df = df[(df["HomeTeam"] != "") & (df["AwayTeam"] != "")]
    df["Round"] = pd.to_numeric(df["Round"], errors="coerce")
    df["GameInRound"] = pd.to_numeric(df["GameInRound"], errors="coerce")
    return df

def load_teams(path: str) -> pd.DataFrame:
    df = read_json_df(path)
    if "Team" not in df.columns:
        raise ValueError("teams.json must include a 'Team' field")
    df["Team"] = df["Team"].astype(str).str.strip()
    df = df[df["Team"] != ""]
    return df[["Team"]]

def per_match_points(row):
    hg = row["HomeGoals"]
    ag = row["AwayGoals"]
    if pd.isna(hg) or pd.isna(ag):
        return 0, 0, "N"
    hg = int(hg); ag = int(ag)
    if hg > ag:   return 3, 0, "H"
    if hg < ag:   return 0, 3, "A"
    return 1, 1, "D"

def comp_rank(sorted_df: pd.DataFrame) -> pd.Series:
    ranks, last_key, last_rank = [], None, 0
    for i, row in enumerate(sorted_df.itertuples(index=False), start=1):
        key = (row.Points, row.GD, row.GF)
        if key != last_key:
            last_rank = i
            last_key = key
        ranks.append(last_rank)
    return pd.Series(ranks, index=sorted_df.index, name="Rank")

def ensure_all_teams(standings: pd.DataFrame, all_teams_df: pd.DataFrame) -> pd.DataFrame:
    zeros = all_teams_df.copy()
    for c in ["Played","Wins","Draws","Losses","GF","GA","GD","Points"]:
        zeros[c] = 0
    merged = zeros.merge(standings, on="Team", how="left", suffixes=("_z",""))
    for c in ["Played","Wins","Draws","Losses","GF","GA","GD","Points"]:
        merged[c] = pd.to_numeric(merged[c], errors="coerce").fillna(0).astype(int)
    return merged[["Team","Played","Wins","Draws","Losses","GF","GA","GD","Points"]]

def compute_standings(games: pd.DataFrame, teams_df: pd.DataFrame) -> pd.DataFrame:
    if games.empty:
        st = ensure_all_teams(pd.DataFrame(columns=["Team","Played","Wins","Draws","Losses","GF","GA","GD","Points"]), teams_df)
        st = st.sort_values(by=["Points","GD","GF","Team"], ascending=[False, False, False, True]).reset_index(drop=True)
        st["Rank"] = range(1, len(st)+1)
        return st[["Rank","Team","Played","Wins","Draws","Losses","GF","GA","GD","Points"]]

    games[["HomePts","AwayPts","Outcome"]] = games.apply(per_match_points, axis=1, result_type="expand")
    played = games[games["Outcome"] != "N"].copy()

    if played.empty:
        st = ensure_all_teams(pd.DataFrame(columns=["Team","Played","Wins","Draws","Losses","GF","GA","GD","Points"]), teams_df)
        st = st.sort_values(by=["Points","GD","GF","Team"], ascending=[False, False, False, True]).reset_index(drop=True)
        st["Rank"] = range(1, len(st)+1)
        return st[["Rank","Team","Played","Wins","Draws","Losses","GF","GA","GD","Points"]]

    home = played.groupby("HomeTeam").agg(
        Played=("HomeTeam","count"),
        Wins=("Outcome", lambda s: (s=="H").sum()),
        Draws=("Outcome", lambda s: (s=="D").sum()),
        Losses=("Outcome", lambda s: (s=="A").sum()),
        GF=("HomeGoals","sum"),
        GA=("AwayGoals","sum"),
        Points=("HomePts","sum"),
    ).reset_index().rename(columns={"HomeTeam":"Team"})

    away = played.groupby("AwayTeam").agg(
        Played=("AwayTeam","count"),
        Wins=("Outcome", lambda s: (s=="A").sum()),
        Draws=("Outcome", lambda s: (s=="D").sum()),
        Losses=("Outcome", lambda s: (s=="H").sum()),
        GF=("AwayGoals","sum"),
        GA=("HomeGoals","sum"),
        Points=("AwayPts","sum"),
    ).reset_index().rename(columns={"AwayTeam":"Team"})

    agg = pd.concat([home, away], ignore_index=True).groupby("Team", as_index=False).sum(numeric_only=True)
    agg["GD"] = agg["GF"] - agg["GA"]

    tbl = ensure_all_teams(agg, teams_df)
    tbl = tbl.sort_values(by=["Points","GD","GF","Team"], ascending=[False, False, False, True]).reset_index(drop=True)
    tbl["Rank"] = comp_rank(tbl)
    return tbl[["Rank","Team","Played","Wins","Draws","Losses","GF","GA","GD","Points"]]

def per_round_table(games: pd.DataFrame) -> pd.DataFrame:
    cols = ["Round","Date","HomeTeam","AwayTeam","HomeGoals","AwayGoals"]
    out = games.copy()
    return out[cols].sort_values(["Round","Date"], na_position="last")

def df_to_html_table(df: pd.DataFrame) -> str:
    return df.to_html(index=False, border=0, classes="table", justify="center", escape=False)

def build_index(games_path: str, out_dir: str, teams_path: str):
    os.makedirs(out_dir, exist_ok=True)
    games = load_games(games_path)
    teams_df = load_teams(teams_path)

    standings = compute_standings(games, teams_df)
    rounds_view = per_round_table(games)

    Path(out_dir, "standings.csv").write_text(standings.to_csv(index=False, encoding="utf-8-sig"), encoding="utf-8")

    css = """
    :root { --bg:#0b1020; --card:#121933; --muted:#a6b1d5; --text:#ecf1ff; --accent:#6ea2ff; }
    * { box-sizing:border-box; }
    body { margin:0; background:var(--bg); color:var(--text); font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif; direction: rtl; }
    .wrap { max-width:1200px; margin: 32px auto; padding: 0 16px; }
    h1 { font-size: clamp(24px, 3vw, 40px); margin: 0 0 16px; }
    .sub { color: var(--muted); margin-bottom: 24px; }
    .card { background: var(--card); border-radius: 16px; padding: 16px; box-shadow: 0 8px 24px rgba(0,0,0,.25); }
    .table { width:100%; border-collapse: collapse; font-size: 14px; }
    .table thead th { text-align: right; padding: 10px 12px; position: sticky; top:0; background: #0f204a; color: #cfe0ff; }
    .table tbody td { padding: 10px 12px; border-top: 1px solid #26345e; }
    .table tbody tr:hover { background: #18244a; }
    a.dl { text-decoration: none; color: var(--accent); }
    footer { color: var(--muted); margin-top: 18px; font-size: 13px; }
    """

    standings_html = df_to_html_table(standings)
    rounds_html = df_to_html_table(rounds_view)

    html = f"""<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>טבלת ליגה</title>
  <style>{css}</style>
</head>
<body>
  <div class="wrap">
    <h1>🏆 טבלת ליגה</h1>
    <div class="sub">נבנה אוטומטית מ- <code>games.json</code> ו- <code>teams.json</code>.</div>
    <div class="card" style="margin-bottom:16px">
      <h2 style="margin:0 0 8px">טבלה</h2>
      <div style="overflow:auto">{standings_html}</div>
      <p style="margin-top:12px"><a class="dl" href="./standings.csv" download>⬇️ הורד standings.csv</a></p>
    </div>
    <div class="card">
      <h2 style="margin:0 0 8px">כל המשחקים</h2>
      <div style="overflow:auto">{rounds_html}</div>
    </div>
    <footer>GF = שערים בעד, GA = שערים נגד, GD = הפרש שערים. הדירוג בסגנון תחרותי (1,1,3...).</footer>
  </div>
</body>
</html>"""
    Path(out_dir, "index.html").write_text(html, encoding="utf-8")

if __name__ == "__main__":
    games_path = sys.argv[1] if len(sys.argv) > 1 else "games.json"
    out_dir = sys.argv[2] if len(sys.argv) > 2 else "dist"
    teams_path = sys.argv[3] if len(sys.argv) > 3 else "teams.json"
    build_index(games_path, out_dir, teams_path)
    print(f"Built site into: {out_dir}")
