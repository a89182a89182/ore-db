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
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
}

function writeText(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, 'utf8');
}

function countBy(rows, key) {
  const counts = {};
  for (const row of rows) {
    const value = row[key] || '';
    counts[value] = (counts[value] || 0) + 1;
  }
  return counts;
}

function summarizeLegality(lineup) {
  const categories = countBy(lineup, 'category');
  const roles = countBy(lineup, 'role');
  const teams = countBy(lineup, 'team');
  const maxTeamCount = Math.max(...Object.values(teams));
  return {
    total: lineup.length,
    batters: categories.batter || 0,
    pitchers: categories.pitcher || 0,
    sp: roles.SP || 0,
    rp: roles.RP || 0,
    cp: roles.CP || 0,
    teamCount: Object.keys(teams).length,
    maxTeamCount,
    ok:
      lineup.length === 18 &&
      (categories.batter || 0) === 9 &&
      (categories.pitcher || 0) === 9 &&
      (roles.SP || 0) === 5 &&
      (roles.RP || 0) === 3 &&
      (roles.CP || 0) === 1 &&
      Object.keys(teams).length === 12 &&
      maxTeamCount <= 2
  };
}

function leagueOrderText(league) {
  return (league.order || []).map(row => `${row.rank}. ${row.team}`).join(' > ');
}

function entryLine(row) {
  return `${String(row.order).padStart(2, '0')}. ${row.role} | ${row.team} | ${row.owner} | ${row.name}`;
}

function renderSelection(selection) {
  const legality = summarizeLegality(selection.lineup || []);
  const lines = [
    `## ${selection.kind}: ${selection.label}`,
    '',
    `- Lineup hash: ${selection.lineupHash}`,
    `- Legality: ${legality.ok ? 'PASS' : 'FAIL'}; total ${legality.total}; batters ${legality.batters}; pitchers ${legality.pitchers}; SP/RP/CP ${legality.sp}/${legality.rp}/${legality.cp}; teams ${legality.teamCount}; max per team ${legality.maxTeamCount}`,
    '',
    '```text'
  ];
  for (const row of selection.lineup || []) {
    lines.push(entryLine(row));
  }
  lines.push('```');
  lines.push('');
  return lines;
}

function buildEntryCard(snapshot) {
  const failReasons = [];
  const selections = (snapshot.selections || []).map(selection => ({
    kind: selection.kind,
    item: selection.item,
    variant: selection.variant,
    label: selection.label,
    lineupHash: selection.lineupHash,
    legality: summarizeLegality(selection.lineup || []),
    lineup: (selection.lineup || []).map(row => ({
      order: row.order,
      role: row.role,
      team: row.team,
      owner: row.owner,
      name: row.name,
      category: row.category
    }))
  }));

  for (const selection of selections) {
    if (!selection.legality.ok) {
      failReasons.push(`${selection.label} failed manual-entry legality summary`);
    }
  }

  return {
    status: failReasons.length ? 'FAIL' : 'PASS',
    failReasons,
    generatedAt: new Date().toISOString(),
    targetSeason: snapshot.targetSeason,
    source: snapshot.source,
    validation: snapshot.validation,
    publicUrl: snapshot.publicUrl,
    snapshotHash: snapshot.snapshotHash,
    submission: snapshot.submission,
    league: {
      champion: snapshot.league?.champion || null,
      championConfidence: snapshot.league?.championConfidence || null,
      exactMatches: snapshot.league?.exactMatches ?? null,
      teamCount: snapshot.league?.teamCount ?? null,
      swapWatchCount: snapshot.league?.swapWatchCount ?? null,
      rankings: (snapshot.league?.rankings || []).map(league => ({
        league: league.league,
        order: (league.order || []).map(row => ({
          rank: row.rank,
          team: row.team
        }))
      }))
    },
    selections
  };
}

