#!/usr/bin/env node

const crypto = require('crypto');
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

function writeText(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, 'utf8');
}

function get(obj, dottedPath) {
  return dottedPath.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
}

function label(item, variant) {
  return item && variant != null ? `${item} V${variant}` : '';
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(stableJson(value), 'utf8').digest('hex');
}

function artifactForItem(summary, item) {
  const artifacts = summary.artifacts || {};
  const byItem = {
    HR: artifacts.hrDraft,
    SB: artifacts.sbDraft,
    K: artifacts.kDraft,
    ERA: artifacts.eraDraft
  };
  return byItem[item] || null;
}

function compactRow(row, order) {
  return {
    order,
    id: row.id || null,
    identity: [row.team || '', row.owner || '', row.name || '', row.category || ''].join('|'),
    teamNameIdentity: [row.team || '', row.name || '', row.category || ''].join('|'),
    team: row.team || '',
    owner: row.owner || '',
    name: row.name || '',
    role: row.role || row.position_or_role || '',
    category: row.category || '',
    age: row.age == null ? null : Number(row.age),
    matchMethod: row.matchMethod || null,
    abilities: row.abilities || null,
    skills: row.skills || [],
    projectedStats: row.projectedStats || null,
    career: row.career || null
  };
}

function loadSelection(summary, item, variant, kind) {
  if (!item || variant == null) return null;
  const draftPath = artifactForItem(summary, item);
  if (!draftPath) throw new Error(`Missing draft artifact path for ${item}`);
  if (!fs.existsSync(draftPath)) throw new Error(`Draft artifact not found for ${item}: ${draftPath}`);
  const draft = readJson(draftPath);
  const variantBlock = (draft.lineupVariants || []).find(row => Number(row.variantIndex) === Number(variant));
  if (!variantBlock) throw new Error(`Variant ${variant} not found in ${item} draft`);
  const lineup = (variantBlock.lineup || []).map((row, index) => compactRow(row, index + 1));
  if (lineup.length !== 18) throw new Error(`${item} V${variant} lineup has ${lineup.length} rows, expected 18`);
  const selection = {
    kind,
    item,
    variant: Number(variant),
    label: label(item, variant),
    mode: draft.mode || item.toLowerCase(),
    feasible: variantBlock.feasible === true,
    objective: variantBlock.objective || draft.objective || null,
    batterObjective: variantBlock.batterObjective || draft.batterObjective || null,
    pitcherObjective: variantBlock.pitcherObjective || draft.pitcherObjective || null,
    draftGeneratedAt: draft.generatedAt || null,
    liveSourceType: get(draft, 'source.liveSourceType') || null,
    liveSourceTimestamp: get(draft, 'source.liveSourceTimestamp') || null,
    liveFetchSucceeded: get(draft, 'source.liveFetchSucceeded') === true,
    lineup
  };
  selection.lineupHash = sha256({
    item: selection.item,
    variant: selection.variant,
    lineup: selection.lineup.map(row => ({
      order: row.order,
      identity: row.identity,
      role: row.role,
      category: row.category
    }))
  });
  return selection;
}

