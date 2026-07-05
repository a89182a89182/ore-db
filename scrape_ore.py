from __future__ import annotations

import base64
import json
import re
import subprocess
from datetime import datetime
from html import unescape
from pathlib import Path
from typing import Any
from urllib.error import URLError
from urllib.request import Request, urlopen


BASE_URL = "http://game.tinycafe.com/ore/ore.cgi"
OUT_ROOT = Path(__file__).resolve().parent
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Codex Ore Scraper"
CACHE_MAX_AGE_SECONDS = 48 * 60 * 60
FETCH_EVENTS: list[dict[str, str]] = []


def record_fetch(url: str, source: str, error: str = "") -> None:
    event = {
        "url": url,
        "source": source,
        "fetched_at": datetime.now().astimezone().isoformat(timespec="seconds"),
    }
    if error:
        event["error"] = error
    FETCH_EVENTS.append(event)


def read_text_guess(path: Path) -> str:
    data = path.read_bytes()
    for encoding in ("utf-8", "cp950"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="ignore")


def live_dir_for_today() -> Path:
    return OUT_ROOT / f"live-{datetime.now().astimezone().strftime('%Y-%m-%d')}"


def cache_live_text(url: str, text: str) -> None:
    match = re.search(r"[?&]mode=teisatu&saku=(\d+)", url)
    if not match:
        return
    live_dir = live_dir_for_today()
    live_dir.mkdir(parents=True, exist_ok=True)
    (live_dir / f"saku_{match.group(1)}.html").write_text(text, encoding="utf-8")


def fetch_cached_text(url: str, max_age_seconds: int = CACHE_MAX_AGE_SECONDS) -> str | None:
    match = re.search(r"[?&]mode=teisatu&saku=(\d+)", url)
    if not match:
        return None
    now_ts = datetime.now().timestamp()
    live_dirs = sorted((path for path in OUT_ROOT.glob("live-*") if path.is_dir()), key=lambda path: path.name, reverse=True)
    for live_dir in live_dirs:
        cached_path = live_dir / f"saku_{match.group(1)}.html"
        if not cached_path.exists():
            continue
        if now_ts - cached_path.stat().st_mtime > max_age_seconds:
            continue
        text = read_text_guess(cached_path)
        return text
    return None


def fetch_text_with_powershell(url: str) -> str:
    def ps_quote(value: str) -> str:
        return "'" + value.replace("'", "''") + "'"

    command = (
        "$ProgressPreference='SilentlyContinue'; "
        "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; "
        f"$resp=Invoke-WebRequest -Uri {ps_quote(url)} -UserAgent {ps_quote(USER_AGENT)} -UseBasicParsing -TimeoutSec 30; "
        "$resp.Content"
    )
    encoded = base64.b64encode(command.encode("utf-16le")).decode("ascii")
    completed = subprocess.run(
        ["powershell", "-NoProfile", "-EncodedCommand", encoded],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=40,
    )
    if completed.returncode != 0 or not completed.stdout:
        raise URLError(completed.stderr.strip() or "PowerShell fetch failed")
    return completed.stdout


def fetch_text(url: str) -> str:
    req = Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urlopen(req, timeout=30) as resp:
            data = resp.read()
        text = data.decode("cp950", errors="ignore")
        cache_live_text(url, text)
        record_fetch(url, "fresh_web_scrape")
        return text
    except (OSError, URLError) as exc:
        try:
            text = fetch_text_with_powershell(url)
            cache_live_text(url, text)
            record_fetch(url, "fresh_web_scrape")
            return text
        except Exception:
            pass
        cached = fetch_cached_text(url)
        if cached is not None:
            record_fetch(url, "cache_fallback", type(exc).__name__)
            return cached
        record_fetch(url, "unavailable", type(exc).__name__)
        raise


