#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

function arg(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find(item => item.startsWith(prefix));
  if (found) return found.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  return fallback;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readJsonIfExists(filePath) {
  return filePath && fs.existsSync(filePath) ? readJson(filePath) : null;
}

function writeText(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, 'utf8');
}

function get(obj, dottedPath) {
  return dottedPath.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
}

function numberFrom(value) {
  if (value == null || value === '') return null;
  const normalized = String(value).replace(/,/g, '').replace(/^第\s*/, '').replace(/\s*名$/, '');
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

function metricSpec(item) {
  const specs = {
    HR: { category: 'batter', statPath: 'current_batting.home_runs', summaryPath: 'season_summary.home_runs', direction: 'desc' },
    SB: { category: 'batter', statPath: 'current_batting.steals', summaryPath: 'season_summary.steals', direction: 'desc' },
    K: { category: 'pitcher', statPath: 'current_pitching.strikeouts', summaryPath: 'season_summary.strikeouts', direction: 'desc' },
    ERA: { category: 'pitcher', statPath: 'current_pitching.era', summaryPath: 'season_summary.era', direction: 'asc' }
  };
  return specs[item] || null;
}

function playerKey(player) {
  return [player.team || '', player.owner || '', player.name || '', player.category || ''].join('|');
}

function teamNameKey(player) {
  return [player.team || '', player.name || '', player.category || ''].join('|');
}

function valueFor(player, spec) {
  return numberFrom(get(player, spec.statPath) ?? get(player, spec.summaryPath));
}

function rankPlayers(players, spec) {
  const rows = players
    .filter(player => player.category === spec.category)
    .map(player => ({ player, value: valueFor(player, spec) }))
    .filter(row => row.value != null);
  rows.sort((a, b) => {
    if (a.value !== b.value) return spec.direction === 'asc' ? a.value - b.value : b.value - a.value;
    return playerKey(a.player).localeCompare(playerKey(b.player));
  });
  const ranks = new Map();
  let previous = null;
  let currentRank = 0;
  rows.forEach((row, index) => {
    if (previous == null || row.value !== previous) currentRank = index + 1;
    previous = row.value;
    ranks.set(playerKey(row.player), currentRank);
    ranks.set(teamNameKey(row.player), currentRank);
  });
  return { rows, ranks };
}

function buildPlayerIndexes(players) {
  const byIdentity = new Map();
  const byTeamName = new Map();
  for (const player of players) {
    byIdentity.set(playerKey(player), player);
    if (!byTeamName.has(teamNameKey(player))) byTeamName.set(teamNameKey(player), player);
  }
  return { byIdentity, byTeamName };
}

function matchPlayer(row, indexes) {
  return indexes.byIdentity.get(row.identity) || indexes.byTeamName.get(row.teamNameIdentity) || null;
}

function reviewSelection(selection, players, indexes) {
  const spec = metricSpec(selection.item);
  if (!spec) {
    return { kind: selection.kind, label: selection.label, item: selection.item, status: 'UNSUPPORTED_ITEM' };
  }
  const ranked = rankPlayers(players, spec);
  const relevant = [];
  const missing = [];
  for (const row of selection.lineup || []) {
    if (row.category !== spec.category) continue;
    const actual = matchPlayer(row, indexes);
    if (!actual) {
      missing.push({ order: row.order, team: row.team, owner: row.owner, name: row.name, category: row.category });
      continue;
    }
    const key = playerKey(actual);
    relevant.push({
      order: row.order,
      team: row.team,
      owner: row.owner,
      name: row.name,
      category: row.category,
      value: valueFor(actual, spec),
      rank: ranked.ranks.get(key) ?? ranked.ranks.get(teamNameKey(actual)) ?? null
    });
  }
  const values = relevant.map(row => row.value).filter(value => value != null);
  const lineupScore = selection.item === 'ERA'
    ? (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null)
    : values.reduce((sum, value) => sum + value, 0);
  return {
    kind: selection.kind,
    label: selection.label,
    item: selection.item,
    status: 'REVIEW_READY',
    metricCategory: spec.category,
    metricDirection: spec.direction,
    relevantRows: relevant.length,
    matchedRows: relevant.filter(row => row.value != null).length,
    missingRows: missing.length,
    lineupScore,
    selectedTop1: relevant.filter(row => row.rank === 1).length,
    selectedTop3: relevant.filter(row => row.rank != null && row.rank <= 3).length,
    selectedTop5: relevant.filter(row => row.rank != null && row.rank <= 5).length,
    selectedTop10: relevant.filter(row => row.rank != null && row.rank <= 10).length,
    selectedTop20: relevant.filter(row => row.rank != null && row.rank <= 20).length,
    bestSelected: relevant
      .filter(row => row.value != null)
      .sort((a, b) => spec.direction === 'asc' ? a.value - b.value : b.value - a.value)[0] || null,
    missing,
    rows: relevant
  };
}

function leagueReview(snapshot, seasonSnapshot) {
  if (!seasonSnapshot || !Array.isArray(seasonSnapshot.teams)) {
    return { status: 'NO_SEASON_SNAPSHOT' };
  }
  const actualByLeague = new Map();
  for (const team of seasonSnapshot.teams) {
    const league = team.league || 'unknown';
    if (!actualByLeague.has(league)) actualByLeague.set(league, []);
    actualByLeague.get(league).push({
      team: team.team,
      rank: numberFrom(get(team, 'current_status.league_rank')),
      winPct: numberFrom(get(team, 'current_status.win_pct')),
      wins: numberFrom(get(team, 'current_status.wins')),
      losses: numberFrom(get(team, 'current_status.losses'))
    });
  }
  for (const rows of actualByLeague.values()) {
    rows.sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));
  }

  const leagues = [];
  let exactMatches = 0;
  let compared = 0;
  for (const predictedLeague of get(snapshot, 'league.rankings') || []) {
    const actualRows = actualByLeague.get(predictedLeague.league) || [];
    const actualRankByTeam = new Map(actualRows.map(row => [row.team, row.rank]));
    const rows = (predictedLeague.order || []).map(row => {
      const actualRank = actualRankByTeam.get(row.team) ?? null;
      if (actualRank != null) {
        compared += 1;
        if (actualRank === row.rank) exactMatches += 1;
      }
      return {
        team: row.team,
        predictedRank: row.rank,
        actualRank,
        exact: actualRank === row.rank
      };
    });
    leagues.push({
      league: predictedLeague.league,
      predicted: (predictedLeague.order || []).map(row => row.team),
      actual: actualRows.map(row => row.team),
      rows
    });
  }
  const currentLeader = Array.from(actualByLeague.values())
    .flat()
    .sort((a, b) => (b.winPct ?? -1) - (a.winPct ?? -1))[0] || null;
  const completedChampion = get(seasonSnapshot, 'championship.season') === String(snapshot.targetSeason)
    ? get(seasonSnapshot, 'championship.champion_team')
    : null;
  return {
    status: 'REVIEW_READY',
    exactMatches,
    compared,
    currentLeader: currentLeader ? currentLeader.team : null,
    predictedChampion: get(snapshot, 'league.champion') || null,
    currentLeaderAligned: currentLeader ? currentLeader.team === get(snapshot, 'league.champion') : null,
    completedChampion,
    completedChampionAligned: completedChampion ? completedChampion === get(snapshot, 'league.champion') : null,
    leagues
  };
}

