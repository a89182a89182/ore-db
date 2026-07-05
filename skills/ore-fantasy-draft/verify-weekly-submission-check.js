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

function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function writeText(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, 'utf8');
}

function fileExists(filePath) {
  return !!filePath && fs.existsSync(filePath);
}

function get(obj, dottedPath) {
  return dottedPath.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
}

function label(item, variant) {
  return item && variant != null ? `${item} V${variant}` : '';
}

function unique(items) {
  return [...new Set(items.filter(Boolean))];
}

function scanLeaks(text) {
  const checks = [
    ['windowsPath', /C:[\\/]Users[\\/]/i],
    ['codexPath', /\.codex/i],
    ['openclawPath', /\.openclaw/i],
    ['oreAuth', /ore-auth/i],
    ['password', /password/i],
    ['credential', /credential/i],
    ['token', /token/i],
    ['psCredential', /PSCredential/i],
    ['hiddenAuth', /hidden.*auth|auth.*hidden/i],
    ['localLiveFallback', /local_live_fallback/i],
    ['redactedLiteral', /\[redacted\]/i],
    ['undefined', /undefined/i],
    ['replacementChar', /\uFFFD/]
  ];
  return checks.filter(([, re]) => re.test(text)).map(([name]) => name);
}

function findLatestSummary({ reportsDir, dateLabel, targetSeason }) {
  const suffix = `_weekly_goal_monitor_summary_${dateLabel}.json`;
  const files = fs.readdirSync(reportsDir)
    .filter(name => name.endsWith(suffix))
    .filter(name => !targetSeason || name.startsWith(`ore_${targetSeason}_`))
    .map(name => path.join(reportsDir, name))
    .filter(filePath => fs.statSync(filePath).isFile())
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files[0] || null;
}

function addPublicRequirements(validation, slip) {
  const requirements = [
    'Final submission checklist',
    'Freshness guard',
    'Selected submission lineup',
    'Weekly submission card',
    'Weekly item risk gate',
    'Backup safety',
    'Variant-level safer alternate',
    'Safer alternate',
    'Fantasy submission readiness',
    'League ranking submission card',
    'League ranking confidence and swap watch',
    'Fantasy public-page access',
    'Fantasy hit-rate and miss review',
    'HR 5 versions',
    'SB 5 versions',
    'K 5 versions',
    'ERA 5 versions',
    'fresh_web_scrape',
    'live_fetch',
    validation.sourceSnapshotScrapedAt,
    get(slip, 'weekly.submit.label'),
    get(slip, 'weekly.backup.label'),
    get(slip, 'weekly.variantAlternate.label'),
    get(slip, 'league.champion')
  ];
  for (const league of get(slip, 'league.rankings') || []) {
    requirements.push(league.league);
    for (const row of league.order || []) requirements.push(row.team);
  }
  if (String(get(slip, 'readiness.status') || '').startsWith('manual_submit_required')) {
    requirements.push('Manual browser submission required');
  }
  return unique(requirements);
}