def clean_text(text: str) -> str:
    text = re.sub(r"<br\s*/?>", "\n", text, flags=re.I)
    text = re.sub(r"<[^>]+>", "", text)
    text = unescape(text)
    text = text.replace("\xa0", " ")
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def find1(pattern: str, text: str, flags: int = 0, default: str = "") -> str:
    match = re.search(pattern, text, flags)
    return match.group(1).strip() if match else default


def extract_skill_map(page_html: str) -> dict[str, str]:
    skill_map: dict[str, str] = {}
    for filename, title in re.findall(r'case "img/([^"]+)": title = "([^"]+)";', page_html):
        skill_map[filename] = title
    return skill_map


def extract_table_rows(table_html: str) -> list[str]:
    rows = []
    pattern = re.compile(r"(<tr[^>]*BgColor=[^>]*>.*?)(?=<tr[^>]*BgColor=|\s*\Z)", re.I | re.S)
    for match in pattern.finditer(table_html):
        rows.append(match.group(1))
    return rows


def extract_cells(row_html: str) -> list[str]:
    return re.findall(r"<td\b.*?</td>", row_html, flags=re.I | re.S)


def parse_name_cell(cell_html: str) -> tuple[str, str | None, bool]:
    is_computer = "monitor.png" in cell_html or "COLOR:#00C300" in cell_html.upper()
    anchor_name = find1(r">([^<>]+)</a>", cell_html, re.I | re.S)
    font_name = find1(r'<font[^>]*font-size:16px[^>]*>\s*(?:<B>)?([^<]+)(?:</B>)?\s*</font>', cell_html, re.I | re.S)
    owner = find1(r'<font[^>]*font-size:11px[^>]*>([^<]+)</font>', cell_html, re.I | re.S)
    name = anchor_name or font_name
    return clean_text(name), clean_text(owner) or None, is_computer


def parse_hand_and_style(cell_html: str) -> tuple[str, str]:
    text = clean_text(cell_html)
    parts = text.split(" ", 1)
    hand = parts[0] if parts else ""
    style = parts[1] if len(parts) > 1 else ""
    return hand, style


def parse_stat_cell(cell_html: str) -> dict[str, str]:
    parts = [clean_text(part) for part in re.split(r"<br\s*/?>", cell_html, flags=re.I) if clean_text(part)]
    if not parts:
        return {"current": "", "career": ""}
    if len(parts) == 1:
        return {"current": parts[0], "career": ""}
    return {"current": parts[0], "career": parts[1]}


def parse_age_years(cell_html: str) -> tuple[int | None, str]:
    age_str = find1(r"<B>(\d+)</B>", cell_html, re.I)
    years = clean_text(find1(r"</B>歲<span[^>]*>(.*?)</span>", cell_html, re.I | re.S))
    years = years.lstrip(",").strip()
    return (int(age_str) if age_str else None), years


def parse_money(cell_html: str) -> tuple[str, str]:
    cash = clean_text(find1(r"<B>([^<]+)</B>", cell_html, re.I | re.S))
    salary = clean_text(find1(r"<span[^>]*>([^<]+)</span>", cell_html, re.I | re.S))
    salary = salary.replace("/年", "").strip()
    return cash, salary


def parse_ability(cell_html: str) -> dict[str, str]:
    rank_img = find1(r"img/([^\"/]+\.gif)", cell_html, re.I)
    value = find1(r"<B>([^<]+)</B>", cell_html, re.I | re.S)
    return {"grade_icon": rank_img, "value": value}


def normalize_pitcher_role(raw_role: str) -> str:
    return {
        "先發": "先發",
        "中繼": "中繼",
        "救援": "CP",
        "SP": "SP",
        "RP": "RP",
        "CP": "CP",
        "CL": "CP",
    }.get(raw_role, raw_role)


def parse_skills(cell_html: str, skill_map: dict[str, str]) -> list[str]:
    skills = []
    pitch_texts = [clean_text(x) for x in re.findall(r"<font[^>]*>([^<]+)</font>", cell_html, re.I | re.S)]
    for item in pitch_texts:
        if item:
            skills.append(item)
    for filename in re.findall(r"img/([^\"/]+\.gif)", cell_html, re.I):
        mapped = skill_map.get(filename)
        if mapped:
            skills.append(mapped)
    deduped: list[str] = []
    seen: set[str] = set()
    for skill in skills:
        if skill not in seen:
            deduped.append(skill)
            seen.add(skill)
    return deduped


