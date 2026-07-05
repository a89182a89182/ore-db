const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const DRAFT_JS = path.join(__dirname, 'draft.js');
const REPORTS_DIR = path.resolve(__dirname, '..', '..', 'reports');
const DEFAULT_SEASON_DIR = path.resolve(__dirname, '..', '..', 'season-774');
const DEFAULT_LIVE_DIR = path.resolve(__dirname, '..', '..', 'live-2026-06-14');
const DEFAULT_FINAL_SEASON_DIR = path.resolve(__dirname, '..', '..', 'season-775');
const DEFAULT_FANTASY_DIR = path.resolve(__dirname, '..', '..', 'fantasy-snapshots', 'season-775', '2026-06-20-manual');
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
    if (inlineValue !== undefined) opts[key] = inlineValue;
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) opts[key] = argv[++i];
    else opts[key] = true;
  }
  return opts;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readJsonIfExists(filePath) {
  return filePath && fs.existsSync(filePath) ? readJson(filePath) : null;
}

function fileSha256(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function assertCompleteFantasySnapshot(fantasyDir, fantasyRows) {
  const manifestPath = path.join(fantasyDir, 'manifest.json');
  const manifest = readJsonIfExists(manifestPath);
  const reasons = [];

  if (!Array.isArray(fantasyRows) || fantasyRows.length === 0) {
    reasons.push('fantasy_full_list_rows_empty');
  }
  if (!manifest) {
    reasons.push('missing_manifest_json');
  } else {
    const validation = manifest.validation || {};
    if (manifest.status !== 'PASS') reasons.push(`manifest_status_${manifest.status || 'missing'}`);
    if (validation.status && validation.status !== 'PASS') reasons.push(`validation_status_${validation.status}`);
    if (Number(validation.fantasyRows || 0) <= 0) reasons.push('manifest_fantasyRows_zero');
    if (Array.isArray(validation.failReasons) && validation.failReasons.length) {
      reasons.push(...validation.failReasons.map(reason => `manifest_fail_${reason}`));
    }
  }

  if (reasons.length) {
    throw new Error(`Incomplete fantasy snapshot: ${fantasyDir}; ${reasons.join('; ')}`);
  }
}

function seasonNumberFromDir(dirPath) {
  const match = String(dirPath || '').replace(/\\/g, '/').match(/season-(\d+)/i);
  return match ? Number(match[1]) : null;
}

function safeNamePart(value, fallback = 'unknown') {
  const text = String(value ?? '').trim();
  return (text || fallback).replace(/[^A-Za-z0-9_.-]+/g, '_');
}

function sourceDayFromSeasonDir(seasonDir) {
  const meta = readJsonIfExists(path.join(seasonDir, 'meta.json'));
  return meta && meta.day != null ? String(meta.day) : null;
}

function num(value, fallback = 0) {
  const n = Number(String(value ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : fallback;
}

function parseRate(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  const text = String(value).trim();
  if (!text) return fallback;
  return num(text.startsWith('.') ? `0${text}` : text, fallback);
}

function numberSequence(text) {
  return (String(text || '').match(/\d+(?:\.\d+)?/g) || []).map(value => Number(value));
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

function inningsToOuts(value) {
  const text = String(value || '').trim();
  if (!text) return 0;
  const match = text.match(/^(\d+)(?:\s+([0-2])\/3)?$/);
  if (!match) return 0;
  return Number(match[1]) * 3 + Number(match[2] || 0);
}

function buildPlayerIndex(players) {
  const byName = new Map();
  const duplicateNames = new Set();
  for (const player of players) {
    if (byName.has(player.name)) duplicateNames.add(player.name);
    byName.set(player.name, player);
  }
  return { byName, duplicateNames: [...duplicateNames].sort() };
}

function batterStats(player) {
  const current = player && player.current_batting || {};
  const summary = player && player.season_summary || {};
  return {
    atBats: num(current.at_bats),
    hits: num(current.hits),
    battingAverage: parseRate(summary.batting_avg, parseRate(current.batting_avg)),
    homeRuns: num(summary.home_runs, num(current.home_runs)),
    rbi: num(summary.rbi, num(current.rbi)),
    steals: num(summary.steals, num(current.steals))
  };
}

function pitcherStats(player) {
  const current = player && player.current_pitching || {};
  const summary = player && player.season_summary || {};
  const outs = inningsToOuts(current.innings_pitched);
  const era = num(summary.era, num(current.era, 99));
  return {
    outs,
    earnedRuns: outs > 0 ? era * outs / 27 : 0,
    era,
    wins: num(summary.wins, num(current.wins)),
    saves: num(summary.saves, num(current.saves)),
    strikeouts: num(summary.strikeouts, num(current.strikeouts))
  };
}

function selectedNamesFromFantasyRow(row, kind) {
  const slots = kind === 'batter' ? BATTER_SLOTS : PITCHER_SLOTS;
  return slots.map(slot => row.picks && row.picks[slot]).filter(Boolean);
}

function selectedPlayersFromDraftVariant(variant, kind) {
  return (variant.lineup || []).filter(player => player.category === kind);
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

function betterThan(a, b, lowerBetter) {
  const epsilon = 1e-9;
  return lowerBetter ? a < b - epsilon : a > b + epsilon;
}

function rankSubmittedRows(rows, lowerBetter) {
  return [...rows].sort((a, b) => {
    if (a.value === b.value) return String(a.account).localeCompare(String(b.account));
    return lowerBetter ? a.value - b.value : b.value - a.value;
  });
}

function evaluateDraft({ config, draftPath, finalPlayers, fantasyRows, byName }) {
  const draft = readJson(draftPath);
  const submitted = fantasyRows.map(row => {
    return {
      account: row.account,
      rank: row.rank,
      value: fantasyValue(row, config.item)
    };
  }).filter(row => row.value != null);
  const ranked = rankSubmittedRows(submitted, config.lowerBetter);
  const firstPlaceValue = ranked[0] ? ranked[0].value : null;
  const top10Cutoff = ranked[9] ? ranked[9].value : null;
  const variants = (draft.lineupVariants || []).map(variant => {
    const selected = selectedPlayersFromDraftVariant(variant, config.kind);
    const players = selected.map(player => byName.get(player.name)).filter(Boolean);
    const value = valueForPlayers(config.item, players);
    const rank = 1 + submitted.filter(row => betterThan(row.value, value, config.lowerBetter)).length;
    return {
      variant: `${config.item} V${variant.variantIndex}`,
      variantIndex: variant.variantIndex,
      value: roundValue(config.item, value),
      rank,
      firstPlaceGap: firstPlaceValue == null
        ? null
        : (config.lowerBetter
          ? Number(Math.max(0, value - firstPlaceValue).toFixed(config.item === 'ERA' ? 5 : 6))
          : Number(Math.max(0, firstPlaceValue - value).toFixed(config.item === 'AVG' ? 6 : 0))),
      shortOfTop10: top10Cutoff == null
        ? null
        : (config.lowerBetter
          ? Number(Math.max(0, value - top10Cutoff).toFixed(config.item === 'ERA' ? 5 : 6))
          : Number(Math.max(0, top10Cutoff - value).toFixed(config.item === 'AVG' ? 6 : 0))),
      top10Cutoff: top10Cutoff == null ? null : roundValue(config.item, top10Cutoff),
      selectedCore: selected.map(player => {
        const finalPlayer = byName.get(player.name);
        return {
          role: player.role,
          team: player.team,
          name: player.name,
          owner: player.owner,
          finalValue: finalPlayer ? roundValue(config.item, valueForPlayers(config.item, [finalPlayer])) : null
        };
      }),
      legality: variant.legality
    };
  });
  return {
    item: config.item,
    mode: config.mode,
    draftPath,
    projectionPath: draft.projection && draft.projection.artifact || null,
    trainingSeasons: draft.projection && draft.projection.trainingSeasons
      ? draft.projection.trainingSeasons.map(row => row.season)
      : [],
    feasible: !!draft.feasible,
    producedVariants: variants.length,
    firstPlaceValue: firstPlaceValue == null ? null : roundValue(config.item, firstPlaceValue),
    firstPlaceVariants: variants.filter(row => row.rank === 1).length,
    bestFirstPlaceGap: variants.length
      ? Math.min(...variants.map(row => row.firstPlaceGap).filter(value => value != null))
      : null,
    top10Cutoff: top10Cutoff == null ? null : roundValue(config.item, top10Cutoff),
    bestRank: Math.min(...variants.map(row => row.rank)),
    top10Variants: variants.filter(row => row.rank <= 10).length,
    variants
  };
}

function runDraft({ config, label, seasonDir, liveDir, maxTrainingSeason, reportsDir, sourceSeason, targetSeason, sourceDay, weightProfile, allowDiagnosticProfile }) {
  const labelPart = safeNamePart(label, 'pass');
  const sourceTag = sourceDay ? `${sourceSeason}_day${safeNamePart(sourceDay)}` : String(sourceSeason || 'unknown');
  const draftPath = path.join(reportsDir, `ore_${targetSeason}_all_items_${labelPart}_${config.item.toLowerCase()}_from_${sourceTag}.json`);
  const projectionPath = path.join(reportsDir, `ore_${targetSeason}_all_items_${labelPart}_${config.item.toLowerCase()}_projection_from_${sourceTag}.json`);
  const args = [
    DRAFT_JS,
    config.mode,
    '--season-dir', seasonDir,
    '--live-dir', liveDir,
    '--no-live-fetch',
    '--max-training-season', String(maxTrainingSeason),
    '--out', draftPath,
    '--projection-out', projectionPath
  ];
  if (weightProfile) {
    args.push('--weight-profile', weightProfile);
  }
  if (allowDiagnosticProfile) {
    args.push('--allow-diagnostic-profile');
  }
  const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`draft ${config.item}/${config.mode} failed:\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  }
  return { draftPath, projectionPath, stdout: result.stdout, stderr: result.stderr };
}

function renderMarkdown(report) {
  const lines = [];
  lines.push(`# ORE ${report.source.targetSeason} All-Item ${report.label} Rerun Review`);
  lines.push('');
  lines.push(`- Status: ${report.status}`);
  lines.push(`- Run count: ${report.runCount}`);
  lines.push(`- Source season: ${report.source.sourceSeason}`);
  lines.push(`- Target season: ${report.source.targetSeason}`);
  lines.push(`- Source dir: ${report.source.seasonDir}`);
  lines.push(`- Live grid: ${report.source.liveDir}`);
  lines.push(`- Max training season: ${report.source.maxTrainingSeason}`);
  if (report.weightProfile && report.weightProfile.path) {
    lines.push(`- Weight profile: ${report.weightProfile.path}`);
    lines.push(`- Weight profile SHA256: ${report.weightProfile.sha256 || ''}`);
  }
  lines.push('');
  lines.push('Only first place is prize-winning; top10 is diagnostic only.');
  lines.push('');
  lines.push('| Item | Mode | First-place variants | Best rank | Gap to first | First value | Top10 variants | Top10 cutoff | Variants |');
  lines.push('|---|---|---:|---:|---:|---:|---:|---:|---|');
  for (const item of report.items) {
    const variantText = item.variants
      .map(row => `V${row.variantIndex}: ${row.value} (#${row.rank}, first gap ${row.firstPlaceGap})`)
      .join('; ');
    lines.push(`| ${item.item} | ${item.mode} | ${item.firstPlaceVariants}/5 | ${item.bestRank} | ${item.bestFirstPlaceGap ?? ''} | ${item.firstPlaceValue ?? ''} | ${item.top10Variants}/5 | ${item.top10Cutoff ?? ''} | ${variantText} |`);
  }
  return lines.join('\n');
}

function main() {
  const args = parseArgs(process.argv);
  const label = args.label || 'pass';
  const seasonDir = path.resolve(args['season-dir'] || DEFAULT_SEASON_DIR);
  const liveDir = path.resolve(args['live-dir'] || DEFAULT_LIVE_DIR);
  const finalSeasonDir = path.resolve(args['final-season-dir'] || DEFAULT_FINAL_SEASON_DIR);
  const fantasyDir = path.resolve(args['fantasy-dir'] || DEFAULT_FANTASY_DIR);
  const reportsDir = path.resolve(args['reports-dir'] || REPORTS_DIR);
  const sourceSeason = Number(args['source-season'] || seasonNumberFromDir(seasonDir) || 774);
  const targetSeason = Number(args['target-season'] || seasonNumberFromDir(finalSeasonDir) || (sourceSeason + 1));
  const sourceDay = String(args['source-day'] || sourceDayFromSeasonDir(seasonDir) || '');
  const maxTrainingSeason = Number(args['max-training-season'] || sourceSeason);
  const weightProfile = args['weight-profile'] ? path.resolve(args['weight-profile']) : null;
  const allowDiagnosticProfile = !!args['allow-diagnostic-profile'];
  const labelPart = safeNamePart(label, 'pass');
  const outPath = path.resolve(args.out || path.join(reportsDir, `ore_${targetSeason}_all_items_${labelPart}_rerun_review.json`));
  const mdPath = path.resolve(args['md-out'] || outPath.replace(/\.json$/i, '.md'));
  fs.mkdirSync(reportsDir, { recursive: true });

  const finalPlayers = readJson(path.join(finalSeasonDir, 'players.json'));
  const fantasyRows = readJson(path.join(fantasyDir, 'fantasy_full_list_rows.json'));
  assertCompleteFantasySnapshot(fantasyDir, fantasyRows);
  const { byName, duplicateNames } = buildPlayerIndex(finalPlayers);
  const items = [];
  const runLogs = [];

  ITEMS.forEach((config, index) => {
    console.log(`[${index + 1}/${ITEMS.length}] ${config.item} (${config.mode})`);
    const run = runDraft({ config, label, seasonDir, liveDir, maxTrainingSeason, reportsDir, sourceSeason, targetSeason, sourceDay, weightProfile, allowDiagnosticProfile });
    runLogs.push({ item: config.item, mode: config.mode, draftPath: run.draftPath, projectionPath: run.projectionPath });
    items.push(evaluateDraft({ config, draftPath: run.draftPath, finalPlayers, fantasyRows, byName }));
  });

  const report = {
    status: 'PASS',
    generatedAt: new Date().toISOString(),
    label,
    runCount: ITEMS.length,
    source: {
      sourceSeason,
      sourceDay: sourceDay || null,
      targetSeason,
      seasonDir,
      liveDir,
      finalSeasonDir,
      fantasyDir,
      maxTrainingSeason,
      trainingLeakGuard: 'max-training-season prevents target season 775 from entering 774->775 retrospective training'
    },
    duplicateFinalPlayerNames: duplicateNames,
    weightProfile: {
      path: weightProfile,
      sha256: fileSha256(weightProfile),
      allowDiagnosticProfile
    },
    runLogs,
    items
  };
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
  fs.writeFileSync(mdPath, renderMarkdown(report), 'utf8');
  console.log(outPath);
  console.log(mdPath);
}

main();
