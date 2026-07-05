from __future__ import annotations

import base64
import importlib.util
import json
import re
import subprocess
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.error import URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


BASE_URL = "http://game.tinycafe.com/ore/ore.cgi"
OUT_ROOT = Path(__file__).resolve().parent
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Codex Ore Snapshot"
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


def write_live_cache(filename: str, text: str) -> None:
    live_dir = live_dir_for_today()
    live_dir.mkdir(parents=True, exist_ok=True)
    (live_dir / filename).write_text(text, encoding="utf-8")


def load_cached_page(
    filenames: list[str],
    required_markers: tuple[str, ...] = (),
    max_age_seconds: int = CACHE_MAX_AGE_SECONDS,
) -> str | None:
    candidates: list[tuple[float, str]] = []
    roots = [path for path in sorted(OUT_ROOT.glob("live-*"), key=lambda item: item.name, reverse=True) if path.is_dir()]
    roots.extend([OUT_ROOT, OUT_ROOT.parent])
    now_ts = datetime.now().timestamp()
    for root in roots:
        for filename in filenames:
            path = root / filename
            if path.exists():
                if now_ts - path.stat().st_mtime > max_age_seconds:
                    continue
                text = read_text_guess(path)
                if required_markers and not any(marker in text for marker in required_markers):
                    continue
                candidates.append((path.stat().st_mtime, text))
    if not candidates:
        return None
    return max(candidates, key=lambda item: item[0])[1]


def load_scraper_module():
    spec = importlib.util.spec_from_file_location("scrape_ore", OUT_ROOT / "scrape_ore.py")
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


