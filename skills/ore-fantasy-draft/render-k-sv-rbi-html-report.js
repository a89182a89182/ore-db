#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPORTS_DIR = path.resolve(__dirname, '..', '..', 'reports');

const ITEM_CONFIGS = [
  {
    key: 'K',
    arg: 'k',
    expectedMode: 'k',
    title: 'K 5 組版本',
    priority: '第一推薦',
    core: 'pitcher',
    coreLabel: '投手',
    metricLabel: '預測三振',
    metric: lineup => sum(lineup, 'pitcher', 'strikeouts')
  },
  {
    key: 'SV',
    arg: 'sv',
    expectedMode: 'sv',
    title: 'SV 5 組版本',
    priority: '第二推薦',
    core: 'pitcher',
    coreLabel: '投手',
    metricLabel: '預測救援',
    metric: lineup => sum(lineup, 'pitcher', 'saves')
  },
  {
    key: 'RBI',
    arg: 'rbi',
    expectedMode: 'rbi',
    title: 'RBI 5 組版本',
    priority: '第三推薦',
    core: 'batter',
    coreLabel: '野手',
    metricLabel: '預測打點',
    metric: lineup => sum(lineup, 'batter', 'rbi')
  }
];

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const [key, inlineValue] = token.slice(2).split('=');
    if (inlineValue !== undefined) args[key] = inlineValue;
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) args[key] = argv[++i];
    else args[key] = true;
  }
  return args;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeText(filePath, body) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body, 'utf8');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function num(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function sum(lineup, category, stat) {
  return (lineup || [])
    .filter(item => item.category === category)
    .reduce((total, item) => total + num(item.projectedStats && item.projectedStats[stat]), 0);
}

function avg(lineup, category, stat) {
  const values = (lineup || [])
    .filter(item => item.category === category)
    .map(item => num(item.projectedStats && item.projectedStats[stat], NaN))
    .filter(Number.isFinite);
  if (!values.length) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function fmt(value, digits = 2) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : '';
}

function zhCode(value) {
  const text = String(value ?? '');
  const map = {
    PASS: '通過',
    FAIL: '失敗',
    WATCH: '觀察',
    champion_pick_aligned_so_far: '來源季冠軍訊號對齊',
    perfect_so_far: '來源季排序完全對齊',
    aligned: '來源季方向對齊',
    thin: '信心偏薄',
    high: '高',
    medium: '中',
    swap_watch: '交換觀察',
    submit_projected_card_with_swap_watch: '照模型排序提交，但保留交換觀察',
    submit_projected_card: '照模型排序提交',
    hold_projection: '維持模型排序',
    watch_hold_projection: '維持模型排序但需再看',
    hold_projection_despite_current_drift: '來源季訊號有漂移，仍維持模型排序',
    hold_projection_but_recheck_before_deadline: '維持模型排序，截止前重查',
    swap_watch_if_persists: '若持續漂移則列入交換觀察'
  };
  return map[text] || text;
}

function seasonNumberFromDir(dirPath) {
  const match = String(dirPath || '').replace(/\\/g, '/').match(/season-(\d+)/i);
  return match ? Number(match[1]) : null;
}

function publicSourceLabel(report) {
  const sourceSeason = seasonNumberFromDir(report.source && report.source.seasonDir);
  const scrapedAt = report.source && report.source.seasonScrapedAt;
  const liveType = report.source && report.source.liveSourceType;
  return {
    sourceSeason,
    scrapedAt: scrapedAt || null,
    liveSourceType: liveType || null
  };
}

function readOptionalJson(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  return readJson(filePath);
}

function allLegalityOk(legality) {
  return Object.values(legality || {}).every(Boolean);
}

function roleCounts(lineup) {
  const counts = { batters: 0, pitchers: 0, SP: 0, RP: 0, CP: 0, teams: new Set() };
  for (const item of lineup || []) {
    if (item.category === 'batter') counts.batters += 1;
    if (item.category === 'pitcher') counts.pitchers += 1;
    if (item.role === 'SP') counts.SP += 1;
    if (item.role === 'RP') counts.RP += 1;
    if (item.role === 'CP') counts.CP += 1;
    if (item.team) counts.teams.add(item.team);
  }
  return { ...counts, teams: counts.teams.size };
}

function lineupAge(item) {
  const age = Number(item && item.age);
  return Number.isFinite(age) && age > 0 ? age : null;
}

function isReplacementLineupPlayer(item) {
  return !!item && (
    item.matchMethod === 'retirement_replacement' ||
    item.isReplacementRookie ||
    item.replacementRookie ||
    item.retirementReplacement ||
    item.replacement_rookie ||
    item.owner === 'replacement rookie' ||
    /^Replacement rookie\b/i.test(String(item.name || ''))
  );
}

function validateReport(config, report) {
  const failReasons = [];
  if (!report) failReasons.push(`${config.key}: missing report`);
  if (!report) return { key: config.key, status: 'FAIL', failReasons };
  if (String(report.mode || '').toLowerCase() !== config.expectedMode) {
    failReasons.push(`${config.key}: expected mode ${config.expectedMode}, got ${report.mode}`);
  }
  if (!report.feasible) failReasons.push(`${config.key}: report is not feasible`);
  if (!allLegalityOk(report.legality)) failReasons.push(`${config.key}: report-level legality failed`);
  const variants = report.lineupVariants || [];
  if (variants.length !== 5) failReasons.push(`${config.key}: expected 5 variants, got ${variants.length}`);
  variants.forEach(variant => {
    const label = `${config.key} V${variant.variantIndex}`;
    const lineup = variant.lineup || [];
    const counts = roleCounts(lineup);
    if (!variant.feasible) failReasons.push(`${label}: not feasible`);
    if (!allLegalityOk(variant.legality)) failReasons.push(`${label}: legality failed`);
    if (lineup.length !== 18) failReasons.push(`${label}: expected 18 lineup rows, got ${lineup.length}`);
    if (counts.batters !== 9 || counts.pitchers !== 9 || counts.SP !== 5 || counts.RP !== 3 || counts.CP !== 1) {
      failReasons.push(`${label}: role counts failed B${counts.batters}/P${counts.pitchers}/SP${counts.SP}/RP${counts.RP}/CP${counts.CP}`);
    }
    if (counts.teams !== 12) failReasons.push(`${label}: expected all 12 teams, got ${counts.teams}`);
    if (lineup.some(item => item.isComputer)) failReasons.push(`${label}: contains computer player`);
    const age43Players = lineup.filter(item => {
      const age = lineupAge(item);
      return age !== null && age >= 43;
    });
    if (age43Players.length) {
      failReasons.push(`${label}: contains age 43 players: ${age43Players.map(item => `${item.name}(${item.age})`).join(', ')}`);
    }
    const replacementPlayers = lineup.filter(isReplacementLineupPlayer);
    if (replacementPlayers.length) {
      failReasons.push(`${label}: contains replacement rookies: ${replacementPlayers.map(item => item.name).join(', ')}`);
    }
  });
  return {
    key: config.key,
    mode: report.mode,
    status: failReasons.length ? 'FAIL' : 'PASS',
    producedVariants: variants.length,
    failReasons
  };
}

function validateBundle(reports, targetSeason, context = {}) {
  const reportResults = ITEM_CONFIGS.map(config => validateReport(config, reports[config.key]));
  const failReasons = reportResults.flatMap(result => result.failReasons);
  const sourceLabels = ITEM_CONFIGS.map(config => publicSourceLabel(reports[config.key] || {}));
  const firstSource = sourceLabels[0] || {};
  const projection = context.projection || null;
  const teamRankingRows = projection && Array.isArray(projection.teamProjections) ? projection.teamProjections.length : 0;
  if (projection && teamRankingRows !== 12) {
    failReasons.push(`team ranking projection expected 12 teams, got ${teamRankingRows}`);
  }
  for (const [index, label] of sourceLabels.entries()) {
    const key = ITEM_CONFIGS[index].key;
    if (label.sourceSeason !== firstSource.sourceSeason) failReasons.push(`${key}: source season differs from K report`);
    if (label.scrapedAt !== firstSource.scrapedAt) failReasons.push(`${key}: source scrapedAt differs from K report`);
  }
  if (targetSeason && firstSource.sourceSeason && Number(targetSeason) !== firstSource.sourceSeason + 1) {
    failReasons.push(`target season ${targetSeason} does not equal source season ${firstSource.sourceSeason} + 1`);
  }
  const allVariants = ITEM_CONFIGS.flatMap(config => (reports[config.key].lineupVariants || []).map(variant => ({ config, variant })));
  return {
    status: failReasons.length ? 'FAIL' : 'PASS',
    generatedAt: new Date().toISOString(),
    targetSeason: targetSeason || null,
    source: firstSource,
    totalVariantSections: allVariants.length,
    totalLineupRows: allVariants.reduce((total, item) => total + ((item.variant.lineup || []).length), 0),
    teamRankingCardIncluded: teamRankingRows > 0,
    teamRankingRows,
    leagueAuditIncluded: Boolean(context.leagueAudit),
    leagueConfidenceAuditIncluded: Boolean(context.leagueConfidenceAudit),
    leagueRankingChampion: projection && projection.teamProjections
      ? [...projection.teamProjections].sort((a, b) => num(b.overallScore) - num(a.overallScore))[0]?.team || null
      : null,
    itemResults: reportResults,
    failReasons
  };
}

function statText(item) {
  const p = item.projectedStats || {};
  if (item.category === 'pitcher') {
    return `K ${p.strikeouts ?? ''} / SV ${p.saves ?? ''} / W ${p.wins ?? ''} / ERA ${p.era ?? ''}`;
  }
  return `AVG ${p.batting_avg ?? ''} / HR ${p.home_runs ?? ''} / RBI ${p.rbi ?? ''} / SB ${p.steals ?? ''}`;
}

function abilityText(item) {
  const a = item.abilities || {};
  if (item.category === 'pitcher') {
    return `控 ${a.control ?? ''} / 體 ${a.stamina ?? ''} / 速 ${a.velocity ?? ''}`;
  }
  return `力 ${a.power ?? ''} / 巧 ${a.contact ?? ''} / 走 ${a.speed ?? ''} / 守 ${a.defense ?? ''} / 肩 ${a.arm ?? ''}`;
}

function renderLineupTable(variant) {
  const rows = (variant.lineup || []).map(item => {
    return `<tr><td>${escapeHtml(item.role)}</td><td>${escapeHtml(item.team)}</td><td class="player">${escapeHtml(item.name)}</td><td>${escapeHtml(item.owner)}</td><td>${escapeHtml(statText(item))}</td><td>${escapeHtml(abilityText(item))}</td><td>${escapeHtml((item.skills || []).join(' / '))}</td></tr>`;
  }).join('\n');
  return `<table><thead><tr><th>位置</th><th>球隊</th><th>球員</th><th>GM</th><th>預測成績</th><th>能力</th><th>技能</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderCopyBlock(config, variant) {
  const rows = (variant.lineup || [])
    .map(item => `${item.role}\t${item.team}\t${item.name}\t${item.owner}`)
    .join('\n');
  return `<details class="copy"><summary>${escapeHtml(config.key)} V${escapeHtml(variant.variantIndex)} 複製用名單</summary><pre>${escapeHtml(rows)}</pre></details>`;
}

function claimId(config, variant) {
  return `claim-${config.key}-${variant.variantIndex}`;
}

function renderClaimControl(config, variant) {
  const id = claimId(config, variant);
  const label = `${config.key} V${variant.variantIndex}`;
  return `<div class="claim" data-claim-key="${escapeHtml(label)}"><label for="${escapeHtml(id)}">${escapeHtml(label)} 猜的人</label><input id="${escapeHtml(id)}" type="text" autocomplete="name" placeholder="輸入名字"><button type="button">儲存</button><span class="claim-status" aria-live="polite"></span></div>`;
}

function renderVariant(config, variant) {
  const lineup = variant.lineup || [];
  const metric = config.metric(lineup);
  const projectedK = sum(lineup, 'pitcher', 'strikeouts');
  const projectedSv = sum(lineup, 'pitcher', 'saves');
  const projectedRbi = sum(lineup, 'batter', 'rbi');
  const projectedEra = avg(lineup, 'pitcher', 'era');
  return `<section class="variant"><div class="variant-head"><h3>${escapeHtml(config.key)} V${escapeHtml(variant.variantIndex)}</h3><div class="variant-meta"><span>${escapeHtml(config.metricLabel)} ${escapeHtml(metric)}</span><span>K ${escapeHtml(projectedK)}</span><span>SV ${escapeHtml(projectedSv)}</span><span>RBI ${escapeHtml(projectedRbi)}</span><span>ERA ${escapeHtml(fmt(projectedEra, 2))}</span><span>${variant.feasible ? '合法' : '不合法'}</span></div></div>${renderClaimControl(config, variant)}${renderCopyBlock(config, variant)}${renderLineupTable(variant)}</section>`;
}

function renderItemSection(config, report) {
  const variants = (report.lineupVariants || []).map(variant => renderVariant(config, variant)).join('\n');
  return `<section class="section"><h2>${escapeHtml(config.title)}</h2><p>${escapeHtml(config.priority)}。核心選擇：${escapeHtml(config.coreLabel)}；非核心位置只作為合法補位。</p>${variants}</section>`;
}

function renderOverview(reports, validation) {
  const rows = ITEM_CONFIGS.map(config => {
    const report = reports[config.key];
    const variants = report.lineupVariants || [];
    const bestMetric = Math.max(...variants.map(variant => config.metric(variant.lineup || [])));
    const result = validation.itemResults.find(item => item.key === config.key) || {};
    return `<tr><td>${escapeHtml(config.priority)}</td><td>${escapeHtml(config.key)}</td><td>${escapeHtml(config.metricLabel)}</td><td>${escapeHtml(bestMetric)}</td><td>${escapeHtml(variants.length)}</td><td>${escapeHtml(result.status === 'PASS' ? '通過' : result.status || '')}</td></tr>`;
  }).join('\n');
  return `<section class="section"><h2>本週項目安排</h2><table><thead><tr><th>優先順序</th><th>項目</th><th>主要指標</th><th>最高預測值</th><th>版本數</th><th>驗證</th></tr></thead><tbody>${rows}</tbody></table><p class="note">SB 週日預設刻意排除，因為其他 GM 可以用球隊盜壘策略操控；SB 留到週五全項目檢討。</p><p class="note">版本名字欄位目前儲存在同一台裝置的瀏覽器；靜態 GitHub Pages 沒有後端時，不能跨使用者同步。</p></section>`;
}

function renderTeamRankingSection(projection, leagueAudit, leagueConfidenceAudit) {
  if (!projection || !Array.isArray(projection.teamProjections) || !projection.teamProjections.length) return '';
  const source = projection.sourceSnapshot || {};
  const sourceLabel = source.season ? `第 ${source.season} 季 day ${source.day ?? ''}` : '來源季';
  const targetSeason = source.season ? Number(source.season) + 1 : null;
  const champion = [...projection.teamProjections].sort((a, b) => num(b.overallScore) - num(a.overallScore))[0];
  const groups = new Map();
  for (const team of projection.teamProjections) {
    const league = team.league || '未分聯盟';
    if (!groups.has(league)) groups.set(league, []);
    groups.get(league).push(team);
  }
  const projectionTables = [...groups.entries()].map(([league, teams]) => {
    const rows = teams
      .slice()
      .sort((a, b) => num(b.overallScore) - num(a.overallScore))
      .map((team, index) => `<tr><td>${index + 1}</td><td class="player">${escapeHtml(team.team)}</td><td>${escapeHtml(fmt(team.overallScore, 2))}</td><td>${escapeHtml(fmt(team.offenseScore, 2))}</td><td>${escapeHtml(fmt(team.pitchingScore, 2))}</td><td>${escapeHtml(fmt(team.sameLeagueAdjustment, 2))}</td></tr>`)
      .join('\n');
    return `<div><h3>${escapeHtml(league)}</h3><table><thead><tr><th>排名</th><th>球隊</th><th>總分</th><th>打擊</th><th>投手</th><th>同聯盟調整</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }).join('\n');
  void leagueAudit;
  void leagueConfidenceAudit;
  return `<section class="section"><h2>球隊排行與冠軍預測</h2><p>冠軍預測：<strong>${escapeHtml(champion && champion.team)}</strong>。下方只顯示第 ${escapeHtml(targetSeason || '')} 季賽前預測排序；不放來源季排名對照，避免誤認成尚未開季的即時排名。</p><div class="summary"><div class="card"><div class="label">冠軍預測</div><div class="value">${escapeHtml(champion && champion.team)}</div></div><div class="card"><div class="label">預測季數</div><div class="value">${escapeHtml(targetSeason || '')}</div></div><div class="card"><div class="label">資料來源</div><div class="value">${escapeHtml(sourceLabel)}</div></div><div class="card"><div class="label">球隊數</div><div class="value">${escapeHtml(projection.teamProjections.length)}</div></div></div><div class="grid-two">${projectionTables}</div></section>`;
}

