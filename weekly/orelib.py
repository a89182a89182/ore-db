# -*- coding: utf-8 -*-
"""ORE weekly core lib"""
import json, os, re, glob
from collections import defaultdict

ROOT = os.environ.get('ORE_ROOT', '/sessions/eager-beautiful-noether/mnt/Documents/ore-db')

POS_MAP = {
    '捕手': 'C', '一壘': '1B', '二壘': '2B', '三壘': '3B', '游擊': 'SS',
    '左外': 'LF', '中外': 'CF', '右外': 'RF', 'ＤＨ': 'DH', 'DH': 'DH',
    '先發': 'SP', '中繼': 'RP', 'CP': 'CP', '救援': 'CP',
}
BAT_SLOTS = ['C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF', 'DH']
BAT_ITEMS = ['avg', 'hr', 'rbi', 'sb']
PIT_ITEMS = ['era', 'w', 'sv', 'k']
ALL_ITEMS = BAT_ITEMS + PIT_ITEMS

PER_ITEM_W = {
    'avg': (3, (0.6, 0.25, 0.15)),
    'hr':  (3, (0.4, 0.35, 0.25)),
    'rbi': (3, (0.4, 0.35, 0.25)),
    'sb':  (3, (0.4, 0.35, 0.25)),
    'k':   (3, (0.4, 0.35, 0.25)),
    'w':   (3, (0.4, 0.35, 0.25)),
    'sv':  (3, (0.6, 0.25, 0.15)),
    'era': (3, (0.5, 0.3, 0.2)),
}


def _num(x, default=0.0):
    if x is None:
        return default
    s = str(x).replace(',', '').strip()
    if s in ('', '-', '.', '----'):
        return default
    try:
        return float(s)
    except ValueError:
        m = re.search(r'-?\d+(?:\.\d+)?', s)
        return float(m.group(0)) if m else default


def parse_ip(s):
    if not s:
        return 0.0
    s = str(s).strip()
    m = re.match(r'^(\d+)(?:\s+(\d)/3)?$', s)
    if m:
        return int(m.group(1)) + (int(m.group(2)) / 3.0 if m.group(2) else 0.0)
    return _num(s)


def list_seasons():
    out = []
    for d in glob.glob(os.path.join(ROOT, 'season-*')):
        m = re.match(r'season-(\d+)$', os.path.basename(d))
        if m and os.path.exists(os.path.join(d, 'players.json')):
            out.append(int(m.group(1)))
    return sorted(out)


def load_players(season):
    p = json.load(open(os.path.join(ROOT, 'season-%s' % season, 'players.json'), encoding='utf-8'))
    return p if isinstance(p, list) else p.get('players', [])


def canon_pos(r):
    return POS_MAP.get(str(r.get('position_or_role', '')).strip(), None)


def career_key(r):
    if r.get('category') == 'batter':
        c = r.get('career_batting') or {}
        return {'ab': _num(c.get('at_bats')), 'h': _num(c.get('hits')),
                'hr': _num(c.get('home_runs')), 'rbi': _num(c.get('rbi')),
                'sb': _num(c.get('steals'))}
    c = r.get('career_pitching') or {}
    ip = parse_ip(c.get('innings_pitched'))
    era = _num(c.get('era'))
    return {'w': _num(c.get('wins')), 'sv': _num(c.get('saves')),
            'k': _num(c.get('strikeouts')), 'ip': ip, 'er': era * ip / 9.0}


def season_deltas():
    seasons = list_seasons()
    idx = {s: {r['name']: r for r in load_players(s)} for s in seasons}
    out = {}
    for a, b in zip(seasons, seasons[1:]):
        if b - a != 1:
            continue
        cur = {}
        for name, ra in idx[a].items():
            rb = idx[b].get(name)
            if rb is None or ra.get('category') != rb.get('category'):
                continue
            ca, cb = career_key(ra), career_key(rb)
            d = {k: cb[k] - ca[k] for k in ca}
            if any(v < -0.01 for v in d.values()):
                continue
            cur[name] = {'cat': ra.get('category'), 'pos': canon_pos(ra), 'stats': d,
                         'age': ra.get('age'), 'team': ra.get('team')}
        out[a] = cur
    return out


