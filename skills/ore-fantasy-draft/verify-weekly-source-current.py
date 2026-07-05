from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import re
from datetime import datetime
from pathlib import Path
from typing import Any


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def clean_value(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(key): clean_value(value[key]) for key in sorted(value)}
    if isinstance(value, list):
        return [clean_value(item) for item in value]
    if value is None:
        return None
    return str(value).strip()


def player_key(player: dict[str, Any]) -> tuple[str, str, str, str, str]:
    return (
        str(player.get("team", "")),
        str(player.get("category", "")),
        str(player.get("position_or_role", "")),
        str(player.get("slot", "")),
        str(player.get("name", "")),
    )


def semantic_player(player: dict[str, Any]) -> dict[str, Any]:
    base = {
        "team": player.get("team"),
        "category": player.get("category"),
        "slot": player.get("slot"),
        "name": player.get("name"),
        "owner": player.get("owner"),
        "is_computer": player.get("is_computer"),
        "position_or_role": player.get("position_or_role"),
        "raw_position_or_role": player.get("raw_position_or_role"),
        "handedness": player.get("handedness"),
        "style": player.get("style"),
        "abilities": player.get("abilities"),
        "skills": sorted(player.get("skills") or []),
        "contract": player.get("contract"),
        "age": player.get("age"),
        "experience": player.get("experience"),
        "cash": player.get("cash"),
        "salary": player.get("salary"),
    }
    if player.get("category") == "batter":
        base["current_batting"] = player.get("current_batting")
        base["career_batting"] = player.get("career_batting")
    elif player.get("category") == "pitcher":
        base["current_pitching"] = player.get("current_pitching")
        base["career_pitching"] = player.get("career_pitching")
    return clean_value(base)


def semantic_team(team: dict[str, Any]) -> dict[str, Any]:
    return clean_value(
        {
            "team": team.get("team"),
            "league": team.get("league"),
            "saku": team.get("saku"),
            "last_season_rank": team.get("last_season_rank"),
            "current_status": team.get("current_status"),
        }
    )


def semantic_payload_from_artifacts(season_dir: Path) -> tuple[dict[str, Any], list[str]]:
    fail_reasons: list[str] = []
    meta = read_json(season_dir / "meta.json")
    players = read_json(season_dir / "players.json")
    snapshot = read_json(season_dir / "season_snapshot.json")
    teams = snapshot.get("teams") or []

    if len(players) != 216:
        fail_reasons.append(f"artifact player count {len(players)}, expected 216")
    if len(teams) != 12:
        fail_reasons.append(f"artifact team count {len(teams)}, expected 12")

    semantic = {
        "season": str(meta.get("season", "")),
        "day": str(meta.get("day", "")),
        "schedule_type": str(meta.get("schedule_type", "")),
        "teams": sorted([semantic_team(team) for team in teams], key=lambda item: (item.get("saku", ""), item.get("team", ""))),
        "players": sorted([semantic_player(player) for player in players], key=player_key),
    }
    return semantic, fail_reasons


def load_scraper(ore_db_dir: Path) -> Any:
    spec = importlib.util.spec_from_file_location("scrape_ore", ore_db_dir / "scrape_ore.py")
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load scraper from {ore_db_dir}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def source_events_are_fresh(scraper: Any) -> tuple[bool, list[int], list[str]]:
    events = list(getattr(scraper, "FETCH_EVENTS", []))
    fresh_sakus: set[int] = set()
    bad_sources: list[str] = []
    for event in events:
        match = re.search(r"[?&]mode=teisatu&saku=(\d+)", event.get("url", ""))
        if not match:
            continue
        saku = int(match.group(1))
        if event.get("source") == "fresh_web_scrape":
            fresh_sakus.add(saku)
        else:
            bad_sources.append(f"saku_{saku}:{event.get('source')}")
    return fresh_sakus == set(range(12)) and not bad_sources, sorted(fresh_sakus), bad_sources


def semantic_payload_from_live(ore_db_dir: Path) -> tuple[dict[str, Any], dict[str, Any], list[str]]:
    scraper = load_scraper(ore_db_dir)
    if hasattr(scraper, "FETCH_EVENTS"):
        scraper.FETCH_EVENTS.clear()

    base_url = getattr(scraper, "BASE_URL", "http://game.tinycafe.com/ore/ore.cgi")
    pages: dict[int, str] = {}
    first_page = scraper.fetch_text(f"{base_url}?mode=teisatu&saku=0")
    skill_map = scraper.extract_skill_map(first_page)
    pages[0] = first_page
    for saku in range(1, 12):
        pages[saku] = scraper.fetch_text(f"{base_url}?mode=teisatu&saku={saku}")

    teams: list[dict[str, Any]] = []
    players: list[dict[str, Any]] = []
    meta_source: dict[str, str] = {}
    for saku in range(12):
        team, roster, meta = scraper.parse_team_page(pages[saku], saku, skill_map)
        teams.append(team)
        players.extend(roster)
        meta_source = meta

    fail_reasons: list[str] = []
    fresh_ok, fresh_sakus, bad_sources = source_events_are_fresh(scraper)
    if not fresh_ok:
        fail_reasons.append(f"live source was not fully fresh: fresh={fresh_sakus}; bad={bad_sources}")
    if len(players) != 216:
        fail_reasons.append(f"live player count {len(players)}, expected 216")
    if len(teams) != 12:
        fail_reasons.append(f"live team count {len(teams)}, expected 12")

    semantic = {
        "season": str(meta_source.get("season", "")),
        "day": str(meta_source.get("day", "")),
        "schedule_type": str(meta_source.get("schedule_type", "")),
        "teams": sorted([semantic_team(team) for team in teams], key=lambda item: (item.get("saku", ""), item.get("team", ""))),
        "players": sorted([semantic_player(player) for player in players], key=player_key),
    }
    source = {
        "checkedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
        "freshSakus": fresh_sakus,
        "badSources": bad_sources,
        "fetchEvents": list(getattr(scraper, "FETCH_EVENTS", [])),
    }
    return semantic, source, fail_reasons