def fetch_post_with_powershell(body_text: str) -> str:
    def ps_quote(value: str) -> str:
        return "'" + value.replace("'", "''") + "'"

    command = (
        "$ProgressPreference='SilentlyContinue'; "
        "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; "
        f"$resp=Invoke-WebRequest -Uri {ps_quote(BASE_URL)} -Method POST -Body {ps_quote(body_text)} "
        f"-ContentType 'application/x-www-form-urlencoded' -UserAgent {ps_quote(USER_AGENT)} "
        "-UseBasicParsing -TimeoutSec 30; "
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


def fetch_kakuninn_page() -> str | None:
    source_label = "POST kakuninn"
    body_text = urlencode({"kakuninn": "陣容介紹"}, encoding="cp950", errors="ignore")
    body = body_text.encode("ascii", errors="ignore")
    req = Request(
        BASE_URL,
        data=body,
        headers={
            "User-Agent": USER_AGENT,
            "Content-Type": "application/x-www-form-urlencoded",
        },
        method="POST",
    )
    try:
        with urlopen(req, timeout=30) as resp:
            text = resp.read().decode("cp950", errors="ignore")
        write_live_cache("kakuninn.html", text)
        record_fetch(source_label, "fresh_web_scrape")
        return text
    except (OSError, URLError) as exc:
        try:
            text = fetch_post_with_powershell(body_text)
            write_live_cache("kakuninn.html", text)
            record_fetch(source_label, "fresh_web_scrape")
            return text
        except Exception:
            pass
        cached = load_cached_page(
            ["kakuninn.html", "__sun_kakuninn.html", "__kakuninn_alt.html", "__ore_roster.html"],
        )
        if cached is not None:
            record_fetch(source_label, "cache_fallback", type(exc).__name__)
            return cached
        record_fetch(source_label, "unavailable", type(exc).__name__)
        return None


def fetch_history_page() -> str | None:
    source_label = "POST kiroku"
    body_text = urlencode({"kiroku": "歷史記錄"}, encoding="cp950", errors="ignore")
    body = body_text.encode("ascii", errors="ignore")
    req = Request(
        BASE_URL,
        data=body,
        headers={
            "User-Agent": USER_AGENT,
            "Content-Type": "application/x-www-form-urlencoded",
        },
        method="POST",
    )
    try:
        with urlopen(req, timeout=30) as resp:
            text = resp.read().decode("cp950", errors="ignore")
        write_live_cache("history.html", text)
        record_fetch(source_label, "fresh_web_scrape")
        return text
    except (OSError, URLError) as exc:
        try:
            text = fetch_post_with_powershell(body_text)
            write_live_cache("history.html", text)
            record_fetch(source_label, "fresh_web_scrape")
            return text
        except Exception:
            pass
        cached = load_cached_page(["history.html", "__ore_history.html"])
        if cached is not None:
            record_fetch(source_label, "cache_fallback", type(exc).__name__)
            return cached
        record_fetch(source_label, "unavailable", type(exc).__name__)
        return None


def build_source_freshness(scrape: Any, archive_events: list[dict[str, str]]) -> dict[str, Any]:
    scrape_events = list(getattr(scrape, "FETCH_EVENTS", []))
    teisatu_events: list[dict[str, Any]] = []
    for event in scrape_events:
        match = re.search(r"[?&]mode=teisatu&saku=(\d+)", event.get("url", ""))
        if not match:
            continue
        item = dict(event)
        item["saku"] = int(match.group(1))
        teisatu_events.append(item)

    fresh_sakus = sorted({event["saku"] for event in teisatu_events if event.get("source") == "fresh_web_scrape"})
    cache_sakus = sorted({event["saku"] for event in teisatu_events if event.get("source") == "cache_fallback"})
    unavailable_sakus = sorted({event["saku"] for event in teisatu_events if event.get("source") == "unavailable"})
    status = "fresh_web_scrape" if len(fresh_sakus) == 12 and not cache_sakus and not unavailable_sakus else "blocked_cache_or_unavailable"

    def archive_status(prefix: str) -> str:
        matches = [event for event in archive_events if event.get("url", "").startswith(prefix)]
        return matches[-1]["source"] if matches else "not_attempted"

    return {
        "status": status,
        "teisatuFreshSakus": fresh_sakus,
        "teisatuCacheSakus": cache_sakus,
        "teisatuUnavailableSakus": unavailable_sakus,
        "teisatuFetchCount": len(teisatu_events),
        "summaryStatus": archive_status("POST kakuninn"),
        "historyStatus": archive_status("POST kiroku"),
        "events": scrape_events + archive_events,
    }


def parse_team_order(html: str) -> list[str]:
    match = re.search(
        r"<tr align=center bgcolor='#FFFFFF'><td>#</td>(.*?)(?=<tr align=center><td bgcolor=\"#FFFFFF\">1</td>)",
        html,
        re.I | re.S,
    )
    if not match:
        return []
    return re.findall(r'font-weight:BOLD;">([^<]+)</a>', match.group(1), re.I)


def map_short_to_full_team(short_names: list[str], teams: list[dict[str, Any]]) -> list[str]:
    full_names = [team["team"] for team in teams]
    mapped: list[str] = []
    for short in short_names:
        target = next((name for name in full_names if short in name), short)
        mapped.append(target)
    return mapped


def parse_batter_summary(cell_html: str, team_name: str) -> dict[str, Any]:
    name = re.search(r"<B>([^<]+)</B>", cell_html, re.I).group(1).strip()
    pos = re.search(r">([A-Z0-9]+)\.<B>", cell_html, re.I).group(1).strip()
    salary = re.search(r"年薪:\s*([0-9,]+)", cell_html).group(1)
    avg = re.search(r"AVG:\s*<U>([^<]+)</U>", cell_html).group(1)
    stat_line = re.search(r"</U><BR>&nbsp;\s*([0-9]+)本([0-9]+)點([0-9]+)盜", cell_html)
    return {
        "team": team_name,
        "name": name,
        "position_or_role": pos,
        "season_summary": {
            "salary": salary,
            "batting_avg": avg,
            "home_runs": stat_line.group(1),
            "rbi": stat_line.group(2),
            "steals": stat_line.group(3),
        },
    }


def parse_pitcher_summary(cell_html: str, team_name: str) -> dict[str, Any]:
    name = re.search(r"<B>([^<]+)</B>", cell_html, re.I).group(1).strip()
    role = re.search(r">([A-Z]+)\.<B>", cell_html, re.I).group(1).strip()
    salary = re.search(r"年薪:\s*([0-9,]+)", cell_html).group(1)
    era = re.search(r"ERA:\s*<U>([^<]+)</U>", cell_html).group(1)
    stat_line = re.search(r"</U><BR>&nbsp;\s*([0-9]+)勝([0-9]+)敗([0-9]+)救([0-9]+)Ｋ", cell_html)
    return {
        "team": team_name,
        "name": name,
        "position_or_role": role,
        "season_summary": {
            "salary": salary,
            "era": era,
            "wins": stat_line.group(1),
            "losses": stat_line.group(2),
            "saves": stat_line.group(3),
            "strikeouts": stat_line.group(4),
        },
    }


def parse_summary_page(html: str, teams: list[dict[str, Any]]) -> dict[tuple[str, str], dict[str, Any]]:
    team_order = map_short_to_full_team(parse_team_order(html), teams)
    cell_pattern = re.compile(r"<td class='k1473' style=\"color:[^\"]+\">.*?</Td>", re.I | re.S)
    cells = cell_pattern.findall(html)
    summary: dict[tuple[str, str], dict[str, Any]] = {}

    batter_cells = [cell for cell in cells if "AVG:" in cell]
    pitcher_cells = [cell for cell in cells if "ERA:" in cell]

    for idx, cell in enumerate(batter_cells):
        team_name = team_order[idx % 12]
        parsed = parse_batter_summary(cell, team_name)
        summary[(team_name, parsed["name"])] = parsed

    for idx, cell in enumerate(pitcher_cells):
        team_name = team_order[idx % 12]
        parsed = parse_pitcher_summary(cell, team_name)
        summary[(team_name, parsed["name"])] = parsed

    return summary


def merge_players(base_players: list[dict[str, Any]], summary_map: dict[tuple[str, str], dict[str, Any]]) -> list[dict[str, Any]]:
    merged: list[dict[str, Any]] = []
    for player in base_players:
        item = dict(player)
        key = (player["team"], player["name"])
        if key in summary_map:
            item["season_summary"] = summary_map[key]["season_summary"]
            if summary_map[key]["position_or_role"] in {"SP", "RP", "CL"}:
                item["season_summary_role"] = summary_map[key]["position_or_role"]
        merged.append(item)
    return merged


def parse_history_page(html: str) -> dict[str, Any]:
    season = re.search(r"第<B>(\d+)</B>季《菜鳥出頭天》總冠軍", html)
    champion = re.search(r'font-size:72px; font-weight:BOLD;">([^<]+)</font>', html)
    finals = re.search(r"總冠軍賽進行到第\s*(\d+)\s*戰，以\s*(\d+)\s*勝\s*(\d+)\s*敗拿下勝利", html)
    return {
        "season": season.group(1) if season else "",
        "champion_team": champion.group(1).strip() if champion else "",
        "finals_games": finals.group(1) if finals else "",
        "finals_wins": finals.group(2) if finals else "",
        "finals_losses": finals.group(3) if finals else "",
    }


def build_season_snapshot(
    season: str,
    day: str,
    schedule_type: str,
    scraped_at: str,
    teams: list[dict[str, Any]],
    players: list[dict[str, Any]],
    championship: dict[str, Any],
) -> dict[str, Any]:
    team_rows: list[dict[str, Any]] = []
    for team in teams:
        roster = [p for p in players if p["team"] == team["team"]]
        team_rows.append(
            {
                "team": team["team"],
                "league": team["league"],
                "saku": team["saku"],
                "last_season_rank": team["last_season_rank"],
                "current_status": team["current_status"],
                "is_champion": team["team"] == championship.get("champion_team"),
                "roster_size": len(roster),
                "batters": [p for p in roster if p["category"] == "batter"],
                "pitchers": [p for p in roster if p["category"] == "pitcher"],
            }
        )

    return {
        "season": season,
        "day": day,
        "schedule_type": schedule_type,
        "scraped_at": scraped_at,
        "championship": championship,
        "teams": team_rows,
    }


def main() -> None:
    FETCH_EVENTS.clear()
    scrape = load_scraper_module()
    if hasattr(scrape, "FETCH_EVENTS"):
        scrape.FETCH_EVENTS.clear()
    first_page = scrape.fetch_text(f"{BASE_URL}?mode=teisatu&saku=0")
    skill_map = scrape.extract_skill_map(first_page)
    pages = {0: first_page}
    for saku in range(1, 12):
        pages[saku] = scrape.fetch_text(f"{BASE_URL}?mode=teisatu&saku={saku}")

    source_freshness = build_source_freshness(scrape, FETCH_EVENTS)
    if source_freshness["status"] != "fresh_web_scrape":
        print(f"sourceFreshness={source_freshness['status']}")
        print(f"fresh_sakus={source_freshness['teisatuFreshSakus']}")
        print(f"cache_sakus={source_freshness['teisatuCacheSakus']}")
        print(f"unavailable_sakus={source_freshness['teisatuUnavailableSakus']}")
        raise SystemExit(2)

    teams: list[dict[str, Any]] = []
    players: list[dict[str, Any]] = []
    meta_source: dict[str, str] = {}
    for saku in range(12):
        team, roster, meta = scrape.parse_team_page(pages[saku], saku, skill_map)
        teams.append(team)
        players.extend(roster)
        meta_source = meta

    kakuninn_html = fetch_kakuninn_page()
    source_freshness = build_source_freshness(scrape, FETCH_EVENTS)
    summary_map = {}
    if kakuninn_html is not None and source_freshness["summaryStatus"] == "fresh_web_scrape":
        summary_map = parse_summary_page(kakuninn_html, teams)
    players = merge_players(players, summary_map)
    history_html = fetch_history_page()
    source_freshness = build_source_freshness(scrape, FETCH_EVENTS)
    championship = {}
    if history_html is not None and source_freshness["historyStatus"] == "fresh_web_scrape":
        championship = parse_history_page(history_html)
    players_with_summary = sum(1 for player in players if "season_summary" in player)

    season = meta_source["season"]
    now = datetime.now().astimezone()
    date_tag = now.strftime("%Y-%m-%d")
    out_dir = OUT_ROOT / f"season-{season}" / "snapshots"
    out_dir.mkdir(parents=True, exist_ok=True)

    payload = {
        "season": season,
        "day": meta_source["day"],
        "schedule_type": meta_source["schedule_type"],
        "scraped_at": now.isoformat(timespec="seconds"),
        "source": {
            "teisatu": [f"{BASE_URL}?mode=teisatu&saku={saku}" for saku in range(12)],
            "kakuninn": "POST kakuninn=陣容介紹",
        },
        "sourceFreshness": source_freshness,
        "championship": championship,
        "summary_rows": len(summary_map),
        "players_with_summary": players_with_summary,
        "players": players,
    }
    out_path = out_dir / f"{date_tag}_players.json"
    out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    season_root = OUT_ROOT / f"season-{season}"
    latest_players_path = season_root / "players.json"
    latest_meta_path = season_root / "meta.json"
    latest_championship_path = season_root / "championship.json"
    latest_season_snapshot_path = season_root / "season_snapshot.json"
    dated_season_snapshot_path = out_dir / f"{date_tag}_season_snapshot.json"

    latest_players_path.write_text(json.dumps(players, ensure_ascii=False, indent=2), encoding="utf-8")
    latest_championship_path.write_text(json.dumps(championship, ensure_ascii=False, indent=2), encoding="utf-8")
    season_snapshot = build_season_snapshot(
        season=season,
        day=meta_source["day"],
        schedule_type=meta_source["schedule_type"],
        scraped_at=now.isoformat(timespec="seconds"),
        teams=teams,
        players=players,
        championship=championship,
    )
    latest_season_snapshot_path.write_text(json.dumps(season_snapshot, ensure_ascii=False, indent=2), encoding="utf-8")
    dated_season_snapshot_path.write_text(json.dumps(season_snapshot, ensure_ascii=False, indent=2), encoding="utf-8")

    meta_payload = {
        "season": season,
        "day": meta_source["day"],
        "schedule_type": meta_source["schedule_type"],
        "scraped_at": now.isoformat(timespec="seconds"),
        "source": {
            "teisatu": [f"{BASE_URL}?mode=teisatu&saku={saku}" for saku in range(12)],
            "kakuninn": "POST kakuninn=陣容介紹",
            "kiroku": "POST kiroku=歷史記錄",
        },
        "sourceFreshness": source_freshness,
        "summary_rows": len(summary_map),
        "players_with_summary": players_with_summary,
        "latest_players_file": str(latest_players_path),
        "latest_championship_file": str(latest_championship_path),
        "latest_season_snapshot_file": str(latest_season_snapshot_path),
        "latest_snapshot_file": str(out_path),
    }
    latest_meta_path.write_text(json.dumps(meta_payload, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"season={season}")
    print(f"players={len(players)}")
    print(f"sourceFreshness={source_freshness['status']}")
    print(f"summaryStatus={source_freshness['summaryStatus']}")
    print(f"historyStatus={source_freshness['historyStatus']}")
    print(f"summaries={len(summary_map)}")
    print(f"players_with_summary={players_with_summary}")
    print(f"latest_players={latest_players_path}")
    print(f"output={out_path}")


if __name__ == "__main__":
    main()