def current_season_summary(season):
    out = {}
    for r in load_players(season):
        s = r.get('season_summary')
        if s:
            out[r['name']] = {'cat': r.get('category'), 'summary': s,
                              'role': r.get('season_summary_role')}
    return out


def project_players(target_season, deltas, roster, n_hist=3, weights=(0.5, 0.3, 0.2)):
    hist_seasons = sorted([s for s in deltas if s < target_season], reverse=True)[:n_hist]
    group_stats = defaultdict(list)
    for s in hist_seasons:
        for name, rec in deltas[s].items():
            if rec['pos']:
                group_stats[rec['pos']].append(rec['stats'])

    def pctile(pos, key, q=0.4):
        vals = sorted(x.get(key, 0.0) for x in group_stats.get(pos, []))
        if not vals:
            return 0.0
        i = min(len(vals) - 1, max(0, int(q * len(vals))))
        return vals[i]

    out = {}
    for r in roster:
        name, cat, pos = r['name'], r.get('category'), canon_pos(r)
        if pos is None:
            continue
        hist = []
        for s in hist_seasons:
            rec = deltas[s].get(name)
            if rec and rec['cat'] == cat:
                if cat == 'pitcher' and rec['pos'] != pos:
                    continue
                hist.append(rec['stats'])
        proj = {}
        keys = ['ab', 'h', 'hr', 'rbi', 'sb'] if cat == 'batter' else ['w', 'sv', 'k', 'ip', 'er']
        if hist:
            ws = weights[:len(hist)]
            tot = sum(ws)
            for k in keys:
                proj[k] = sum(w * h.get(k, 0.0) for w, h in zip(ws, hist)) / tot
            src = 'hist%d' % len(hist)
        else:
            for k in keys:
                proj[k] = pctile(pos, k)
            src = 'rookie'
        cp = r.get('career_pitching') or {}
        out[name] = {'cat': cat, 'pos': pos, 'proj': proj, 'src': src,
                     'team': r.get('team'), 'age': r.get('age'),
                     'career_era': _num(cp.get('era'), 99.0) if cat == 'pitcher' else None,
                     'career_k9': _num(cp.get('k_per_9_like')) if cat == 'pitcher' else None}
    return out


def item_value(p, item):
    pr = p['proj']
    if item in ('hr', 'rbi', 'sb', 'k', 'w', 'sv'):
        return pr.get(item, 0)
    if item == 'avg':
        ab = pr.get('ab', 0)
        return (pr.get('h', 0) / ab) if ab > 50 else 0.0
    if item == 'era':
        ce = p.get('career_era')
        return -(ce if ce and ce > 0 else 99.0)
    return 0.0


def slot_candidates(projections):
    by = defaultdict(list)
    for name, p in projections.items():
        by[p['pos']].append(name)
    return by


