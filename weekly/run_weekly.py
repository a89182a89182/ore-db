# -*- coding: utf-8 -*-
"""產出每週 HTML 報告: 當季戰績整理 + 下季各項目夢幻球隊推薦 + 回測佐證"""
import sys, os, json, datetime
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import orelib as O

def num(x): return O._num(x)

def pseudo_delta_from_summary(season, deltas):
    """用當季 live season_summary 建立近似單季成績 (該季還沒有 next-season career 可相減時)"""
    hist = sorted([s for s in deltas if s < season], reverse=True)[:3]
    rows = O.load_players(season)
    out = {}
    for r in rows:
        s = r.get('season_summary')
        if not s:
            continue
        name, cat, pos = r['name'], r.get('category'), O.canon_pos(r)
        if cat == 'batter':
            hr, rbi, sb = num(s.get('home_runs')), num(s.get('rbi')), num(s.get('steals'))
            avg = num(s.get('batting_avg'))
            past_ab = [deltas[h][name]['stats']['ab'] for h in hist if name in deltas[h] and deltas[h][name]['cat']=='batter']
            ab = sum(past_ab)/len(past_ab) if past_ab else 450.0
            st = {'ab': ab, 'h': avg*ab, 'hr': hr, 'rbi': rbi, 'sb': sb}
        else:
            era = num(s.get('era'))
            w, sv, k = num(s.get('wins')), num(s.get('saves')), num(s.get('strikeouts'))
            k9 = num((r.get('career_pitching') or {}).get('k_per_9_like')) or 6.0
            ip = k*9.0/k9 if k9 > 0 else 100.0
            st = {'w': w, 'sv': sv, 'k': k, 'ip': ip, 'er': era*ip/9.0}
        out[name] = {'cat': cat, 'pos': pos, 'stats': st, 'age': r.get('age'), 'team': r.get('team')}
    return out

def fmt_team(team, proj, item):
    order = ['C','1B','2B','3B','SS','LF','CF','RF','DH','SP1','SP2','SP3','SP4','SP5','RP1','RP2','RP3','CP']
    rows = []
    for slot in order:
        n = team.get(slot)
        if not n: continue
        p = proj[n]
        v = O.item_value(p, item)
        if item == 'era': v = -v
        rows.append((slot, n, p['team'] or '', p['src'], round(v,3) if isinstance(v,float) else v))
    return rows

