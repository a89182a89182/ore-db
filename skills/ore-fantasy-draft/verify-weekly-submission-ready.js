#!/usr/bin/env node

const fs = require('fs');

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

function writeJson(filePath, payload) {
  fs.mkdirSync(require('path').dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function label(item, variant) {
  return item && variant != null ? `${item} V${variant}` : '';
}

function get(obj, path) {
  return path.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
}

function scanLeaks(text) {
  const checks = [
    ['windowsPath', new RegExp('C:[\\\\/]Users[\\\\/]', 'i')],
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
    ['noneLiteral', /\bNone\b/],
    ['replacementChar', /\uFFFD/]
  ];
  return checks.filter(([, re]) => re.test(text)).map(([name]) => name);
}

function requireEqual(failReasons, name, actual, expected) {
  if (actual !== expected) {
    failReasons.push(`${name} mismatch: actual=${actual ?? 'null'} expected=${expected ?? 'null'}`);
  }
}

function requireTruthy(failReasons, name, value) {
  if (!value) failReasons.push(`${name} is not true`);
}

function addPublicRequirements(validation, slip) {
  const requirements = [
    'Final submission checklist',
    'Freshness guard',
    'Selected submission lineup',
    'Weekly submission card',
    'Weekly item risk gate',
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
  ].filter(Boolean);

  for (const league of get(slip, 'league.rankings') || []) {
    if (league.league) requirements.push(league.league);
    for (const row of league.order || []) {
      if (row.team) requirements.push(row.team);
    }
  }

  if (String(get(slip, 'readiness.status') || '').startsWith('manual_submit_required')) {
    requirements.push('Manual browser submission required');
  }

  return [...new Set(requirements)];
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function verifyLocal(validation, slip, slipMarkdown) {
  const failReasons = [];
  requireEqual(failReasons, 'validation.status', validation.status, 'PASS');
  requireTruthy(failReasons, 'validation.auditConsistencyOk', validation.auditConsistencyOk === true);
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
  requireEqual(failReasons, 'slip.league.champion', get(slip, 'league.champion'), validation.leagueRankingCardChampion);

  requireTruthy(failReasons, 'validation.freshnessGuardSourceFreshnessStatus', validation.freshnessGuardSourceFreshnessStatus === 'fresh_web_scrape');
  requireTruthy(failReasons, 'validation.freshnessGuardLiveFetchAll', validation.freshnessGuardLiveFetchAll === true);
  requireTruthy(failReasons, 'validation.weeklyRiskVariantBackupSafetyIncluded', validation.weeklyRiskVariantBackupSafetyIncluded === true);
  requireTruthy(failReasons, 'validation.submissionReadinessDoNotAutoSubmit', validation.submissionReadinessDoNotAutoSubmit === true);
  requireEqual(failReasons, 'validation.selectedSubmissionLineupPrimaryRows', validation.selectedSubmissionLineupPrimaryRows, 18);
  requireEqual(failReasons, 'validation.selectedSubmissionLineupBackupRows', validation.selectedSubmissionLineupBackupRows, 18);
  if (Number(validation.selectedSubmissionCopyBlockCount || 0) < 2) {
    failReasons.push(`validation.selectedSubmissionCopyBlockCount too low: ${validation.selectedSubmissionCopyBlockCount}`);
  }

  const rankings = get(slip, 'league.rankings') || [];
  if (rankings.length < 2) failReasons.push(`slip league rankings too short: ${rankings.length}`);
  for (const league of rankings) {
    if ((league.order || []).length !== 6) {
      failReasons.push(`slip league ${league.league || '-'} order count is ${(league.order || []).length}, expected 6`);
    }
  }

  const slipLeakHits = scanLeaks(`${JSON.stringify(slip)}\n${slipMarkdown}`);
  if (slipLeakHits.length) failReasons.push(`slip safety scan failed: ${slipLeakHits.join(', ')}`);

  return { failReasons, slipLeakHits };
}

function inspectPublicHtml({ status, html, validation, slip }) {
  const requirements = addPublicRequirements(validation, slip);
  const missing = requirements.filter(item => !html.includes(item));
  const leakHits = scanLeaks(html);
  const selectedRows = (html.match(/selected-lineup-row/g) || []).length;
  const copyBlocks = (html.match(/selected-lineup-copy/g) || []).length;
  const failReasons = [];

  if (status !== 200) failReasons.push(`public page http status ${status}`);
  if (missing.length) failReasons.push(`public page missing required text: ${missing.join(', ')}`);
  if (leakHits.length) failReasons.push(`public page safety scan failed: ${leakHits.join(', ')}`);
  if (selectedRows < 36) failReasons.push(`public selected-lineup-row count ${selectedRows}, expected at least 36`);
  if (copyBlocks < 2) failReasons.push(`public selected-lineup-copy count ${copyBlocks}, expected at least 2`);
  if (!html.includes(validation.sourceSnapshotScrapedAt)) failReasons.push('public page does not include current source scrapedAt');

  return {
    httpStatus: status,
    missing,
    leakHits,
    selectedRows,
    copyBlocks,
    hasScrapedAt: html.includes(validation.sourceSnapshotScrapedAt),
    htmlLength: html.length,
    failReasons
  };
}

async function verifyPublic(publicUrl, validation, slip, retries, retryDelayMs) {
  if (!publicUrl) {
    return {
      checked: false,
      httpStatus: null,
      missing: [],
      leakHits: [],
      selectedRows: 0,
      copyBlocks: 0,
      hasScrapedAt: false,
      htmlLength: 0,
      failReasons: []
    };
  }

  const maxAttempts = Math.max(1, Number(retries) || 1);
  let last = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const res = await fetch(`${publicUrl}${publicUrl.includes('?') ? '&' : '?'}verify=${Date.now()}-${attempt}`, { cache: 'no-store' });
      const html = await res.text();
      last = {
        checked: true,
        attempt,
        maxAttempts,
        ...inspectPublicHtml({ status: res.status, html, validation, slip })
      };
    } catch (error) {
      last = {
        checked: true,
        attempt,
        maxAttempts,
        httpStatus: null,
        missing: [],
        leakHits: [],
        selectedRows: 0,
        copyBlocks: 0,
        hasScrapedAt: false,
        htmlLength: 0,
        failReasons: [`public page fetch failed: ${error.message || String(error)}`]
      };
    }
    if (!last.failReasons.length) return last;
    if (attempt < maxAttempts) await sleep(Math.max(0, Number(retryDelayMs) || 0));
  }
  return last;
}

async function main() {
  const validationPath = arg('validation');
  const slipJsonPath = arg('slip-json');
  const slipMdPath = arg('slip-md');
  const publicUrl = arg('public-url', '');
  const outPath = arg('out');
  const publicRetries = Number(arg('public-retries', '8'));
  const publicRetryDelayMs = Number(arg('public-retry-delay-ms', '5000'));

  if (!validationPath) throw new Error('Missing --validation');
  if (!slipJsonPath) throw new Error('Missing --slip-json');
  if (!slipMdPath) throw new Error('Missing --slip-md');
  if (!outPath) throw new Error('Missing --out');

  const validation = readJson(validationPath);
  const slip = readJson(slipJsonPath);
  const slipMarkdown = readText(slipMdPath);
  const local = verifyLocal(validation, slip, slipMarkdown);
  const publicPage = await verifyPublic(publicUrl, validation, slip, publicRetries, publicRetryDelayMs);
  const failReasons = [...local.failReasons, ...publicPage.failReasons];
  const status = failReasons.length ? 'FAIL' : 'PASS';
  const payload = {
    status,
    failReasons,
    generatedAt: new Date().toISOString(),
    publicUrl: publicUrl || null,
    validation: {
      status: validation.status,
      sha256: validation.sha256,
      targetSeason: validation.targetSeason,
      sourceSeason: validation.sourceSnapshotSeason,
      sourceDay: validation.sourceSnapshotDay,
      sourceScrapedAt: validation.sourceSnapshotScrapedAt,
      freshness: validation.freshnessGuardSourceFreshnessStatus,
      liveFetchAll: validation.freshnessGuardLiveFetchAll,
      auditConsistencyOk: validation.auditConsistencyOk
    },
    slip: {
      status: slip.status,
      submit: get(slip, 'weekly.submit.label') || null,
      backup: get(slip, 'weekly.backup.label') || null,
      backupSafety: get(slip, 'weekly.backup.safetyStatus') || null,
      variantAlternate: get(slip, 'weekly.variantAlternate.label') || null,
      variantAlternateStatus: get(slip, 'weekly.variantAlternate.status') || null,
      champion: get(slip, 'league.champion') || null,
      localLeakHits: local.slipLeakHits
    },
    publicPage
  };

  writeJson(outPath, payload);
  console.log(JSON.stringify({
    status,
    outPath,
    publicChecked: publicPage.checked,
    publicHttpStatus: publicPage.httpStatus,
    submit: payload.slip.submit,
    backup: payload.slip.backup,
    variantAlternate: payload.slip.variantAlternate,
    champion: payload.slip.champion,
    failReasons
  }, null, 2));
  if (failReasons.length) process.exitCode = 1;
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
});
