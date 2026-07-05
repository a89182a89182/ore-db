#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPORTS_DIR = path.resolve(__dirname, '..', '..', 'reports');
const BATTER_POSITIONS = ['C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF', 'DH'];
const PITCHER_ROLES = ['SP', 'RP', 'CP'];

const ITEM_CONFIGS = {
  HR: {
    key: 'HR',
    arg: 'hr',
    expectedMode: 'hr',
    core: 'batter',
    metricLabel: '預測全壘打',
    metric: lineup => sum(lineup, 'batter', 'home_runs'),
    rationale: '2026-06-26 holdout 出現 first-place variant，是目前最強的第一名訊號。'
  },
  RBI: {
    key: 'RBI',
    arg: 'rbi',
    expectedMode: 'rbi',
    core: 'batter',
    metricLabel: '預測打點',
    metric: lineup => sum(lineup, 'batter', 'rbi'),
    rationale: '<=775 training 曾有 first-place variant，776 holdout 最佳第 3 且只差 8 RBI。'
  },
  W: {
    key: 'W',
    arg: 'w',
    expectedMode: 'w',
    core: 'pitcher',
    metricLabel: '預測勝投',
    metric: lineup => sum(lineup, 'pitcher', 'wins'),
    rationale: '第三順位 recheck candidate；比 K/SV 更符合最新 first-place selector。'
  },
  K: {
    key: 'K',
    arg: 'k',
    expectedMode: 'k',
    core: 'pitcher',
    metricLabel: '預測三振',
    metric: lineup => sum(lineup, 'pitcher', 'strikeouts'),
    rationale: 'K 只有在 fresh-source evidence 修復 776 first-place miss pattern 時才回到正式品項。'
  },
  SV: {
    key: 'SV',
    arg: 'sv',
    expectedMode: 'sv',
    core: 'pitcher',
    metricLabel: '預測救援',
    metric: lineup => sum(lineup, 'pitcher', 'saves'),
    rationale: 'SV 在 776 holdout 與 delivered verdict 都沒有第一名，預設降級。'
  }
};

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const eq = token.indexOf('=');
    if (eq !== -1) {
      args[token.slice(2, eq)] = token.slice(eq + 1);
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      args[token.slice(2)] = argv[i + 1];
      i += 1;
    } else {
      args[token.slice(2)] = true;
    }
  }
  return args;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readOptionalJson(filePath) {
  return filePath && fs.existsSync(filePath) ? readJson(filePath) : null;
}

function writeText(filePath, body) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body, 'utf8');
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex').toUpperCase();
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

function fmt(value, digits = 2) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : '';
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
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0;
}

function seasonNumberFromDir(dirPath) {
  const match = String(dirPath || '').replace(/\\/g, '/').match(/season-(\d+)/i);
  return match ? Number(match[1]) : null;
}

function allTrue(record) {
  return Object.values(record || {}).every(Boolean);
}

function roleCounts(lineup) {
  const teams = new Map();
  const positions = new Set();
  const counts = { batters: 0, pitchers: 0, SP: 0, RP: 0, CP: 0 };
  for (const item of lineup || []) {
    if (item.category === 'batter') {
      counts.batters += 1;
      positions.add(item.role);
    }
    if (item.category === 'pitcher') {
      counts.pitchers += 1;
      if (PITCHER_ROLES.includes(item.role)) counts[item.role] += 1;
    }
    if (item.team) teams.set(item.team, (teams.get(item.team) || 0) + 1);
  }
  return {
    ...counts,
    teams: teams.size,
    maxTeamCount: teams.size ? Math.max(...teams.values()) : 0,
    fullBatterGrid: BATTER_POSITIONS.every(position => positions.has(position))
  };
}

function isReplacementPlayer(item) {
  if (!item) return false;
  const lower = JSON.stringify(item).toLowerCase();
  return item.matchMethod === 'retirement_replacement' ||
    item.isReplacementRookie ||
    item.replacementRookie ||
    item.retirementReplacement ||
    item.replacement_rookie ||
    /^replacement rookie\b/i.test(String(item.name || '')) ||
    lower.includes('retirement_replacement') ||
    lower.includes('replacement rookie');
}