def main():
    cur = int(sys.argv[1]) if len(sys.argv) > 1 else 777
    nxt = cur + 1
    deltas = O.season_deltas()
    pseudo = pseudo_delta_from_summary(cur, deltas)
    deltas_ext = dict(deltas); deltas_ext[cur] = pseudo
    roster = O.load_players(cur)  # 778 名單近似 = 777 現有名單
    summary = O.current_season_summary(cur)

    # ---- 當季整理 ----
    bat = []
    pit = []
    for name, rec in summary.items():
        s = rec['summary']
        if rec['cat'] == 'batter':
            bat.append((name, num(s.get('batting_avg')), int(num(s.get('home_runs'))), int(num(s.get('rbi'))), int(num(s.get('steals')))))
        else:
            pit.append((name, num(s.get('era')), int(num(s.get('wins'))), int(num(s.get('saves'))), int(num(s.get('strikeouts'))), rec.get('role') or ''))
    teaminfo = {r['name']: (r.get('team') or '') for r in roster}

    # ---- 778 推薦 ----
    all5 = {}
    for it in O.ALL_ITEMS:
        all5[it] = O.five_variants(nxt, deltas_ext, roster, it, roster_season=cur)
        # era 的 summary 混合
        if it == 'era':
            for lb, tm, proj in all5[it]:
                for nm, p in proj.items():
                    if p['cat'] == 'pitcher':
                        se = None
                        if nm in summary and summary[nm]['cat'] == 'pitcher':
                            se = num(summary[nm]['summary'].get('era'))
                        ce = p.get('career_era') or 99.0
                        p['career_era'] = (0.6 * se + 0.4 * ce) if se and se > 0 else ce

    # ---- HTML ----
    today = datetime.date.today().isoformat()
    css = "body{font-family:'Microsoft JhengHei',sans-serif;margin:20px auto;max-width:1000px;background:#f7f7fb;color:#222}h1{color:#1a3c6e}h2{color:#1a3c6e;border-bottom:2px solid #1a3c6e;padding-bottom:4px;margin-top:36px}table{border-collapse:collapse;width:100%;background:#fff;margin:10px 0;font-size:14px}th{background:#1a3c6e;color:#fff;padding:6px 8px}td{border:1px solid #ddd;padding:5px 8px;text-align:center}tr:nth-child(even){background:#eef2f8}.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.note{color:#666;font-size:13px}.tag{display:inline-block;background:#e8f0fe;border-radius:4px;padding:1px 6px;font-size:12px;color:#1a3c6e}"
    L = []
    L.append('<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="utf-8"><title>ORE 週報 %s</title><style>%s</style></head><body>' % (today, css))
    L.append('<h1>ORE 菜鳥出頭天 週報 — 第 %d 季整理 &amp; 第 %d 季夢幻球隊推薦</h1>' % (cur, nxt))
    L.append('<p class="note">產出時間 %s | 資料: season-%d live summary (%d 位球員) + %d 個歷史球季 career 重建</p>' % (today, cur, len(summary), len(deltas)))

    ITEM_NAME = {'avg':'打率','hr':'本打','rbi':'打點','sb':'盜壘','era':'防率','w':'勝場','sv':'救援','k':'三振'}
    L.append('<h2>第 %d 季 夢幻球隊推薦 — 每項目五版</h2>' % nxt)
    L.append('<p class="note">週日 20:00~週一 20:00 開放組隊。全部符合正式規則(12隊各1~2人/AVG,ERA排除電腦/同分比低年薪)。V1主推=歷史加權 V2迴歸=能力值模型 V3積極=近季趨勢 V4保守=高齡重罰 V5混合。776回測各版最佳名次: RBI#1 W#2 SB#2 SV#2 K#3 AVG#12 HR#16。</p>')
    ORDER5 = ['C','1B','2B','3B','SS','LF','CF','RF','DH','SP1','SP2','SP3','SP4','SP5','RP1','RP2','RP3','CP']
    for it in ['rbi','hr','k','w','sb','sv','avg','era']:
        vs = all5[it]
        L.append('<h3>[%s] %s</h3><table><tr><th>位置</th>%s</tr>' % (ITEM_NAME[it], it.upper(),
                 ''.join('<th>%s</th>' % lb for lb, _, _ in vs)))
        for slot in ORDER5:
            cells = []
            for lb, tm, proj in vs:
                nm = tm.get(slot) or '—'
                mark = ''
                if nm != '—' and proj.get(nm, {}).get('src') == 'rookie':
                    mark = ' <span class="tag">新</span>'
                cells.append('<td>%s%s</td>' % (nm, mark))
            L.append('<tr><td><b>%s</b></td>%s</tr>' % (slot, ''.join(cells)))
        L.append('</table>')

    # 球隊排名預測
    L.append('<h2>第 %d 季 球隊排名預測</h2>' % nxt)
    L.append('<p class="note">戰力指標 = 全隊投手投影勝場總和。777 季驗證:中華聯盟 6/6 全對、台灣聯盟 4/6,兩聯盟第一名(=總冠軍賽對戰組合)全中。</p>')
    st = O.team_strength(nxt, deltas_ext, roster_season=cur)
    for lg in ['中華聯盟', '台灣聯盟']:
        sub=[x for x in st if x['league']==lg]
        L.append('<h3>%s</h3><table><tr><th>預測名次</th><th>球隊</th><th>投影勝場</th></tr>' % lg)
        for i,x in enumerate(sub,1):
            L.append('<tr><td>%d</td><td>%s</td><td>%.1f</td></tr>' % (i,x['team'],x['pred_wins']))
        L.append('</table>')
    champs=[ [x for x in st if x['league']==lg][0] for lg in ['中華聯盟','台灣聯盟'] if [x for x in st if x['league']==lg] ]
    if len(champs)==2:
        pick=max(champs,key=lambda x:x['pred_wins'])
        L.append('<p><b>總冠軍賽預測:</b> %s vs %s → 預測冠軍 <b>%s</b></p>' % (champs[0]['team'],champs[1]['team'],pick['team']))

    L.append('<h2>模型可信度(776 季回測,對照真實 80 人榜單)</h2>')
    L.append('<table><tr><th>項目</th><th>模型名次</th><th>前10門檻</th><th>冠軍成績</th><th>Codex 舊模型最佳</th></tr>')
    bt = [('RBI','#1 (V1, 970>冠軍960)','903','960','3 名'),('W','#2 (V2迴歸)','108','116','—'),('SB','#2 (V1)','46','96','—'),('SV','#2 (V1)','31','43','11 名'),('K','#3 (V2迴歸)','1025','1122','11 名'),('AVG','#12','0.283','0.293','—'),('HR','#16 (V4保守)','356','375','—'),('ERA','無法回測(歷史局數損壞,777 起可)','','','39 名')]
    for r in bt:
        L.append('<tr>' + ''.join('<td>%s</td>'%c for c in r) + '</tr>')
    L.append('</table>')
    L.append('</body></html>')

    out = os.path.join(O.ROOT, 'reports-weekly')
    os.makedirs(out, exist_ok=True)
    path = os.path.join(out, 'ore_weekly_%s_s%d.html' % (today, cur))
    open(path, 'w', encoding='utf-8').write('\n'.join(L))
    print('WROTE', path)
    # 也輸出推薦 JSON 供追蹤
    jpath = os.path.join(out, 'ore_recs_%s_s%d.json' % (today, nxt))
    json.dump({it: {lb: tm for lb, tm, _ in all5[it]} for it in all5}, open(jpath,'w',encoding='utf-8'), ensure_ascii=False, indent=1)
    print('WROTE', jpath)

if __name__ == '__main__':
    main()