async function fetchPublic(publicUrl, validation, slip, retries, delayMs) {
  if (!publicUrl) {
    return {
      checked: false,
      httpStatus: null,
      missing: ['publicUrl'],
      leakHits: [],
      selectedRows: 0,
      copyBlocks: 0,
      failReasons: ['publicUrl is missing']
    };
  }
  let last = null;
  const attempts = Math.max(1, Number(retries) || 1);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const res = await fetch(`${publicUrl}${publicUrl.includes('?') ? '&' : '?'}submission_check=${Date.now()}-${attempt}`, { cache: 'no-store' });
      const html = await res.text();
      const requirements = addPublicRequirements(validation, slip);
      const missing = requirements.filter(item => !html.includes(item));
      const leakHits = scanLeaks(html);
      const selectedRows = (html.match(/selected-lineup-row/g) || []).length;
      const copyBlocks = (html.match(/selected-lineup-copy/g) || []).length;
      const failReasons = [];
      if (res.status !== 200) failReasons.push(`public page http status ${res.status}`);
      if (missing.length) failReasons.push(`public page missing required text: ${missing.join(', ')}`);
      if (leakHits.length) failReasons.push(`public page safety scan failed: ${leakHits.join(', ')}`);
      if (selectedRows < 36) failReasons.push(`public selected-lineup-row count ${selectedRows}, expected at least 36`);
      if (copyBlocks < 2) failReasons.push(`public selected-lineup-copy count ${copyBlocks}, expected at least 2`);
      last = { checked: true, attempt, maxAttempts: attempts, httpStatus: res.status, missing, leakHits, selectedRows, copyBlocks, htmlLength: html.length, failReasons };
    } catch (error) {
      last = {
        checked: true,
        attempt,
        maxAttempts: attempts,
        httpStatus: null,
        missing: [],
        leakHits: [],
        selectedRows: 0,
        copyBlocks: 0,
        htmlLength: 0,
        failReasons: [`public page fetch failed: ${error.message || String(error)}`]
      };
    }
    if (!last.failReasons.length) return last;
    if (attempt < attempts && delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  return last;
}

function requireEqual(failReasons, name, actual, expected) {
  if (actual !== expected) failReasons.push(`${name} mismatch: actual=${actual ?? 'null'} expected=${expected ?? 'null'}`);
}

function requireTrue(failReasons, name, value) {
  if (value !== true) failReasons.push(`${name} is not true`);
}

function requireAtLeast(failReasons, name, value, min) {
  if (Number(value || 0) < min) failReasons.push(`${name} ${value ?? 'null'}, expected at least ${min}`);
}

function loadArtifacts(summary, sourceCurrentOverride) {
  const artifacts = summary.artifacts || {};
  return {
    validationPath: artifacts.validation,
    slipMdPath: artifacts.submissionSlip,
    slipJsonPath: artifacts.submissionSlipJson,
    preSubmitPath: artifacts.preSubmitVerification,
    sourceCurrentPath: sourceCurrentOverride || artifacts.sourceCurrentVerification,
    htmlPath: artifacts.htmlReport,
    summaryMdPath: artifacts.summaryMarkdown
  };
}