function sourceLabel(report) {
  return {
    sourceSeason: seasonNumberFromDir(report && report.source && report.source.seasonDir),
    scrapedAt: report && report.source ? report.source.seasonScrapedAt || null : null,
    liveSourceType: report && report.source ? report.source.liveSourceType || null : null,
    liveSourceTimestamp: report && report.source ? report.source.liveSourceTimestamp || null : null
  };
}

function validateReport(config, report) {
  const failReasons = [];
  if (!report) return { key: config.key, status: 'FAIL', producedVariants: 0, failReasons: [`${config.key}: missing report`] };
  if (String(report.mode || '').toLowerCase() !== config.expectedMode) {
    failReasons.push(`${config.key}: expected mode ${config.expectedMode}, got ${report.mode}`);
  }
  if (report.feasible !== true) failReasons.push(`${config.key}: report feasible is not true`);
  if (!allTrue(report.legality)) failReasons.push(`${config.key}: report-level legality failed`);
  if (report.weightProfile && report.weightProfile.diagnosticOnly !== false) {
    failReasons.push(`${config.key}: weight profile is diagnosticOnly or missing diagnosticOnly=false`);
  }
  if (report.weightProfile && report.weightProfile.diagnosticEnabled) {
    failReasons.push(`${config.key}: diagnostic actual-stat scoring is enabled`);
  }
  const variants = report.lineupVariants || [];
  if (variants.length !== 5) failReasons.push(`${config.key}: expected 5 variants, got ${variants.length}`);
  const variantChecks = variants.map(variant => {
    const label = `${config.key} V${variant.variantIndex}`;
    const lineup = variant.lineup || [];
    const counts = roleCounts(lineup);
    const age43 = lineup.filter(item => Number(item.age) >= 43);
    const replacements = lineup.filter(isReplacementPlayer);
    const computers = lineup.filter(item => item.isComputer || item.is_computer);
    const variantFailReasons = [];
    if (variant.feasible !== true) variantFailReasons.push(`${label}: feasible is not true`);
    if (!allTrue(variant.legality)) variantFailReasons.push(`${label}: legality failed`);
    if (lineup.length !== 18) variantFailReasons.push(`${label}: expected 18 players, got ${lineup.length}`);
    if (counts.batters !== 9 || counts.pitchers !== 9 || counts.SP !== 5 || counts.RP !== 3 || counts.CP !== 1) {
      variantFailReasons.push(`${label}: role grid failed`);
    }
    if (!counts.fullBatterGrid) variantFailReasons.push(`${label}: missing full batter grid`);
    if (counts.teams !== 12) variantFailReasons.push(`${label}: expected 12 teams, got ${counts.teams}`);
    if (counts.maxTeamCount > 2) variantFailReasons.push(`${label}: max team count ${counts.maxTeamCount} exceeds 2`);
    if (computers.length) variantFailReasons.push(`${label}: contains computer players`);
    if (age43.length) variantFailReasons.push(`${label}: contains age 43+ player`);
    if (replacements.length) variantFailReasons.push(`${label}: contains replacement rookie`);
    failReasons.push(...variantFailReasons);
    return {
      variantIndex: variant.variantIndex,
      totalPlayers: lineup.length,
      ...counts,
      computerPlayers: computers.length,
      age43Players: age43.length,
      replacementPlayers: replacements.length,
      status: variantFailReasons.length ? 'FAIL' : 'PASS'
    };
  });
  return {
    key: config.key,
    mode: report.mode,
    status: failReasons.length ? 'FAIL' : 'PASS',
    producedVariants: variants.length,
    source: sourceLabel(report),
    variantChecks,
    failReasons
  };
}

