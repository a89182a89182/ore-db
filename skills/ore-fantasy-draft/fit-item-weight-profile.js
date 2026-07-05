#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const REPORTS_DIR = path.join(ROOT, 'reports');
const DRAFT_JS = path.join(__dirname, 'draft.js');
const DEFAULT_PROFILE = path.join(__dirname, 'weight-profiles', 'default.json');
const FORMAL_PROFILE = path.join(__dirname, 'weight-profiles', 'formal-latest.json');
const DEFAULT_SOURCE_SEASON = 775;
const DEFAULT_TARGET_SEASON = 776;
const DEFAULT_DATE_LABEL = '2026-06-26';
const DEFAULT_SOURCE_DIR = path.join(ROOT, 'season-775');
const DEFAULT_LIVE_DIR = path.join(ROOT, 'live-2026-06-21');
const DEFAULT_FINAL_DIR = path.join(ROOT, 'season-776');
const DEFAULT_FANTASY_DIR = path.join(ROOT, 'fantasy-snapshots', 'season-776', '2026-06-26-browser-full-list-manual');
const BATTER_SLOTS = ['C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF', 'DH'];
const PITCHER_SLOTS = ['SP1', 'SP2', 'SP3', 'SP4', 'SP5', 'RP1', 'RP2', 'RP3', 'CP'];
const ITEMS = [
  { item: 'AVG', mode: 'avg', kind: 'batter', lowerBetter: false },
  { item: 'HR', mode: 'hr', kind: 'batter', lowerBetter: false },
  { item: 'RBI', mode: 'rbi', kind: 'batter', lowerBetter: false },
  { item: 'SB', mode: 'sb', kind: 'batter', lowerBetter: false },
  { item: 'ERA', mode: 'era', kind: 'pitcher', lowerBetter: true },
  { item: 'W', mode: 'w', kind: 'pitcher', lowerBetter: false },
  { item: 'SV', mode: 'sv', kind: 'pitcher', lowerBetter: false },
  { item: 'K', mode: 'k', kind: 'pitcher', lowerBetter: false }
];