function verifyLoaded({ summary, validation, slip, slipMarkdown, preSubmit, sourceCurrent, publicPage, artifactPaths, dateLabel }) {
  const failReasons = [];
  const warnings = [];

  requireEqual(failReasons, 'summary.dateLabel', summary.dateLabel, dateLabel);
  requireEqual(failReasons, 'validation.status', validation.status, 'PASS');
  requireTrue(failReasons, 'validation.auditConsistencyOk', validation.auditConsistencyOk === true);
  requireEqual(failReasons, 'validation.freshnessGuardSourceFreshnessStatus', validation.freshnessGuardSourceFreshnessStatus, 'fresh_web_scrape');
  requireTrue(failReasons, 'validation.freshnessGuardLiveFetchAll', validation.freshnessGuardLiveFetchAll === true);
  requireEqual(failReasons, 'validation.variantSections', validation.variantSections, 20);
  requireEqual(failReasons, 'validation.lineupRows', validation.lineupRows, 360);

  for (const field of [
    'finalSubmissionChecklistIncluded',
    'freshnessGuardIncluded',
    'selectedSubmissionLineupIncluded',
    'submissionCardIncluded',
    'weeklyItemRiskGateIncluded',
    'weeklyRiskBackupSafetyIncluded',
    'weeklyRiskVariantBackupSafetyIncluded',
    'submissionReadinessAuditIncluded',
    'leagueRankingCardIncluded',
    'leagueConfidenceAuditIncluded',
    'leagueConfidenceSectionIncluded',
    'fantasyPublicAuditIncluded',
    'hitRateAuditIncluded',
    'submissionReadinessDoNotAutoSubmit'
  ]) {
    requireTrue(failReasons, `validation.${field}`, validation[field] === true);
  }

  requireEqual(failReasons, 'validation.selectedSubmissionLineupPrimaryRows', validation.selectedSubmissionLineupPrimaryRows, 18);
  requireEqual(failReasons, 'validation.selectedSubmissionLineupBackupRows', validation.selectedSubmissionLineupBackupRows, 18);
  requireEqual(failReasons, 'validation.selectedSubmissionPrimaryCopyRows', validation.selectedSubmissionPrimaryCopyRows, 18);
  requireEqual(failReasons, 'validation.selectedSubmissionBackupCopyRows', validation.selectedSubmissionBackupCopyRows, 18);
  requireAtLeast(failReasons, 'validation.selectedSubmissionCopyBlockCount', validation.selectedSubmissionCopyBlockCount, 2);

  requireEqual(failReasons, 'slip.status', slip.status, 'PASS');
  if ((slip.failReasons || []).length) failReasons.push(`slip.failReasons is not empty: ${slip.failReasons.join('; ')}`);
  requireEqual(failReasons, 'slip.validation.sha256', get(slip, 'validation.sha256'), validation.sha256);
  requireEqual(failReasons, 'slip.source.scrapedAt', get(slip, 'source.scrapedAt'), validation.sourceSnapshotScrapedAt);
  requireEqual(failReasons, 'slip.source.freshnessStatus', get(slip, 'source.freshnessStatus'), validation.freshnessGuardSourceFreshnessStatus);
  requireEqual(failReasons, 'slip.weekly.submit.label', get(slip, 'weekly.submit.label'), label(validation.submissionReadinessItem, validation.submissionReadinessVariant));
  requireEqual(failReasons, 'slip.weekly.backup.label', get(slip, 'weekly.backup.label'), label(validation.selectedSubmissionLineupBackupItem, validation.selectedSubmissionLineupBackupVariant));
  requireEqual(
    failReasons,
    'slip.weekly.variantAlternate.label',
    get(slip, 'weekly.variantAlternate.label') || null,
    label(validation.weeklyRiskVariantSafeBackupItem, validation.weeklyRiskVariantSafeBackupVariant) || null
  );
  requireTrue(failReasons, 'slip.readiness.doNotAutoSubmit', get(slip, 'readiness.doNotAutoSubmit') === true);

  const leagueRankings = get(slip, 'league.rankings') || [];
  if (leagueRankings.length !== 2) failReasons.push(`slip league rankings count ${leagueRankings.length}, expected 2`);
  for (const league of leagueRankings) {
    if ((league.order || []).length !== 6) failReasons.push(`slip league ${league.league || '-'} order count ${(league.order || []).length}, expected 6`);
  }

  requireEqual(failReasons, 'preSubmit.status', preSubmit.status, 'PASS');
  if ((preSubmit.failReasons || []).length) failReasons.push(`preSubmit.failReasons is not empty: ${preSubmit.failReasons.join('; ')}`);
  requireEqual(failReasons, 'preSubmit.validation.sha256', get(preSubmit, 'validation.sha256'), validation.sha256);
  requireEqual(failReasons, 'preSubmit.validation.sourceScrapedAt', get(preSubmit, 'validation.sourceScrapedAt'), validation.sourceSnapshotScrapedAt);
  requireEqual(failReasons, 'preSubmit.publicPage.httpStatus', get(preSubmit, 'publicPage.httpStatus'), 200);
  requireAtLeast(failReasons, 'preSubmit.publicPage.selectedRows', get(preSubmit, 'publicPage.selectedRows'), 36);
  requireAtLeast(failReasons, 'preSubmit.publicPage.copyBlocks', get(preSubmit, 'publicPage.copyBlocks'), 2);
  if ((get(preSubmit, 'publicPage.missing') || []).length) failReasons.push(`preSubmit public missing text: ${get(preSubmit, 'publicPage.missing').join(', ')}`);
  if ((get(preSubmit, 'publicPage.leakHits') || []).length) failReasons.push(`preSubmit public leak hits: ${get(preSubmit, 'publicPage.leakHits').join(', ')}`);

  requireEqual(failReasons, 'sourceCurrent.status', sourceCurrent.status, 'PASS');
  if ((sourceCurrent.failReasons || []).length) failReasons.push(`sourceCurrent.failReasons is not empty: ${sourceCurrent.failReasons.join('; ')}`);
  requireEqual(failReasons, 'sourceCurrent.expectedHash', sourceCurrent.expectedHash, sourceCurrent.actualHash);
  requireEqual(failReasons, 'sourceCurrent.actualSource.season', get(sourceCurrent, 'actualSource.season'), String(validation.sourceSnapshotSeason));
  requireEqual(failReasons, 'sourceCurrent.actualSource.day', get(sourceCurrent, 'actualSource.day'), String(validation.sourceSnapshotDay));
  requireEqual(failReasons, 'sourceCurrent.actualSource.playerCount', get(sourceCurrent, 'actualSource.playerCount'), 216);
  requireEqual(failReasons, 'sourceCurrent.actualSource.teamCount', get(sourceCurrent, 'actualSource.teamCount'), 12);
  requireEqual(failReasons, 'sourceCurrent.diff.changedPlayerCount', get(sourceCurrent, 'diff.changedPlayerCount'), 0);
  requireEqual(failReasons, 'sourceCurrent.diff.changedTeamCount', get(sourceCurrent, 'diff.changedTeamCount'), 0);
  requireAtLeast(failReasons, 'sourceCurrent.liveFetch.freshSakus', (get(sourceCurrent, 'liveFetch.freshSakus') || []).length, 12);
  if ((get(sourceCurrent, 'liveFetch.badSources') || []).length) failReasons.push(`sourceCurrent bad sources: ${get(sourceCurrent, 'liveFetch.badSources').join(', ')}`);

  if (publicPage.failReasons.length) failReasons.push(...publicPage.failReasons);

  const slipLeakHits = scanLeaks(`${JSON.stringify(slip)}\n${slipMarkdown}`);
  if (slipLeakHits.length) failReasons.push(`slip safety scan failed: ${slipLeakHits.join(', ')}`);

  for (const [name, filePath] of Object.entries(artifactPaths)) {
    if (filePath && !fileExists(filePath)) failReasons.push(`artifact missing: ${name}`);
  }

  if (get(slip, 'weekly.backup.riskLevel') === 'red') {
    warnings.push('Backup is high-risk; keep it as caution-only unless a fresh rerun improves it.');
  }
  if (get(slip, 'readiness.formAccessStatus') === 'blocked_auth_required_after_login') {
    warnings.push('Fantasy form access remains blocked in automation; manual browser entry is required.');
  }
  return { failReasons, warnings };
}