function validateBundle(configs, reports, options) {
  const failReasons = [];
  const itemResults = configs.map(config => validateReport(config, reports[config.key]));
  failReasons.push(...itemResults.flatMap(result => result.failReasons));
  const firstSource = itemResults[0] ? itemResults[0].source || {} : {};
  for (const result of itemResults) {
    const label = result.source || {};
    if (label.sourceSeason !== firstSource.sourceSeason) failReasons.push(`${result.key}: source season differs from first item`);
    if (label.scrapedAt !== firstSource.scrapedAt) failReasons.push(`${result.key}: source scrapedAt differs from first item`);
  }
  const projection = options.projection || null;
  const projectionSource = projection && projection.sourceSnapshot ? projection.sourceSnapshot : {};
  if (projection) {
    if (projectionSource.sourceFreshnessStatus !== 'fresh_web_scrape') {
      failReasons.push(`projection source freshness is ${projectionSource.sourceFreshnessStatus}`);
    }
    if (Number(projectionSource.season) !== Number(firstSource.sourceSeason)) {
      failReasons.push('projection source season differs from draft source season');
    }
    if (projectionSource.scrapedAt !== firstSource.scrapedAt) {
      failReasons.push('projection source scrapedAt differs from draft source scrapedAt');
    }
    if (!Array.isArray(projection.teamProjections) || projection.teamProjections.length !== 12) {
      failReasons.push('projection must include 12 team projections');
    }
  }
  if (options.targetSeason && firstSource.sourceSeason && Number(options.targetSeason) !== Number(firstSource.sourceSeason) + 1) {
    failReasons.push(`target season ${options.targetSeason} does not equal source season ${firstSource.sourceSeason} + 1`);
  }
  const totalVariantSections = configs.reduce((total, config) => total + ((reports[config.key].lineupVariants || []).length), 0);
  const totalLineupRows = configs.reduce((total, config) => {
    return total + (reports[config.key].lineupVariants || []).reduce((sumRows, variant) => sumRows + ((variant.lineup || []).length), 0);
  }, 0);
  return {
    status: failReasons.length ? 'FAIL' : 'PASS',
    generatedAt: new Date().toISOString(),
    targetSeason: options.targetSeason || null,
    selectedItems: configs.map(config => config.key),
    itemPriority: configs.map((config, index) => ({ rank: index + 1, item: config.key, rationale: config.rationale })),
    source: {
      season: firstSource.sourceSeason || projectionSource.season || null,
      day: projectionSource.day || null,
      scrapedAt: firstSource.scrapedAt || projectionSource.scrapedAt || null,
      freshnessStatus: projectionSource.sourceFreshnessStatus || null,
      liveSources: [...new Set(itemResults.map(result => result.source && result.source.liveSourceType).filter(Boolean))]
    },
    model: {
      version: projection ? projection.modelVersion : null,
      confidence: projection ? projection.confidence : null,
      trainingSeasons: projection && Array.isArray(projection.trainingSeasons)
        ? projection.trainingSeasons.map(row => Number(row.season || row)).filter(Number.isFinite)
        : []
    },
    formalWeightProfile: {
      name: options.formalProfileName || null,
      sha256: options.formalProfileSha256 || null,
      diagnosticOnly: false
    },
    firstPlaceModelNotes: [
      'Only first place is prize-winning; top10/top3 are diagnostics only.',
      'HR and RBI are ahead of failed K/SV first-place results from the 2026-06-26 review.',
      'W is used as the third recheck candidate from the latest selector; SB remains strategy-risk/review-only.'
    ],
    totalVariantSections,
    totalLineupRows,
    teamRankingCardIncluded: Boolean(projection && Array.isArray(projection.teamProjections) && projection.teamProjections.length === 12),
    teamRankingRows: projection && Array.isArray(projection.teamProjections) ? projection.teamProjections.length : 0,
    leagueAuditIncluded: Boolean(options.leagueAudit),
    leagueConfidenceAuditIncluded: Boolean(options.leagueConfidenceAudit),
    leagueAuditSummary: options.leagueAudit ? options.leagueAudit.overall : null,
    leagueConfidenceSummary: options.leagueConfidenceAudit ? options.leagueConfidenceAudit.overall || {
      championConfidence: options.leagueConfidenceAudit.championConfidence,
      decision: options.leagueConfidenceAudit.decision
    } : null,
    itemResults,
    failReasons
  };
}