def build_team(projections, item):
    cands = slot_candidates(projections)
    team = {}

    def top(pos, n, keyf):
        return sorted(cands.get(pos, []), key=keyf, reverse=True)[:n]

    def generic_bat(n):
        p = projections[n]['proj']
        return p.get('rbi', 0) + 10 * p.get('hr', 0) + 2 * p.get('sb', 0)

    def generic_pit(n):
        return projections[n]['proj'].get('k', 0)

    if item in BAT_ITEMS:
        if item == 'avg':
            def rate_ok(n):
                return projections[n]['proj'].get('ab', 0) >= 100
            pick = {}
            for s in BAT_SLOTS:
                pool = [n for n in cands.get(s, []) if rate_ok(n)] or cands.get(s, [])
                pick[s] = max(pool, key=lambda n: item_value(projections[n], 'avg'))
            improved = True
            while improved:
                improved = False
                H = sum(projections[pick[s]]['proj'].get('h', 0) for s in BAT_SLOTS)
                AB = sum(projections[pick[s]]['proj'].get('ab', 0) for s in BAT_SLOTS)
                for s in BAT_SLOTS:
                    for n in cands.get(s, []):
                        if n == pick[s] or n in pick.values():
                            continue
                        h2 = H - projections[pick[s]]['proj'].get('h', 0) + projections[n]['proj'].get('h', 0)
                        ab2 = AB - projections[pick[s]]['proj'].get('ab', 0) + projections[n]['proj'].get('ab', 0)
                        if ab2 > 0 and AB > 0 and h2 / ab2 > H / AB + 1e-9:
                            pick[s] = n
                            H, AB = h2, ab2
                            improved = True
            team.update(pick)
        else:
            used = set()
            for s in BAT_SLOTS:
                pool = [n for n in cands.get(s, []) if n not in used]
                team[s] = max(pool, key=lambda n: item_value(projections[n], item))
                used.add(team[s])
        sp = top('SP', 5, generic_pit)
        rp = top('RP', 3, generic_pit)
        cp = top('CP', 1, generic_pit)
    else:
        used = set()
        for s in BAT_SLOTS:
            pool = [n for n in cands.get(s, []) if n not in used]
            team[s] = max(pool, key=generic_bat)
            used.add(team[s])
        keyf = lambda n: item_value(projections[n], item)
        if item == 'sv':
            sp = top('SP', 5, generic_pit)
            rp = top('RP', 3, keyf)
            cp = top('CP', 1, keyf)
        elif item == 'era':
            def era_key(n):
                p = projections[n]
                pen = 0.0 if p['src'].startswith('hist') else 1.5
                return item_value(p, 'era') - pen
            sp = top('SP', 5, era_key)
            rp = top('RP', 3, era_key)
            cp = top('CP', 1, era_key)
        else:
            sp = top('SP', 5, keyf)
            rp = top('RP', 3, keyf)
            cp = top('CP', 1, keyf)
    for i, n in enumerate(sp, 1):
        team['SP%d' % i] = n
    for i, n in enumerate(rp, 1):
        team['RP%d' % i] = n
    team['CP'] = cp[0] if cp else None
    return team


def team_actual(team, actual, item):
    names = [n for n in team.values() if n]
    if item == 'avg':
        H = sum(actual[n]['stats'].get('h', 0) for n in names if n in actual)
        AB = sum(actual[n]['stats'].get('ab', 0) for n in names if n in actual)
        return round(H / AB, 4) if AB else 0.0
    if item == 'era':
        ER = sum(actual[n]['stats'].get('er', 0) for n in names if n in actual)
        IP = sum(actual[n]['stats'].get('ip', 0) for n in names if n in actual)
        return round(ER * 9.0 / IP, 3) if IP else 99.0
    return sum(actual[n]['stats'].get(item, 0) for n in names if n in actual)


def parse_totals(row):
    out = {}
    m = re.match(r'([\d.]+)\s+(\d+)轟-(\d+)點-(\d+)盜', row.get('battingTotal', ''))
    if m:
        out['avg'] = float(m.group(1)); out['hr'] = int(m.group(2))
        out['rbi'] = int(m.group(3)); out['sb'] = int(m.group(4))
    m = re.match(r'([\d.]+)\s+(\d+)勝-(\d+)救援-(\d+)K', row.get('pitchingTotal', ''))
    if m:
        out['era'] = float(m.group(1)); out['w'] = int(m.group(2))
        out['sv'] = int(m.group(3)); out['k'] = int(m.group(4))
    return out


def rank_in_field(value, field_values, item):
    if item == 'era':
        better = sum(1 for v in field_values if v < value)
    else:
        better = sum(1 for v in field_values if v > value)
    return better + 1


# ---------------- per-item 調整 (2026-07-05 回測採用) ----------------
# trend: 最近兩季差值外推 0.6x ; age: 40 歲以上投影打 75 折 (退休/退化風險)
PER_ITEM_CONF = {
    'hr':  {'age': 1, 'trend': 1},
    'rbi': {'age': 1},
    'sb':  {'age': 1},
    'k':   {'age': 1},
    'w':   {'age': 1, 'ctx': 0.3},
    'sv':  {'trend': 1},
    'avg': {'age': 1},
    'era': {'age': 1},
}