function jsString(value) {
  return JSON.stringify(String(value ?? '')).replace(/</g, '\\u003c');
}

function renderClaimScript(validation) {
  const prefix = `ore-sunday-preview:${validation.targetSeason || 'unknown'}:${validation.source.sourceSeason || 'unknown'}:${validation.source.scrapedAt || 'unknown'}`;
  return `<script>
(() => {
  const storagePrefix = ${jsString(prefix)};
  document.querySelectorAll('.claim').forEach(block => {
    const claimKey = block.dataset.claimKey || '';
    const storageKey = storagePrefix + ':' + claimKey;
    const input = block.querySelector('input');
    const button = block.querySelector('button');
    const status = block.querySelector('.claim-status');
    const renderStatus = name => {
      status.textContent = name ? '已標記：' + name : '';
    };
    const saved = localStorage.getItem(storageKey) || '';
    input.value = saved;
    renderStatus(saved);
    button.addEventListener('click', () => {
      const name = input.value.trim();
      if (name) {
        localStorage.setItem(storageKey, name);
        renderStatus(name);
      } else {
        localStorage.removeItem(storageKey);
        status.textContent = '已清除';
      }
    });
  });
})();
</script>`;
}

function renderHtml({ reports, validation, projection, leagueAudit, leagueConfidenceAudit }) {
  const hash = crypto.createHash('sha256')
    .update(JSON.stringify({
      targetSeason: validation.targetSeason,
      source: validation.source,
      itemResults: validation.itemResults,
      totalVariantSections: validation.totalVariantSections,
      totalLineupRows: validation.totalLineupRows
    }))
    .digest('hex');
  const sections = ITEM_CONFIGS.map(config => renderItemSection(config, reports[config.key])).join('\n');
  return `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ORE 第 ${escapeHtml(validation.targetSeason || '')} 季週日預覽 - K SV RBI</title>
  <style>
    :root{color-scheme:light;--bg:#f4f6f8;--paper:#fff;--ink:#18212f;--muted:#5f6b7a;--line:#d9e1ea;--accent:#0f7b5c;--warn:#9a4b00}
    *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans TC","Microsoft JhengHei",Arial,sans-serif;line-height:1.55}
    .wrap{max-width:1200px;margin:0 auto;padding:24px 16px 56px}.hero,.section,.variant{background:var(--paper);border:1px solid var(--line);border-radius:8px;box-shadow:0 1px 2px rgba(20,30,45,.04)}
    .hero{padding:22px;margin-bottom:14px}.section{padding:18px;margin-top:14px}.variant{padding:14px;margin-top:12px}h1{margin:0 0 8px;font-size:30px;letter-spacing:0}h2{margin:0 0 10px;font-size:22px}h3{margin:0;font-size:17px}
    p{margin:7px 0;color:var(--muted)}.note{color:var(--warn)}.summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;margin-top:14px}.card{border:1px solid var(--line);border-radius:8px;padding:12px;background:#fbfcfd}.label{font-size:12px;color:var(--muted);text-transform:uppercase}.value{font-size:20px;font-weight:800;margin-top:2px}
    table{width:100%;border-collapse:collapse;margin-top:10px;font-size:13px}th,td{border-bottom:1px solid var(--line);padding:7px 8px;text-align:left;vertical-align:top}th{background:#eef3f6;font-weight:700}.player{font-weight:700}.variant-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap}.variant-meta{display:flex;gap:7px;flex-wrap:wrap}.variant-meta span{border:1px solid var(--line);border-radius:999px;padding:3px 8px;background:#f7fafb;color:#2d3845;font-size:12px}
    .claim{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:10px;padding:10px;border:1px solid var(--line);border-radius:8px;background:#f7fafb}.claim label{font-weight:800;font-size:13px}.claim input{min-width:220px;max-width:320px;flex:1 1 220px;border:1px solid #b9c7d5;border-radius:6px;padding:7px 9px;font:inherit}.claim button{border:0;border-radius:6px;background:var(--accent);color:white;font-weight:800;padding:8px 12px;cursor:pointer}.claim-status{color:var(--accent);font-weight:800;font-size:13px}
    details.copy{margin-top:10px}summary{cursor:pointer;color:var(--accent);font-weight:700}pre{white-space:pre-wrap;background:#101820;color:#f5f7fa;border-radius:8px;padding:12px;overflow:auto;font-size:12px}.grid-two{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px}
  </style>
</head>
<body>
  <main class="wrap">
    <section class="hero">
      <h1>ORE 第 ${escapeHtml(validation.targetSeason || '')} 季週日預覽</h1>
      <p>K / SV / RBI 各提供五組合法版本。週日預設優先攻擊較穩定的一項式核心，不追策略容易被操控的 SB。</p>
      <div class="summary">
        <div class="card"><div class="label">驗證</div><div class="value">${escapeHtml(validation.status === 'PASS' ? '通過' : validation.status)}</div></div>
        <div class="card"><div class="label">來源季數</div><div class="value">${escapeHtml(validation.source.sourceSeason || '')}</div></div>
        <div class="card"><div class="label">版本數</div><div class="value">${escapeHtml(validation.totalVariantSections)}</div></div>
        <div class="card"><div class="label">名單列數</div><div class="value">${escapeHtml(validation.totalLineupRows)}</div></div>
      </div>
      <p>來源抓取時間：${escapeHtml(validation.source.scrapedAt || '')}。驗證 SHA：${escapeHtml(hash.slice(0, 16))}。</p>
    </section>
    ${renderOverview(reports, validation)}
    ${renderTeamRankingSection(projection, leagueAudit, leagueConfidenceAudit)}
    ${sections}
  </main>
  ${renderClaimScript(validation)}
</body>
</html>`;
}

