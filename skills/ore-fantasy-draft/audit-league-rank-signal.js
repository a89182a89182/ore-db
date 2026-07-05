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

function num(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const parsed = Number(String(value).replace(/,/g, '').trim());
  return Number.isFinite(parsed) ? parsed : fallback;
}

function rankNumber(value) {
  const match = String(value || '').match(/(\d+)/);
  return match ? Number(match[1]) : null;
}

function fmt(value, digits = 2) {
  return value == null || !Number.isFinite(Number(value)) ? '-' : Number(value).toFixed(digits);
}

function leagueGroups(rows) {
  const groups = new Map();
  for (const row of rows) {
    const league = row.league || 'unknown';
    if (!groups.has(league)) groups.set(league, []);
    groups.get(league).push(row);
  }
  return groups;
}

function predictedRows(projection) {
  return (projection.teamProjections || [])
    .slice()
    .sort((a, b) => (b.overallScore || 0) - (a.overallScore || 0))
    .map(row => ({
      team: row.team,
      league: row.league,
      overallScore: num(row.overallScore),
      rawOverallScore: num(row.rawOverallScore),
      sameLeagueAdjustment: num(row.sameLeagueAdjustment),
      offenseScore: num(row.offenseScore),
      pitchingScore: num(row.pitchingScore)
    }));
}

function currentRows(snapshot) {
  return (snapshot.teams || []).map(row => {
    const status = row.current_status || {};
    return {
      team: row.team,
      league: row.league,
      currentRank: rankNumber(status.league_rank),
      leagueRankText: status.league_rank || '',
      gamesPlayed: num(status.games_played),
      winPct: num(status.win_pct),
      wins: num(status.wins),
      losses: num(status.losses),
      ties: num(status.ties),
      remainingGames: num(status.remaining_games),
      era: num(status.era),
      runsPerGame: num(status.runs_per_game)
    };
  });
}

function addPredictedRanks(rows) {
  const groups = leagueGroups(rows);
  const ranked = [];
  for (const [league, leagueRows] of groups.entries()) {
    leagueRows
      .slice()
      .sort((a, b) => (b.overallScore || 0) - (a.overallScore || 0))
      .forEach((row, index) => ranked.push({ ...row, league, predictedRank: index + 1 }));
  }
  return ranked;
}

function addCurrentRanks(rows) {
  const groups = leagueGroups(rows);
  const ranked = [];
  for (const [league, leagueRows] of groups.entries()) {
    leagueRows
      .slice()
      .sort((a, b) => {
        if (a.currentRank != null && b.currentRank != null) return a.currentRank - b.currentRank;
        if (a.winPct !== b.winPct) return (b.winPct || 0) - (a.winPct || 0);
        return (b.wins || 0) - (a.wins || 0);
      })
      .forEach((row, index) => ranked.push({ ...row, league, currentRank: row.currentRank || index + 1 }));
  }
  return ranked;
}