def apply_adjust(base, dl, target, trend=False, age=False, tr_w=0.6, age_factor=0.75):
    hs = sorted([s for s in dl if s < target], reverse=True)[:3]
    for n, p in base.items():
        if trend:
            seq = [dl[s][n]['stats'] for s in hs
                   if n in dl[s] and dl[s][n]['cat'] == p['cat']
                   and (p['cat'] == 'batter' or dl[s][n]['pos'] == p['pos'])]
            keys = ['hr', 'rbi', 'sb'] if p['cat'] == 'batter' else ['k', 'w', 'sv']
            if len(seq) >= 2:
                for k in keys:
                    d = seq[0].get(k, 0) - seq[1].get(k, 0)
                    p['proj'][k] = max(0.0, p['proj'][k] + tr_w * d)
        if age and p.get('age'):
            try:
                a = int(p['age'])
            except (TypeError, ValueError):
                a = 0
            if a >= 40:
                for k in list(p['proj'].keys()):
                    p['proj'][k] *= age_factor
    return base


def team_wins_by_season(dl):
    out = {}
    for s, d in dl.items():
        tw = {}
        for n, r in d.items():
            if r['cat'] == 'pitcher' and r.get('team'):
                tw[r['team']] = tw.get(r['team'], 0) + r['stats'].get('w', 0)
        out[s] = tw
    return out


def apply_team_context(base, dl, target, beta, roster_season=None):
    """球隊季間強弱變化修正 (轉隊率~0, 主要修正球隊整體升降對 W/SV 的影響)"""
    import statistics
    tw = team_wins_by_season(dl)
    st = team_strength(target, dl, roster_season=roster_season)
    pred = {x['team']: x['pred_wins'] for x in st}
    if not pred:
        return base
    mean_pred = statistics.mean(pred.values())
    hs = sorted(dl, reverse=True)[:3]
    mean_old = statistics.mean([statistics.mean(tw[s].values()) for s in hs if tw.get(s)])
    for nm, p in base.items():
        if p['cat'] != 'pitcher':
            continue
        ctxs = [tw[s][dl[s][nm]['team']] for s in hs
                if nm in dl[s] and dl[s][nm].get('team') in tw.get(s, {})]
        new = pred.get(p.get('team'))
        if ctxs and new and mean_old:
            old = statistics.mean(ctxs)
            ratio = (new / mean_pred) / ((old / mean_old) or 1)
            f = max(0.5, min(2.0, ratio)) ** beta
            for k in ('w', 'sv'):
                p['proj'][k] *= f
    return base


def project_item(target, dl, roster, item, roster_season=None):
    """單一項目的最佳投影 (權重 + trend/age/ctx 設定)"""
    n, w = PER_ITEM_W[item]
    conf = PER_ITEM_CONF.get(item, {})
    base = project_players(target, dl, roster, n_hist=n, weights=w)
    base = apply_adjust(base, dl, target,
                        trend=bool(conf.get('trend')), age=bool(conf.get('age')))
    if conf.get('ctx'):
        base = apply_team_context(base, dl, target, float(conf['ctx']),
                                  roster_season=roster_season)
    return base


def project_item_variants(target, dl, roster, item, roster_season=None):
    """回傳 [(label, projections)] — main / upside(趨勢+菜鳥樂觀) / safe(高齡重罰)"""
    out = [('main', project_item(target, dl, roster, item, roster_season=roster_season))]
    n, w = PER_ITEM_W[item]
    up = project_players(target, dl, roster, n_hist=2, weights=(0.7, 0.3))
    apply_adjust(up, dl, target, trend=True, age=False)
    out.append(('upside', up))
    sf = project_players(target, dl, roster, n_hist=n, weights=w)
    apply_adjust(sf, dl, target, trend=False, age=True, age_factor=0.55)
    out.append(('safe', sf))
    return out


