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

function num(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function fmt(value, digits = 2) {
  return value == null || !Number.isFinite(Number(value)) ? '-' : Number(value).toFixed(digits);
}

function signed(value) {
  if (value == null || !Number.isFinite(Number(value))) return '-';
  const parsed = Number(value);
  return parsed > 0 ? `+${parsed}` : String(parsed);
}

function dayLabel(day) {
  return day == null || day === '' ? 'dayx' : `day${day}`;
}

function scoreGap(left, right) {
  if (!left || !right) return null;
  const gap = num(left.overallScore) - num(right.overallScore);
  return Number.isFinite(gap) ? gap : null;
}

function championConfidence(overall, rows) {
  const ordered = rows
    .slice()
    .sort((a, b) => num(b.overallScore, 0) - num(a.overallScore, 0));
  const top = ordered[0] || null;
  const second = ordered[1] || null;
  const gap = top && second ? num(top.overallScore, 0) - num(second.overallScore, 0) : null;
  const aligned = overall && overall.status === 'champion_pick_aligned_so_far';
  let confidence = 'watch';
  if (aligned && gap != null && gap >= 150) confidence = 'high';
  else if (aligned && gap != null && gap >= 75) confidence = 'medium';
  else if (aligned) confidence = 'thin';
  return {
    champion: top ? top.team : overall && overall.projectedChampion || null,
    confidence,
    scoreGapToSecond: gap,
    currentAlignment: overall && overall.status || null,
    currentLeader: overall && overall.currentOverallLeader || null
  };
}

function alignedConfidence(nearestGap) {
  if (nearestGap == null) return { confidence: 'watch', decision: 'submit_projected_rank' };
  if (nearestGap >= 150) return { confidence: 'high', decision: 'submit_projected_rank' };
  if (nearestGap >= 50) return { confidence: 'medium', decision: 'submit_projected_rank' };
  return { confidence: 'close_call_watch', decision: 'submit_projected_rank_with_close_watch' };
}

function driftConfidence(driftGap) {
  if (driftGap != null && driftGap >= 150) {
    return { confidence: 'hold_projection', decision: 'hold_projection_despite_current_drift' };
  }
  if (driftGap != null && driftGap >= 75) {
    return { confidence: 'watch_hold_projection', decision: 'hold_projection_but_recheck_before_deadline' };
  }
  return { confidence: 'swap_watch', decision: 'swap_watch_if_persists' };
}

function classifyRow(row, rowsByPredictedRank, rowsByCurrentRank) {
  const previous = rowsByPredictedRank.get(Number(row.predictedRank) - 1) || null;
  const next = rowsByPredictedRank.get(Number(row.predictedRank) + 1) || null;
  const gapToPrevious = previous ? scoreGap(previous, row) : null;
  const gapToNext = next ? scoreGap(row, next) : null;
  const neighborGaps = [gapToPrevious, gapToNext]
    .filter(value => value != null && Number.isFinite(Number(value)))
    .map(value => Math.abs(Number(value)));
  const nearestPredictedGap = neighborGaps.length ? Math.min(...neighborGaps) : null;
  const currentSlotTeam = rowsByCurrentRank.get(Number(row.predictedRank)) || null;
  const driftScoreGap = currentSlotTeam && currentSlotTeam.team !== row.team
    ? Math.abs(scoreGap(row, currentSlotTeam))
    : null;
  const rankDelta = row.rankDelta == null ? null : Number(row.rankDelta);
  const label = rankDelta === 0
    ? alignedConfidence(nearestPredictedGap)
    : driftConfidence(driftScoreGap != null ? driftScoreGap : nearestPredictedGap);

  return {
    league: row.league,
    team: row.team,
    submitRank: row.predictedRank,
    currentRank: row.currentRank,
    rankDelta: row.rankDelta,
    overallScore: row.overallScore,
    winPct: row.winPct,
    wins: row.wins,
    losses: row.losses,
    ties: row.ties,
    confidence: label.confidence,
    decision: label.decision,
    gapToPrevious,
    gapToNext,
    nearestPredictedGap,
    driftScoreGap,
    currentSlotTeam: currentSlotTeam ? currentSlotTeam.team : null,
    currentSlotScore: currentSlotTeam ? currentSlotTeam.overallScore : null
  };
}

function classifyLeague(league) {
  const sourceRows = (league.rows || [])
    .slice()
    .sort((a, b) => Number(a.predictedRank || 0) - Number(b.predictedRank || 0));
  const rowsByPredictedRank = new Map(sourceRows.map(row => [Number(row.predictedRank), row]));
  const rowsByCurrentRank = new Map(sourceRows
    .filter(row => row.currentRank != null)
    .map(row => [Number(row.currentRank), row]));
  const rows = sourceRows.map(row => classifyRow(row, rowsByPredictedRank, rowsByCurrentRank));
  const holdProjection = rows.filter(row => row.confidence === 'hold_projection');
  const watchHoldProjection = rows.filter(row => row.confidence === 'watch_hold_projection');
  const swapWatch = rows.filter(row => row.confidence === 'swap_watch');
  const closeCallWatch = rows.filter(row => row.confidence === 'close_call_watch');
  let confidence = 'high';
  if (swapWatch.length) confidence = 'swap_watch';
  else if (watchHoldProjection.length || closeCallWatch.length) confidence = 'watch';
  else if (holdProjection.length || rows.some(row => row.confidence === 'medium')) confidence = 'medium';
  return {
    league: league.league,
    status: league.status,
    confidence,
    exactMatches: league.exactMatches,
    teamCount: league.teamCount,
    meanAbsRankError: league.meanAbsRankError,
    predictedWinner: league.predictedWinner,
    rows,
    holdProjection,
    watchHoldProjection,
    closeCallWatch,
    swapWatch
  };
}

function renderMarkdown(audit) {
  const lines = [];
  lines.push(`# ORE ${audit.targetSeason} League Ranking Confidence Audit`);
  lines.push('');
  lines.push(`Generated: ${audit.generatedAt}`);
  lines.push(`Source season: ${audit.source.season}; day: ${audit.source.day}; scraped at: ${audit.source.scrapedAt}`);
  lines.push(`Status: ${audit.status}`);
  lines.push('');
  lines.push('## Decision');
  lines.push(`- Champion: ${audit.overall.champion}; confidence ${audit.overall.championConfidence}; gap to second ${fmt(audit.overall.championGapToSecond, 2)}.`);
  lines.push(`- Overall decision: ${audit.overall.decision}.`);
  lines.push(`- Hold projection count: ${audit.summary.holdProjectionCount}; swap-watch count: ${audit.summary.swapWatchCount}; close-call watch count: ${audit.summary.closeCallWatchCount}.`);
  lines.push('');
  for (const league of audit.leagues) {
    lines.push(`## ${league.league}`);
    lines.push(`- Confidence: ${league.confidence}; exact matches ${league.exactMatches}/${league.teamCount}; mean rank error ${fmt(league.meanAbsRankError, 3)}.`);
    for (const row of league.rows) {
      lines.push(`- Submit ${row.submitRank}: ${row.team}; current ${row.currentRank}; delta ${signed(row.rankDelta)}; confidence ${row.confidence}; decision ${row.decision}; score ${fmt(row.overallScore, 2)}; drift gap ${fmt(row.driftScoreGap, 2)}.`);
    }
    lines.push('');
  }
  if (audit.holdProjectionItems.length) {
    lines.push('## Hold Projection Despite Current Drift');
    for (const item of audit.holdProjectionItems) {
      lines.push(`- ${item.league} ${item.team}: submit rank ${item.submitRank}, current rank ${item.currentRank}, drift gap ${fmt(item.driftScoreGap, 2)}.`);
    }
    lines.push('');
  }
  if (audit.watchItems.length) {
    lines.push('## Watch Items');
    for (const item of audit.watchItems) {
      lines.push(`- ${item.league} ${item.team}: ${item.confidence}; decision ${item.decision}; submit ${item.submitRank}, current ${item.currentRank}.`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function main() {
  const leagueAuditPath = arg('league-audit');
  if (!leagueAuditPath) throw new Error('Missing --league-audit');
  const leagueAudit = readJson(leagueAuditPath);
  const reportsDir = arg('reports-dir', path.dirname(path.resolve(leagueAuditPath)));
  const source = leagueAudit.source || {};
  const targetSeason = Number(leagueAudit.targetSeason || (Number(source.season) + 1));
  const dateLabel = arg('date', new Date().toISOString().slice(0, 10));
  const outPath = arg('out', path.join(reportsDir, `ore_${targetSeason}_league_rank_${dayLabel(source.day)}_confidence_audit_${dateLabel}.json`));
  const mdPath = arg('md-out', path.join(reportsDir, `ore_${targetSeason}_league_rank_${dayLabel(source.day)}_confidence_audit_${dateLabel}.md`));

  const leagues = (leagueAudit.leagues || []).map(classifyLeague);
  const allRows = leagues.flatMap(league => league.rows);
  const champion = championConfidence(leagueAudit.overall || {}, allRows);
  const holdProjectionItems = allRows.filter(row => row.confidence === 'hold_projection' || row.confidence === 'watch_hold_projection');
  const swapWatchItems = allRows.filter(row => row.confidence === 'swap_watch');
  const closeCallWatchItems = allRows.filter(row => row.confidence === 'close_call_watch');
  const watchItems = [...swapWatchItems, ...closeCallWatchItems, ...allRows.filter(row => row.confidence === 'watch_hold_projection')];
  const status = champion.confidence === 'watch' || swapWatchItems.length
    ? 'WATCH'
    : watchItems.length || holdProjectionItems.length
      ? 'PASS_WITH_WATCH'
      : 'PASS';
  const decision = champion.confidence === 'watch'
    ? 'watch_champion_before_submit'
    : swapWatchItems.length
      ? 'submit_projected_card_with_swap_watch'
      : 'submit_projected_card';

  const audit = {
    generatedAt: new Date().toISOString(),
    dateLabel,
    targetSeason,
    status,
    source: {
      seasonDir: source.seasonDir || null,
      projectionPath: source.projectionPath || null,
      snapshotPath: source.snapshotPath || null,
      season: source.season == null ? null : String(source.season),
      day: source.day == null ? null : String(source.day),
      scrapedAt: source.scrapedAt || null,
      leagueAudit: {
        path: path.resolve(leagueAuditPath),
        status: leagueAudit.overall && leagueAudit.overall.status || null,
        exactMatches: leagueAudit.overall && leagueAudit.overall.exactMatches || null,
        teamCount: leagueAudit.overall && leagueAudit.overall.teamCount || null
      }
    },
    overall: {
      champion: champion.champion,
      championConfidence: champion.confidence,
      championGapToSecond: champion.scoreGapToSecond,
      currentAlignment: champion.currentAlignment,
      currentLeader: champion.currentLeader,
      decision,
      exactMatches: leagueAudit.overall && leagueAudit.overall.exactMatches || null,
      teamCount: leagueAudit.overall && leagueAudit.overall.teamCount || null,
      meanAbsRankError: leagueAudit.overall && leagueAudit.overall.meanAbsRankError || null
    },
    summary: {
      highConfidenceCount: allRows.filter(row => row.confidence === 'high').length,
      mediumConfidenceCount: allRows.filter(row => row.confidence === 'medium').length,
      holdProjectionCount: allRows.filter(row => row.confidence === 'hold_projection').length,
      watchHoldProjectionCount: allRows.filter(row => row.confidence === 'watch_hold_projection').length,
      closeCallWatchCount: closeCallWatchItems.length,
      swapWatchCount: swapWatchItems.length,
      watchCount: watchItems.length
    },
    leagues,
    holdProjectionItems,
    watchItems
  };

  writeFile(outPath, JSON.stringify(audit, null, 2));
  writeFile(mdPath, renderMarkdown(audit));
  console.log(JSON.stringify({
    status: audit.status,
    outPath,
    mdPath,
    champion: audit.overall.champion,
    championConfidence: audit.overall.championConfidence,
    decision: audit.overall.decision,
    holdProjectionCount: audit.summary.holdProjectionCount,
    swapWatchCount: audit.summary.swapWatchCount,
    watchCount: audit.summary.watchCount
  }, null, 2));
}

main();