def parse_record_tables(page_html: str) -> dict[str, Any]:
    record_match = re.search(
        r'<table width="100%" border=1 cellspacing=0 cellpadding="?1"? bgcolor="#FFFFFF">\s*'
        r"<tr[^>]*>.*?出賽.*?</tr>\s*<tr[^>]*>(.*?)</tr>",
        page_html,
        re.I | re.S,
    )
    metric_match = re.search(
        r'<table border=1 width="100%" cellspacing="?0"? cellpadding="?1"? bgcolor="#FFFFFF">\s*'
        r"<tr[^>]*>.*?打擊率.*?</tr>\s*<tr[^>]*>(.*?)</tr>",
        page_html,
        re.I | re.S,
    )

    record_values = [clean_text(x) for x in re.findall(r"<td[^>]*>(.*?)</td>", record_match.group(1), re.I | re.S)] if record_match else []
    metric_values = [clean_text(x) for x in re.findall(r"<td[^>]*>(.*?)</td>", metric_match.group(1), re.I | re.S)] if metric_match else []

    remaining_games = ""
    remaining_today = ""
    if len(record_values) >= 7:
        remaining_games = find1(r"(\d+)", record_values[6])
        remaining_today = find1(r"今日剩(\d+)場", record_values[6])

    return {
        "games_played": record_values[0] if len(record_values) > 0 else "",
        "win_pct": record_values[1] if len(record_values) > 1 else "",
        "wins": record_values[2] if len(record_values) > 2 else "",
        "losses": record_values[3] if len(record_values) > 3 else "",
        "ties": record_values[4] if len(record_values) > 4 else "",
        "streak": record_values[5] if len(record_values) > 5 else "",
        "remaining_games": remaining_games,
        "remaining_today_games": remaining_today,
        "batting_avg": metric_values[0] if len(metric_values) > 0 else "",
        "era": metric_values[1] if len(metric_values) > 1 else "",
        "runs_per_game": metric_values[2] if len(metric_values) > 2 else "",
        "home_runs": metric_values[3] if len(metric_values) > 3 else "",
        "steals": metric_values[4] if len(metric_values) > 4 else "",
        "errors": metric_values[5] if len(metric_values) > 5 else "",
    }