def team_strength(target, dl, roster_season=None):
    """各隊戰力 = 全隊投手投影勝場總和 (777 驗證: 中華 6/6 全對, 台灣 4/6)"""
    rs = roster_season if roster_season is not None else target
    roster = load_players(rs)
    pj = project_players(target, dl, roster, n_hist=3, weights=(0.4, 0.35, 0.25))
    apply_adjust(pj, dl, target, trend=True, age=True)
    st = {}
    lg = {}
    for r in roster:
        if r.get('team'):
            lg.setdefault(r['team'], None)
    # league 對照從 season_snapshot 取
    import json as _json
    snap_path = os.path.join(ROOT, 'season-%s' % rs, 'season_snapshot.json')
    if os.path.exists(snap_path):
        snap = _json.load(open(snap_path, encoding='utf-8'))
        teams = snap if isinstance(snap, list) else snap.get('teams', [])
        for t in teams:
            lg[t['team']] = t.get('league')
    for n, p in pj.items():
        if p['cat'] == 'pitcher' and p.get('team'):
            st[p['team']] = st.get(p['team'], 0.0) + p['proj'].get('w', 0.0)
    return [{'team': t, 'league': lg.get(t), 'pred_wins': round(v, 1)}
            for t, v in sorted(st.items(), key=lambda x: -x[1])]


# ---------------- 規則約束選隊 (2026-07-05: 每隊>=1且<=2人 / AVG,ERA需>=8非電腦 / 同分比低年薪) ----------------

def parse_salary(s):
    """'2億0200萬' / '6700萬' -> 萬"""
    if not s:
        return 0.0
    s = str(s)
    m = re.match(r'(?:(\d+)億)?(?:(\d+)萬)?', s.replace(',', ''))
    v = 0.0
    if m:
        if m.group(1):
            v += int(m.group(1)) * 10000
        if m.group(2):
            v += int(m.group(2))
    return v


SLOT_ORDER = ['C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF', 'DH',
              'SP1', 'SP2', 'SP3', 'SP4', 'SP5', 'RP1', 'RP2', 'RP3', 'CP']


def slot_pos(slot):
    return slot if slot in BAT_SLOTS + ['CP'] else ('SP' if slot.startswith('SP') else 'RP')


def _team_counts(assign, projections):
    c = {}
    for n in assign.values():
        if n:
            t = projections[n]['team']
            c[t] = c.get(t, 0) + 1
    return c


def _objective(assign, projections, item):
    names = [n for n in assign.values() if n]
    sal = sum(projections[n].get('salary', 0.0) for n in names)
    if item == 'avg':
        H = sum(projections[n]['proj'].get('h', 0) for n in names)
        AB = sum(projections[n]['proj'].get('ab', 0) for n in names)
        main = H / AB if AB else 0.0
    elif item == 'era':
        pit = [n for n in names if projections[n]['cat'] == 'pitcher']
        if pit:
            main = -sum((projections[n].get('career_era') or 9.0) for n in pit) / len(pit)
        else:
            main = -99.0
    else:
        main = sum(item_value(projections[n], item) for n in names)
    return main - sal * 1e-9


def build_team_rules(projections, item, exclude_computer_for_rate=True, restarts=8, seed=7):
    import random
    rng = random.Random(seed)
    best = None
    best_obj = None
    for ri in range(max(1, restarts)):
        a = _build_team_rules_once(projections, item, exclude_computer_for_rate,
                                   rng if ri > 0 else None)
        o = _objective(a, projections, item)
        if best_obj is None or o > best_obj:
            best, best_obj = a, o
    return best