function statText(item) {
  const p = item.projectedStats || {};
  if (item.category === 'pitcher') {
    return `W ${p.wins ?? ''} / K ${p.strikeouts ?? ''} / SV ${p.saves ?? ''} / ERA ${p.era ?? ''}`;
  }
  return `HR ${p.home_runs ?? ''} / RBI ${p.rbi ?? ''} / AVG ${p.batting_avg ?? ''} / SB ${p.steals ?? ''}`;
}

function abilityText(item) {
  const a = item.abilities || {};
  if (item.category === 'pitcher') return `控 ${a.control ?? ''} / 體 ${a.stamina ?? ''} / 速 ${a.velocity ?? ''}`;
  return `力 ${a.power ?? ''} / 巧 ${a.contact ?? ''} / 走 ${a.speed ?? ''} / 守 ${a.defense ?? ''} / 肩 ${a.arm ?? ''}`;
}

function copyRows(variant) {
  return (variant.lineup || []).map(item => `${item.role}\t${item.team}\t${item.name}\t${item.owner}`).join('\n');
}

function renderLineupTable(variant) {
  const rows = (variant.lineup || []).map(item => {
    return `<tr><td>${escapeHtml(item.role)}</td><td>${escapeHtml(item.team)}</td><td class="player">${escapeHtml(item.name)}</td><td>${escapeHtml(item.owner)}</td><td>${escapeHtml(statText(item))}</td><td>${escapeHtml(abilityText(item))}</td><td>${escapeHtml((item.skills || []).join(' / '))}</td></tr>`;
  }).join('\n');
  return `<table><thead><tr><th>位置</th><th>球隊</th><th>球員</th><th>GM</th><th>預測</th><th>能力</th><th>技能</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderVariant(config, variant) {
  const lineup = variant.lineup || [];
  const metric = config.metric(lineup);
  const projectedHr = sum(lineup, 'batter', 'home_runs');
  const projectedRbi = sum(lineup, 'batter', 'rbi');
  const projectedW = sum(lineup, 'pitcher', 'wins');
  const projectedK = sum(lineup, 'pitcher', 'strikeouts');
  const projectedSv = sum(lineup, 'pitcher', 'saves');
  const projectedEra = avg(lineup, 'pitcher', 'era');
  return `<section class="variant">
    <div class="variant-head">
      <h3>${escapeHtml(config.key)} V${escapeHtml(variant.variantIndex)}</h3>
      <div class="chips">
        <span>${escapeHtml(config.metricLabel)} ${escapeHtml(metric)}</span>
        <span>HR ${escapeHtml(projectedHr)}</span>
        <span>RBI ${escapeHtml(projectedRbi)}</span>
        <span>W ${escapeHtml(projectedW)}</span>
        <span>K ${escapeHtml(projectedK)}</span>
        <span>SV ${escapeHtml(projectedSv)}</span>
        <span>ERA ${escapeHtml(fmt(projectedEra, 2))}</span>
      </div>
    </div>
    <div class="claim" data-claim-key="${escapeHtml(`${config.key} V${variant.variantIndex}`)}">
      <label>${escapeHtml(config.key)} V${escapeHtml(variant.variantIndex)} 認領</label>
      <input type="text" autocomplete="name" placeholder="輸入名字">
      <button type="button">儲存</button>
      <span class="claim-status" aria-live="polite"></span>
    </div>
    <details><summary>複製用 18 人名單</summary><pre>${escapeHtml(copyRows(variant))}</pre></details>
    ${renderLineupTable(variant)}
  </section>`;
}

function renderItemSection(config, report) {
  return `<section class="section">
    <h2>${escapeHtml(config.key)} 5 組版本</h2>
    <p>${escapeHtml(config.rationale)} 核心目標是 ${escapeHtml(config.metricLabel)}；非目標位置只做合法補位與隊伍限制。</p>
    ${(report.lineupVariants || []).map(variant => renderVariant(config, variant)).join('\n')}
  </section>`;
}

function renderOverview(configs, reports, validation) {
  const rows = configs.map((config, index) => {
    const variants = reports[config.key].lineupVariants || [];
    const bestMetric = Math.max(...variants.map(variant => config.metric(variant.lineup || [])));
    const result = validation.itemResults.find(row => row.key === config.key) || {};
    return `<tr><td>${index + 1}</td><td>${escapeHtml(config.key)}</td><td>${escapeHtml(config.metricLabel)}</td><td>${escapeHtml(bestMetric)}</td><td>${escapeHtml(variants.length)}</td><td>${escapeHtml(result.status || '')}</td><td>${escapeHtml(config.rationale)}</td></tr>`;
  }).join('\n');
  return `<section class="section">
    <h2>品項優先序</h2>
    <p>本週只以第一名機率為正式目標；top10/top3 只用來診斷距離，不視為成功。</p>
    <table><thead><tr><th>#</th><th>品項</th><th>目標</th><th>最佳預測值</th><th>版本數</th><th>驗證</th><th>依據</th></tr></thead><tbody>${rows}</tbody></table>
  </section>`;
}

function renderTeamRankings(projection, leagueAudit, confidenceAudit) {
  if (!projection || !Array.isArray(projection.teamProjections)) return '';
  const groups = new Map();
  for (const team of projection.teamProjections) {
    const league = team.league || '未分聯盟';
    if (!groups.has(league)) groups.set(league, []);
    groups.get(league).push(team);
  }
  const tables = [...groups.entries()].map(([league, teams]) => {
    const rows = teams.slice().sort((a, b) => num(b.overallScore) - num(a.overallScore)).map((team, index) => {
      return `<tr><td>${index + 1}</td><td class="player">${escapeHtml(team.team)}</td><td>${escapeHtml(fmt(team.overallScore, 2))}</td><td>${escapeHtml(fmt(team.offenseScore, 2))}</td><td>${escapeHtml(fmt(team.pitchingScore, 2))}</td><td>${escapeHtml(fmt(team.sameLeagueAdjustment, 2))}</td></tr>`;
    }).join('\n');
    return `<div><h3>${escapeHtml(league)}</h3><table><thead><tr><th>預測排名</th><th>球隊</th><th>總分</th><th>打擊</th><th>投手</th><th>同聯盟調整</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }).join('\n');
  const overall = leagueAudit && leagueAudit.overall ? leagueAudit.overall : {};
  const confidence = confidenceAudit && confidenceAudit.overall ? confidenceAudit.overall : {};
  return `<section class="section">
    <h2>聯盟排名與冠軍預測</h2>
    <div class="summary">
      <div class="card"><div class="label">預測冠軍</div><div class="value">${escapeHtml(overall.projectedChampion || '')}</div></div>
      <div class="card"><div class="label">目前領先</div><div class="value">${escapeHtml(overall.currentOverallLeader || '')}</div></div>
      <div class="card"><div class="label">Exact rank</div><div class="value">${escapeHtml(`${overall.exactMatches ?? ''}/${overall.teamCount ?? ''}`)}</div></div>
      <div class="card"><div class="label">Champion confidence</div><div class="value">${escapeHtml(confidence.championConfidence || confidenceAudit?.championConfidence || '')}</div></div>
    </div>
    <p>League-rank audit 狀態：${escapeHtml(overall.status || '')}；mean abs rank error ${escapeHtml(overall.meanAbsRankError ?? '')}；max error ${escapeHtml(overall.maxAbsRankError ?? '')}。Confidence decision：${escapeHtml(confidence.decision || confidenceAudit?.decision || '')}。</p>
    <div class="grid-two">${tables}</div>
  </section>`;
}

