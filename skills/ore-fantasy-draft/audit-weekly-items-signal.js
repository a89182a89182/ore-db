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

function teamNameKey(row) {
  return [row.team || '', row.name || '', row.category || ''].join('|');
}

function identity(row) {
  return [row.team || '', row.owner || '', row.name || '', row.category || ''].join('|');
}

function roleOf(row) {
  return String(row.role || row.position_or_role || '').trim();
}

function ranked(rows, valueFn, desc) {
  const sorted = rows
    .filter(row => {
      const value = valueFn(row);
      return value != null && Number.isFinite(value);
    })
    .slice()
    .sort((a, b) => desc ? valueFn(b) - valueFn(a) : valueFn(a) - valueFn(b));

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

function bucket(rank) {
  if (rank == null) return 'unranked';
  if (rank <= 1) return 'top1';
  if (rank <= 3) return 'top3';
  if (rank <= 5) return 'top5';
  if (rank <= 10) return 'top10';
  if (rank <= 20) return 'top20';
  return 'outside20';
}

function bucketCounts(rows) {
  const counts = {
    top1: 0,
    top3: 0,
    top5: 0,
    top10: 0,
    top20: 0,
    outside20: 0,
    unranked: 0
  };
  for (const row of rows) counts[bucket(row.rank)] += 1;
  counts.withinTop10 = counts.top1 + counts.top3 + counts.top5 + counts.top10;
  counts.withinTop20 = counts.withinTop10 + counts.top20;
  return counts;
}

function average(values) {
  const clean = values.filter(value => value != null && Number.isFinite(value));
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : null;
}

function weightedEra(rows) {
  let outs = 0;
  let eraOuts = 0;
  for (const row of rows) {
    if (row.current == null || !Number.isFinite(row.current) || !row.outs) continue;
    outs += row.outs;
    eraOuts += row.current * row.outs;
  }
  return outs ? eraOuts / outs : null;
}

function exactOrLooseLookup(row, byKey, byTeamName) {
  return byKey.get(keyFor(row)) || (byTeamName.get(teamNameKey(row)) || [])[0] || null;
}

function reportSource(reportPath, report) {
  return {
    path: reportPath,
    mode: report.mode || null,
    liveSourceType: report.source && report.source.liveSourceType || null,
    liveFetchSucceeded: report.source && report.source.liveFetchSucceeded || false,
    fallbackReason: report.source && report.source.fallbackReason || null,
    fantasyGrid: report.fantasyGrid || null
  };
}

function selectedRows(report, category) {
  return (report.lineupVariants || []).map((variant, index) => ({
    variantIndex: variant.variantIndex || index + 1,
    feasible: Boolean(variant.feasible),
    rows: (variant.lineup || []).filter(row => row.category === category)
  }));
}

function coverage(sortedActualRows, uniqueSelectedRows, topN) {
  const selected = new Set(uniqueSelectedRows.map(row => row.identity));
  const actualTop = sortedActualRows.slice(0, topN).map(row => identity(row));
  const hit = actualTop.filter(item => selected.has(item)).length;
  return { hit, total: topN, rate: hit / topN };
}

function topRows(rows, n, metricName, valueField, lowerBetter = false) {
  return rows.slice(0, n).map((row, index) => ({
    rank: index + 1,
    team: row.team,
    owner: row.owner || '',
    name: row.name,
    role: roleOf(row),
    value: row[valueField],
    IP: row.actualOuts == null ? null : formatIp(row.actualOuts),
    metric: metricName,
    lowerBetter
  }));
}

function missedLeaders(sortedActualRows, uniqueSelectedRows, topN, metricName, valueField, lowerBetter = false) {
  const selected = new Set(uniqueSelectedRows.map(row => row.identity));
  return topRows(sortedActualRows, topN, metricName, valueField, lowerBetter)
    .filter(row => !selected.has(identity({ ...row, category: metricName === 'HR' || metricName === 'SB' ? 'batter' : 'pitcher' })));
}

function bestVariant(variants, lowerBetter) {
  const withValues = variants.filter(variant => variant.actualValue != null && Number.isFinite(variant.actualValue));
  if (!withValues.length) return null;
  return withValues
    .slice()
    .sort((a, b) => lowerBetter ? a.actualValue - b.actualValue : b.actualValue - a.actualValue)[0];
}

function projectedValue(row, projectedField) {
  return numberOrNull(row.projectedStats && row.projectedStats[projectedField]);
}

function compactSelected(row, item) {
  return {
    rank: row.rank,
    team: row.team,
    owner: row.owner || '',
    name: row.name,
    role: row.role,
    current: row.current,
    projected: row.projected,
    IP: row.outs == null ? null : formatIp(row.outs),
    variants: row.variants || [],
    item
  };
}

function analyzeItem(config, report, currentRows, byKey, byTeamName, ranks) {
  const variants = selectedRows(report, config.category).map(variant => {
    const rows = variant.rows.map(row => {
      const candidate = {
        team: row.team,
        owner: row.owner || '',
        name: row.name,
        category: config.category
      };
      const actual = exactOrLooseLookup(candidate, byKey, byTeamName);
      const rankKey = actual ? keyFor(actual) : keyFor(candidate);
      return {
        item: config.item,
        variantIndex: variant.variantIndex,
        team: row.team,
        owner: row.owner || actual?.owner || '',
        name: row.name,
        role: roleOf(row),
        category: config.category,
        current: actual ? actual[config.actualField] : null,
        projected: projectedValue(row, config.projectedField),
        outs: actual ? actual.actualOuts : null,
        rank: ranks.ranks.get(rankKey) || null,
        identity: actual ? identity(actual) : identity(candidate)
      };
    });

    const actualValue = config.item === 'ERA'
      ? weightedEra(rows)
      : rows.reduce((sum, row) => sum + (row.current || 0), 0);
    const projectedValueTotal = config.item === 'ERA'
      ? average(rows.map(row => row.projected))
      : rows.reduce((sum, row) => sum + (row.projected || 0), 0);

    return {
      variantIndex: variant.variantIndex,
      feasible: variant.feasible,
      selectedCount: rows.length,
      actualValue,
      projectedValue: projectedValueTotal,
      selectedTop: bucketCounts(rows),
      rows
    };
  });

  const uniqueMap = new Map();
  for (const variant of variants) {
    for (const row of variant.rows) {
      if (!uniqueMap.has(row.identity)) uniqueMap.set(row.identity, { ...row, variants: [] });
      uniqueMap.get(row.identity).variants.push(variant.variantIndex);
    }
  }
  const uniqueSelected = [...uniqueMap.values()].sort((a, b) => (a.rank || 999999) - (b.rank || 999999));
  const top10 = coverage(ranks.sorted, uniqueSelected, 10);
  const top20 = coverage(ranks.sorted, uniqueSelected, 20);
  const best = bestVariant(variants, config.lowerBetter);
  const bestTop10 = variants.length ? Math.max(...variants.map(variant => variant.selectedTop.withinTop10)) : 0;
  const bestTop20 = variants.length ? Math.max(...variants.map(variant => variant.selectedTop.withinTop20)) : 0;
  const stabilityBonus = { K: 2, HR: 1, SB: 0.5, ERA: -1 }[config.item] || 0;
  const signalScore = top10.hit * 3 + top20.hit + bestTop10 + bestTop20 * 0.25 + stabilityBonus;

  return {
    item: config.item,
    category: config.category,
    report: reportSource(config.path, report),
    signalScore,
    signalParts: {
      top10Hits: top10.hit,
      top20Hits: top20.hit,
      bestVariantTop10Hits: bestTop10,
      bestVariantTop20Hits: bestTop20,
      stabilityBonus
    },
    coverage: { top10, top20 },
    bestVariant: best && {
      variantIndex: best.variantIndex,
      actualValue: best.actualValue,
      projectedValue: best.projectedValue,
      selectedTop: best.selectedTop
    },
    variants: variants.map(variant => ({
      variantIndex: variant.variantIndex,
      feasible: variant.feasible,
      selectedCount: variant.selectedCount,
      actualValue: variant.actualValue,
      projectedValue: variant.projectedValue,
      selectedTop: variant.selectedTop,
      rows: variant.rows
    })),
    topSelected: uniqueSelected.slice(0, 15).map(row => compactSelected(row, config.item)),
    missedCurrentTop10: missedLeaders(ranks.sorted, uniqueSelected, 10, config.item, config.actualField, config.lowerBetter),
    leaderboardTop10: topRows(ranks.sorted, 10, config.item, config.actualField, config.lowerBetter)
  };
}

function recommendationFrom(items) {
  const ranking = Object.values(items)
    .map(item => ({
      item: item.item,
      score: Number(item.signalScore.toFixed(2)),
      top10: item.coverage.top10,
      top20: item.coverage.top20,
      bestVariant: item.bestVariant,
      reason: `${item.coverage.top10.hit}/10 top10, ${item.coverage.top20.hit}/20 top20, best variant top10 ${item.signalParts.bestVariantTop10Hits}`
    }))
    .sort((a, b) => b.score - a.score);
  const primary = ranking[0] || null;
  const secondary = ranking[1] || null;
  return {
    primary: primary ? primary.item : null,
    secondary: secondary ? secondary.item : null,
    reason: primary
      ? `${primary.item} has the strongest current-result overlap across HR/SB/K/ERA (${primary.reason}).`
      : 'No weekly item reports were available.',
    ranking
  };
}

function renderMetricValue(item, value) {
  if (value == null || !Number.isFinite(Number(value))) return '-';
  if (item === 'ERA') return fmt(value, 3);
  return String(Math.round(value));
}

function renderMarkdown(audit) {
  const lines = [];
  lines.push(`# ORE ${audit.targetSeason} Weekly Item Signal Audit`);
  lines.push('');
  lines.push(`Generated: ${audit.generatedAt}`);
  lines.push(`Source season: ${audit.source.season}; day: ${audit.source.day}; scraped at: ${audit.source.scrapedAt}`);
  lines.push('');
  lines.push('## Recommendation');
  lines.push(`- Primary: ${audit.recommendation.primary}`);
  lines.push(`- Secondary: ${audit.recommendation.secondary}`);
  lines.push(`- Reason: ${audit.recommendation.reason}`);
  lines.push('');
  lines.push('## Ranking');
  lines.push('| Rank | Item | Score | Top10 | Top20 | Best variant | Reason |');
  lines.push('|---:|---|---:|---:|---:|---|---|');
  audit.recommendation.ranking.forEach((row, index) => {
    const best = row.bestVariant
      ? `V${row.bestVariant.variantIndex} ${renderMetricValue(row.item, row.bestVariant.actualValue)}`
      : '-';
    lines.push(`| ${index + 1} | ${row.item} | ${fmt(row.score, 2)} | ${row.top10.hit}/${row.top10.total} | ${row.top20.hit}/${row.top20.total} | ${best} | ${row.reason} |`);
  });
  lines.push('');
  for (const item of audit.recommendation.ranking.map(row => row.item)) {
    const block = audit.items[item];
    lines.push(`## ${item}`);
    lines.push(`- Coverage: top10 ${block.coverage.top10.hit}/${block.coverage.top10.total} (${pct(block.coverage.top10.rate)}), top20 ${block.coverage.top20.hit}/${block.coverage.top20.total} (${pct(block.coverage.top20.rate)}).`);
    if (block.bestVariant) {
      lines.push(`- Best current variant: V${block.bestVariant.variantIndex}, current ${renderMetricValue(item, block.bestVariant.actualValue)}, projected ${renderMetricValue(item, block.bestVariant.projectedValue)}.`);
    }
    lines.push('- Top selected:');
    for (const row of block.topSelected.slice(0, 8)) {
      lines.push(`  - #${row.rank || '-'} ${row.role} ${row.team} ${row.name} (${row.owner}): current ${renderMetricValue(item, row.current)}, projected ${renderMetricValue(item, row.projected)}, variants ${row.variants.join(',')}.`);
    }
    lines.push('- Current top10 missed:');
    for (const row of block.missedCurrentTop10.slice(0, 8)) {
      lines.push(`  - #${row.rank} ${row.role} ${row.team} ${row.name} (${row.owner}): ${item} ${renderMetricValue(item, row.value)}${row.IP ? `, IP ${row.IP}` : ''}.`);
    }
    lines.push('');
  }
  lines.push('## Caveat');
  lines.push('This audit compares legal draft variants with current partial-season HR/SB/K/ERA leaderboards. It is a weekly priority monitor, not a replacement for fresh-source validation, lineup legality, or the projection model.');
  return `${lines.join('\n')}\n`;
}

function main() {
  const reportsDir = arg('reports-dir', path.resolve(__dirname, '..', '..', 'reports'));
  const paths = {
    HR: arg('hr', path.join(reportsDir, 'ore_draft_hr.json')),
    SB: arg('sb', path.join(reportsDir, 'ore_draft_sb.json')),
    K: arg('k', path.join(reportsDir, 'ore_draft_k.json')),
    ERA: arg('era', path.join(reportsDir, 'ore_draft_era.json'))
  };
  const reports = {
    HR: readJson(paths.HR),
    SB: readJson(paths.SB),
    K: readJson(paths.K),
    ERA: readJson(paths.ERA)
  };
  const seasonDir = arg(
    'season-dir',
    reports.K.source && reports.K.source.seasonDir ||
      reports.ERA.source && reports.ERA.source.seasonDir ||
      reports.HR.source && reports.HR.source.seasonDir ||
      reports.SB.source && reports.SB.source.seasonDir
  );
  if (!seasonDir) throw new Error('Missing --season-dir and draft source.seasonDir');
  const playersPath = arg('players', path.join(seasonDir, 'players.json'));
  const metaPath = path.join(seasonDir, 'meta.json');
  const players = readJson(playersPath);
  const meta = fs.existsSync(metaPath) ? readJson(metaPath) : {};
  const sourceSeason = Number(meta.season || players[0] && players[0].season);
  const targetSeason = sourceSeason + 1;
  const sourceDay = meta.day || meta.current_day || null;
  const dayLabel = sourceDay == null ? 'dayx' : `day${sourceDay}`;
  const dateLabel = arg('date', new Date().toISOString().slice(0, 10));
  const outPath = arg('out', path.join(reportsDir, `ore_${targetSeason}_weekly_items_${dayLabel}_signal_audit_${dateLabel}.json`));
  const mdPath = arg('md-out', path.join(reportsDir, `ore_${targetSeason}_weekly_items_${dayLabel}_signal_audit_${dateLabel}.md`));

  const batters = players
    .filter(row => row.category === 'batter' && !row.is_computer)
    .map(row => ({
      ...row,
      actualHR: numberOrNull(row.current_batting && row.current_batting.home_runs),
      actualSB: numberOrNull(row.current_batting && row.current_batting.steals)
    }));
  const pitchers = players
    .filter(row => row.category === 'pitcher' && !row.is_computer)
    .map(row => ({
      ...row,
      actualK: numberOrNull(row.current_pitching && row.current_pitching.strikeouts),
      actualERA: numberOrNull(row.current_pitching && row.current_pitching.era),
      actualOuts: parseOuts(row.current_pitching && row.current_pitching.innings_pitched)
    }));

  const byKey = new Map([...batters, ...pitchers].map(row => [keyFor(row), row]));
  const byTeamName = new Map();
  for (const row of [...batters, ...pitchers]) {
    const key = teamNameKey(row);
    if (!byTeamName.has(key)) byTeamName.set(key, []);
    byTeamName.get(key).push(row);
  }

  const ranks = {
    HR: ranked(batters, row => row.actualHR, true),
    SB: ranked(batters, row => row.actualSB, true),
    K: ranked(pitchers, row => row.actualK, true),
    ERA: ranked(pitchers.filter(row => row.actualERA != null && row.actualOuts > 0), row => row.actualERA, false)
  };

  const configs = {
    HR: { item: 'HR', category: 'batter', actualField: 'actualHR', projectedField: 'home_runs', lowerBetter: false, path: paths.HR },
    SB: { item: 'SB', category: 'batter', actualField: 'actualSB', projectedField: 'steals', lowerBetter: false, path: paths.SB },
    K: { item: 'K', category: 'pitcher', actualField: 'actualK', projectedField: 'strikeouts', lowerBetter: false, path: paths.K },
    ERA: { item: 'ERA', category: 'pitcher', actualField: 'actualERA', projectedField: 'era', lowerBetter: true, path: paths.ERA }
  };

  const items = {};
  for (const item of ['HR', 'SB', 'K', 'ERA']) {
    items[item] = analyzeItem(configs[item], reports[item], item === 'HR' || item === 'SB' ? batters : pitchers, byKey, byTeamName, ranks[item]);
  }
  const recommendation = recommendationFrom(items);

  const audit = {
    generatedAt: new Date().toISOString(),
    targetSeason,
    source: {
      seasonDir,
      playersPath,
      season: String(sourceSeason),
      day: sourceDay,
      scrapedAt: meta.scraped_at || meta.scrapedAt || null,
      playerCount: players.length,
      batterCount: batters.length,
      pitcherCount: pitchers.length,
      hr: reportSource(paths.HR, reports.HR),
      sb: reportSource(paths.SB, reports.SB),
      k: reportSource(paths.K, reports.K),
      era: reportSource(paths.ERA, reports.ERA)
    },
    recommendation,
    items
  };

  writeFile(outPath, JSON.stringify(audit, null, 2));
  writeFile(mdPath, renderMarkdown(audit));
  console.log(JSON.stringify({
    status: 'PASS',
    outPath,
    mdPath,
    recommendation: audit.recommendation,
    ranking: audit.recommendation.ranking
  }, null, 2));
}

main();