function main() {
  const args = parseArgs(process.argv);
  const reports = {};
  for (const config of ITEM_CONFIGS) {
    const filePath = args[config.arg];
    if (!filePath) throw new Error(`Missing --${config.arg}=<draft json>`);
    reports[config.key] = readJson(path.resolve(filePath));
  }
  const targetSeason = args['target-season'] ? Number(args['target-season']) : null;
  const projectionPath = args.projection ? path.resolve(args.projection) : path.join(REPORTS_DIR, 'ore_projection_snapshot.json');
  const leagueAuditPath = args['league-audit'] ? path.resolve(args['league-audit']) : null;
  const leagueConfidenceAuditPath = args['league-confidence-audit'] ? path.resolve(args['league-confidence-audit']) : null;
  const projection = readOptionalJson(projectionPath);
  const leagueAudit = readOptionalJson(leagueAuditPath);
  const leagueConfidenceAudit = readOptionalJson(leagueConfidenceAuditPath);
  const outPath = path.resolve(args.out || path.join(REPORTS_DIR, `ore_${targetSeason || 'current'}_k_sv_rbi_sunday_preview.html`));
  const validationPath = path.resolve(args['validation-out'] || outPath.replace(/\.html?$/i, '_validation.json'));
  const validation = validateBundle(reports, targetSeason, { projection, leagueAudit, leagueConfidenceAudit });
  writeText(validationPath, `${JSON.stringify(validation, null, 2)}\n`);
  writeText(outPath, renderHtml({ reports, validation, projection, leagueAudit, leagueConfidenceAudit }));
  console.log(outPath);
  console.log(validationPath);
  if (validation.status !== 'PASS') {
    console.error(validation.failReasons.join('\n'));
    process.exitCode = 2;
  }
}

main();
