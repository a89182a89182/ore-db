#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

function arg(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find(item => item.startsWith(prefix));
  if (!found) return fallback;
  return found.slice(prefix.length);
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
  if (match) {
    return Number(match[1]) * 3 + (match[2] ? Number(match[2]) : 0);
  }
  const parsed = Number(text);
  return Number.isFinite(parsed) ? Math.round(parsed * 3) : 0;
}

function formatIp(outs) {
  if (!outs) return '0';
  const innings = Math.floor(outs / 3);
  const remainder = outs % 3;
  if (!remainder) return String(innings);
  return `${innings} ${remainder}/3`;
}

function fmt(value, digits = 2) {
  return value == null || !Number.isFinite(Number(value)) ? '-' : Number(value).toFixed(digits);
}

function pct(value, digits = 0) {
  return `${(value * 100).toFixed(digits)}%`;
}

function keyFor(row) {
  return [row.team || '', row.owner || '', row.name || '', row.category || 'pitcher'].join('|');
}

function teamNameKey(row) {
  return [row.team || '', row.name || ''].join('|');
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

function bucketCounts(rows, rankField) {
  const counts = {
    top1: 0,
    top3: 0,
    top5: 0,
    top10: 0,
    top20: 0,
    outside20: 0,
    unranked: 0
  };
  for (const row of rows) counts[bucket(row[rankField])] += 1;
  counts.withinTop10 = counts.top1 + counts.top3 + counts.top5 + counts.top10;
  counts.withinTop20 = counts.withinTop10 + counts.top20;
  return counts;
}

function weightedEra(rows) {
  let outs = 0;
  let eraOuts = 0;
  for (const row of rows) {
    if (row.actualEra == null || !Number.isFinite(row.actualEra) || !row.actualOuts) continue;
    outs += row.actualOuts;
    eraOuts += row.actualEra * row.actualOuts;
  }
  return outs ? eraOuts / outs : null;
}

function projectedEraAverage(rows) {
  const values = rows
    .map(row => row.projectedEra)
    .filter(value => value != null && Number.isFinite(value));
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function topRows(rows, n, metric) {
  return rows.slice(0, n).map((row, index) => ({
    rank: index + 1,
    team: row.team,
    owner: row.owner || '',
    name: row.name,
    role: roleOf(row),
    K: row.actualK,
    ERA: row.actualEra,
    IP: formatIp(row.actualOuts),
    metric
  }));
}

function compactSelected(row, mode) {
  const base = {
    team: row.team,
    owner: row.owner || '',
    name: row.name,
    role: row.role,
    variants: row.variants || []
  };
  if (mode === 'K') {
    return {
      ...base,
      rank: row.allKRank,
      currentK: row.actualK,
      projectedK: row.projectedK,
      currentERA: row.actualEra,
      IP: formatIp(row.actualOuts)
    };
  }
  return {
    ...base,
    rank: row.allEraRank,
    currentERA: row.actualEra,
    projectedERA: row.projectedEra,
    currentK: row.actualK,
    IP: formatIp(row.actualOuts)
  };
}

function selectedPitchers(report) {
  return (report.lineupVariants || []).map((variant, index) => ({
    variantIndex: variant.variantIndex || index + 1,
    feasible: Boolean(variant.feasible),
    pitchers: (variant.lineup || []).filter(row => row.category === 'pitcher')
  }));
}

function exactOrLooseLookup(row, byKey, byTeamName) {
  return byKey.get(keyFor(row)) || (byTeamName.get(teamNameKey(row)) || [])[0] || null;
}

function coverage(sortedActualRows, uniqueSelectedRows, topN) {
  const selected = new Set(uniqueSelectedRows.map(row => [row.team, row.owner || '', row.name].join('|')));
  const actualTop = sortedActualRows
    .slice(0, topN)
    .map(row => [row.team, row.owner || '', row.name].join('|'));
  const hit = actualTop.filter(item => selected.has(item)).length;
  return { hit, total: topN, rate: hit / topN };
}

function missedLeaders(sortedActualRows, uniqueSelectedRows, topN, metric) {
  const selected = new Set(uniqueSelectedRows.map(row => [row.team, row.owner || '', row.name].join('|')));
  return sortedActualRows
    .slice(0, topN)
    .map((row, index) => ({
      rank: index + 1,
      team: row.team,
      owner: row.owner || '',
      name: row.name,
      role: roleOf(row),
      K: row.actualK,
      ERA: row.actualEra,
      IP: formatIp(row.actualOuts),
      metric
    }))
    .filter(row => !selected.has([row.team, row.owner || '', row.name].join('|')));
}

function bestBy(rows, field, asc = false) {
  return rows
    .slice()
    .sort((a, b) => asc ? (a[field] ?? 999999) - (b[field] ?? 999999) : (b[field] ?? -999999) - (a[field] ?? -999999))[0];
}

function loadMeta(seasonDir) {
  if (!seasonDir) return {};
  const metaPath = path.join(seasonDir, 'meta.json');
  return fs.existsSync(metaPath) ? readJson(metaPath) : {};
}

function analyzeMode(mode, report, pitchers, byKey, byTeamName, kRanks, eraRanks, roleRanks) {
  const variants = selectedPitchers(report).map(variant => {
    const rows = variant.pitchers.map(row => {
      const actual = exactOrLooseLookup(row, byKey, byTeamName);
      const key = actual ? keyFor(actual) : keyFor(row);
      const role = roleOf(row);
      return {
        mode,
        variantIndex: variant.variantIndex,
        team: row.team,
        owner: row.owner || actual?.owner || '',
        name: row.name,
        role,
        projectedK: numberOrNull(row.projectedStats && row.projectedStats.strikeouts),
        projectedEra: numberOrNull(row.projectedStats && row.projectedStats.era),
        actualK: actual ? actual.actualK : null,
        actualEra: actual ? actual.actualEra : null,
        actualOuts: actual ? actual.actualOuts : 0,
        allKRank: kRanks.ranks.get(key) || null,
        allEraRank: eraRanks.ranks.get(key) || null,
        roleKRank: roleRanks[role] && roleRanks[role].k.ranks.get(key) || null,
        roleEraRank: roleRanks[role] && roleRanks[role].era.ranks.get(key) || null
      };
    });

    return {
      variantIndex: variant.variantIndex,
      feasible: variant.feasible,
      pitcherCount: rows.length,
      projectedKTotal: rows.reduce((sum, row) => sum + (row.projectedK || 0), 0),
      actualKTotal: rows.reduce((sum, row) => sum + (row.actualK || 0), 0),
      projectedEraAverage: projectedEraAverage(rows),
      actualWeightedEra: weightedEra(rows),
      selectedTopK: bucketCounts(rows, 'allKRank'),
      selectedTopEra: bucketCounts(rows, 'allEraRank'),
      pitchers: rows
    };
  });

  const uniqueMap = new Map();
  for (const variant of variants) {
    for (const row of variant.pitchers) {
      const key = [row.team, row.owner || '', row.name].join('|');
      if (!uniqueMap.has(key)) uniqueMap.set(key, { ...row, variants: [] });
      uniqueMap.get(key).variants.push(variant.variantIndex);
    }
  }
  const uniqueSelected = [...uniqueMap.values()];
  const rankField = mode === 'K' ? 'allKRank' : 'allEraRank';
  uniqueSelected.sort((a, b) => (a[rankField] || 999999) - (b[rankField] || 999999));

  return { variants, uniqueSelected };
}

function renderMarkdown(audit) {
  const lines = [];
  lines.push(`# ORE ${audit.targetSeason} K/ERA Signal Audit`);
  lines.push('');
  lines.push(`Generated: ${audit.generatedAt}`);
  lines.push(`Source season: ${audit.source.season}; day: ${audit.source.day}; scraped at: ${audit.source.scrapedAt}`);
  lines.push(`K source: ${audit.source.k.liveSourceType}; ERA source: ${audit.source.era.liveSourceType}`);
  lines.push('');
  lines.push('## Recommendation');
  lines.push(`- Primary: ${audit.recommendation.primary}`);
  lines.push(`- Secondary: ${audit.recommendation.secondary}`);
  lines.push(`- Reason: ${audit.recommendation.reason}`);
  lines.push('');
  lines.push('## Coverage');
  lines.push(`- K selected coverage: top10 ${audit.coverage.kTop10.hit}/${audit.coverage.kTop10.total} (${pct(audit.coverage.kTop10.rate)}), top20 ${audit.coverage.kTop20.hit}/${audit.coverage.kTop20.total} (${pct(audit.coverage.kTop20.rate)}).`);
  lines.push(`- ERA selected coverage: top10 ${audit.coverage.eraTop10.hit}/${audit.coverage.eraTop10.total} (${pct(audit.coverage.eraTop10.rate)}), top20 ${audit.coverage.eraTop20.hit}/${audit.coverage.eraTop20.total} (${pct(audit.coverage.eraTop20.rate)}).`);
  lines.push('');
  lines.push('## K Variants');
  for (const variant of audit.k.variants) {
    lines.push(`- Variant ${variant.variantIndex}: current K ${variant.actualKTotal}, projected K ${variant.projectedKTotal}, selected top10 K ${variant.selectedTopK.withinTop10}, selected top20 K ${variant.selectedTopK.withinTop20}.`);
  }
  lines.push('');
  lines.push('## Top Selected K Pitchers');
  for (const row of audit.k.topSelected) {
    lines.push(`- #${row.rank || '-'} ${row.role} ${row.team} ${row.name} (${row.owner}): current K ${row.currentK ?? '-'}, projected K ${row.projectedK ?? '-'}, ERA ${fmt(row.currentERA, 2)}, IP ${row.IP}, variants ${row.variants.join(',')}.`);
  }
  lines.push('');
  lines.push('## Current K Top 10 Missed By K Variants');
  for (const row of audit.k.missedCurrentTop10) {
    lines.push(`- #${row.rank} ${row.role} ${row.team} ${row.name} (${row.owner}): K ${row.K}, ERA ${fmt(row.ERA, 2)}, IP ${row.IP}.`);
  }
  lines.push('');
  lines.push('## ERA Variants');
  for (const variant of audit.era.variants) {
    lines.push(`- Variant ${variant.variantIndex}: current weighted ERA ${fmt(variant.actualWeightedEra, 3)}, projected average ERA ${fmt(variant.projectedEraAverage, 3)}, selected top10 ERA ${variant.selectedTopEra.withinTop10}, selected top20 ERA ${variant.selectedTopEra.withinTop20}.`);
  }
  lines.push('');
  lines.push('## Top Selected ERA Pitchers');
  for (const row of audit.era.topSelected) {
    lines.push(`- #${row.rank || '-'} ${row.role} ${row.team} ${row.name} (${row.owner}): current ERA ${fmt(row.currentERA, 2)}, projected ERA ${fmt(row.projectedERA, 2)}, K ${row.currentK ?? '-'}, IP ${row.IP}, variants ${row.variants.join(',')}.`);
  }
  lines.push('');
  lines.push('## Current ERA Top 10 Missed By ERA Variants');
  for (const row of audit.era.missedCurrentTop10) {
    lines.push(`- #${row.rank} ${row.role} ${row.team} ${row.name} (${row.owner}): ERA ${fmt(row.ERA, 2)}, K ${row.K ?? '-'}, IP ${row.IP}.`);
  }
  lines.push('');
  lines.push('## Caveat');
  lines.push('This audit compares current partial-season results against selected K/ERA variants. It is a monitoring layer for weekly item priority, not a replacement for legality checks, fresh-source validation, or the projection model.');
  return `${lines.join('\n')}\n`;
}

function main() {
  const reportsDir = arg('reports-dir', path.resolve(__dirname, '..', '..', 'reports'));
  const kPath = arg('k', path.join(reportsDir, 'ore_draft_k.json'));
  const eraPath = arg('era', path.join(reportsDir, 'ore_draft_era.json'));
  const kReport = readJson(kPath);
  const eraReport = readJson(eraPath);
  const seasonDir = arg('season-dir', kReport.source && kReport.source.seasonDir || eraReport.source && eraReport.source.seasonDir);
  if (!seasonDir) throw new Error('Missing --season-dir and draft source.seasonDir');
  const playersPath = arg('players', path.join(seasonDir, 'players.json'));
  const players = readJson(playersPath);
  const meta = loadMeta(seasonDir);
  const sourceSeason = Number(meta.season || players[0] && players[0].season);
  const targetSeason = sourceSeason + 1;
  const sourceDay = meta.day || meta.current_day || null;
  const dayLabel = sourceDay == null ? 'dayx' : `day${sourceDay}`;
  const dateLabel = arg('date', new Date().toISOString().slice(0, 10));
  const outPath = arg('out', path.join(reportsDir, `ore_${targetSeason}_k_era_${dayLabel}_signal_audit_${dateLabel}.json`));
  const mdPath = arg('md-out', path.join(reportsDir, `ore_${targetSeason}_k_era_${dayLabel}_signal_audit_${dateLabel}.md`));

  const pitchers = players
    .filter(row => row.category === 'pitcher' && !row.is_computer)
    .map(row => ({
      ...row,
      actualK: numberOrNull(row.current_pitching && row.current_pitching.strikeouts),
      actualEra: numberOrNull(row.current_pitching && row.current_pitching.era),
      actualOuts: parseOuts(row.current_pitching && row.current_pitching.innings_pitched)
    }));

  const byKey = new Map(pitchers.map(row => [keyFor(row), row]));
  const byTeamName = new Map();
  for (const row of pitchers) {
    const key = teamNameKey(row);
    if (!byTeamName.has(key)) byTeamName.set(key, []);
    byTeamName.get(key).push(row);
  }

  const kRanks = ranked(pitchers, row => row.actualK, true);
  const eraRanks = ranked(pitchers.filter(row => row.actualEra != null && row.actualOuts > 0), row => row.actualEra, false);
  const roleRanks = {};
  for (const role of ['SP', 'RP', 'CP']) {
    const roleRows = pitchers.filter(row => roleOf(row) === role);
    roleRanks[role] = {
      k: ranked(roleRows, row => row.actualK, true),
      era: ranked(roleRows.filter(row => row.actualEra != null && row.actualOuts > 0), row => row.actualEra, false)
    };
  }

  const k = analyzeMode('K', kReport, pitchers, byKey, byTeamName, kRanks, eraRanks, roleRanks);
  const era = analyzeMode('ERA', eraReport, pitchers, byKey, byTeamName, kRanks, eraRanks, roleRanks);
  const coverageSummary = {
    kTop10: coverage(kRanks.sorted, k.uniqueSelected, 10),
    kTop20: coverage(kRanks.sorted, k.uniqueSelected, 20),
    eraTop10: coverage(eraRanks.sorted, era.uniqueSelected, 10),
    eraTop20: coverage(eraRanks.sorted, era.uniqueSelected, 20)
  };
  const kSignal = coverageSummary.kTop10.hit * 2 + coverageSummary.kTop20.hit + Math.max(...k.variants.map(variant => variant.selectedTopK.withinTop10));
  const eraSignal = coverageSummary.eraTop10.hit * 2 + coverageSummary.eraTop20.hit + Math.max(...era.variants.map(variant => variant.selectedTopEra.withinTop10));
  const recommendation = kSignal > eraSignal + 2
    ? { primary: 'K', secondary: 'ERA', reason: 'K variants overlap more with current strikeout leaders, and K accumulation is less volatile than early ERA.' }
    : eraSignal > kSignal + 2
      ? { primary: 'ERA', secondary: 'K', reason: 'ERA variants overlap more with current low-ERA leaders.' }
      : { primary: 'K and ERA, K slightly first', secondary: 'ERA', reason: 'Both items have early signal; K is less sensitive to small-IP ERA volatility.' };

  const audit = {
    generatedAt: new Date().toISOString(),
    targetSeason,
    source: {
      seasonDir,
      playersPath,
      season: String(sourceSeason),
      day: sourceDay,
      scrapedAt: meta.scraped_at || meta.scrapedAt || kReport.source && kReport.source.seasonScrapedAt || null,
      playerCount: players.length,
      pitcherCount: pitchers.length,
      k: {
        path: kPath,
        liveSourceType: kReport.source && kReport.source.liveSourceType || null,
        liveFetchSucceeded: kReport.source && kReport.source.liveFetchSucceeded || false,
        fallbackReason: kReport.source && kReport.source.fallbackReason || null,
        fantasyGrid: kReport.fantasyGrid || null
      },
      era: {
        path: eraPath,
        liveSourceType: eraReport.source && eraReport.source.liveSourceType || null,
        liveFetchSucceeded: eraReport.source && eraReport.source.liveFetchSucceeded || false,
        fallbackReason: eraReport.source && eraReport.source.fallbackReason || null,
        fantasyGrid: eraReport.fantasyGrid || null
      }
    },
    recommendation,
    coverage: coverageSummary,
    leaderboardContext: {
      currentKTop10: topRows(kRanks.sorted, 10, 'K'),
      currentEraTop10: topRows(eraRanks.sorted, 10, 'ERA')
    },
    k: {
      variants: k.variants.map(variant => ({
        variantIndex: variant.variantIndex,
        feasible: variant.feasible,
        pitcherCount: variant.pitcherCount,
        projectedKTotal: variant.projectedKTotal,
        actualKTotal: variant.actualKTotal,
        selectedTopK: variant.selectedTopK,
        pitchers: variant.pitchers
      })),
      topSelected: k.uniqueSelected.slice(0, 12).map(row => compactSelected(row, 'K')),
      missedCurrentTop10: missedLeaders(kRanks.sorted, k.uniqueSelected, 10, 'K')
    },
    era: {
      variants: era.variants.map(variant => ({
        variantIndex: variant.variantIndex,
        feasible: variant.feasible,
        pitcherCount: variant.pitcherCount,
        projectedEraAverage: variant.projectedEraAverage,
        actualWeightedEra: variant.actualWeightedEra,
        selectedTopEra: variant.selectedTopEra,
        pitchers: variant.pitchers
      })),
      topSelected: era.uniqueSelected.slice(0, 12).map(row => compactSelected(row, 'ERA')),
      missedCurrentTop10: missedLeaders(eraRanks.sorted, era.uniqueSelected, 10, 'ERA')
    },
    best: {
      kVariantByCurrentK: bestBy(k.variants, 'actualKTotal', false) && {
        variantIndex: bestBy(k.variants, 'actualKTotal', false).variantIndex,
        actualKTotal: bestBy(k.variants, 'actualKTotal', false).actualKTotal,
        projectedKTotal: bestBy(k.variants, 'actualKTotal', false).projectedKTotal
      },
      eraVariantByCurrentWeightedEra: bestBy(era.variants, 'actualWeightedEra', true) && {
        variantIndex: bestBy(era.variants, 'actualWeightedEra', true).variantIndex,
        actualWeightedEra: bestBy(era.variants, 'actualWeightedEra', true).actualWeightedEra,
        projectedEraAverage: bestBy(era.variants, 'actualWeightedEra', true).projectedEraAverage
      }
    }
  };

  writeFile(outPath, JSON.stringify(audit, null, 2));
  writeFile(mdPath, renderMarkdown(audit));
  console.log(JSON.stringify({
    status: 'PASS',
    outPath,
    mdPath,
    recommendation: audit.recommendation,
    coverage: audit.coverage,
    best: audit.best
  }, null, 2));
}

main();