function renderClaimScript(validation) {
  const prefix = `ore-sunday-first-place:${validation.targetSeason || 'unknown'}:${validation.source.season || 'unknown'}:${validation.source.scrapedAt || 'unknown'}`;
  return `<script>
(() => {
  const prefix = ${JSON.stringify(prefix)};
  document.querySelectorAll('.claim').forEach(block => {
    const key = prefix + ':' + (block.dataset.claimKey || '');
    const input = block.querySelector('input');
    const button = block.querySelector('button');
    const status = block.querySelector('.claim-status');
    const render = value => { status.textContent = value ? '已記錄：' + value : ''; };
    const saved = localStorage.getItem(key) || '';
    input.value = saved;
    render(saved);
    button.addEventListener('click', () => {
      const value = input.value.trim();
      if (value) localStorage.setItem(key, value);
      else localStorage.removeItem(key);
      render(value);
    });
  });
})();
</script>`;
}

function renderHtml({ configs, reports, validation, projection, leagueAudit, leagueConfidenceAudit }) {
  const itemText = configs.map(config => config.key).join(' / ');
  const htmlId = sha256(JSON.stringify({
    targetSeason: validation.targetSeason,
    source: validation.source,
    selectedItems: validation.selectedItems,
    totalVariantSections: validation.totalVariantSections
  })).slice(0, 16);
  return `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ORE ${escapeHtml(validation.targetSeason)} Sunday Preview - ${escapeHtml(itemText)}</title>
  <style>
    :root{color-scheme:light;--bg:#f5f7fa;--paper:#fff;--ink:#152033;--muted:#5b6575;--line:#d8e0ea;--accent:#146c5c;--warn:#9a4b00}
    *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans TC","Microsoft JhengHei",Arial,sans-serif;line-height:1.55}
    .wrap{max-width:1240px;margin:0 auto;padding:24px 16px 56px}.hero,.section,.variant{background:var(--paper);border:1px solid var(--line);border-radius:8px;box-shadow:0 1px 2px rgba(20,30,45,.04)}
    .hero{padding:22px;margin-bottom:14px}.section{padding:18px;margin-top:14px}.variant{padding:14px;margin-top:12px}h1{margin:0 0 8px;font-size:30px;letter-spacing:0}h2{margin:0 0 10px;font-size:22px}h3{margin:0;font-size:17px}
    p{margin:7px 0;color:var(--muted)}.note{color:var(--warn)}.summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;margin-top:14px}.card{border:1px solid var(--line);border-radius:8px;padding:12px;background:#fbfcfd}.label{font-size:12px;color:var(--muted);text-transform:uppercase}.value{font-size:20px;font-weight:800;margin-top:2px}
    table{width:100%;border-collapse:collapse;margin-top:10px;font-size:13px}th,td{border-bottom:1px solid var(--line);padding:7px 8px;text-align:left;vertical-align:top}th{background:#eef3f6;font-weight:700}.player{font-weight:700}.variant-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap}.chips{display:flex;gap:7px;flex-wrap:wrap}.chips span{border:1px solid var(--line);border-radius:999px;padding:3px 8px;background:#f7fafb;color:#2d3845;font-size:12px}
    .claim{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:10px;padding:10px;border:1px solid var(--line);border-radius:8px;background:#f7fafb}.claim label{font-weight:800;font-size:13px}.claim input{min-width:220px;max-width:320px;flex:1 1 220px;border:1px solid #b9c7d5;border-radius:6px;padding:7px 9px;font:inherit}.claim button{border:0;border-radius:6px;background:var(--accent);color:white;font-weight:800;padding:8px 12px;cursor:pointer}.claim-status{color:var(--accent);font-weight:800;font-size:13px}
    details{margin-top:10px}summary{cursor:pointer;color:var(--accent);font-weight:700}pre{white-space:pre-wrap;background:#101820;color:#f5f7fa;border-radius:8px;padding:12px;overflow:auto;font-size:12px}.grid-two{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px}
  </style>
</head>
<body>
  <main class="wrap">
    <section class="hero">
      <h1>ORE ${escapeHtml(validation.targetSeason)} Sunday Preview</h1>
      <p>本週正式推薦品項：<strong>${escapeHtml(itemText)}</strong>。選擇依據是最新完整 Friday first-place review；只有第一名有獎，top10/top3 只作為診斷訊號。</p>
      <div class="summary">
        <div class="card"><div class="label">驗證狀態</div><div class="value">${escapeHtml(validation.status)}</div></div>
        <div class="card"><div class="label">來源</div><div class="value">${escapeHtml(`S${validation.source.season} D${validation.source.day}`)}</div></div>
        <div class="card"><div class="label">Variants</div><div class="value">${escapeHtml(validation.totalVariantSections)}</div></div>
        <div class="card"><div class="label">Rows</div><div class="value">${escapeHtml(validation.totalLineupRows)}</div></div>
      </div>
      <p>來源時間：${escapeHtml(validation.source.scrapedAt)}；freshness：${escapeHtml(validation.source.freshnessStatus)}；formal profile SHA256：${escapeHtml(validation.formalWeightProfile.sha256 || '')}；report id：${escapeHtml(htmlId)}。</p>
      <p class="note">K/SV 因 2026-06-26 first-place verdict 未得第一且 fresh evidence 未修復 miss pattern，本次不列入正式三品項；SB 保持 strategy-risk review-only。</p>
    </section>
    ${renderOverview(configs, reports, validation)}
    ${renderTeamRankings(projection, leagueAudit, leagueConfidenceAudit)}
    ${configs.map(config => renderItemSection(config, reports[config.key])).join('\n')}
  </main>
  ${renderClaimScript(validation)}
</body>
</html>`;
}