def parse_batters(page_html: str, team_name: str, season: str, skill_map: dict[str, str]) -> list[dict[str, Any]]:
    roster_tables = re.findall(
        r'<table width="100%" border=0 cellspacing=1 cellpadding=1 bgcolor="#000000">(.*?)</table>',
        page_html,
        re.I | re.S,
    )
    rows = extract_table_rows(roster_tables[0] if roster_tables else "")
    players: list[dict[str, Any]] = []
    for row in rows:
        cells = extract_cells(row)
        if len(cells) < 21:
            continue
        slot = find1(r"name=jun\d+ value=(\d+)", cells[0], re.I)
        position = clean_text(re.sub(r"<input[^>]+>", "", cells[0], flags=re.I))
        name, owner, is_computer = parse_name_cell(cells[1])
        hand, batting_style = parse_hand_and_style(cells[2])
        age, years = parse_age_years(cells[19])
        cash, salary = parse_money(cells[20])
        players.append(
            {
                "season": season,
                "team": team_name,
                "slot": slot,
                "category": "batter",
                "name": name,
                "owner": owner,
                "is_computer": is_computer,
                "position_or_role": position,
                "handedness": hand,
                "style": batting_style,
                "abilities": {
                    "power": parse_ability(cells[3]),
                    "contact": parse_ability(cells[4]),
                    "speed": parse_ability(cells[5]),
                    "arm": parse_ability(cells[6]),
                    "defense": parse_ability(cells[7]),
                },
                "skills": parse_skills(cells[8], skill_map),
                "contract": clean_text(cells[18]),
                "age": age,
                "experience": years,
                "cash": cash,
                "salary": salary,
                "current_batting": {
                    "batting_avg": parse_stat_cell(cells[9])["current"],
                    "at_bats": parse_stat_cell(cells[10])["current"],
                    "hits": parse_stat_cell(cells[11])["current"],
                    "home_runs": parse_stat_cell(cells[12])["current"],
                    "rbi": parse_stat_cell(cells[13])["current"],
                    "walk_hit_by_pitch": parse_stat_cell(cells[14])["current"],
                    "sacrifice_bunts": parse_stat_cell(cells[15])["current"],
                    "steals": parse_stat_cell(cells[16])["current"],
                    "errors": parse_stat_cell(cells[17])["current"],
                },
                "career_batting": {
                    "batting_avg": parse_stat_cell(cells[9])["career"],
                    "at_bats": parse_stat_cell(cells[10])["career"],
                    "hits": parse_stat_cell(cells[11])["career"],
                    "home_runs": parse_stat_cell(cells[12])["career"],
                    "rbi": parse_stat_cell(cells[13])["career"],
                    "walk_hit_by_pitch": parse_stat_cell(cells[14])["career"],
                    "sacrifice_bunts": parse_stat_cell(cells[15])["career"],
                    "steals": parse_stat_cell(cells[16])["career"],
                    "errors": parse_stat_cell(cells[17])["career"],
                },
            }
        )
    return players


def parse_pitchers(page_html: str, team_name: str, season: str, skill_map: dict[str, str]) -> list[dict[str, Any]]:
    roster_tables = re.findall(
        r'<table width="100%" border=0 cellspacing=1 cellpadding=1 bgcolor="#000000">(.*?)</table>',
        page_html,
        re.I | re.S,
    )
    rows = extract_table_rows(roster_tables[1] if len(roster_tables) > 1 else "")
    players: list[dict[str, Any]] = []
    for row in rows:
        cells = extract_cells(row)
        if len(cells) < 19:
            continue
        slot = find1(r"name=jun\d+ value=(\d+)", cells[0], re.I)
        raw_role = find1(r"name=posit\d+ value=([^>]+)", cells[2], re.I)
        role = normalize_pitcher_role(raw_role)
        name, owner, is_computer = parse_name_cell(cells[1])
        hand, pitching_style = parse_hand_and_style(cells[2])
        age, years = parse_age_years(cells[17])
        cash, salary = parse_money(cells[18])
        players.append(
            {
                "season": season,
                "team": team_name,
                "slot": slot,
                "category": "pitcher",
                "name": name,
                "owner": owner,
                "is_computer": is_computer,
                "position_or_role": role,
                "raw_position_or_role": raw_role,
                "handedness": hand,
                "style": pitching_style,
                "abilities": {
                    "control": parse_ability(cells[3]),
                    "stamina": parse_ability(cells[4]),
                    "velocity": clean_text(cells[5]),
                    "pitch_mix": parse_skills(cells[6], skill_map),
                },
                "contract": clean_text(cells[16]),
                "age": age,
                "experience": years,
                "cash": cash,
                "salary": salary,
                "current_pitching": {
                    "era": parse_stat_cell(cells[7])["current"],
                    "wins": parse_stat_cell(cells[8])["current"],
                    "losses": parse_stat_cell(cells[9])["current"],
                    "saves": parse_stat_cell(cells[10])["current"],
                    "innings_pitched": parse_stat_cell(cells[11])["current"],
                    "strikeouts": parse_stat_cell(cells[12])["current"],
                    "walks": parse_stat_cell(cells[13])["current"],
                    "home_runs_allowed": parse_stat_cell(cells[14])["current"],
                    "k_per_9_like": parse_stat_cell(cells[15])["current"],
                },
                "career_pitching": {
                    "era": parse_stat_cell(cells[7])["career"],
                    "wins": parse_stat_cell(cells[8])["career"],
                    "losses": parse_stat_cell(cells[9])["career"],
                    "saves": parse_stat_cell(cells[10])["career"],
                    "innings_pitched": parse_stat_cell(cells[11])["career"],
                    "strikeouts": parse_stat_cell(cells[12])["career"],
                    "walks": parse_stat_cell(cells[13])["career"],
                    "home_runs_allowed": parse_stat_cell(cells[14])["career"],
                    "k_per_9_like": parse_stat_cell(cells[15])["career"],
                },
                "skills": parse_skills(cells[6], skill_map),
            }
        )
    return players