function renderMarkdown(card) {
  const lines = [
    `# ORE ${card.targetSeason} Manual Entry Card`,
    '',
    `- Status: ${card.status}`,
    `- Source: season ${card.source?.season || '-'} day ${card.source?.day || '-'}; scrapedAt ${card.source?.scrapedAt || '-'}`,
    `- Validation SHA: ${card.validation?.sha256 || '-'}`,
    `- Snapshot hash: ${card.snapshotHash || '-'}`,
    `- Public report: ${card.publicUrl || 'not published'}`,
    '',
    '## Submit Card',
    '',
    `- Submit: ${card.submission?.submit || '-'}`,
    `- Backup: ${card.submission?.backup || '-'}; safety ${card.submission?.backupSafetyStatus || '-'}`,
    `- Watch-only alternate: ${card.submission?.variantAlternate || '-'}`,
    `- Manual status: ${card.submission?.readinessStatus || '-'}; form access ${card.submission?.formAccessStatus || '-'}; doNotAutoSubmit=${card.submission?.doNotAutoSubmit === true}`,
    '',
    '## League Ranking',
    '',
    `- Champion: ${card.league.champion || '-'}`,
    `- Confidence: ${card.league.championConfidence || '-'}; exact ranks ${card.league.exactMatches ?? '-'}/${card.league.teamCount ?? '-'}; swap watch ${card.league.swapWatchCount ?? '-'}`,
  ];

  for (const league of card.league.rankings || []) {
    lines.push(`- ${league.league}: ${leagueOrderText(league)}`);
  }
  lines.push('');

  for (const selection of card.selections) {
    lines.push(...renderSelection(selection));
  }

  lines.push('## Pre-Submit Checkboxes');
  lines.push('');
  lines.push('- [ ] Source scrapedAt matches the latest final guard.');
  lines.push('- [ ] Entered the primary lineup exactly as `primary` above.');
  lines.push('- [ ] Entered the champion and both league ranking orders exactly as above.');
  lines.push('- [ ] Did not use the high-risk backup unless deliberately switching after a fresh guard warning.');
  lines.push('- [ ] Did not treat the watch-only alternate as the primary submission.');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function renderText(card) {
  const lines = [
    `ORE ${card.targetSeason} MANUAL ENTRY CARD`,
    `STATUS: ${card.status}`,
    `SUBMIT: ${card.submission?.submit || '-'}`,
    `BACKUP: ${card.submission?.backup || '-'} (${card.submission?.backupSafetyStatus || '-'})`,
    `WATCH ONLY: ${card.submission?.variantAlternate || '-'}`,
    `CHAMPION: ${card.league.champion || '-'}`,
    ''
  ];
  for (const league of card.league.rankings || []) {
    lines.push(`${league.league}: ${leagueOrderText(league)}`);
  }
  lines.push('');
  for (const selection of card.selections) {
    lines.push(`${selection.kind.toUpperCase()} ${selection.label} ${selection.lineupHash}`);
    for (const row of selection.lineup) lines.push(entryLine(row));
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

function main() {
  const snapshotPath = arg('snapshot');
  const outPath = arg('out');
  const jsonOutPath = arg('json-out');
  const textOutPath = arg('text-out');
  if (!snapshotPath) throw new Error('Missing --snapshot');
  if (!outPath) throw new Error('Missing --out');
  if (!jsonOutPath) throw new Error('Missing --json-out');
  if (!textOutPath) throw new Error('Missing --text-out');

  const snapshot = readJson(snapshotPath);
  const card = buildEntryCard(snapshot);
  writeText(jsonOutPath, `${JSON.stringify(card, null, 2)}\n`);
  writeText(outPath, renderMarkdown(card));
  writeText(textOutPath, renderText(card));
  console.log(JSON.stringify({
    status: card.status,
    failReasons: card.failReasons,
    outPath,
    jsonOutPath,
    textOutPath,
    selections: card.selections.map(selection => ({
      kind: selection.kind,
      label: selection.label,
      legality: selection.legality
    }))
  }, null, 2));
  if (card.status !== 'PASS') process.exitCode = 1;
}

main();