function renderMarkdown(snapshot) {
  const lines = [
    `# ORE ${snapshot.targetSeason} Weekly Submission Snapshot`,
    '',
    `- Generated: ${snapshot.generatedAt}`,
    `- Source: season ${snapshot.source.season} day ${snapshot.source.day}; scraped at ${snapshot.source.scrapedAt}; freshness ${snapshot.source.freshnessStatus}`,
    `- Validation SHA: ${snapshot.validation.sha256}`,
    `- Snapshot hash: ${snapshot.snapshotHash}`,
    `- Public report: ${snapshot.publicUrl || 'not published'}`,
    ''
  ];
  if (snapshot.league) {
    lines.push('## League Ranking');
    lines.push('');
    lines.push(`- Champion: ${snapshot.league.champion || '-'}`);
    lines.push(`- Confidence: ${snapshot.league.championConfidence || '-'}; exact ranks ${snapshot.league.exactMatches ?? '-'}/${snapshot.league.teamCount ?? '-'}; swap watch ${snapshot.league.swapWatchCount ?? '-'}`);
    for (const league of snapshot.league.rankings || []) {
      const order = (league.order || []).map(row => `${row.rank}. ${row.team}`).join(' > ');
      lines.push(`- ${league.league}: ${order}`);
    }
    lines.push('');
  }
  for (const selection of snapshot.selections) {
    lines.push(`## ${selection.kind}: ${selection.label}`);
    lines.push('');
    lines.push(`- Hash: ${selection.lineupHash}`);
    lines.push(`- Live source: ${selection.liveSourceType}; liveFetchSucceeded=${selection.liveFetchSucceeded}`);
    lines.push('');
    lines.push('| # | Role | Team | Owner | Name | Category |');
    lines.push('|---:|---|---|---|---|---|');
    for (const row of selection.lineup) {
      lines.push(`| ${row.order} | ${row.role} | ${row.team} | ${row.owner} | ${row.name} | ${row.category} |`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

function buildSnapshot({ summary, slip, validation }) {
  const selections = [
    loadSelection(summary, get(slip, 'weekly.submit.item'), get(slip, 'weekly.submit.variant'), 'primary'),
    loadSelection(summary, get(slip, 'weekly.backup.item'), get(slip, 'weekly.backup.variant'), 'backup')
  ];
  const altItem = get(slip, 'weekly.variantAlternate.item');
  const altVariant = get(slip, 'weekly.variantAlternate.variant');
  if (altItem && altVariant != null) {
    selections.push(loadSelection(summary, altItem, altVariant, 'variantAlternate'));
  }
  const snapshot = {
    status: 'PASS',
    failReasons: [],
    generatedAt: new Date().toISOString(),
    targetSeason: slip.targetSeason || summary.targetSeason || validation.targetSeason || null,
    source: {
      season: get(slip, 'source.season') || String(validation.sourceSnapshotSeason || ''),
      day: get(slip, 'source.day') || String(validation.sourceSnapshotDay || ''),
      scrapedAt: get(slip, 'source.scrapedAt') || validation.sourceSnapshotScrapedAt || null,
      freshnessStatus: get(slip, 'source.freshnessStatus') || validation.freshnessGuardSourceFreshnessStatus || null,
      rerunRule: get(slip, 'source.rerunRule') || validation.freshnessGuardRerunRule || null
    },
    validation: {
      status: validation.status || null,
      sha256: validation.sha256 || null,
      auditConsistencyOk: validation.auditConsistencyOk === true
    },
    publicUrl: slip.publicUrl || get(summary, 'publish.publicUrl') || null,
    submission: {
      submit: get(slip, 'weekly.submit.label') || null,
      backup: get(slip, 'weekly.backup.label') || null,
      backupSafetyStatus: get(slip, 'weekly.backup.safetyStatus') || null,
      variantAlternate: get(slip, 'weekly.variantAlternate.label') || null,
      readinessStatus: get(slip, 'readiness.status') || null,
      formAccessStatus: get(slip, 'readiness.formAccessStatus') || null,
      doNotAutoSubmit: get(slip, 'readiness.doNotAutoSubmit') === true
    },
    league: slip.league || null,
    selections
  };
  snapshot.snapshotHash = sha256({
    targetSeason: snapshot.targetSeason,
    source: snapshot.source,
    validationSha256: snapshot.validation.sha256,
    league: snapshot.league,
    selections: snapshot.selections.map(selection => ({
      kind: selection.kind,
      item: selection.item,
      variant: selection.variant,
      lineupHash: selection.lineupHash
    }))
  });
  return snapshot;
}

function main() {
  const summaryPath = arg('summary');
  const slipPath = arg('slip-json');
  const validationPath = arg('validation');
  const outPath = arg('out');
  const mdOutPath = arg('md-out');
  if (!summaryPath) throw new Error('Missing --summary');
  if (!slipPath) throw new Error('Missing --slip-json');
  if (!validationPath) throw new Error('Missing --validation');
  if (!outPath) throw new Error('Missing --out');
  if (!mdOutPath) throw new Error('Missing --md-out');

  const summary = readJson(summaryPath);
  const slip = readJson(slipPath);
  const validation = readJson(validationPath);
  const snapshot = buildSnapshot({ summary, slip, validation });
  writeText(outPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  writeText(mdOutPath, renderMarkdown(snapshot));
  console.log(JSON.stringify({
    status: snapshot.status,
    outPath,
    mdOutPath,
    snapshotHash: snapshot.snapshotHash,
    selections: snapshot.selections.map(selection => ({
      kind: selection.kind,
      label: selection.label,
      rows: selection.lineup.length,
      lineupHash: selection.lineupHash
    }))
  }, null, 2));
}

main();
