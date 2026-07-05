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

function writeText(filePath, body) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body, 'utf8');
}

function stripHtml(text) {
  return String(text || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function numbers(text) {
  return (String(text || '').match(/\d+(?:\.\d+)?/g) || []).map(Number);
}

function fantasyStats(row) {
  const batting = numbers(row.battingTotal);
  const pitching = numbers(row.pitchingTotal);
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

function itemSpec(item) {
  const specs = {
    AVG: { lowerBetter: false, relevant: 'batter' },
    HR: { lowerBetter: false, relevant: 'batter' },
    RBI: { lowerBetter: false, relevant: 'batter' },
    SB: { lowerBetter: false, relevant: 'batter' },
    ERA: { lowerBetter: true, relevant: 'pitcher' },
    W: { lowerBetter: false, relevant: 'pitcher' },
    SV: { lowerBetter: false, relevant: 'pitcher' },
    K: { lowerBetter: false, relevant: 'pitcher' }
  };
  return specs[item] || null;
}

const ALL_ITEMS = ['AVG', 'HR', 'RBI', 'SB', 'ERA', 'W', 'SV', 'K'];
const ITEM_LABEL_ORDER = ['AVG', 'RBI', 'ERA', 'HR', 'SB', 'SV', 'W', 'K'];
const CHINESE_CATEGORY_TO_ITEM = {
  '打率': 'AVG',
  '本打': 'HR',
  '打點': 'RBI',
  '盜壘': 'SB',
  '防率': 'ERA',
  '勝場': 'W',
  '救援': 'SV',
  '三振': 'K'
};

function normalizeItems(value) {
  const raw = String(value || 'all').trim();
  if (!raw || raw.toLowerCase() === 'all') return ALL_ITEMS.slice();
  const items = raw.split(',').map(item => item.trim().toUpperCase()).filter(Boolean);
  const unknown = items.filter(item => !itemSpec(item));
  if (unknown.length) throw new Error(`Unknown fantasy item(s): ${unknown.join(', ')}`);
  return items;
}

function itemFromLabel(label) {
  const raw = String(label || '').trim();
  const upper = raw.toUpperCase();
  for (const item of ITEM_LABEL_ORDER) {
    if (upper === item || upper.startsWith(`${item} `) || upper.startsWith(`${item}　`) || upper.startsWith(`${item}-`) || upper.startsWith(`${item}單`)) {
      return item;
    }
  }
  for (const [chinese, item] of Object.entries(CHINESE_CATEGORY_TO_ITEM)) {
    if (raw.startsWith(chinese)) return item;
  }
  return null;
}

function loadCategoryLeaders(actualDir) {
  const filePath = path.join(actualDir, 'category_leaders.json');
  if (!fs.existsSync(filePath)) return {};
  const rows = readJson(filePath);
  const grouped = {};
  for (const row of rows) {
    const item = CHINESE_CATEGORY_TO_ITEM[row.category] || itemFromLabel(row.category);
    if (!item) continue;
    if (!grouped[item]) grouped[item] = [];
    grouped[item].push({
      item,
      category: row.category,
      account: row.account,
      team: row.team || null,
      value: row.value,
      numericValue: Number(row.value),
      rawLine: row.rawLine || null
    });
  }
  for (const item of Object.keys(grouped)) {
    grouped[item] = grouped[item].map((row, index) => ({ ...row, leaderboardRank: index + 1 }));
  }
  return grouped;
}

function rankRows(rows, item) {
  const spec = itemSpec(item);
  const ranked = rows
    .map(row => ({ ...row, stats: fantasyStats(row), value: fantasyStats(row)[item] }))
    .filter(row => row.value != null && Number.isFinite(Number(row.value)))
    .sort((a, b) => {
      if (a.value !== b.value) return spec.lowerBetter ? a.value - b.value : b.value - a.value;
      return Number(a.rank || 999999) - Number(b.rank || 999999)
        || String(a.account || '').localeCompare(String(b.account || ''));
    });
  let previous = null;
  let currentRank = 0;
  ranked.forEach((row, index) => {
    if (index === 0 || row.value !== previous) currentRank = index + 1;
    row.categoryRank = currentRank;
    previous = row.value;
  });
  return ranked;
}

function positionKeysForKind(kind) {
  return kind === 'pitcher'
    ? ['SP1', 'SP2', 'SP3', 'SP4', 'SP5', 'RP1', 'RP2', 'RP3', 'CP']
    : ['C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF', 'DH'];
}

function roleForPosition(position) {
  if (/^SP/i.test(position)) return 'SP';
  if (/^RP/i.test(position)) return 'RP';
  if (/^CP/i.test(position)) return 'CP';
  return position;
}

function pickSet(row, kind) {
  return new Set(positionKeysForKind(kind).map(key => row.picks && row.picks[key]).filter(Boolean));
}

function allPickSet(row) {
  return new Set(Object.values((row && row.picks) || {}).filter(Boolean));
}

function overlap(setA, setB) {
  return [...setA].filter(value => setB.has(value)).sort((a, b) => String(a).localeCompare(String(b)));
}

function normalizedAccount(account) {
  return String(account || '').replace(/\(-?\d+\)$/, '');
}

function countBy(rows, field) {
  const counts = {};
  for (const row of rows) {
    const value = row[field] || '';
    if (!value) continue;
    counts[value] = (counts[value] || 0) + 1;
  }
  return Object.entries(counts)
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

function consensusRows(topRows, kind) {
  const bySlot = {};
  const byRole = {};
  const allRelevant = [];
  for (const row of topRows) {
    for (const position of positionKeysForKind(kind)) {
      const name = row.picks && row.picks[position];
      if (!name) continue;
      const role = roleForPosition(position);
      const entry = { account: row.account, position, role, name };
      allRelevant.push(entry);
      if (!bySlot[position]) bySlot[position] = [];
      bySlot[position].push(entry);
      if (!byRole[role]) byRole[role] = [];
      byRole[role].push(entry);
    }
  }
  return {
    bySlot: Object.fromEntries(Object.entries(bySlot).map(([position, rows]) => [position, countBy(rows, 'name').slice(0, 8)])),
    byRole: Object.fromEntries(Object.entries(byRole).map(([role, rows]) => [role, countBy(rows, 'name').slice(0, 12)])),
    overall: countBy(allRelevant, 'name').slice(0, 20)
  };
}

function parsePublicVariants(html) {
  const headings = [...html.matchAll(/<h3>(.*?)<\/h3>/g)]
    .map(match => ({ index: match.index, label: stripHtml(match[1]) }));
  return headings.map((heading, index) => {
    const end = index + 1 < headings.length ? headings[index + 1].index : html.indexOf('</body>', heading.index);
    const block = html.slice(heading.index, end < 0 ? html.length : end);
    const rows = [];
    const rowPattern = /<tr class="(batter|sp|rp|cp)"><td class="pos">([\s\S]*?)<\/td><td>([\s\S]*?)<\/td><td class="player">([\s\S]*?)<\/td><td>([\s\S]*?)<\/td>[\s\S]*?<td>([\s\S]*?)<\/td><\/tr>/g;
    for (const match of block.matchAll(rowPattern)) {
      const rowClass = match[1];
      rows.push({
        rowClass,
        position: stripHtml(match[2]),
        role: rowClass === 'sp' ? 'SP' : rowClass === 'rp' ? 'RP' : rowClass === 'cp' ? 'CP' : stripHtml(match[2]),
        team: stripHtml(match[3]),
        name: stripHtml(match[4]),
        owner: stripHtml(match[5]),
        category: rowClass === 'batter' ? 'batter' : 'pitcher',
        projected: stripHtml(match[6])
      });
    }
    const digits = heading.label.match(/\d+/g) || [];
    return {
      label: heading.label,
      item: itemFromLabel(heading.label),
      version: digits.length ? Number(digits[digits.length - 1]) : null,
      rows
    };
  }).filter(variant => variant.item);
}

function variantRelevantSet(variant, kind) {
  return new Set(variant.rows.filter(row => row.category === kind).map(row => row.name).filter(Boolean));
}

function variantAllSet(variant) {
  return new Set(variant.rows.map(row => row.name).filter(Boolean));
}

function exactAndClosestMatches(variant, fantasyRows, kind, item) {
  const relevant = variantRelevantSet(variant, kind);
  const all = variantAllSet(variant);
  const matches = fantasyRows.map(row => {
    const relevantOverlap = overlap(relevant, pickSet(row, kind));
    const allOverlap = overlap(all, allPickSet(row));
    const stats = fantasyStats(row);
    return {
      account: row.account,
      overallRank: row.rank,
      itemValue: stats[item],
      categoryRank: null,
      relevantOverlapCount: relevantOverlap.length,
      relevantCount: relevant.size,
      allOverlapCount: allOverlap.length,
      allCount: all.size,
      relevantOverlap,
      allOverlap,
      stats
    };
  });
  const ranked = rankRows(fantasyRows, item);
  const rankByAccount = new Map(ranked.map(row => [row.account, row.categoryRank]));
  for (const match of matches) match.categoryRank = rankByAccount.get(match.account) || null;
  matches.sort((a, b) => {
    return b.relevantOverlapCount - a.relevantOverlapCount
      || b.allOverlapCount - a.allOverlapCount
      || Number(a.categoryRank || 999999) - Number(b.categoryRank || 999999)
      || Number(a.overallRank || 999999) - Number(b.overallRank || 999999);
  });
  return {
    exactRelevantMatches: matches.filter(row => row.relevantOverlapCount === relevant.size),
    exactFullMatches: matches.filter(row => row.allOverlapCount === all.size),
    closestMatches: matches.slice(0, 5)
  };
}

function selectedConsensusHits(variant, consensus, kind) {
  const selected = variant.rows.filter(row => row.category === kind);
  return selected.map(row => {
    const roleCounts = consensus.byRole[roleForPosition(row.position)] || [];
    const roleHit = roleCounts.find(entry => entry.value === row.name) || null;
    const overallHit = (consensus.overall || []).find(entry => entry.value === row.name) || null;
    return {
      position: row.position,
      role: roleForPosition(row.position),
      name: row.name,
      top10RoleFrequency: roleHit ? roleHit.count : 0,
      top10OverallFrequency: overallHit ? overallHit.count : 0
    };
  });
}

function itemDiagnostics(itemReviews, items) {
  return Object.fromEntries(items.map(item => {
    const review = itemReviews[item];
    const top10 = review.top10 || [];
    const leader = review.leaderboardTop10 && review.leaderboardTop10[0] ? review.leaderboardTop10[0] : top10[0] || null;
    const cutoff = review.leaderboardTop10Cutoff || review.top10Cutoff || null;
    const avgOverallRank = top10.length
      ? top10.reduce((sum, row) => sum + Number(row.overallRank || 0), 0) / top10.length
      : null;
    return [item, {
      relevantKind: review.relevantKind,
      leader,
      cutoff,
      averageTop10OverallRank: avgOverallRank == null ? null : Number(avgOverallRank.toFixed(2)),
      publicVariantCount: review.variants.length,
      publicVariantTop10EvidenceCount: review.variants.filter(variant => variant.wouldHaveTop10Evidence).length
    }];
  }));
}

function top10AccountOverlapMatrix(itemReviews, items) {
  const sets = Object.fromEntries(items.map(item => [
    item,
    new Set((itemReviews[item].top10 || []).map(row => normalizedAccount(row.account)))
  ]));
  return Object.fromEntries(items.map(item => [
    item,
    Object.fromEntries(items.map(other => [other, overlap(sets[item], sets[other]).length]))
  ]));
}

function review({ publicHtmlPath, actualDir, items, outPath, mdOutPath }) {
  const html = publicHtmlPath ? fs.readFileSync(publicHtmlPath, 'utf8').replace(/^\uFEFF/, '') : '';
  const fantasyRows = readJson(path.join(actualDir, 'fantasy_full_list_rows.json'));
  const manifest = readJson(path.join(actualDir, 'manifest.json'));
  const leadersByItem = loadCategoryLeaders(actualDir);
  const variants = parsePublicVariants(html).filter(variant => items.includes(variant.item));
  const itemReviews = {};
  for (const item of items) {
    const spec = itemSpec(item);
    const ranked = rankRows(fantasyRows, item);
    const top10 = ranked.slice(0, 10);
    const top20 = ranked.slice(0, 20);
    const consensus = {
      top10: consensusRows(top10, spec.relevant),
      top20: consensusRows(top20, spec.relevant)
    };
    const itemVariants = variants
      .filter(variant => variant.item === item)
      .map(variant => {
        const matches = exactAndClosestMatches(variant, fantasyRows, spec.relevant, item);
        const bestExact = matches.exactRelevantMatches
          .slice()
          .sort((a, b) => Number(a.categoryRank || 999999) - Number(b.categoryRank || 999999))[0] || null;
        return {
          displayLabel: `${variant.item} V${variant.version}`,
          label: variant.label,
          item: variant.item,
          version: variant.version,
          relevantKind: spec.relevant,
          relevantNames: [...variantRelevantSet(variant, spec.relevant)],
          selectedConsensusHits: selectedConsensusHits(variant, consensus.top10, spec.relevant),
          exactRelevantMatches: matches.exactRelevantMatches.slice(0, 8),
          exactFullMatches: matches.exactFullMatches.slice(0, 8),
          closestMatches: matches.closestMatches,
          bestExactRelevantMatch: bestExact,
          wouldHaveTop10Evidence: Boolean(bestExact && bestExact.categoryRank <= 10)
        };
      });
    itemReviews[item] = {
      item,
      relevantKind: spec.relevant,
      top10Cutoff: top10[9] ? {
        account: top10[9].account,
        overallRank: top10[9].rank,
        value: top10[9].value,
        categoryRank: top10[9].categoryRank
      } : null,
      leaderboardTop10Cutoff: leadersByItem[item] && leadersByItem[item][9] ? leadersByItem[item][9] : null,
      leaderboardTop10: (leadersByItem[item] || []).slice(0, 10),
      top10: top10.map(row => ({
        account: row.account,
        overallRank: row.rank,
        value: row.value,
        categoryRank: row.categoryRank,
        pitchingTotal: row.pitchingTotal,
        battingTotal: row.battingTotal
      })),
      consensus,
      variants: itemVariants
    };
  }

  const audit = {
    status: 'PASS',
    generatedAt: new Date().toISOString(),
    publicHtmlPath,
    actualDir,
    actualManifest: {
      status: manifest.status || manifest.validation && manifest.validation.status || null,
      validation: manifest.validation || null
    },
    items,
    itemReviews,
    itemDiagnostics: itemDiagnostics(itemReviews, items),
    top10AccountOverlapMatrix: top10AccountOverlapMatrix(itemReviews, items),
    modelActions: [
      'For one-category fantasy goals, evaluate only the category-relevant core first; legal filler positions should not be scored as if overall rank were the objective.',
      'Before publishing any one-category variant, compare projected category totals against historical/current top10 cutoffs with a buffer.',
      'After results, rerun this position loop and update role/position miss notes from actual top10 category cores, not overall fantasy rank.'
    ]
  };
  if (outPath) writeText(outPath, `${JSON.stringify(audit, null, 2)}\n`);
  if (mdOutPath) writeText(mdOutPath, renderMarkdown(audit));
  return audit;
}

function renderMarkdown(audit) {
  const lines = [];
  lines.push('# ORE Fantasy Category Position Loop Review');
  lines.push('');
  lines.push(`- Status: ${audit.status}`);
  lines.push(`- Actual snapshot: ${audit.actualDir}`);
  lines.push('');
  lines.push('## Item Diagnostics');
  lines.push('');
  lines.push('| Item | Core | Winner | Top10 cutoff | Avg top10 overall rank | Public variants | Top10 evidence |');
  lines.push('|---|---|---|---|---:|---:|---:|');
  for (const item of audit.items) {
    const diagnostic = audit.itemDiagnostics[item];
    const leader = diagnostic.leader;
    const cutoff = diagnostic.cutoff;
    const leaderText = leader ? `${leader.account} ${leader.value}` : '-';
    const cutoffText = cutoff ? `${cutoff.account} ${cutoff.value}` : '-';
    lines.push(`| ${item} | ${diagnostic.relevantKind} | ${leaderText} | ${cutoffText} | ${diagnostic.averageTop10OverallRank ?? '-'} | ${diagnostic.publicVariantCount} | ${diagnostic.publicVariantTop10EvidenceCount} |`);
  }
  lines.push('');
  lines.push('## Top10 Account Overlap');
  lines.push('');
  lines.push(`| Item | ${audit.items.join(' | ')} |`);
  lines.push(`|---${audit.items.map(() => '|---:').join('')}|`);
  for (const item of audit.items) {
    const row = audit.items.map(other => audit.top10AccountOverlapMatrix[item][other]);
    lines.push(`| ${item} | ${row.join(' | ')} |`);
  }
  lines.push('');
  for (const item of audit.items) {
    const block = audit.itemReviews[item];
    lines.push(`## ${item}`);
    lines.push('');
    lines.push(`- Relevant core: ${block.relevantKind}`);
    if (block.leaderboardTop10Cutoff) {
      lines.push(`- Top10 cutoff: ${block.leaderboardTop10Cutoff.value} (${block.leaderboardTop10Cutoff.account}, leaderboard rank ${block.leaderboardTop10Cutoff.leaderboardRank})`);
    } else if (block.top10Cutoff) {
      lines.push(`- Top10 cutoff: ${block.top10Cutoff.value} (${block.top10Cutoff.account}, rank ${block.top10Cutoff.categoryRank})`);
    }
    lines.push('- Top actual category rows:');
    for (const row of block.top10.slice(0, 5)) {
      lines.push(`  - #${row.categoryRank} ${row.account}: ${item} ${row.value}; overall ${row.overallRank}`);
    }
    lines.push('- Top10 relevant-position consensus:');
    for (const [position, rows] of Object.entries(block.consensus.top10.bySlot)) {
      const compact = rows.slice(0, 4).map(row => `${row.value}(${row.count})`).join(', ');
      lines.push(`  - ${position}: ${compact}`);
    }
    lines.push('- Top10 relevant-role consensus:');
    for (const [role, rows] of Object.entries(block.consensus.top10.byRole)) {
      const compact = rows.slice(0, 6).map(row => `${row.value}(${row.count})`).join(', ');
      lines.push(`  - ${role}: ${compact}`);
    }
    lines.push('');
    if (block.variants.length) {
      lines.push('| Variant | Exact core evidence | Best category rank | Best value | Full match | Top10? |');
      lines.push('|---|---:|---:|---:|---:|---|');
      for (const variant of block.variants) {
        const best = variant.bestExactRelevantMatch;
        const full = variant.exactFullMatches.length ? variant.exactFullMatches[0] : null;
        lines.push(`| ${variant.displayLabel || variant.label} | ${variant.exactRelevantMatches.length} | ${best ? best.categoryRank : '-'} | ${best ? best.itemValue : '-'} | ${full ? `${full.account} (${full.allOverlapCount}/${full.allCount})` : '-'} | ${variant.wouldHaveTop10Evidence ? 'yes' : 'no'} |`);
      }
    } else {
      lines.push('- Delivered public variants found for this item: none in the supplied public HTML.');
    }
    lines.push('');
  }
  lines.push('## Model Actions');
  for (const action of audit.modelActions) lines.push(`- ${action}`);
  return `${lines.join('\n')}\n`;
}

function main() {
  const publicHtmlPath = arg('public-html');
  const actualDir = arg('actual-dir');
  const outPath = arg('out');
  const mdOutPath = arg('md-out');
  const items = normalizeItems(arg('items', 'all'));
  if (!actualDir) throw new Error('Missing --actual-dir');
  const audit = review({ publicHtmlPath, actualDir, items, outPath, mdOutPath });
  console.log(JSON.stringify({
    status: audit.status,
    items,
    outPath,
    mdOutPath,
    summary: Object.fromEntries(items.map(item => [
      item,
      {
        top10Cutoff: audit.itemReviews[item].top10Cutoff,
        leaderboardTop10Cutoff: audit.itemReviews[item].leaderboardTop10Cutoff,
        itemDiagnostics: audit.itemDiagnostics[item],
        variants: audit.itemReviews[item].variants.map(variant => ({
          label: variant.label,
          displayLabel: variant.displayLabel,
          exactRelevantMatches: variant.exactRelevantMatches.length,
          bestCategoryRank: variant.bestExactRelevantMatch ? variant.bestExactRelevantMatch.categoryRank : null,
          bestValue: variant.bestExactRelevantMatch ? variant.bestExactRelevantMatch.itemValue : null,
          top10: variant.wouldHaveTop10Evidence
        }))
      }
    ]))
  }, null, 2));
}

main();