def semantic_hash(payload: dict[str, Any]) -> str:
    body = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(body.encode("utf-8")).hexdigest()


def summarize_diff(expected: dict[str, Any], actual: dict[str, Any]) -> dict[str, Any]:
    expected_players = {json.dumps(player_key(player), ensure_ascii=False): player for player in expected.get("players", [])}
    actual_players = {json.dumps(player_key(player), ensure_ascii=False): player for player in actual.get("players", [])}
    expected_teams = {str(team.get("saku")): team for team in expected.get("teams", [])}
    actual_teams = {str(team.get("saku")): team for team in actual.get("teams", [])}
    changed_players = [key for key in sorted(set(expected_players) & set(actual_players)) if expected_players[key] != actual_players[key]]
    changed_teams = [key for key in sorted(set(expected_teams) & set(actual_teams)) if expected_teams[key] != actual_teams[key]]
    return {
        "seasonChanged": expected.get("season") != actual.get("season"),
        "dayChanged": expected.get("day") != actual.get("day"),
        "scheduleTypeChanged": expected.get("schedule_type") != actual.get("schedule_type"),
        "expectedPlayerCount": len(expected_players),
        "actualPlayerCount": len(actual_players),
        "missingPlayers": sorted(set(expected_players) - set(actual_players))[:20],
        "addedPlayers": sorted(set(actual_players) - set(expected_players))[:20],
        "changedPlayers": changed_players[:20],
        "changedPlayerCount": len(changed_players),
        "expectedTeamCount": len(expected_teams),
        "actualTeamCount": len(actual_teams),
        "changedTeams": changed_teams[:20],
        "changedTeamCount": len(changed_teams),
    }


def capture(args: argparse.Namespace) -> int:
    season_dir = Path(args.season_dir)
    semantic, fail_reasons = semantic_payload_from_artifacts(season_dir)
    payload = {
        "status": "PASS" if not fail_reasons else "FAIL",
        "failReasons": fail_reasons,
        "generatedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
        "mode": "capture",
        "seasonDir": str(season_dir),
        "semanticHash": semantic_hash(semantic),
        "source": {
            "season": semantic.get("season"),
            "day": semantic.get("day"),
            "scheduleType": semantic.get("schedule_type"),
            "teamCount": len(semantic.get("teams", [])),
            "playerCount": len(semantic.get("players", [])),
        },
        "semantic": semantic,
    }
    write_json(Path(args.out), payload)
    print(json.dumps({k: payload[k] for k in ("status", "mode", "semanticHash", "source", "failReasons")}, ensure_ascii=False, indent=2))
    return 0 if payload["status"] == "PASS" else 1


def verify(args: argparse.Namespace) -> int:
    expected_payload = read_json(Path(args.fingerprint))
    expected = expected_payload.get("semantic") or {}
    actual, source, live_failures = semantic_payload_from_live(Path(args.ore_db_dir))
    expected_hash = expected_payload.get("semanticHash")
    actual_hash = semantic_hash(actual)
    fail_reasons = list(live_failures)
    if actual_hash != expected_hash:
        fail_reasons.append("current live source fingerprint differs from validated monitor source; rerun full weekly monitor")
    diff = summarize_diff(expected, actual)
    payload = {
        "status": "PASS" if not fail_reasons else "FAIL",
        "failReasons": fail_reasons,
        "generatedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
        "mode": "verify",
        "expectedHash": expected_hash,
        "actualHash": actual_hash,
        "expectedSource": expected_payload.get("source"),
        "actualSource": {
            "season": actual.get("season"),
            "day": actual.get("day"),
            "scheduleType": actual.get("schedule_type"),
            "teamCount": len(actual.get("teams", [])),
            "playerCount": len(actual.get("players", [])),
        },
        "changedPlayerCount": diff["changedPlayerCount"],
        "changedTeamCount": diff["changedTeamCount"],
        "expectedPlayerCount": diff["expectedPlayerCount"],
        "actualPlayerCount": diff["actualPlayerCount"],
        "expectedTeamCount": diff["expectedTeamCount"],
        "actualTeamCount": diff["actualTeamCount"],
        "liveFetch": source,
        "diff": diff,
    }
    write_json(Path(args.out), payload)
    print(json.dumps({
        "status": payload["status"],
        "mode": payload["mode"],
        "expectedHash": expected_hash,
        "actualHash": actual_hash,
        "actualSource": payload["actualSource"],
        "changedPlayerCount": diff["changedPlayerCount"],
        "changedTeamCount": diff["changedTeamCount"],
        "failReasons": fail_reasons,
    }, ensure_ascii=False, indent=2))
    return 0 if payload["status"] == "PASS" else 1


def main() -> int:
    parser = argparse.ArgumentParser(description="Capture or verify ORE weekly source semantic fingerprint.")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--capture", action="store_true")
    mode.add_argument("--verify", action="store_true")
    parser.add_argument("--season-dir")
    parser.add_argument("--ore-db-dir", default="C:\\Users\\YOSHI\\Documents\\ore-db")
    parser.add_argument("--fingerprint")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    if args.capture:
        if not args.season_dir:
            parser.error("--capture requires --season-dir")
        return capture(args)
    if not args.fingerprint:
        parser.error("--verify requires --fingerprint")
    return verify(args)


if __name__ == "__main__":
    raise SystemExit(main())