function fmtPct(value) {
  return value == null || !Number.isFinite(Number(value)) ? '-' : `${(Number(value) * 100).toFixed(1)}%`;
}

function leagueLine(league) {
  return `${league.league}: ${(league.order || []).map(row => `${row.rank}. ${row.team}`).join(' > ')}`;
}

function buildReminder({ status, failReasons, warnings, summary, validation, slip, preSubmit, sourceCurrent, publicPage }) {
  const alt = get(slip, 'weekly.variantAlternate');
  const lines = [
    `# ORE ${slip.targetSeason || validation.targetSeason} 週提交前檢查`,
    '',
    `- 狀態: ${status}`,
    `- 公開報告: ${slip.publicUrl || preSubmit.publicUrl || get(summary, 'publish.publicUrl') || '未發布'}`,
    `- 本週提交: ${get(slip, 'weekly.submit.label')}`,
    `- 備案: ${get(slip, 'weekly.backup.label')}；${get(slip, 'weekly.backup.action') || '-'}；安全性 ${get(slip, 'weekly.backup.safetyStatus') || '-'}`,
    `- 觀察替代: ${alt && alt.label ? `${alt.label}；${alt.status}; clear miss ${fmtPct(alt.clearMissRate)}; useful top20 ${alt.usefulTop20}/9；watch-only` : '無'}`,
    `- 手動狀態: ${get(slip, 'readiness.status')}；form access ${get(slip, 'readiness.formAccessStatus')}；doNotAutoSubmit=${get(slip, 'readiness.doNotAutoSubmit')}`,
    `- 冠軍: ${get(slip, 'league.champion')}；信心 ${get(slip, 'league.championConfidence')}；exact ranks ${get(slip, 'league.exactMatches')}/${get(slip, 'league.teamCount')}；swap-watch ${get(slip, 'league.swapWatchCount')}`,
    ...((get(slip, 'league.rankings') || []).map(leagueLine).map(line => `- ${line}`)),
    `- 來源: season ${get(slip, 'source.season')} day ${get(slip, 'source.day')}；scrapedAt ${get(slip, 'source.scrapedAt')}；${get(slip, 'source.freshnessStatus')}`,
    `- 驗證: validation PASS sha256 ${validation.sha256}; pre-submit ${preSubmit.status}; source-current ${sourceCurrent.status}; public HTTP ${publicPage.httpStatus}`,
    `- 重跑規則: ${get(slip, 'source.rerunRule')}`,
  ];
  if (warnings.length) {
    lines.push('', '## 注意', ...warnings.map(item => `- ${item}`));
  }
  if (failReasons.length) {
    lines.push('', '## 未通過原因', ...failReasons.map(item => `- ${item}`));
  }
  return `${lines.join('\n')}\n`;
}