def _build_team_rules_once(projections, item, exclude_computer_for_rate=True, rng=None):
    """規則約束: 12 隊各 >=1 且 <=2 人, 18 slots。回傳 {slot: name}"""
    cands = slot_candidates(projections)
    pools = {}
    for slot in SLOT_ORDER:
        pos = slot_pos(slot)
        pool = list(cands.get(pos, []))
        if item in ('avg', 'era') and exclude_computer_for_rate:
            key_cat = 'batter' if item == 'avg' else 'pitcher'
            pool2 = [n for n in pool if not (projections[n].get('is_computer') and projections[n]['cat'] == key_cat)]
            if pool2:
                pool = pool2
        pools[slot] = pool

    def keyv(n):
        return (item_value(projections[n], item), -projections[n].get('salary', 0.0))

    assign = {}
    used = set()
    for slot in SLOT_ORDER:
        pool = [n for n in pools[slot] if n not in used]
        if not pool:
            assign[slot] = None
            continue
        ranked = sorted(pool, key=keyv, reverse=True)
        if rng is not None and len(ranked) > 1:
            k = min(3, len(ranked))
            best = ranked[rng.randrange(k)]
        else:
            best = ranked[0]
        assign[slot] = best
        used.add(best)

    all_teams = set(p['team'] for p in projections.values() if p.get('team'))

    # 修復: 先解 over(>2), 再補 missing
    for _ in range(400):
        c = _team_counts(assign, projections)
        over = [t for t, v in c.items() if v > 2]
        missing = [t for t in all_teams if t not in c]
        if not over and not missing:
            break
        best_move = None
        for slot in SLOT_ORDER:
            cur = assign.get(slot)
            if cur is None:
                continue
            cur_t = projections[cur]['team']
            for n in pools[slot]:
                if n == cur or n in used:
                    continue
                t = projections[n]['team']
                helps = (cur_t in over and c.get(t, 0) < 2 and t not in over) or \
                        (t in missing and c.get(cur_t, 0) > 1)
                if not helps:
                    continue
                loss = item_value(projections[cur], item) - item_value(projections[n], item)
                if item == 'era':
                    loss = -loss
                if best_move is None or loss < best_move[0]:
                    best_move = (loss, slot, n)
        if best_move is None:
            break
        _, slot, n = best_move
        used.discard(assign[slot])
        assign[slot] = n
        used.add(n)

    # 局部改善 (保持可行)
    improved = True
    guard = 0
    while improved and guard < 60:
        improved = False
        guard += 1
        base_obj = _objective(assign, projections, item)
        for slot in SLOT_ORDER:
            cur = assign.get(slot)
            for n in pools[slot]:
                if n == cur or n in used:
                    continue
                old = assign[slot]
                assign[slot] = n
                used.discard(old)
                used.add(n)
                c = _team_counts(assign, projections)
                ok = all(v <= 2 for v in c.values()) and set(c) == all_teams
                new_obj = _objective(assign, projections, item)
                if ok and new_obj > base_obj + 1e-12:
                    base_obj = new_obj
                    improved = True
                else:
                    assign[slot] = old
                    used.discard(n)
                    used.add(old)
    return assign


def enrich_projections(projections, roster):
    info = {r['name']: r for r in roster}
    for n, p in projections.items():
        r = info.get(n, {})
        p['salary'] = parse_salary(r.get('salary'))
        p['is_computer'] = bool(r.get('is_computer'))
    return projections


# ---------------- 迴歸模型 + 五版變體 (2026-07-05) ----------------

def _abilities_vec(r):
    a = r.get('abilities') or {}
    def g(k):
        v = a.get(k)
        if isinstance(v, dict):
            v = v.get('value')
        return _num(v)
    if r.get('category') == 'batter':
        return [g('power'), g('contact'), g('speed'), g('arm'), g('defense')]
    vel = a.get('velocity')
    if isinstance(vel, dict):
        vel = vel.get('value')
    return [g('control'), g('stamina'), _num(vel)]


def _ridge_fit(X, Y, lam=1.0):
    d = len(X[0])
    A = [[sum(X[i][j] * X[i][k] for i in range(len(X))) + (lam if j == k else 0)
          for k in range(d)] for j in range(d)]
    b = [sum(X[i][j] * Y[i] for i in range(len(X))) for j in range(d)]
    for c in range(d):
        p = max(range(c, d), key=lambda r: abs(A[r][c]))
        A[c], A[p] = A[p], A[c]
        b[c], b[p] = b[p], b[c]
        for r2 in range(c + 1, d):
            f = A[r2][c] / A[c][c]
            for k in range(c, d):
                A[r2][k] -= f * A[c][k]
            b[r2] -= f * b[c]
    w = [0.0] * d
    for r2 in range(d - 1, -1, -1):
        w[r2] = (b[r2] - sum(A[r2][k] * w[k] for k in range(r2 + 1, d))) / A[r2][r2]
    return w