def league_from_saku(saku: int) -> str:
    # Some live game pages omit the league banner; ORE team slots are stable.
    return "\u4e2d\u83ef\u806f\u76df" if saku <= 5 else "\u53f0\u7063\u806f\u76df"


def parse_team_page(page_html: str, saku: int, skill_map: dict[str, str]) -> tuple[dict[str, Any], list[dict[str, Any]], dict[str, str]]:
    season = find1(r"第<font[^>]*><B>(\d+)</B></font>季", page_html, re.I | re.S)
    day = find1(r"第<font[^>]*><B>(\d+)</B></font>日", page_html, re.I | re.S)
    schedule_type = find1(r"<font style=\"color:#FFFFFF;background-color:#0000FF;\">&nbsp;<B>([^<]+)</B>&nbsp;</font>", page_html, re.I | re.S)
    team_name = find1(r'name=team value=([^>\n]+)', page_html, re.I)
    league = find1(r"球隊所屬聯盟：<font color=blue><b>([^<]+)</b></font>", page_html, re.I | re.S)
    current_rank = find1(r"目前聯盟排名：<font color=red><b>([^<]+)</b></font>", page_html, re.I | re.S)
    previous_rank = find1(r"上季聯盟排名：<b>([^<]+)</b>", page_html, re.I | re.S)

    team = {
        "saku": saku,
        "team": clean_text(team_name),
        "league": clean_text(league) or league_from_saku(saku),
        "last_season_rank": clean_text(previous_rank),
        "current_status": parse_record_tables(page_html) | {"league_rank": clean_text(current_rank)},
    }
    players = parse_batters(page_html, team["team"], season, skill_map) + parse_pitchers(page_html, team["team"], season, skill_map)
    meta = {"season": season, "day": day, "schedule_type": clean_text(schedule_type)}
    return team, players, meta


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def main() -> None:
    pages: dict[int, str] = {}
    first_page = fetch_text(f"{BASE_URL}?mode=teisatu&saku=0")
    skill_map = extract_skill_map(first_page)
    pages[0] = first_page
    for saku in range(1, 12):
        pages[saku] = fetch_text(f"{BASE_URL}?mode=teisatu&saku={saku}")

    teams: list[dict[str, Any]] = []
    players: list[dict[str, Any]] = []
    meta_source: dict[str, str] = {}

    for saku in range(12):
        team, roster, meta = parse_team_page(pages[saku], saku, skill_map)
        teams.append(team)
        players.extend(roster)
        meta_source = meta

    season = meta_source["season"]
    out_dir = OUT_ROOT / f"season-{season}"
    scrape_time = datetime.now().astimezone().isoformat(timespec="seconds")
    meta = {
        "season": season,
        "day": meta_source["day"],
        "schedule_type": meta_source["schedule_type"],
        "scraped_at": scrape_time,
        "source": BASE_URL,
        "team_pages": [f"{BASE_URL}?mode=teisatu&saku={saku}" for saku in range(12)],
    }

    write_json(out_dir / "teams.json", teams)
    write_json(out_dir / "players.json", players)
    write_json(out_dir / "meta.json", meta)

    print(f"season={season}")
    print(f"teams={len(teams)}")
    print(f"players={len(players)}")
    print(f"output={out_dir}")


if __name__ == "__main__":
    main()