function parseArgs(argv) {
  const opts = {};
  for (let i = 2; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const [key, inlineValue] = token.slice(2).split('=');
    opts[key] = inlineValue !== undefined
      ? inlineValue
      : (i + 1 < argv.length && !argv[i + 1].startsWith('--') ? argv[++i] : true);
  }
  return opts;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function writeText(filePath, body) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body, 'utf8');
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function safe(value) {
  return String(value || '').replace(/[^A-Za-z0-9_.-]+/g, '_');
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function num(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(n) ? n : fallback;
}

function parseRate(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  const text = String(value).trim();
  return num(text.startsWith('.') ? `0${text}` : text, fallback);
}

function numberSequence(text) {
  return (String(text || '').match(/\d+(?:\.\d+)?/g) || []).map(Number);
}

function fantasyStats(row) {
  const batting = numberSequence(row.battingTotal);
  const pitching = numberSequence(row.pitchingTotal);
  return {
    AVG: batting[0] ?? null,
    HR: batting[1] ?? null,
    RBI: batting[2] ?? null,
    SB: batting[3] ?? null,
    ERA: pitching[0] ?? null,
    W: pitching[1] ?? null,
    SV: pitching[2] ?? null,
    K: pitching[3] ?? null
  };
}

function fantasyValue(row, item) {
  const value = fantasyStats(row)[item];
  return value == null || !Number.isFinite(Number(value)) ? null : Number(value);
}

function buildPlayerIndex(players) {
  const byName = new Map();
  for (const player of players) byName.set(player.name, player);
  return byName;
}

function batterStats(player) {
  const current = player && player.current_batting || {};
  const summary = player && player.season_summary || {};
  return {
    battingAverage: parseRate(summary.batting_avg, parseRate(current.batting_avg)),
    homeRuns: num(summary.home_runs, num(current.home_runs)),
    rbi: num(summary.rbi, num(current.rbi)),
    steals: num(summary.steals, num(current.steals))
  };
}

function pitcherStats(player) {
  const current = player && player.current_pitching || {};
  const summary = player && player.season_summary || {};
  return {
    era: parseRate(summary.era, parseRate(current.era, 99)),
    wins: num(summary.wins, num(current.wins)),
    saves: num(summary.saves, num(current.saves)),
    strikeouts: num(summary.strikeouts, num(current.strikeouts))
  };
}

function valueForPlayers(item, players) {
  if (item === 'AVG') {
    const rates = players.map(player => batterStats(player).battingAverage).filter(Number.isFinite);
    return rates.length ? rates.reduce((sum, value) => sum + value, 0) / rates.length : 0;
  }
  if (item === 'HR') return players.reduce((sum, player) => sum + batterStats(player).homeRuns, 0);
  if (item === 'RBI') return players.reduce((sum, player) => sum + batterStats(player).rbi, 0);
  if (item === 'SB') return players.reduce((sum, player) => sum + batterStats(player).steals, 0);
  if (item === 'ERA') {
    const rates = players.map(player => pitcherStats(player).era).filter(Number.isFinite);
    return rates.length ? rates.reduce((sum, value) => sum + value, 0) / rates.length : 99;
  }
  if (item === 'W') return players.reduce((sum, player) => sum + pitcherStats(player).wins, 0);
  if (item === 'SV') return players.reduce((sum, player) => sum + pitcherStats(player).saves, 0);
  if (item === 'K') return players.reduce((sum, player) => sum + pitcherStats(player).strikeouts, 0);
  throw new Error(`Unsupported item: ${item}`);
}

function roundValue(item, value) {
  if (item === 'AVG') return Number(value.toFixed(6));
  if (item === 'ERA') return Number(value.toFixed(5));
  return Number(value.toFixed(0));
}

function rankSubmittedRows(rows, lowerBetter) {
  return [...rows].sort((a, b) => {
    if (a.value === b.value) return String(a.account).localeCompare(String(b.account));
    return lowerBetter ? a.value - b.value : b.value - a.value;
  });
}

function selectedPlayersFromVariant(variant, kind) {
  return (variant.lineup || []).filter(player => player.category === kind);
}

function selectedNamesFromFantasyRow(row, kind) {
  const slots = kind === 'batter' ? BATTER_SLOTS : PITCHER_SLOTS;
  return slots.map(slot => row.picks && row.picks[slot]).filter(Boolean);
}

function rankForValue(rankedRows, value, lowerBetter) {
  return rankedRows.findIndex(row => lowerBetter ? value <= row.value : value >= row.value) + 1 || rankedRows.length + 1;
}

function evaluateDraft({ config, draftPath, finalPlayers, fantasyRows, byName }) {
  const draft = readJson(draftPath);
  const submitted = fantasyRows.map(row => ({
    account: row.account,
    rank: row.rank,
    value: fantasyValue(row, config.item)
  })).filter(row => row.value != null);
  const ranked = rankSubmittedRows(submitted, config.lowerBetter);
  const firstPlace = ranked[0] || null;
  const top10Cutoff = ranked[9] ? ranked[9].value : null;
  const variants = (draft.lineupVariants || []).map(variant => {
    const selected = selectedPlayersFromVariant(variant, config.kind);
    const players = selected.map(player => byName.get(player.name)).filter(Boolean);
    const value = roundValue(config.item, valueForPlayers(config.item, players));
    const rank = rankForValue(ranked, value, config.lowerBetter);
    const firstPlaceGap = firstPlace == null ? null : (config.lowerBetter
      ? Number(Math.max(0, value - firstPlace.value).toFixed(config.item === 'ERA' ? 5 : 6))
      : Number(Math.max(0, firstPlace.value - value).toFixed(config.item === 'AVG' ? 6 : 0)));
    return {
      variantIndex: variant.variantIndex,
      value,
      rank,
      firstPlaceGap,
      objective: variant.objective,
      batterObjective: variant.batterObjective,
      pitcherObjective: variant.pitcherObjective,
      roster: selected.map(player => ({
        name: player.name,
        role: player.role,
        team: player.team,
        score: player.score,
        primary: player.scoreComponents && player.scoreComponents.primary,
        scoreComponents: player.scoreComponents
      }))
    };
  });
  return {
    item: config.item,
    mode: config.mode,
    draftPath,
    profile: draft.weightProfile || null,
    firstPlaceAccount: firstPlace && firstPlace.account,
    firstPlaceValue: firstPlace ? roundValue(config.item, firstPlace.value) : null,
    top10Cutoff: top10Cutoff == null ? null : roundValue(config.item, top10Cutoff),
    firstPlaceVariants: variants.filter(row => row.rank === 1).length,
    bestRank: variants.length ? Math.min(...variants.map(row => row.rank)) : null,
    bestFirstPlaceGap: variants.length ? Math.min(...variants.map(row => row.firstPlaceGap).filter(value => value != null)) : null,
    top10Variants: variants.filter(row => row.rank <= 10).length,
    bestVariant: variants.slice().sort((a, b) => a.rank - b.rank || a.firstPlaceGap - b.firstPlaceGap)[0] || null,
    variants
  };
}

function candidateProfile(baseProfile, config, candidate, context) {
  const profile = clone(baseProfile);
  profile.name = `${candidate.name}-${config.item}`;
  profile.generatedAt = new Date().toISOString();
  profile.generatedBy = 'fit-item-weight-profile.js';
  profile.trainingContext = context.trainingContext;
  profile.diagnosticOnly = !!candidate.oracle;
  profile.variantCount = Math.max(5, num(profile.variantCount, 5));
  profile.candidate = {
    item: config.item,
    name: candidate.name,
    round: candidate.round,
    strategy: candidate.strategy
  };
  profile.diagnostic = {
    enabled: !!candidate.oracle,
    actualStatsPath: candidate.oracle ? context.finalPlayersPath : null,
    item: candidate.oracle ? config.item : null,
    scoreScale: 1000000
  };

  const weights = profile.itemWeights || {};
  if (candidate.name === 'projected-heavy') {
    if (weights[config.mode]) {
      for (const key of Object.keys(weights[config.mode])) {
        if (typeof weights[config.mode][key] === 'number') weights[config.mode][key] *= 1.12;
      }
    }
  } else if (candidate.name === 'skill-light') {
    for (const section of ['avg', 'hr', 'rbi', 'sb', 'k', 'pitcherCoreQuality']) {
      if (!weights[section]) continue;
      for (const key of Object.keys(weights[section])) {
        if (/skill|pitch/i.test(key) && typeof weights[section][key] === 'number') weights[section][key] *= 0.5;
      }
    }
  } else if (candidate.name === 'role-balanced') {
    if (weights.sv && weights.sv.CP) weights.sv.CP.closerBonus = num(weights.sv.CP.closerBonus, 2000) * 0.75;
    if (weights.k) weights.k.velocity = num(weights.k.velocity, 0.001) * 3;
  } else if (candidate.name === 'risk-light') {
    for (const section of ['pitcherCoreQuality']) {
      if (weights[section] && typeof weights[section].riskPenalty === 'number') weights[section].riskPenalty *= 0.5;
    }
    for (const mode of ['era', 'w', 'sv']) {
      if (!weights[mode]) continue;
      for (const role of Object.keys(weights[mode])) {
        if (weights[mode][role] && typeof weights[mode][role].riskPenalty === 'number') weights[mode][role].riskPenalty *= 0.5;
      }
    }
  }
  return profile;
}

function candidatePlan() {
  return [
    { name: 'baseline-default', round: 1, strategy: 'default profile' },
    { name: 'projected-heavy', round: 1, strategy: 'increase item projected-stat coefficients' },
    { name: 'skill-light', round: 1, strategy: 'reduce skill/tie-breaker dependence' },
    { name: 'role-balanced', round: 1, strategy: 'alter role/tie-break balance' },
    { name: 'risk-light', round: 1, strategy: 'reduce risk penalties' }
  ];
}

function oracleCandidate() {
  return { name: 'oracle-derived-actual-score', round: 2, strategy: 'use 776 actual item stat as solver score', oracle: true };
}

function runDraft({ config, profilePath, label, allowDiagnostic, paths }) {
  const draftPath = path.join(paths.reportsDir, `${label}_${config.item.toLowerCase()}_draft.json`);
  const projectionPath = path.join(paths.reportsDir, `${label}_${config.item.toLowerCase()}_projection.json`);
  const args = [
    DRAFT_JS,
    config.mode,
    '--season-dir', paths.sourceDir,
    '--live-dir', paths.liveDir,
    '--no-live-fetch',
    '--max-training-season', String(paths.maxTrainingSeason),
    '--out', draftPath,
    '--projection-out', projectionPath,
    '--weight-profile', profilePath
  ];
  if (allowDiagnostic) args.push('--allow-diagnostic-profile');
  const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`draft failed for ${config.item} ${label}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  }
  return { draftPath, projectionPath };
}

function profileFile(candidateDir, config, candidate) {
  return path.join(candidateDir, `${config.item.toLowerCase()}_${safe(candidate.round)}_${safe(candidate.name)}.json`);
}

function runCandidate({ baseProfile, config, candidate, paths, context, finalPlayers, fantasyRows, byName }) {
  const profile = candidateProfile(baseProfile, config, candidate, context);
  const profilePath = profileFile(paths.candidateDir, config, candidate);
  writeJson(profilePath, profile);
  const label = `ore_${paths.targetSeason}_${safe(paths.mode)}_${config.item.toLowerCase()}_${safe(candidate.round)}_${safe(candidate.name)}`;
  const run = runDraft({ config, profilePath, label, allowDiagnostic: !!candidate.oracle, paths });
  const evaluation = evaluateDraft({ config, draftPath: run.draftPath, finalPlayers, fantasyRows, byName });
  return {
    item: config.item,
    candidate: candidate.name,
    round: candidate.round,
    strategy: candidate.strategy,
    diagnosticOnly: !!candidate.oracle,
    profilePath,
    profileSha256: sha256(profilePath),
    draftPath: run.draftPath,
    projectionPath: run.projectionPath,
    bestRank: evaluation.bestRank,
    firstPlaceVariants: evaluation.firstPlaceVariants,
    bestFirstPlaceGap: evaluation.bestFirstPlaceGap,
    firstPlaceValue: evaluation.firstPlaceValue,
    top10Variants: evaluation.top10Variants,
    bestVariant: evaluation.bestVariant,
    variants: evaluation.variants
  };
}

function winnerForItem(rows, config) {
  return rankSubmittedRows(rows.map(row => ({
    row,
    account: row.account,
    value: fantasyValue(row, config.item)
  })).filter(row => row.value != null), config.lowerBetter)[0].row;
}

function missMatrixRow(config, baselineResult, fantasyRows) {
  const winner = winnerForItem(fantasyRows, config);
  const championNames = selectedNamesFromFantasyRow(winner, config.kind);
  const modelRoster = baselineResult.bestVariant ? baselineResult.bestVariant.roster : [];
  const modelNames = modelRoster.map(player => player.name);
  const modelSet = new Set(modelNames);
  const missing = championNames.filter(name => !modelSet.has(name));
  return {
    item: config.item,
    championAccount: winner.account,
    championValue: fantasyValue(winner, config.item),
    championRoster: championNames,
    modelRoster: modelNames,
    overlap: championNames.filter(name => modelSet.has(name)).length,
    missingCorePlayers: missing.map(name => {
      const slot = Object.entries(winner.picks || {}).find(([, value]) => value === name);
      return { name, slot: slot ? slot[0] : null };
    }),
    modelPredictedScore: baselineResult.bestVariant ? (baselineResult.bestVariant[config.kind === 'batter' ? 'batterObjective' : 'pitcherObjective'] ?? baselineResult.bestVariant.objective) : null,
    actualScore: baselineResult.bestVariant ? baselineResult.bestVariant.value : null,
    firstPlaceGap: baselineResult.bestFirstPlaceGap,
    mainFeature: missing.length
      ? `missing champion ${config.kind} core; selected alternatives had higher model score`
      : `same core but non-core/filler or tie-break gap remained`
  };
}

function renderOracleMarkdown(report) {
  const lines = [`# ORE ${report.targetSeason} Oracle Capacity Check`, '', `- Status: ${report.status}`, ''];
  lines.push('| Item | Status | Best rank | First-place variants | Blockers | Profile |');
  lines.push('|---|---|---:|---:|---|---|');
  for (const row of report.items) {
    lines.push(`| ${row.item} | ${row.status} | ${row.bestRank ?? ''} | ${row.firstPlaceVariants ?? 0} | ${(row.blockers || []).join(', ')} | ${row.profilePath} |`);
  }
  return lines.join('\n');
}

function renderOverfitMarkdown(report) {
  const lines = [`# ORE ${report.targetSeason} Private Overfit Weights`, '', `- Status: ${report.status}`, '- Diagnostic profiles may not be used for official Sunday prediction.', ''];
  lines.push('| Item | Status | Candidates | Successful profiles | Best rank |');
  lines.push('|---|---|---:|---|---:|');
  for (const row of report.items) {
    lines.push(`| ${row.item} | ${row.status} | ${row.candidates.length} | ${row.successfulProfiles.map(p => p.candidate).join(', ')} | ${row.bestRank} |`);
  }
  return lines.join('\n');
}

function renderTrainMarkdown(report) {
  const lines = [`# ORE ${report.sourceSeason} to ${report.targetSeason} Weight Training Holdout Comparison`, '', `- Status: ${report.status}`, `- Formal profile: ${report.formalProfilePath}`, ''];
  lines.push('| Item | Formal best rank | First-place variants | Gap to first |');
  lines.push('|---|---:|---:|---:|');
  for (const row of report.items) {
    lines.push(`| ${row.item} | ${row.bestRank} | ${row.firstPlaceVariants} | ${row.bestFirstPlaceGap ?? ''} |`);
  }
  return lines.join('\n');
}

function renderMissMarkdown(report) {
  const lines = [`# ORE ${report.targetSeason} Item Champion Miss Matrix`, '', `- Status: ${report.status}`, ''];
  lines.push('| Item | Champion | Value | Overlap | Missing core | Model actual | Gap | Main feature |');
  lines.push('|---|---|---:|---:|---|---:|---:|---|');
  for (const row of report.items) {
    lines.push(`| ${row.item} | ${row.championAccount} | ${row.championValue} | ${row.overlap} | ${row.missingCorePlayers.map(p => `${p.slot}:${p.name}`).join('; ')} | ${row.actualScore ?? ''} | ${row.firstPlaceGap ?? ''} | ${row.mainFeature} |`);
  }
  return lines.join('\n');
}

function outputPaths(paths) {
  const date = paths.dateLabel;
  return {
    oracleJson: path.join(paths.reportsDir, `ore_${paths.targetSeason}_all_items_oracle_capacity_check_${date}.json`),
    oracleMd: path.join(paths.reportsDir, `ore_${paths.targetSeason}_all_items_oracle_capacity_check_${date}.md`),
    overfitJson: path.join(paths.reportsDir, `ore_${paths.targetSeason}_all_items_private_overfit_weights_${date}.json`),
    overfitMd: path.join(paths.reportsDir, `ore_${paths.targetSeason}_all_items_private_overfit_weights_${date}.md`),
    trainJson: path.join(paths.reportsDir, `ore_${paths.sourceSeason}_to_${paths.targetSeason}_weight_training_holdout_comparison_${date}.json`),
    trainMd: path.join(paths.reportsDir, `ore_${paths.sourceSeason}_to_${paths.targetSeason}_weight_training_holdout_comparison_${date}.md`),
    missJson: path.join(paths.reportsDir, `ore_${paths.targetSeason}_item_champion_miss_matrix_${date}.json`),
    missMd: path.join(paths.reportsDir, `ore_${paths.targetSeason}_item_champion_miss_matrix_${date}.md`)
  };
}

function buildPaths(args, mode) {
  const reportsDir = path.resolve(args['reports-dir'] || REPORTS_DIR);
  const targetSeason = Number(args['target-season'] || DEFAULT_TARGET_SEASON);
  const sourceSeason = Number(args['source-season'] || DEFAULT_SOURCE_SEASON);
  const dateLabel = args['date-label'] || DEFAULT_DATE_LABEL;
  return {
    mode,
    reportsDir,
    candidateDir: path.join(reportsDir, `ore_${targetSeason}_weight_profile_candidates_${dateLabel}`),
    sourceDir: path.resolve(args['season-dir'] || DEFAULT_SOURCE_DIR),
    liveDir: path.resolve(args['live-dir'] || DEFAULT_LIVE_DIR),
    finalDir: path.resolve(args['final-season-dir'] || DEFAULT_FINAL_DIR),
    finalPlayersPath: path.join(path.resolve(args['final-season-dir'] || DEFAULT_FINAL_DIR), 'players.json'),
    fantasyDir: path.resolve(args['fantasy-dir'] || DEFAULT_FANTASY_DIR),
    sourceSeason,
    targetSeason,
    maxTrainingSeason: Number(args['max-training-season'] || sourceSeason),
    dateLabel
  };
}

function runDiagnosticOverfit(args) {
  const paths = buildPaths(args, 'diagnostic-overfit');
  const outputs = outputPaths(paths);
  const baseProfile = readJson(args['base-profile'] || DEFAULT_PROFILE);
  const finalPlayers = readJson(paths.finalPlayersPath);
  const fantasyRows = readJson(path.join(paths.fantasyDir, 'fantasy_full_list_rows.json'));
  const byName = buildPlayerIndex(finalPlayers);
  const context = {
    finalPlayersPath: paths.finalPlayersPath,
    trainingContext: {
      mode: 'diagnostic-overfit',
      sourceSeason: paths.sourceSeason,
      targetSeason: paths.targetSeason,
      diagnosticUsesTargetFinalStats: true
    }
  };

  const oracleItems = [];
  const overfitItems = [];
  const missItems = [];

  for (const config of ITEMS) {
    const oracle = runCandidate({ baseProfile, config, candidate: oracleCandidate(), paths, context, finalPlayers, fantasyRows, byName });
    oracleItems.push({
      item: config.item,
      status: oracle.firstPlaceVariants > 0 ? 'PASS' : 'HARD_BLOCKER',
      blockers: oracle.firstPlaceVariants > 0 ? [] : ['candidate_pool', 'legality', 'scoring_formula', 'solver_search'],
      ...oracle
    });

    const candidates = [];
    for (const candidate of candidatePlan()) {
      candidates.push(runCandidate({ baseProfile, config, candidate, paths, context, finalPlayers, fantasyRows, byName }));
    }
    if (!candidates.some(candidate => candidate.firstPlaceVariants > 0)) {
      candidates.push(oracle);
    }
    const successfulProfiles = candidates.filter(candidate => candidate.firstPlaceVariants > 0);
    overfitItems.push({
      item: config.item,
      status: successfulProfiles.length ? 'PASS' : 'HARD_BLOCKER',
      searchRounds: candidates.some(candidate => candidate.round === 2)
        ? ['round1_weight_variants', 'round2_oracle_derived_actual_score']
        : ['round1_weight_variants'],
      bestRank: Math.min(...candidates.map(candidate => candidate.bestRank || 999)),
      candidates,
      successfulProfiles: successfulProfiles.map(candidate => ({
        candidate: candidate.candidate,
        profilePath: candidate.profilePath,
        profileSha256: candidate.profileSha256,
        bestRank: candidate.bestRank,
        firstPlaceVariants: candidate.firstPlaceVariants,
        diagnosticOnly: candidate.diagnosticOnly
      }))
    });

    const baseline = candidates.find(candidate => candidate.candidate === 'baseline-default') || candidates[0];
    missItems.push(missMatrixRow(config, baseline, fantasyRows));
  }

  const oracleReport = {
    status: oracleItems.every(item => item.status === 'PASS') ? 'PASS' : 'BLOCKED',
    generatedAt: new Date().toISOString(),
    sourceSeason: paths.sourceSeason,
    targetSeason: paths.targetSeason,
    reportsDir: paths.reportsDir,
    items: oracleItems
  };
  const overfitReport = {
    status: overfitItems.every(item => item.status === 'PASS') ? 'PASS' : 'BLOCKED',
    generatedAt: new Date().toISOString(),
    sourceSeason: paths.sourceSeason,
    targetSeason: paths.targetSeason,
    diagnosticOnly: true,
    items: overfitItems
  };
  const missReport = {
    status: 'PASS',
    generatedAt: new Date().toISOString(),
    sourceSeason: paths.sourceSeason,
    targetSeason: paths.targetSeason,
    items: missItems
  };

  writeJson(outputs.oracleJson, oracleReport);
  writeText(outputs.oracleMd, renderOracleMarkdown(oracleReport));
  writeJson(outputs.overfitJson, overfitReport);
  writeText(outputs.overfitMd, renderOverfitMarkdown(overfitReport));
  writeJson(outputs.missJson, missReport);
  writeText(outputs.missMd, renderMissMarkdown(missReport));
  console.log(outputs.oracleJson);
  console.log(outputs.overfitJson);
  console.log(outputs.missJson);
}

function runTrainHoldout(args) {
  const paths = buildPaths(args, 'train-holdout');
  const outputs = outputPaths(paths);
  const profile = readJson(args['base-profile'] || DEFAULT_PROFILE);
  profile.name = `formal-latest-${paths.sourceSeason}-to-${paths.targetSeason}`;
  profile.generatedAt = new Date().toISOString();
  profile.generatedBy = 'fit-item-weight-profile.js';
  profile.diagnosticOnly = false;
  profile.diagnostic = { enabled: false, actualStatsPath: null, item: null, scoreScale: 1000000 };
  profile.trainingContext = {
    mode: 'train-holdout',
    sourceSeason: paths.sourceSeason,
    targetSeason: paths.targetSeason,
    targetSeasonUsage: 'validation_only_no_winner_name_boosts'
  };
  writeJson(FORMAL_PROFILE, profile);

  const finalPlayers = readJson(paths.finalPlayersPath);
  const fantasyRows = readJson(path.join(paths.fantasyDir, 'fantasy_full_list_rows.json'));
  const byName = buildPlayerIndex(finalPlayers);
  const items = [];
  for (const config of ITEMS) {
    const run = runDraft({
      config,
      profilePath: FORMAL_PROFILE,
      label: `ore_${paths.targetSeason}_train_holdout_formal_${config.item.toLowerCase()}`,
      allowDiagnostic: false,
      paths
    });
    const evaluation = evaluateDraft({ config, draftPath: run.draftPath, finalPlayers, fantasyRows, byName });
    items.push({
      item: config.item,
      mode: config.mode,
      draftPath: run.draftPath,
      projectionPath: run.projectionPath,
      bestRank: evaluation.bestRank,
      firstPlaceVariants: evaluation.firstPlaceVariants,
      bestFirstPlaceGap: evaluation.bestFirstPlaceGap,
      top10Variants: evaluation.top10Variants,
      firstPlaceValue: evaluation.firstPlaceValue,
      bestVariant: evaluation.bestVariant
    });
  }
  const report = {
    status: 'PASS',
    generatedAt: new Date().toISOString(),
    sourceSeason: paths.sourceSeason,
    targetSeason: paths.targetSeason,
    formalProfilePath: FORMAL_PROFILE,
    formalProfileSha256: sha256(FORMAL_PROFILE),
    diagnosticOnly: false,
    targetSeasonWinnerBoosts: false,
    items
  };
  writeJson(outputs.trainJson, report);
  writeText(outputs.trainMd, renderTrainMarkdown(report));
  console.log(outputs.trainJson);
}

function main() {
  const args = parseArgs(process.argv);
  const mode = args.mode || 'diagnostic-overfit';
  if (mode === 'diagnostic-overfit') return runDiagnosticOverfit(args);
  if (mode === 'train-holdout') return runTrainHoldout(args);
  throw new Error(`Unsupported mode: ${mode}`);
}

main();