def _feat(dl, t, name, pos, cat, item, roster_row):
    l1 = dl.get(t - 1, {}).get(name)
    l2 = dl.get(t - 2, {}).get(name)
    def gv(d):
        if d and d['cat'] == cat and (cat == 'batter' or d['pos'] == pos):
            return d['stats'].get(item, 0.0)
        return None
    v1, v2 = gv(l1), gv(l2)
    ab = _abilities_vec(roster_row)
    age = _num(roster_row.get('age'), 28)
    return [1.0, v1 if v1 is not None else -1, 1.0 if v1 is None else 0.0,
            v2 if v2 is not None else -1, 1.0 if v2 is None else 0.0,
            age, 1.0 if age >= 40 else 0.0] + ab


def reg_project(target, dl, roster, item, blend=1.0, base=None):
    """能力值+歷史迴歸投影 (blend=1 全用迴歸); avg/era 不適用回傳 base"""
    if item in ('avg', 'era'):
        return base
    cat = 'batter' if item in ('hr', 'rbi', 'sb', 'h', 'ab') else 'pitcher'
    X, Y = [], []
    seasons = sorted([s for s in dl if s < target])
    ros = {s: {r['name']: r for r in load_players(s)} for s in seasons}
    for t in seasons:
        if t - 1 not in dl:
            continue
        for n, rec in dl[t].items():
            if rec['cat'] != cat or not rec['pos']:
                continue
            r = ros[t].get(n)
            if r is None:
                continue
            X.append(_feat(dl, t, n, rec['pos'], cat, item, r))
            Y.append(rec['stats'].get(item, 0.0))
    if len(X) < 50:
        return base
    w = _ridge_fit(X, Y)
    if base is None:
        base = project_item(target, dl, roster, item,
                            roster_season=min(target, max(s for s in dl) + 1) if dl else target)
    ros_t = {r['name']: r for r in roster}
    for n, p in base.items():
        if p['cat'] != cat or item not in p['proj']:
            continue
        r = ros_t.get(n)
        if r is None:
            continue
        f = _feat(dl, target, n, p['pos'], cat, item, r)
        rv = max(0.0, sum(wi * fi for wi, fi in zip(w, f)))
        p['proj'][item] = (1 - blend) * p['proj'][item] + blend * rv
    return base


def five_variants(target, dl, roster, item, roster_season=None):
    """五版合法陣容: V1 主推 / V2 迴歸 / V3 積極 / V4 保守 / V5 混合。
    回傳 [(label, team, projections)]"""
    out = []
    def mk(label, proj):
        proj = enrich_projections(proj, roster)
        team = build_team_rules(proj, item)
        out.append((label, team, proj))
    # V1 main
    p1 = project_item(target, dl, roster, item, roster_season=roster_season)
    mk('V1主推', p1)
    # V2 迴歸
    p2 = project_item(target, dl, roster, item, roster_season=roster_season)
    p2 = reg_project(target, dl, roster, item, blend=1.0, base=p2) or p2
    mk('V2迴歸', p2)
    # V3 積極 (近季重+趨勢外推, 不罰高齡)
    n, w = PER_ITEM_W[item]
    p3 = project_players(target, dl, roster, n_hist=2, weights=(0.7, 0.3))
    apply_adjust(p3, dl, target, trend=True, age=False)
    mk('V3積極', p3)
    # V4 保守 (高齡重罰)
    p4 = project_players(target, dl, roster, n_hist=n, weights=w)
    apply_adjust(p4, dl, target, trend=False, age=True, age_factor=0.55)
    mk('V4保守', p4)
    # V5 混合 (主推+迴歸 50/50)
    p5 = project_item(target, dl, roster, item, roster_season=roster_season)
    p5 = reg_project(target, dl, roster, item, blend=0.5, base=p5) or p5
    mk('V5混合', p5)
    return out
