# -*- coding: utf-8 -*-
"""權重搜尋: 對多個歷史球季回測, 指標 = 我方隊伍真實得分 / oracle(事後最佳隊伍)得分"""
import os, sys, itertools, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import orelib as O

ITEMS = ['avg', 'hr', 'rbi', 'sb', 'k', 'w', 'sv']  # era 歷史資料壞掉, 排除


def actual_as_proj(actual):
    return {n: {'cat': r['cat'], 'pos': r['pos'], 'proj': r['stats'], 'src': 'actual'}
            for n, r in actual.items() if r['pos']}


def eval_config(targets, deltas, n_hist, weights, q):
    import orelib
    ratios = {it: [] for it in ITEMS}
    for t in targets:
        roster = O.load_players(t)
        hist = {s: d for s, d in deltas.items() if s < t}
        # monkey-patch percentile q
        proj = O.project_players(t, hist, roster, n_hist=n_hist, weights=weights)
        actual = deltas[t]
        oracle_proj = actual_as_proj(actual)
        for it in ITEMS:
            team = O.build_team(proj, it)
            ours = O.team_actual(team, actual, it)
            oteam = O.build_team(oracle_proj, it)
            best = O.team_actual(oteam, actual, it)
            if it == 'avg':
                ratios[it].append(ours / best if best else 0)
            else:
                ratios[it].append(ours / best if best else 0)
    return {it: sum(v) / len(v) for it, v in ratios.items()}


def main():
    deltas = O.season_deltas()
    targets = [s for s in [770, 771, 772, 773, 774, 775, 776] if s in deltas]
    print('targets:', targets)
    configs = [
        (1, (1.0,)),
        (2, (0.6, 0.4)),
        (2, (0.7, 0.3)),
        (3, (0.5, 0.3, 0.2)),
        (3, (0.6, 0.25, 0.15)),
        (3, (0.4, 0.35, 0.25)),
    ]
    rows = []
    for n_hist, w in configs:
        r = eval_config(targets, deltas, n_hist, w, 0.4)
        mean = sum(r.values()) / len(r)
        rows.append((mean, n_hist, w, r))
        print(f"n={n_hist} w={w} mean={mean:.4f} " + ' '.join(f'{k}={v:.3f}' for k, v in r.items()))
    rows.sort(reverse=True)
    print('\nBEST:', rows[0][1], rows[0][2], f'mean={rows[0][0]:.4f}')


if __name__ == '__main__':
    main()