function main() {
  const args = parseArgs(process.argv);
  const selectedItems = String(args.items || 'HR,RBI,W')
    .split(',')
    .map(item => item.trim().toUpperCase())
    .filter(Boolean);
  const configs = selectedItems.map(item => {
    if (!ITEM_CONFIGS[item]) throw new Error(`Unsupported item: ${item}`);
    return ITEM_CONFIGS[item];
  });
  const reports = {};
  for (const config of configs) {
    const reportPath = args[config.arg];
    if (!reportPath) throw new Error(`Missing --${config.arg}=<draft json>`);
    reports[config.key] = readJson(path.resolve(reportPath));
  }
  const targetSeason = args['target-season'] ? Number(args['target-season']) : null;
  const projectionPath = args.projection ? path.resolve(args.projection) : path.join(REPORTS_DIR, 'ore_projection_snapshot.json');
  const leagueAuditPath = args['league-audit'] ? path.resolve(args['league-audit']) : null;
  const leagueConfidencePath = args['league-confidence-audit'] ? path.resolve(args['league-confidence-audit']) : null;
  const projection = readOptionalJson(projectionPath);
  const leagueAudit = readOptionalJson(leagueAuditPath);
  const leagueConfidenceAudit = readOptionalJson(leagueConfidencePath);
  const outPath = path.resolve(args.out || path.join(REPORTS_DIR, `ore_${targetSeason || 'current'}_sunday_first_place_preview.html`));
  const validationPath = path.resolve(args['validation-out'] || outPath.replace(/\.html?$/i, '_validation.json'));
  const validation = validateBundle(configs, reports, {
    projection,
    leagueAudit,
    leagueConfidenceAudit,
    targetSeason,
    formalProfileName: args['formal-profile-name'] || null,
    formalProfileSha256: args['formal-profile-sha256'] || null
  });
  const html = renderHtml({ configs, reports, validation, projection, leagueAudit, leagueConfidenceAudit });
  validation.htmlSha256 = sha256(html);
  writeText(validationPath, `${JSON.stringify(validation, null, 2)}\n`);
  writeText(outPath, html);
  console.log(outPath);
  console.log(validationPath);
  console.log(`status=${validation.status}`);
  if (validation.status !== 'PASS') {
    console.error(validation.failReasons.join('\n'));
    process.exitCode = 2;
  }
}

main();