function numberSequence(text) {
  return (String(text || '').match(/\d+(?:\.\d+)?/g) || []).map(value => Number(value));
}

function parseFantasyTotals(row) {
  const batting = numberSequence(row.battingTotal);
  const pitching = numberSequence(row.pitchingTotal);
  return {
    batting: {
      AVG: batting[0] ?? null,
      HR: batting[1] ?? null,
      RBI: batting[2] ?? null,
      SB: batting[3] ?? null
    },
    pitching: {
      ERA: pitching[0] ?? null,
      W: pitching[1] ?? null,
      SV: pitching[2] ?? null,
      K: pitching[3] ?? null
    }
  };
}

function fantasyItemSpec(item) {
  const specs = {
    AVG: { group: 'batting', field: 'AVG', direction: 'desc' },
    HR: { group: 'batting', field: 'HR', direction: 'desc' },
    RBI: { group: 'batting', field: 'RBI', direction: 'desc' },
    SB: { group: 'batting', field: 'SB', direction: 'desc' },
    ERA: { group: 'pitching', field: 'ERA', direction: 'asc' },
    W: { group: 'pitching', field: 'W', direction: 'desc' },
    SV: { group: 'pitching', field: 'SV', direction: 'desc' },
    K: { group: 'pitching', field: 'K', direction: 'desc' }
  };
  return specs[item] || null;
}

