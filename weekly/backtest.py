# -*- coding: utf-8 -*-
"""回測: 用 <=S-1 的資料投影 S, 選隊, 對照 S 的真實成績與 fantasy 名單名次"""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import orelib as O

FULL_LIST = {
    776: os.path.join(O.ROOT, 'fantasy-snapshots', 'season-776',
                      '2026-06-26-browser-full-list-manual', 'fantasy_full_list_rows.json'),
}


def backtest(target):
    deltas = O.season_deltas()
    if target not in deltas:
        raise SystemExit(f'season {target} 沒有真實成績 (需要 season-{target+1} 的 career)')
    roster = O.load_players(target)
    proj = O.project_players(target, {s: d for s, d in deltas.items() if s < target}, roster)
    actual = deltas[target]

    field = None
    if target in FULL_LIST and os.path.exists(FULL_LIST[target]):
        rows = json.load(open(FULL_LIST[target], encoding='utf-8'))
        field = {it: [] for it in O.ALL_ITEMS}
        for r in rows:
            t = O.parse_totals(r)
            for it in O.ALL_ITEMS:
                if it in t:
                    field[it].append(t[it])

    results = {}
    for it in O.ALL_ITEMS:
        team = O.build_team(proj, it)
        score = O.team_actual(team, actual, it)
        rec = {'score': score, 'team': team}
        if field and field[it]:
            rec['rank'] = O.rank_in_field(score, field[it], it)
            rec['field_size'] = len(field[it])
            srt = sorted(field[it], reverse=(it != 'era'))
            rec['top10_cutoff'] = srt[9] if len(srt) >= 10 else srt[-1]
            rec['first'] = srt[0]
        results[it] = rec
    return results


if __name__ == '__main__':
    target = int(sys.argv[1]) if len(sys.argv) > 1 else 776
    res = backtest(target)
    print(f'=== backtest season {target} ===')
    for it, r in res.items():
        line = f"{it.upper():>4}: score={r['score']}"
        if 'rank' in r:
            line += f"  rank={r['rank']}/{r['field_size']}  top10_cutoff={r['top10_cutoff']}  first={r['first']}"
        print(line)
