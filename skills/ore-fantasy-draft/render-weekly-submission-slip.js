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

function fmt(value, digits = 1) {
  return value == null || !Number.isFinite(Number(value)) ? '-' : Number(value).toFixed(digits);
}

function compact(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function versionLabel(item, variant) {
  if (!item || variant == null) return '';
  return `${item} V${variant}`;
}

function leagueOrders(leagueAudit) {
  return (leagueAudit.leagues || []).map(league => {
    const rows = (league.rows || [])
      .slice()
      .sort((a, b) => Number(a.predictedRank || 0) - Number(b.predictedRank || 0))
      .map(row => ({
        rank: Number(row.predictedRank || 0),
        team: row.team || '',
        currentRank: row.currentRank == null ? null : Number(row.currentRank),
        rankDelta: row.rankDelta == null ? null : Number(row.rankDelta)
      }));
    return {
      league: league.league || '',
      predictedWinner: league.predictedWinner || '',
      exactMatches: league.exactMatches == null ? null : Number(league.exactMatches),
      teamCount: league.teamCount == null ? null : Number(league.teamCount),
      order: rows
    };
  });
}

function markdownListRankings(leagues) {
  return leagues.flatMap(league => {
    const order = league.order
      .map(row => `${row.rank}. ${row.team}`)
      .join(' > ');
    return [`- ${league.league}: ${order}`];
  });
}

function buildSlip({ weeklyAudit, readinessAudit, leagueAudit, leagueConfidenceAudit, validation, publicUrl }) {
  const submission = readinessAudit.submission || {};
  const leagueOverall = leagueAudit.overall || {};
  const confidenceOverall = leagueConfidenceAudit.overall || {};
  const confidenceSummary = leagueConfidenceAudit.summary || {};
  const leagues = leagueOrders(leagueAudit);
  const variantAlternate = submission.variantSafeBackupItem ? {
    item: submission.variantSafeBackupItem,
    variant: submission.variantSafeBackupVariantIndex,
    label: versionLabel(submission.variantSafeBackupItem, submission.variantSafeBackupVariantIndex),
    status: submission.variantSafeBackupStatus || null,
    clearMissRate: submission.variantSafeBackupClearMissRate == null ? null : Number(submission.variantSafeBackupClearMissRate),
    usefulTop20: submission.variantSafeBackupUsefulTop20 == null ? null : Number(submission.variantSafeBackupUsefulTop20),
    note: 'watch/recheck only'
  } : null;
  const source = weeklyAudit.source || {};
  const slip = {
    generatedAt: new Date().toISOString(),
    targetSeason: weeklyAudit.targetSeason || validation.targetSeason || null,
    source: {
      season: source.season == null ? null : String(source.season),
      day: source.day == null ? null : String(source.day),
      scrapedAt: source.scrapedAt || validation.sourceSnapshotScrapedAt || null,
      freshnessStatus: validation.sourceFreshnessStatus || validation.freshnessGuardSourceFreshnessStatus || null,
      rerunRule: validation.freshnessGuardRerunRule || 'rerun_if_source_season_day_or_scrapedAt_changes'
    },
    weekly: {
      submit: {
        item: submission.item || null,
        variant: submission.variantIndex ?? null,
        label: versionLabel(submission.item, submission.variantIndex),
        action: submission.action || null,
        riskLevel: submission.primaryRiskLevel || null,
        riskLabel: submission.primaryRiskLabel || null,
        manualActionRequired: submission.manualActionRequired === true,
        manualActionReason: submission.manualActionReason || null
      },
      backup: {
        item: submission.backupItem || null,
        variant: submission.backupVariantIndex ?? null,
        label: versionLabel(submission.backupItem, submission.backupVariantIndex),
        action: submission.backupAction || null,
        riskLevel: submission.backupRiskLevel || null,
        safetyStatus: submission.backupSafetyStatus || null
      },
      variantAlternate
    },
    readiness: {
      status: readinessAudit.status || null,
      formAccessStatus: readinessAudit.formAccessStatus || null,
      doNotAutoSubmit: readinessAudit.doNotAutoSubmit === true
    },
    league: {
      champion: leagueOverall.projectedChampion || confidenceOverall.champion || null,
      confidenceStatus: leagueConfidenceAudit.status || null,
      championConfidence: confidenceOverall.championConfidence || null,
      decision: confidenceOverall.decision || null,
      exactMatches: leagueOverall.exactMatches == null ? null : Number(leagueOverall.exactMatches),
      teamCount: leagueOverall.teamCount == null ? null : Number(leagueOverall.teamCount),
      meanAbsRankError: leagueOverall.meanAbsRankError == null ? null : Number(leagueOverall.meanAbsRankError),
      holdProjectionCount: confidenceSummary.holdProjectionCount == null ? null : Number(confidenceSummary.holdProjectionCount),
      swapWatchCount: confidenceSummary.swapWatchCount == null ? null : Number(confidenceSummary.swapWatchCount),
      rankings: leagues
    },
    validation: {
      status: validation.status || null,
      auditConsistencyOk: validation.auditConsistencyOk === true,
      sha256: validation.sha256 || null,
      selectedPrimaryRows: validation.selectedSubmissionLineupPrimaryRows ?? null,
      selectedBackupRows: validation.selectedSubmissionLineupBackupRows ?? null,
      copyBlockCount: validation.selectedSubmissionCopyBlockCount ?? null,
      variantBackupSafetyIncluded: validation.weeklyRiskVariantBackupSafetyIncluded === true
    },
    publicUrl: publicUrl || null
  };

  const failReasons = [];
  if (slip.validation.status !== 'PASS') failReasons.push(`validation status is ${slip.validation.status}`);
  if (slip.validation.auditConsistencyOk !== true) failReasons.push('audit consistency is not ok');
  if (!slip.weekly.submit.label) failReasons.push('weekly submit label is missing');
  if (!slip.weekly.backup.label) failReasons.push('weekly backup label is missing');
  if (!slip.league.champion) failReasons.push('league champion is missing');
  if (!slip.league.rankings.length) failReasons.push('league rankings are missing');
  if (slip.validation.selectedPrimaryRows !== 18) failReasons.push(`primary rows ${slip.validation.selectedPrimaryRows}, expected 18`);
  if (slip.validation.selectedBackupRows !== 18) failReasons.push(`backup rows ${slip.validation.selectedBackupRows}, expected 18`);
  if (Number(slip.validation.copyBlockCount || 0) < 2) failReasons.push(`copy blocks ${slip.validation.copyBlockCount}, expected at least 2`);
  if (slip.validation.variantBackupSafetyIncluded !== true) failReasons.push('variant backup safety was not included');
  if (slip.weekly.submit.manualActionRequired === true) failReasons.push(`primary weekly item requires manual recheck: ${slip.weekly.submit.manualActionReason || 'unknown'}`);

  return { slip, failReasons };
}

function renderMarkdown(slip) {
  const alt = slip.weekly.variantAlternate;
  const altText = alt
    ? `${alt.label} (clear miss ${fmt(Number(alt.clearMissRate || 0) * 100, 1)}%, useful top20 ${alt.usefulTop20}/9; ${alt.note})`
    : 'none';
  const lines = [
    `# ORE ${slip.targetSeason} Submission Slip`,
    '',
    `- Source: season ${slip.source.season} day ${slip.source.day}; scraped at ${slip.source.scrapedAt}; freshness ${slip.source.freshnessStatus}`,
    `- Rerun rule: ${slip.source.rerunRule}`,
    `- Public report: ${slip.publicUrl || 'not published'}`,
    '',
    '## Weekly Item',
    '',
    `- Submit: ${slip.weekly.submit.label}; action ${slip.weekly.submit.action || '-'}; risk ${slip.weekly.submit.riskLabel || '-'}`,
    `- Backup: ${slip.weekly.backup.label}; action ${slip.weekly.backup.action || '-'}; safety ${slip.weekly.backup.safetyStatus || '-'}`,
    `- Safer alternate: ${altText}`,
    `- Manual status: ${slip.readiness.status}; form access ${slip.readiness.formAccessStatus}; doNotAutoSubmit=${slip.readiness.doNotAutoSubmit}`,
    '',
    '## League Ranking',
    '',
    `- Champion: ${slip.league.champion}`,
    `- Confidence: ${slip.league.championConfidence}; decision ${slip.league.decision}; exact ranks ${slip.league.exactMatches}/${slip.league.teamCount}; mean error ${fmt(slip.league.meanAbsRankError, 3)}`,
    `- Hold projection: ${slip.league.holdProjectionCount}; swap watch: ${slip.league.swapWatchCount}`,
    ...markdownListRankings(slip.league.rankings),
    '',
    '## Validation',
    '',
    `- Status: ${slip.validation.status}; auditConsistencyOk=${slip.validation.auditConsistencyOk}; sha256=${slip.validation.sha256}`,
    `- Selected lineups: primary rows ${slip.validation.selectedPrimaryRows}; backup rows ${slip.validation.selectedBackupRows}; copy blocks ${slip.validation.copyBlockCount}`,
    `- Variant backup safety included: ${slip.validation.variantBackupSafetyIncluded}`
  ];
  return `${lines.map(compact).join('\n')}\n`;
}

function safetyScan(markdown, jsonText) {
  const combined = `${markdown}\n${jsonText}`;
  const forbidden = [
    'C:\\Users\\',
    '.codex',
    '.openclaw',
    'ore-auth',
    'password',
    'credential',
    'token',
    '[redacted]',
    'local_live_fallback',
    'undefined',
    'None',
    '\uFFFD'
  ];
  return forbidden.filter(item => combined.includes(item));
}

function main() {
  const weeklyPath = arg('weekly-items-audit');
  const readinessPath = arg('submission-readiness-audit');
  const leaguePath = arg('league-audit');
  const confidencePath = arg('league-confidence-audit');
  const validationPath = arg('validation');
  const outPath = arg('out');
  const jsonOutPath = arg('json-out');
  const publicUrl = arg('public-url', null);
  if (!weeklyPath) throw new Error('Missing --weekly-items-audit');
  if (!readinessPath) throw new Error('Missing --submission-readiness-audit');
  if (!leaguePath) throw new Error('Missing --league-audit');
  if (!confidencePath) throw new Error('Missing --league-confidence-audit');
  if (!validationPath) throw new Error('Missing --validation');
  if (!outPath) throw new Error('Missing --out');
  if (!jsonOutPath) throw new Error('Missing --json-out');

  const weeklyAudit = readJson(weeklyPath);
  const readinessAudit = readJson(readinessPath);
  const leagueAudit = readJson(leaguePath);
  const leagueConfidenceAudit = readJson(confidencePath);
  const validation = readJson(validationPath);
  const { slip, failReasons } = buildSlip({ weeklyAudit, readinessAudit, leagueAudit, leagueConfidenceAudit, validation, publicUrl });
  const jsonText = JSON.stringify({ status: failReasons.length ? 'FAIL' : 'PASS', failReasons, ...slip }, null, 2);
  const markdown = renderMarkdown(slip);
  const leaks = safetyScan(markdown, jsonText);
  if (leaks.length) failReasons.push(`slip safety scan failed: ${leaks.join(', ')}`);
  const finalJsonText = JSON.stringify({ status: failReasons.length ? 'FAIL' : 'PASS', failReasons, ...slip }, null, 2);

  writeFile(outPath, markdown);
  writeFile(jsonOutPath, finalJsonText);
  const status = failReasons.length ? 'FAIL' : 'PASS';
  console.log(JSON.stringify({
    status,
    outPath,
    jsonOutPath,
    submit: slip.weekly.submit.label,
    backup: slip.weekly.backup.label,
    variantAlternate: slip.weekly.variantAlternate ? slip.weekly.variantAlternate.label : null,
    champion: slip.league.champion,
    failReasons
  }, null, 2));
  if (failReasons.length) process.exitCode = 1;
}

main();