function enrichFantasyRows(rows) {
  return (rows || []).map(row => ({
    ...row,
    stats: parseFantasyTotals(row)
  }));
}

function fantasyValue(row, item) {
  const spec = fantasyItemSpec(item);
  if (!spec) return null;
  const value = row.stats && row.stats[spec.group] && row.stats[spec.group][spec.field];
  return value == null || !Number.isFinite(Number(value)) ? null : Number(value);
}

function rankFantasyAccounts(rows, item) {
  const spec = fantasyItemSpec(item);
  if (!spec) return { status: 'UNSUPPORTED_ITEM', rows: [], ranks: new Map() };
  const sorted = rows
    .map(row => ({ row, value: fantasyValue(row, item) }))
    .filter(entry => entry.value != null)
    .sort((a, b) => {
      if (a.value !== b.value) return spec.direction === 'asc' ? a.value - b.value : b.value - a.value;
      return Number(a.row.rank || 999999) - Number(b.row.rank || 999999)
        || String(a.row.account || '').localeCompare(String(b.row.account || ''));
    });
  const ranks = new Map();
  let previous = null;
  let currentRank = 0;
  sorted.forEach((entry, index) => {
    if (index === 0 || entry.value !== previous) currentRank = index + 1;
    ranks.set(entry.row.account, currentRank);
    previous = entry.value;
  });
  return {
    status: 'REVIEW_READY',
    rows: sorted.map(entry => ({
      rank: ranks.get(entry.row.account),
      overallRank: entry.row.rank,
      account: entry.row.account,
      value: entry.value
    })),
    ranks
  };
}

function selectionNameSet(selection) {
  return new Set((selection.lineup || []).map(row => row.name).filter(Boolean));
}

function pickNameSet(row) {
  return new Set(Object.values((row && row.picks) || {}).filter(Boolean));
}

function intersection(a, b) {
  return [...a].filter(value => b.has(value)).sort((x, y) => String(x).localeCompare(String(y)));
}

function difference(a, b) {
  return [...a].filter(value => !b.has(value)).sort((x, y) => String(x).localeCompare(String(y)));
}