function summarizeLeague(league, predicted, current) {
  const currentByTeam = new Map(current.map(row => [row.team, row]));
  const predictedByTeam = new Map(predicted.map(row => [row.team, row]));
  const rows = predicted.map(pred => {
    const cur = currentByTeam.get(pred.team) || {};
    return {
      team: pred.team,
      league,
      predictedRank: pred.predictedRank,
      currentRank: cur.currentRank || null,
      rankDelta: cur.currentRank == null ? null : cur.currentRank - pred.predictedRank,
      overallScore: pred.overallScore,
      sameLeagueAdjustment: pred.sameLeagueAdjustment,
      winPct: cur.winPct,
      wins: cur.wins,
      losses: cur.losses,
      ties: cur.ties,
      era: cur.era,
      runsPerGame: cur.runsPerGame
    };
  }).sort((a, b) => a.predictedRank - b.predictedRank);

  const absErrors = rows
    .map(row => row.rankDelta == null ? null : Math.abs(row.rankDelta))
    .filter(value => value != null);
  const exactMatches = rows.filter(row => row.rankDelta === 0).length;
  const meanAbsRankError = absErrors.length ? absErrors.reduce((sum, value) => sum + value, 0) / absErrors.length : null;
  const maxAbsRankError = absErrors.length ? Math.max(...absErrors) : null;
  const predictedWinner = predicted.find(row => row.predictedRank === 1);
  const currentLeader = current.find(row => row.currentRank === 1);
  const predictedWinnerCurrentRank = predictedWinner && currentByTeam.get(predictedWinner.team)
    ? currentByTeam.get(predictedWinner.team).currentRank
    : null;
  const currentLeaderPredictedRank = currentLeader && predictedByTeam.get(currentLeader.team)
    ? predictedByTeam.get(currentLeader.team).predictedRank
    : null;
  const largestMisses = rows
    .filter(row => row.rankDelta !== 0 && row.rankDelta != null)
    .slice()
    .sort((a, b) => Math.abs(b.rankDelta) - Math.abs(a.rankDelta))
    .slice(0, 3);

  let status = 'aligned';
  if (predictedWinnerCurrentRank && predictedWinnerCurrentRank > 2) status = 'winner_watch';
  if (meanAbsRankError != null && meanAbsRankError >= 1.5) status = 'rank_watch';
  if (exactMatches === rows.length) status = 'perfect_so_far';

  return {
    league,
    status,
    exactMatches,
    teamCount: rows.length,
    meanAbsRankError,
    maxAbsRankError,
    predictedWinner: predictedWinner ? predictedWinner.team : null,
    predictedWinnerCurrentRank,
    currentLeader: currentLeader ? currentLeader.team : null,
    currentLeaderPredictedRank,
    rows,
    largestMisses
  };
}

function renderMarkdown(audit) {
  const lines = [];
  lines.push(`# ORE ${audit.targetSeason} League Ranking Signal Audit`);
  lines.push('');
  lines.push(`Generated: ${audit.generatedAt}`);
  lines.push(`Source season: ${audit.source.season}; day: ${audit.source.day}; scraped at: ${audit.source.scrapedAt}`);
  lines.push('');
  lines.push('## Summary');
  lines.push(`- Champion pick: ${audit.overall.projectedChampion}; current overall leader: ${audit.overall.currentOverallLeader}; status: ${audit.overall.status}.`);
  lines.push(`- Exact league-rank matches so far: ${audit.overall.exactMatches}/${audit.overall.teamCount}; mean absolute rank error: ${fmt(audit.overall.meanAbsRankError, 2)}.`);
  lines.push('');
  for (const league of audit.leagues) {
    lines.push(`## ${league.league}`);
    lines.push(`- Status: ${league.status}; exact matches ${league.exactMatches}/${league.teamCount}; mean absolute rank error ${fmt(league.meanAbsRankError, 2)}.`);
    lines.push(`- Predicted winner: ${league.predictedWinner} (current rank ${league.predictedWinnerCurrentRank}); current leader: ${league.currentLeader} (predicted rank ${league.currentLeaderPredictedRank}).`);
    for (const row of league.rows) {
      const sign = row.rankDelta > 0 ? '+' : '';
      lines.push(`- P${row.predictedRank}/C${row.currentRank} ${row.team}: delta ${sign}${row.rankDelta}, score ${fmt(row.overallScore, 2)}, W-L-T ${row.wins}-${row.losses}-${row.ties}, winPct ${fmt(row.winPct, 3)}, ERA ${fmt(row.era, 2)}, R/G ${fmt(row.runsPerGame, 1)}.`);
    }
    lines.push('');
  }
  lines.push('## Caveat');
  lines.push('This compares next-season projection rankings against current in-season standings from the fresh snapshot. It is a drift monitor, not final-season proof.');
  return `${lines.join('\n')}\n`;
}