async function main() {
  const reportsDir = arg('reports-dir', 'C:\\Users\\YOSHI\\Documents\\ore-db\\reports');
  const dateLabel = arg('date-label', new Date().toISOString().slice(0, 10));
  const targetSeason = arg('target-season');
  const summaryPath = arg('summary') || findLatestSummary({ reportsDir, dateLabel, targetSeason });
  const outPath = arg('out') || path.join(reportsDir, `ore_weekly_submission_check_${dateLabel}.json`);
  const mdOutPath = arg('md-out') || outPath.replace(/\.json$/i, '.md');
  const sourceCurrentOverride = arg('source-current-override');
  const publicRetries = Number(arg('public-retries', '3'));
  const publicRetryDelayMs = Number(arg('public-retry-delay-ms', '3000'));
  const failReasons = [];

  if (!summaryPath || !fileExists(summaryPath)) {
    const payload = {
      status: 'FAIL',
      readyForManualSubmission: false,
      shouldRerun: true,
      failReasons: [`summary missing for date ${dateLabel}`],
      generatedAt: new Date().toISOString()
    };
    writeText(outPath, `${JSON.stringify(payload, null, 2)}\n`);
    writeText(mdOutPath, `# ORE 週提交前檢查\n\n- 狀態: FAIL\n- 未通過原因: summary missing for date ${dateLabel}\n- 建議: rerun full weekly monitor\n`);
    console.log(JSON.stringify(payload, null, 2));
    process.exitCode = 1;
    return;
  }

  const summary = readJson(summaryPath);
  const artifactPaths = loadArtifacts(summary, sourceCurrentOverride);
  for (const [name, filePath] of Object.entries(artifactPaths)) {
    if (filePath && !fileExists(filePath)) failReasons.push(`artifact missing: ${name} (${filePath})`);
  }
  if (failReasons.length) {
    const payload = {
      status: 'FAIL',
      readyForManualSubmission: false,
      shouldRerun: true,
      failReasons,
      generatedAt: new Date().toISOString(),
      summaryPath
    };
    writeText(outPath, `${JSON.stringify(payload, null, 2)}\n`);
    writeText(mdOutPath, `# ORE 週提交前檢查\n\n- 狀態: FAIL\n${failReasons.map(item => `- ${item}`).join('\n')}\n`);
    console.log(JSON.stringify(payload, null, 2));
    process.exitCode = 1;
    return;
  }

  const validation = readJson(artifactPaths.validationPath);
  const slip = readJson(artifactPaths.slipJsonPath);
  const slipMarkdown = readText(artifactPaths.slipMdPath);
  const preSubmit = readJson(artifactPaths.preSubmitPath);
  const sourceCurrent = readJson(artifactPaths.sourceCurrentPath);
  const publicUrl = slip.publicUrl || preSubmit.publicUrl || get(summary, 'publish.publicUrl') || '';
  const publicPage = await fetchPublic(publicUrl, validation, slip, publicRetries, publicRetryDelayMs);
  const checked = verifyLoaded({
    summary,
    validation,
    slip,
    slipMarkdown,
    preSubmit,
    sourceCurrent,
    publicPage,
    artifactPaths,
    dateLabel
  });
  failReasons.push(...checked.failReasons);
  const status = failReasons.length ? 'FAIL' : 'PASS';
  const reminderMarkdown = buildReminder({
    status,
    failReasons,
    warnings: checked.warnings,
    summary,
    validation,
    slip,
    preSubmit,
    sourceCurrent,
    publicPage
  });
  const reminderLeakHits = scanLeaks(reminderMarkdown);
  if (reminderLeakHits.length) {
    failReasons.push(`reminder safety scan failed: ${reminderLeakHits.join(', ')}`);
  }
  const finalStatus = failReasons.length ? 'FAIL' : 'PASS';
  const payload = {
    status: finalStatus,
    readyForManualSubmission: finalStatus === 'PASS',
    shouldRerun: finalStatus !== 'PASS',
    failReasons,
    warnings: checked.warnings,
    generatedAt: new Date().toISOString(),
    dateLabel,
    summaryPath,
    artifactPaths,
    publicUrl,
    submission: {
      submit: get(slip, 'weekly.submit.label'),
      backup: get(slip, 'weekly.backup.label'),
      backupRiskLevel: get(slip, 'weekly.backup.riskLevel'),
      backupSafetyStatus: get(slip, 'weekly.backup.safetyStatus'),
      variantAlternate: get(slip, 'weekly.variantAlternate.label'),
      variantAlternateStatus: get(slip, 'weekly.variantAlternate.status'),
      manualStatus: get(slip, 'readiness.status'),
      formAccessStatus: get(slip, 'readiness.formAccessStatus'),
      doNotAutoSubmit: get(slip, 'readiness.doNotAutoSubmit')
    },
    league: {
      champion: get(slip, 'league.champion'),
      championConfidence: get(slip, 'league.championConfidence'),
      exactMatches: get(slip, 'league.exactMatches'),
      teamCount: get(slip, 'league.teamCount'),
      swapWatchCount: get(slip, 'league.swapWatchCount'),
      rankings: get(slip, 'league.rankings')
    },
    source: {
      season: get(slip, 'source.season'),
      day: get(slip, 'source.day'),
      scrapedAt: get(slip, 'source.scrapedAt'),
      freshnessStatus: get(slip, 'source.freshnessStatus'),
      rerunRule: get(slip, 'source.rerunRule')
    },
    gates: {
      validationStatus: validation.status,
      validationSha256: validation.sha256,
      preSubmitStatus: preSubmit.status,
      sourceCurrentStatus: sourceCurrent.status,
      sourceExpectedHash: sourceCurrent.expectedHash,
      sourceActualHash: sourceCurrent.actualHash,
      changedPlayerCount: get(sourceCurrent, 'diff.changedPlayerCount'),
      changedTeamCount: get(sourceCurrent, 'diff.changedTeamCount'),
      publicHttpStatus: publicPage.httpStatus,
      publicSelectedRows: publicPage.selectedRows,
      publicCopyBlocks: publicPage.copyBlocks
    }
  };
  writeText(outPath, `${JSON.stringify(payload, null, 2)}\n`);
  writeText(mdOutPath, reminderMarkdown);
  console.log(JSON.stringify({
    status: finalStatus,
    readyForManualSubmission: payload.readyForManualSubmission,
    shouldRerun: payload.shouldRerun,
    outPath,
    mdOutPath,
    submit: payload.submission.submit,
    backup: payload.submission.backup,
    champion: payload.league.champion,
    failReasons
  }, null, 2));
  if (failReasons.length) process.exitCode = 1;
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
});