function reviewFantasySelection(selection, fantasyRows, actualAccount) {
  const ranked = rankFantasyAccounts(fantasyRows, selection.item);
  if (ranked.status !== 'REVIEW_READY') {
    return { kind: selection.kind, label: selection.label, item: selection.item, status: ranked.status };
  }
  const accountRow = fantasyRows.find(row => row.account === actualAccount) || null;
  const selectedNames = selectionNameSet(selection);
  const submittedNames = pickNameSet(accountRow);
  const overlapNames = accountRow ? intersection(selectedNames, submittedNames) : [];
  const accountValue = accountRow ? fantasyValue(accountRow, selection.item) : null;
  return {
    kind: selection.kind,
    label: selection.label,
    item: selection.item,
    status: accountRow ? 'REVIEW_READY' : 'ACCOUNT_NOT_FOUND',
    actualAccount,
    accountOverallRank: accountRow ? accountRow.rank : null,
    accountMetricValue: accountValue,
    accountMetricRank: accountRow ? (ranked.ranks.get(actualAccount) ?? null) : null,
    leader: ranked.rows[0] || null,
    top10: ranked.rows.slice(0, 10),
    top10Cutoff: ranked.rows[9] || null,
    submittedPickOverlap: accountRow ? {
      selectedCount: selectedNames.size,
      submittedCount: submittedNames.size,
      overlapCount: overlapNames.length,
      overlapNames,
      selectedNotSubmitted: difference(selectedNames, submittedNames),
      submittedNotSelected: difference(submittedNames, selectedNames)
    } : null
  };
}

function categoryReviewForAccount(fantasyRows, actualAccount) {
  const accountRow = fantasyRows.find(row => row.account === actualAccount) || null;
  const items = ['AVG', 'HR', 'RBI', 'SB', 'ERA', 'W', 'SV', 'K'];
  const byItem = {};
  for (const item of items) {
    const ranked = rankFantasyAccounts(fantasyRows, item);
    byItem[item] = {
      status: ranked.status,
      accountValue: accountRow ? fantasyValue(accountRow, item) : null,
      accountRank: accountRow && ranked.ranks ? ranked.ranks.get(actualAccount) ?? null : null,
      leader: ranked.rows[0] || null,
      top10Cutoff: ranked.rows[9] || null
    };
  }
  return {
    actualAccount,
    accountFound: Boolean(accountRow),
    accountOverallRank: accountRow ? accountRow.rank : null,
    accountBattingTotal: accountRow ? accountRow.battingTotal : null,
    accountPitchingTotal: accountRow ? accountRow.pitchingTotal : null,
    items: byItem
  };
}

function leagueReviewFromFinalRankings(snapshot, teamRankings) {
  if (!Array.isArray(teamRankings) || !teamRankings.length) return { status: 'NO_TEAM_RANKINGS' };
  const actualByLeague = new Map();
  for (const row of teamRankings) {
    if (!actualByLeague.has(row.league)) actualByLeague.set(row.league, []);
    actualByLeague.get(row.league).push(row);
  }
  for (const rows of actualByLeague.values()) rows.sort((a, b) => Number(a.rank || 99) - Number(b.rank || 99));

  const leagues = [];
  let exactMatches = 0;
  let compared = 0;
  let winnerMatches = 0;
  let winnerCompared = 0;
  for (const predictedLeague of get(snapshot, 'league.rankings') || []) {
    const actualRows = actualByLeague.get(predictedLeague.league) || [];
    const actualRankByTeam = new Map(actualRows.map(row => [row.team, Number(row.rank)]));
    const actualWinner = actualRows.find(row => row.isChampion || Number(row.rank) === 1) || null;
    const predictedWinner = predictedLeague.predictedWinner || (predictedLeague.order || [])[0]?.team || null;
    if (actualWinner && predictedWinner) {
      winnerCompared += 1;
      if (actualWinner.team === predictedWinner) winnerMatches += 1;
    }
    const rows = (predictedLeague.order || []).map(row => {
      const actualRank = actualRankByTeam.get(row.team) ?? null;
      if (actualRank != null) {
        compared += 1;
        if (actualRank === Number(row.rank)) exactMatches += 1;
      }
      return {
        team: row.team,
        predictedRank: Number(row.rank),
        actualRank,
        exact: actualRank === Number(row.rank),
        error: actualRank == null ? null : Math.abs(actualRank - Number(row.rank))
      };
    });
    leagues.push({
      league: predictedLeague.league,
      predictedWinner,
      actualWinner: actualWinner ? actualWinner.team : null,
      winnerAligned: actualWinner && predictedWinner ? actualWinner.team === predictedWinner : null,
      predicted: (predictedLeague.order || []).map(row => row.team),
      actual: actualRows.map(row => row.team),
      rows
    });
  }
  const champions = teamRankings.filter(row => row.isChampion || Number(row.rank) === 1).map(row => row.team);
  return {
    status: 'REVIEW_READY_FINAL_TEAM_RANKINGS',
    exactMatches,
    compared,
    winnerMatches,
    winnerCompared,
    predictedChampion: get(snapshot, 'league.champion') || null,
    actualChampions: champions,
    completedChampionAligned: champions.includes(get(snapshot, 'league.champion')),
    leagues
  };
}