function main() {
  const reportsDir = arg('reports-dir', path.resolve(__dirname, '..', '..', 'reports'));
  const projectionPath = arg('projection', path.join(reportsDir, 'ore_projection_snapshot.json'));
  const projection = readJson(projectionPath);
  const seasonDir = arg('season-dir', projection.sourceSnapshot && projection.sourceSnapshot.seasonDir);
  if (!seasonDir) throw new Error('Missing --season-dir and projection.sourceSnapshot.seasonDir');
  const snapshotPath = arg('snapshot', path.join(seasonDir, 'season_snapshot.json'));
  const snapshot = readJson(snapshotPath);
  const sourceSeason = num(snapshot.season, num(projection.sourceSnapshot && projection.sourceSnapshot.season));
  const targetSeason = sourceSeason + 1;
  const day = snapshot.day || projection.sourceSnapshot && projection.sourceSnapshot.day || null;
  const dayLabel = day == null ? 'dayx' : `day${day}`;
  const dateLabel = arg('date', new Date().toISOString().slice(0, 10));
  const outPath = arg('out', path.join(reportsDir, `ore_${targetSeason}_league_rank_${dayLabel}_signal_audit_${dateLabel}.json`));
  const mdPath = arg('md-out', path.join(reportsDir, `ore_${targetSeason}_league_rank_${dayLabel}_signal_audit_${dateLabel}.md`));

  const predicted = addPredictedRanks(predictedRows(projection));
  const current = addCurrentRanks(currentRows(snapshot));
  const predictedGroups = leagueGroups(predicted);
  const currentGroups = leagueGroups(current);
  const leagues = [...predictedGroups.keys()].map(league => summarizeLeague(
    league,
    predictedGroups.get(league),
    currentGroups.get(league) || []
  ));

  const allRows = leagues.flatMap(league => league.rows);
  const exactMatches = allRows.filter(row => row.rankDelta === 0).length;
  const absErrors = allRows
    .map(row => row.rankDelta == null ? null : Math.abs(row.rankDelta))
    .filter(value => value != null);
  const projectedChampion = predicted.slice().sort((a, b) => (b.overallScore || 0) - (a.overallScore || 0))[0];
  const currentOverallLeader = current.slice().sort((a, b) => {
    if ((a.winPct || 0) !== (b.winPct || 0)) return (b.winPct || 0) - (a.winPct || 0);
    return (b.wins || 0) - (a.wins || 0);
  })[0];
  const projectedChampionCurrent = current.find(row => row.team === projectedChampion.team);
  const currentLeaderProjected = predicted.find(row => row.team === currentOverallLeader.team);

  const overall = {
    status: projectedChampion.team === currentOverallLeader.team ? 'champion_pick_aligned_so_far' : 'champion_pick_watch',
    projectedChampion: projectedChampion.team,
    projectedChampionLeague: projectedChampion.league,
    projectedChampionCurrentRank: projectedChampionCurrent ? projectedChampionCurrent.currentRank : null,
    currentOverallLeader: currentOverallLeader.team,
    currentOverallLeaderLeague: currentOverallLeader.league,
    currentLeaderProjectedRank: currentLeaderProjected ? currentLeaderProjected.predictedRank : null,
    exactMatches,
    teamCount: allRows.length,
    meanAbsRankError: absErrors.length ? absErrors.reduce((sum, value) => sum + value, 0) / absErrors.length : null,
    maxAbsRankError: absErrors.length ? Math.max(...absErrors) : null
  };

  const audit = {
    generatedAt: new Date().toISOString(),
    targetSeason,
    source: {
      seasonDir,
      projectionPath,
      snapshotPath,
      season: String(sourceSeason),
      day,
      scrapedAt: snapshot.scraped_at || projection.sourceSnapshot && projection.sourceSnapshot.scrapedAt || null,
      scheduleType: snapshot.schedule_type || null
    },
    overall,
    leagues
  };

  writeFile(outPath, JSON.stringify(audit, null, 2));
  writeFile(mdPath, renderMarkdown(audit));
  console.log(JSON.stringify({
    status: 'PASS',
    outPath,
    mdPath,
    overall,
    leagues: leagues.map(league => ({
      league: league.league,
      status: league.status,
      exactMatches: league.exactMatches,
      teamCount: league.teamCount,
      meanAbsRankError: league.meanAbsRankError,
      predictedWinner: league.predictedWinner,
      predictedWinnerCurrentRank: league.predictedWinnerCurrentRank
    }))
  }, null, 2));
}

main();
