#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

function arg(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find(item => item.startsWith(prefix));
  if (found) return found.slice(prefix.length);
  const splitIndex = process.argv.indexOf(`--${name}`);
  if (splitIndex >= 0 && process.argv[splitIndex + 1]) return process.argv[splitIndex + 1];
  return fallback;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readJsonIfExists(filePath) {
  return filePath && fs.existsSync(filePath) ? readJson(filePath) : null;
}

function writeFile(filePath, body) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body, 'utf8');
}

function numberOrNull(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const cleaned = String(value).replace(/,/g, '').trim();
  if (!cleaned || cleaned === '-' || cleaned === '--') return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseOuts(value) {
  if (value == null || value === '') return 0;
  if (typeof value === 'number') return Math.round(value * 3);
  const text = String(value).trim();
  if (!text || text === '-' || text === '--') return 0;
  const match = text.match(/^(\d+)(?:\s+([0-2])\/3)?$/);
  if (match) return Number(match[1]) * 3 + (match[2] ? Number(match[2]) : 0);
  const parsed = Number(text);
  return Number.isFinite(parsed) ? Math.round(parsed * 3) : 0;
}

function formatIp(outs) {
  if (!outs) return '0';
  const innings = Math.floor(outs / 3);
  const remainder = outs % 3;
  return remainder ? `${innings} ${remainder}/3` : String(innings);
}

function fmt(value, digits = 2) {
  return value == null || !Number.isFinite(Number(value)) ? '-' : Number(value).toFixed(digits);
}

function pct(value, digits = 0) {
  return `${(Number(value || 0) * 100).toFixed(digits)}%`;
}

function keyFor(row) {
  return [row.team || '', row.owner || '', row.name || '', row.category || ''].join('|');
}

function identity(row) {
  return keyFor(row);
}

function roleOf(row) {
  return String(row.role || row.position_or_role || row.season_summary_role || row.raw_position_or_role || '').trim();
}

function ranked(rows, valueFn, desc) {
  const sorted = rows
    .filter(row => {
      const value = valueFn(row);
      return value != null && Number.isFinite(value);
    })
    .slice()
    .sort((a, b) => {
      const delta = valueFn(a) - valueFn(b);
      return desc ? -delta : delta;
    });

  const ranks = new Map();
  let previous = null;
  let rank = 0;
  sorted.forEach((row, index) => {
    const value = valueFn(row);
    if (index === 0 || value !== previous) rank = index + 1;
    ranks.set(keyFor(row), rank);
    previous = value;
  });
  return { sorted, ranks };
}

function leaderboardRows(rows, n, item, valueField, lowerBetter = false) {
  return rows.slice(0, n).map((row, index) => ({
    rank: index + 1,
    identity: identity(row),
    team: row.team,
    owner: row.owner || '',
    name: row.name,
    role: roleOf(row),
    category: row.category,
    current: row[valueField],
    value: row[valueField],
    projected: null,
    outs: row.actualOuts == null ? null : row.actualOuts,
    IP: row.actualOuts == null ? null : formatIp(row.actualOuts),
    metric: item,
    lowerBetter
  }));
}

function selectedUniqueRows(itemBlock) {
  const unique = new Map();
  for (const variant of itemBlock.variants || []) {
    for (const row of variant.rows || []) {
      if (!unique.has(row.identity)) {
        unique.set(row.identity, {
          item: row.item,
          identity: row.identity,
          team: row.team,
          owner: row.owner || '',
          name: row.name,
          role: row.role,
          category: row.category,
          current: row.current,
          projected: row.projected,
          outs: row.outs == null ? null : row.outs,
          IP: row.outs == null ? null : formatIp(row.outs),
          rank: row.rank == null ? null : Number(row.rank),
          variants: []
        });
      }
      unique.get(row.identity).variants.push(variant.variantIndex);
    }
  }
  return [...unique.values()].sort((a, b) => {
    const ar = a.rank == null ? 999999 : a.rank;
    const br = b.rank == null ? 999999 : b.rank;
    return ar - br || String(a.team).localeCompare(String(b.team));
  });
}

function metricCounts(rows) {
  const counts = {
    selectedUnique: rows.length,
    selectedTopScorer: rows.filter(row => row.rank != null && row.rank <= 1).length,
    selectedTop3: rows.filter(row => row.rank != null && row.rank <= 3).length,
    selectedTop5: rows.filter(row => row.rank != null && row.rank <= 5).length,
    selectedTop10: rows.filter(row => row.rank != null && row.rank <= 10).length,
    selectedUsefulTop20: rows.filter(row => row.rank != null && row.rank <= 20).length,
    selectedUsefulButNotTop: rows.filter(row => row.rank != null && row.rank > 5 && row.rank <= 20).length,
    clearMisses: rows.filter(row => row.rank == null || row.rank > 20).length,
    unranked: rows.filter(row => row.rank == null).length
  };
  counts.clearMissRate = counts.selectedUnique ? counts.clearMisses / counts.selectedUnique : 0;
  counts.usefulRate = counts.selectedUnique ? counts.selectedUsefulTop20 / counts.selectedUnique : 0;
  return counts;
}

function variantHitRates(variants) {
  return (variants || []).map(variant => {
    const rows = variant.rows || [];
    const counts = metricCounts(rows);
    return {
      variantIndex: variant.variantIndex,
      feasible: variant.feasible,
      selectedCount: rows.length,
      actualValue: variant.actualValue,
      projectedValue: variant.projectedValue,
      selectedTopScorer: counts.selectedTopScorer,
      selectedTop3: counts.selectedTop3,
      selectedTop5: counts.selectedTop5,
      selectedUsefulTop20: counts.selectedUsefulTop20,
      clearMisses: counts.clearMisses,
      clearMissRate: counts.clearMissRate
    };
  });
}

function variantTeamContexts(variants) {
  return (variants || []).map(variant => {
    const teamCounts = {};
    const roles = new Set();
    for (const row of variant.rows || []) {
      teamCounts[row.team] = (teamCounts[row.team] || 0) + 1;
      if (row.role) roles.add(row.role);
    }
    return { variantIndex: variant.variantIndex, teamCounts, roles };
  });
}

function sourceHasRisk(itemBlock) {
  const report = itemBlock.report || {};
  return Boolean(report.fallbackReason || report.liveFetchSucceeded === false || report.liveSourceType !== 'live_fetch');
}

function causeForMissedLeader(item, row, selectedRows, variantContexts, itemBlock, fantasyPublicAudit) {
  const causes = [];
  const selectedRoles = new Set(selectedRows.map(selected => selected.role).filter(Boolean));
  if (sourceHasRisk(itemBlock)) causes.push('live_source_risk');
  const playerPicksStatus = fantasyPublicAudit && fantasyPublicAudit.fantasy && fantasyPublicAudit.fantasy.playerPicksStatus;
  if (playerPicksStatus && /blocked|unavailable|missing/i.test(playerPicksStatus)) causes.push('public_consensus_unavailable');
  if (row.role && !selectedRoles.has(row.role)) causes.push('role_slot_gap');
  if (variantContexts.some(context => (context.teamCounts[row.team] || 0) >= 2)) causes.push('max_two_per_team_tradeoff');
  if (item === 'SB') causes.push('sb_strategy_or_small_sample_volatility');
  if (item === 'ERA' && /CP|CL/i.test(row.role || '')) causes.push('low_ip_era_volatility');
  if (!causes.length) causes.push('projection_current_result_gap');
  return [...new Set(causes)];
}

function causeForUnderperformer(item, row, itemBlock, fantasyPublicAudit) {
  const causes = [];
  if (sourceHasRisk(itemBlock)) causes.push('live_source_risk');
  const playerPicksStatus = fantasyPublicAudit && fantasyPublicAudit.fantasy && fantasyPublicAudit.fantasy.playerPicksStatus;
  if (playerPicksStatus && /blocked|unavailable|missing/i.test(playerPicksStatus)) causes.push('public_consensus_unavailable');
  if ((row.variants || []).length >= 4) causes.push('systematic_projection_overweight');
  if (row.projected != null) causes.push('projection_variance');
  if (item === 'SB') causes.push('steal_strategy_variance');
  if (item === 'K' && /RP|CP/i.test(row.role || '')) causes.push('reliever_workload_variance');
  if (item === 'ERA' && row.outs != null && row.outs < 120) causes.push('low_ip_era_volatility');
  if (!causes.length) causes.push('current_result_underperformance');
  return [...new Set(causes)];
}

function compactRow(row, item) {
  return {
    rank: row.rank,
    team: row.team,
    owner: row.owner || '',
    name: row.name,
    role: row.role,
    current: row.current,
    projected: row.projected,
    IP: row.IP || (row.outs == null ? null : formatIp(row.outs)),
    variants: row.variants || [],
    item
  };
}

function verdict(item, counts, coverage) {
  const top10Hit = coverage && coverage.top10 ? Number(coverage.top10.hit || 0) : 0;
  if (top10Hit >= 7 && counts.clearMissRate <= 0.25) return 'strong';
  if (top10Hit >= 4 && counts.usefulRate >= 0.35) return 'usable';
  if (counts.clearMissRate >= 0.5) return 'needs_review';
  return 'thin';
}

function analyzeItem(item, itemBlock, ranks, valueField, lowerBetter, fantasyPublicAudit) {
  const selectedRows = selectedUniqueRows(itemBlock);
  const counts = metricCounts(selectedRows);
  const selectedSet = new Set(selectedRows.map(row => row.identity));
  const top20 = leaderboardRows(ranks.sorted, 20, item, valueField, lowerBetter);
  const variantContexts = variantTeamContexts(itemBlock.variants);
  const missedTop10 = top20
    .slice(0, 10)
    .filter(row => !selectedSet.has(row.identity))
    .map(row => ({
      ...row,
      likelyCauses: causeForMissedLeader(item, row, selectedRows, variantContexts, itemBlock, fantasyPublicAudit)
    }));
  const missedTop20 = top20
    .filter(row => !selectedSet.has(row.identity))
    .map(row => ({
      ...row,
      likelyCauses: causeForMissedLeader(item, row, selectedRows, variantContexts, itemBlock, fantasyPublicAudit)
    }));
  const underperformers = selectedRows
    .filter(row => row.rank == null || row.rank > 20)
    .sort((a, b) => {
      const ar = a.rank == null ? 999999 : a.rank;
      const br = b.rank == null ? 999999 : b.rank;
      return br - ar || (b.variants || []).length - (a.variants || []).length;
    })
    .map(row => ({
      ...compactRow(row, item),
      likelyCauses: causeForUnderperformer(item, row, itemBlock, fantasyPublicAudit)
    }));

  const top10 = (itemBlock.coverage && itemBlock.coverage.top10) || {};
  const top20Coverage = (itemBlock.coverage && itemBlock.coverage.top20) || {};
  return {
    item,
    status: 'PASS',
    verdict: verdict(item, counts, itemBlock.coverage || {}),
    counts,
    coverage: {
      top10: top10,
      top20: top20Coverage
    },
    bestVariant: itemBlock.bestVariant || null,
    variantHitRates: variantHitRates(itemBlock.variants || []),
    topSelected: selectedRows.slice(0, 12).map(row => compactRow(row, item)),
    underperformers: underperformers.slice(0, 12),
    missedCurrentTop10: missedTop10,
    missedCurrentTop20: missedTop20,
    leaderboardTop10: top20.slice(0, 10),
    sourceRisk: sourceHasRisk(itemBlock)
  };
}

function causeSummary(items) {
  const counts = {};
  for (const item of Object.values(items)) {
    for (const row of [...(item.underperformers || []), ...(item.missedCurrentTop10 || [])]) {
      for (const cause of row.likelyCauses || []) {
        counts[cause] = (counts[cause] || 0) + 1;
      }
    }
  }
  return Object.entries(counts)
    .map(([cause, count]) => ({ cause, count }))
    .sort((a, b) => b.count - a.count || a.cause.localeCompare(b.cause));
}

function actionPlan(items, weeklyRecommendation, fantasyPublicAudit) {
  const actions = [];
  const primary = weeklyRecommendation && weeklyRecommendation.primary;
  if (primary && items[primary]) {
    const item = items[primary];
    actions.push(`${primary}: keep as primary while it remains ${item.verdict}; current top10 overlap is ${item.coverage.top10.hit || 0}/${item.coverage.top10.total || 10}.`);
  }
  for (const item of Object.values(items)) {
    if (item.counts.clearMissRate >= 0.45) {
      actions.push(`${item.item}: review selected outside-top20 players before using this item as the weekly bet; clear-miss rate is ${pct(item.counts.clearMissRate)}.`);
    }
    if ((item.missedCurrentTop10 || []).length >= 6) {
      actions.push(`${item.item}: inspect missed current top10 leaders and add a manual caution flag until the projection gap narrows.`);
    }
  }
  const playerPicksStatus = fantasyPublicAudit && fantasyPublicAudit.fantasy && fantasyPublicAudit.fantasy.playerPicksStatus;
  if (playerPicksStatus && /blocked|unavailable|missing/i.test(playerPicksStatus)) {
    actions.push(`Public fantasy player picks are ${playerPicksStatus}; treat this audit as result-based validation rather than crowd-consensus validation.`);
  }
  return [...new Set(actions)].slice(0, 8);
}

function renderMetricValue(item, value) {
  if (value == null || !Number.isFinite(Number(value))) return '-';
  if (item === 'ERA') return fmt(value, 3);
  return String(Math.round(value));
}

function renderMarkdown(audit) {
  const lines = [];
  lines.push(`# ORE ${audit.targetSeason} Fantasy Hit-Rate Audit`);
  lines.push('');
  lines.push(`Generated: ${audit.generatedAt}`);
  lines.push(`Source season: ${audit.source.season}; day: ${audit.source.day}; scraped at: ${audit.source.scrapedAt}`);
  lines.push(`Status: ${audit.status}`);
  lines.push('');
  lines.push('## Item hit rates');
  lines.push('| Item | Verdict | Top scorer | Top3 | Top5 | Useful top20 | Clear misses | Top10 hit | Top20 hit |');
  lines.push('|---|---|---:|---:|---:|---:|---:|---:|---:|');
  for (const item of ['HR', 'SB', 'K', 'ERA']) {
    const block = audit.items[item];
    lines.push(`| ${item} | ${block.verdict} | ${block.counts.selectedTopScorer} | ${block.counts.selectedTop3} | ${block.counts.selectedTop5} | ${block.counts.selectedUsefulTop20} | ${block.counts.clearMisses} (${pct(block.counts.clearMissRate)}) | ${block.coverage.top10.hit}/${block.coverage.top10.total} | ${block.coverage.top20.hit}/${block.coverage.top20.total} |`);
  }
  lines.push('');
  lines.push('## Model actions');
  for (const action of audit.modelActions) lines.push(`- ${action}`);
  lines.push('');
  for (const item of ['HR', 'SB', 'K', 'ERA']) {
    const block = audit.items[item];
    lines.push(`## ${item} misses`);
    lines.push('- Underperformers:');
    for (const row of block.underperformers.slice(0, 6)) {
      lines.push(`  - #${row.rank || '-'} ${row.role} ${row.team} ${row.name} (${row.owner}): current ${renderMetricValue(item, row.current)}, projected ${renderMetricValue(item, row.projected)}, variants ${(row.variants || []).join(',')}; causes ${(row.likelyCauses || []).join(', ')}.`);
    }
    lines.push('- Missed current top10:');
    for (const row of block.missedCurrentTop10.slice(0, 6)) {
      lines.push(`  - #${row.rank} ${row.role} ${row.team} ${row.name} (${row.owner}): current ${renderMetricValue(item, row.current)}${row.IP ? `, IP ${row.IP}` : ''}; causes ${(row.likelyCauses || []).join(', ')}.`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

function main() {
  const reportsDir = arg('reports-dir', path.resolve(__dirname, '..', '..', 'reports'));
  const weeklyItemsAuditPath = arg('weekly-items-audit', null);
  if (!weeklyItemsAuditPath) throw new Error('Missing --weekly-items-audit');
  const weeklyItemsAudit = readJson(weeklyItemsAuditPath);
  const fantasyPublicAuditPath = arg('fantasy-public-audit', null);
  const fantasyPublicAudit = readJsonIfExists(fantasyPublicAuditPath);
  const source = weeklyItemsAudit.source || {};
  const paths = {
    HR: arg('hr', source.hr && source.hr.path || path.join(reportsDir, 'ore_draft_hr.json')),
    SB: arg('sb', source.sb && source.sb.path || path.join(reportsDir, 'ore_draft_sb.json')),
    K: arg('k', source.k && source.k.path || path.join(reportsDir, 'ore_draft_k.json')),
    ERA: arg('era', source.era && source.era.path || path.join(reportsDir, 'ore_draft_era.json'))
  };
  const seasonDir = arg('season-dir', source.seasonDir);
  if (!seasonDir) throw new Error('Missing --season-dir and weekly audit source.seasonDir');
  const playersPath = arg('players', path.join(seasonDir, 'players.json'));
  const metaPath = path.join(seasonDir, 'meta.json');
  const players = readJson(playersPath);
  const meta = fs.existsSync(metaPath) ? readJson(metaPath) : {};
  const sourceSeason = Number(meta.season || source.season || players[0] && players[0].season);
  const targetSeason = Number(weeklyItemsAudit.targetSeason || sourceSeason + 1);
  const sourceDay = meta.day || meta.current_day || source.day || null;
  const dayLabel = sourceDay == null ? 'dayx' : `day${sourceDay}`;
  const dateLabel = arg('date', new Date().toISOString().slice(0, 10));
  const outPath = arg('out', path.join(reportsDir, `ore_${targetSeason}_fantasy_hit_rate_${dayLabel}_audit_${dateLabel}.json`));
  const mdPath = arg('md-out', path.join(reportsDir, `ore_${targetSeason}_fantasy_hit_rate_${dayLabel}_audit_${dateLabel}.md`));

  const batters = players
    .filter(row => row.category === 'batter' && !row.is_computer)
    .map(row => ({
      ...row,
      role: roleOf(row),
      actualHR: numberOrNull(row.current_batting && row.current_batting.home_runs),
      actualSB: numberOrNull(row.current_batting && row.current_batting.steals)
    }));
  const pitchers = players
    .filter(row => row.category === 'pitcher' && !row.is_computer)
    .map(row => ({
      ...row,
      role: roleOf(row),
      actualK: numberOrNull(row.current_pitching && row.current_pitching.strikeouts),
      actualERA: numberOrNull(row.current_pitching && row.current_pitching.era),
      actualOuts: parseOuts(row.current_pitching && row.current_pitching.innings_pitched)
    }));

  const ranks = {
    HR: ranked(batters, row => row.actualHR, true),
    SB: ranked(batters, row => row.actualSB, true),
    K: ranked(pitchers, row => row.actualK, true),
    ERA: ranked(pitchers.filter(row => row.actualERA != null && row.actualOuts > 0), row => row.actualERA, false)
  };

  const items = {
    HR: analyzeItem('HR', weeklyItemsAudit.items.HR, ranks.HR, 'actualHR', false, fantasyPublicAudit),
    SB: analyzeItem('SB', weeklyItemsAudit.items.SB, ranks.SB, 'actualSB', false, fantasyPublicAudit),
    K: analyzeItem('K', weeklyItemsAudit.items.K, ranks.K, 'actualK', false, fantasyPublicAudit),
    ERA: analyzeItem('ERA', weeklyItemsAudit.items.ERA, ranks.ERA, 'actualERA', true, fantasyPublicAudit)
  };

  const audit = {
    generatedAt: new Date().toISOString(),
    status: 'PASS',
    targetSeason,
    source: {
      seasonDir,
      playersPath,
      season: String(sourceSeason),
      day: sourceDay == null ? null : String(sourceDay),
      scrapedAt: meta.scraped_at || meta.scrapedAt || source.scrapedAt || null,
      playerCount: players.length,
      batterCount: batters.length,
      pitcherCount: pitchers.length,
      weeklyItemsAudit: { path: weeklyItemsAuditPath },
      fantasyPublicAudit: fantasyPublicAuditPath ? {
        path: fantasyPublicAuditPath,
        status: fantasyPublicAudit ? fantasyPublicAudit.status : null,
        playerPicksStatus: fantasyPublicAudit && fantasyPublicAudit.fantasy ? fantasyPublicAudit.fantasy.playerPicksStatus : null
      } : null,
      hr: { path: paths.HR },
      sb: { path: paths.SB },
      k: { path: paths.K },
      era: { path: paths.ERA }
    },
    weeklyRecommendation: weeklyItemsAudit.recommendation || null,
    primaryItem: weeklyItemsAudit.recommendation && weeklyItemsAudit.recommendation.primary || null,
    items,
    rootCauseSummary: causeSummary(items),
    modelActions: actionPlan(items, weeklyItemsAudit.recommendation || {}, fantasyPublicAudit)
  };

  writeFile(outPath, JSON.stringify(audit, null, 2));
  writeFile(mdPath, renderMarkdown(audit));
  console.log(JSON.stringify({
    status: audit.status,
    outPath,
    mdPath,
    primaryItem: audit.primaryItem,
    itemVerdicts: Object.fromEntries(Object.entries(items).map(([item, block]) => [item, block.verdict])),
    clearMissRates: Object.fromEntries(Object.entries(items).map(([item, block]) => [item, Number(block.counts.clearMissRate.toFixed(3))]))
  }, null, 2));
}

main();