function reviewFromFantasySnapshot(snapshot, fantasySnapshotDir, actualAccount) {
  const fantasyRowsPath = path.join(fantasySnapshotDir, 'fantasy_full_list_rows.json');
  const teamRankingsPath = path.join(fantasySnapshotDir, 'team_rankings.json');
  const manifestPath = path.join(fantasySnapshotDir, 'manifest.json');
  const fantasyRows = enrichFantasyRows(readJson(fantasyRowsPath));
  const teamRankings = readJsonIfExists(teamRankingsPath);
  const manifest = readJsonIfExists(manifestPath);
  const league = leagueReviewFromFinalRankings(snapshot, teamRankings || []);
  return {
    status: 'REVIEW_READY',
    generatedAt: new Date().toISOString(),
    targetSeason: snapshot.targetSeason,
    snapshotHash: snapshot.snapshotHash || null,
    seasonDir: fantasySnapshotDir,
    readyForOutcomeReview: true,
    source: {
      snapshotSource: snapshot.source,
      actualFantasySnapshotDir: fantasySnapshotDir,
      actualFantasyManifest: manifest ? {
        path: manifestPath,
        status: manifest.status || null,
        fantasyRows: manifest.counts && manifest.counts.fantasyRows || null,
        rosterEntries: manifest.counts && manifest.counts.rosterEntries || null,
        teamRankingRows: manifest.counts && manifest.counts.teamRankingRows || null
      } : null
    },
    selections: (snapshot.selections || []).map(selection => reviewFantasySelection(selection, fantasyRows, actualAccount)),
    fantasy: {
      actualAccount,
      rowCount: fantasyRows.length,
      categoryReview: categoryReviewForAccount(fantasyRows, actualAccount)
    },
    league
  };
}

function hasUsableStats(players) {
  return players.some(player => {
    if (player.category === 'batter') {
      return ['home_runs', 'steals', 'hits', 'at_bats'].some(key => numberFrom(get(player, `current_batting.${key}`)) > 0);
    }
    return ['strikeouts', 'wins', 'saves'].some(key => numberFrom(get(player, `current_pitching.${key}`)) > 0);
  });
}

function renderMarkdown(review) {
  const lines = [
    `# ORE ${review.targetSeason} Weekly Submission Outcome Review`,
    '',
    `- Status: ${review.status}`,
    `- Snapshot hash: ${review.snapshotHash || '-'}`,
    `- Season dir: ${review.seasonDir}`,
    ''
  ];
  if (review.status !== 'REVIEW_READY') {
    lines.push(`- Reason: ${review.reason || 'not ready'}`);
    return `${lines.join('\n')}\n`;
  }
  lines.push('## Selections');
  lines.push('');
  for (const selection of review.selections) {
    lines.push(`### ${selection.kind}: ${selection.label}`);
    lines.push('');
    lines.push(`- Status: ${selection.status}`);
    if (selection.accountMetricRank != null) {
      lines.push(`- Actual account: ${selection.actualAccount}; overall rank ${selection.accountOverallRank}; ${selection.item} value ${selection.accountMetricValue}; ${selection.item} rank ${selection.accountMetricRank}`);
      if (selection.leader) lines.push(`- Item leader: ${selection.leader.account} value ${selection.leader.value}`);
      if (selection.submittedPickOverlap) lines.push(`- Submitted-pick overlap: ${selection.submittedPickOverlap.overlapCount}/${selection.submittedPickOverlap.selectedCount}`);
    } else {
      lines.push(`- Lineup score: ${selection.lineupScore ?? '-'}`);
      lines.push(`- Relevant/matched/missing rows: ${selection.relevantRows}/${selection.matchedRows}/${selection.missingRows}`);
      lines.push(`- Top ranks selected: top1 ${selection.selectedTop1}, top3 ${selection.selectedTop3}, top5 ${selection.selectedTop5}, top10 ${selection.selectedTop10}, top20 ${selection.selectedTop20}`);
      if (selection.bestSelected) {
        lines.push(`- Best selected: ${selection.bestSelected.team} ${selection.bestSelected.name} value ${selection.bestSelected.value} rank ${selection.bestSelected.rank ?? '-'}`);
      }
    }
    lines.push('');
  }
  if (review.fantasy && review.fantasy.categoryReview) {
    const category = review.fantasy.categoryReview;
    lines.push('## Fantasy Account Categories');
    lines.push('');
    lines.push(`- Account: ${category.actualAccount}; overall rank ${category.accountOverallRank ?? '-'}`);
    for (const item of ['AVG', 'HR', 'RBI', 'SB', 'ERA', 'W', 'SV', 'K']) {
      const row = category.items[item] || {};
      lines.push(`- ${item}: value ${row.accountValue ?? '-'}; rank ${row.accountRank ?? '-'}; leader ${row.leader ? `${row.leader.account} ${row.leader.value}` : '-'}`);
    }
    lines.push('');
  }
  lines.push('## League');
  lines.push('');
  lines.push(`- Predicted champion: ${review.league.predictedChampion || '-'}`);
  if (review.league.currentLeader || review.league.currentLeaderAligned != null) {
    lines.push(`- Current leader: ${review.league.currentLeader || '-'}; aligned=${review.league.currentLeaderAligned}`);
  }
  if (review.league.actualChampions) {
    lines.push(`- Actual champions: ${review.league.actualChampions.join(', ')}; aligned=${review.league.completedChampionAligned}`);
  }
  if (review.league.winnerCompared != null) {
    lines.push(`- League winners: ${review.league.winnerMatches}/${review.league.winnerCompared}`);
  }
  lines.push(`- Exact ranks: ${review.league.exactMatches}/${review.league.compared}`);
  if (review.league.completedChampion) {
    lines.push(`- Completed champion: ${review.league.completedChampion}; aligned=${review.league.completedChampionAligned}`);
  }
  return `${lines.join('\n')}\n`;
}

function waiting(status, reason, snapshot, seasonDir, outPath, mdOutPath) {
  const review = {
    status,
    reason,
    generatedAt: new Date().toISOString(),
    targetSeason: snapshot.targetSeason,
    snapshotHash: snapshot.snapshotHash || null,
    seasonDir,
    readyForOutcomeReview: false
  };
  if (outPath) writeText(outPath, `${JSON.stringify(review, null, 2)}\n`);
  if (mdOutPath) writeText(mdOutPath, renderMarkdown(review));
  return review;
}

function main() {
  const snapshotPath = arg('snapshot');
  const oreDbDir = arg('ore-db-dir', 'C:\\Users\\YOSHI\\Documents\\ore-db');
  const outPath = arg('out');
  const mdOutPath = arg('md-out');
  const fantasySnapshotDir = arg('fantasy-snapshot-dir');
  const actualAccount = arg('actual-account', process.env.ORE_FANTASY_ACCOUNT || 'a89182');
  if (!snapshotPath) throw new Error('Missing --snapshot');
  const snapshot = readJson(snapshotPath);
  if (fantasySnapshotDir) {
    const review = reviewFromFantasySnapshot(snapshot, fantasySnapshotDir, actualAccount);
    if (outPath) writeText(outPath, `${JSON.stringify(review, null, 2)}\n`);
    if (mdOutPath) writeText(mdOutPath, renderMarkdown(review));
    console.log(JSON.stringify({
      status: review.status,
      targetSeason: review.targetSeason,
      actualAccount,
      selections: review.selections.map(selection => ({
        kind: selection.kind,
        label: selection.label,
        item: selection.item,
        accountMetricRank: selection.accountMetricRank,
        accountMetricValue: selection.accountMetricValue,
        overlapCount: selection.submittedPickOverlap ? selection.submittedPickOverlap.overlapCount : null
      })),
      league: {
        exactMatches: review.league.exactMatches,
        compared: review.league.compared,
        winnerMatches: review.league.winnerMatches,
        winnerCompared: review.league.winnerCompared
      },
      outPath,
      mdOutPath
    }, null, 2));
    return;
  }
  const seasonDir = path.join(oreDbDir, `season-${snapshot.targetSeason}`);
  if (!fs.existsSync(seasonDir)) {
    const review = waiting('WAITING_FOR_TARGET_SEASON', `Target season directory not found: ${seasonDir}`, snapshot, seasonDir, outPath, mdOutPath);
    console.log(JSON.stringify({ status: review.status, reason: review.reason, outPath, mdOutPath }, null, 2));
    return;
  }
  const playersPath = path.join(seasonDir, 'players.json');
  if (!fs.existsSync(playersPath)) {
    const review = waiting('WAITING_FOR_TARGET_RESULTS', `Target season players.json not found: ${playersPath}`, snapshot, seasonDir, outPath, mdOutPath);
    console.log(JSON.stringify({ status: review.status, reason: review.reason, outPath, mdOutPath }, null, 2));
    return;
  }
  const players = readJson(playersPath);
  if (!Array.isArray(players) || players.length === 0 || !hasUsableStats(players)) {
    const review = waiting('WAITING_FOR_TARGET_RESULTS', 'Target season exists but has no usable current results yet.', snapshot, seasonDir, outPath, mdOutPath);
    console.log(JSON.stringify({ status: review.status, reason: review.reason, outPath, mdOutPath }, null, 2));
    return;
  }
  const seasonSnapshotPath = path.join(seasonDir, 'season_snapshot.json');
  const seasonSnapshot = fs.existsSync(seasonSnapshotPath) ? readJson(seasonSnapshotPath) : null;
  const indexes = buildPlayerIndexes(players);
  const review = {
    status: 'REVIEW_READY',
    generatedAt: new Date().toISOString(),
    targetSeason: snapshot.targetSeason,
    snapshotHash: snapshot.snapshotHash || null,
    seasonDir,
    readyForOutcomeReview: true,
    source: {
      snapshotSource: snapshot.source,
      actualSeasonScrapedAt: seasonSnapshot ? seasonSnapshot.scraped_at : null,
      actualSeasonDay: seasonSnapshot ? seasonSnapshot.day : null
    },
    selections: (snapshot.selections || []).map(selection => reviewSelection(selection, players, indexes)),
    league: leagueReview(snapshot, seasonSnapshot)
  };
  if (outPath) writeText(outPath, `${JSON.stringify(review, null, 2)}\n`);
  if (mdOutPath) writeText(mdOutPath, renderMarkdown(review));
  console.log(JSON.stringify({
    status: review.status,
    targetSeason: review.targetSeason,
    selections: review.selections.map(selection => ({
      kind: selection.kind,
      label: selection.label,
      lineupScore: selection.lineupScore,
      selectedTop10: selection.selectedTop10,
      missingRows: selection.missingRows
    })),
    league: {
      exactMatches: review.league.exactMatches,
      compared: review.league.compared,
      currentLeader: review.league.currentLeader,
      currentLeaderAligned: review.league.currentLeaderAligned
    },
    outPath,
    mdOutPath
  }, null, 2));
}

main();
