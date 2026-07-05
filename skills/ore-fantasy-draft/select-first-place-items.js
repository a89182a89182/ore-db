#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const ITEMS = ['AVG', 'HR', 'RBI', 'SB', 'ERA', 'W', 'SV', 'K'];
const STRATEGY_RISK_ITEMS = new Set(['SB']);
const CLOSE_GAP = {
  AVG: { close: 0.005, medium: 0.015 },
  HR: { close: 5, medium: 20 },
  RBI: { close: 10, medium: 40 },
  SB: { close: 10, medium: 25 },
  ERA: { close: 0.15, medium: 0.4 },
  W: { close: 3, medium: 8 },
  SV: { close: 5, medium: 10 },
  K: { close: 25, medium: 75 }
};

function parseArgs(argv) {
  const opts = {};
  for (let i = 2; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const [key, inlineValue] = token.slice(2).split('=');
    const value = inlineValue !== undefined
      ? inlineValue
      : (i + 1 < argv.length && !argv[i + 1].startsWith('--') ? argv[++i] : true);
    if (opts[key] === undefined) opts[key] = value;
    else if (Array.isArray(opts[key])) opts[key].push(value);
    else opts[key] = [opts[key], value];
  }
  return opts;
}

function optionList(opts, key) {
  const value = opts[key];
  if (value === undefined || value === null || value === true) return [];
  const raw = Array.isArray(value) ? value : [value];
  return raw.flatMap(item => String(item).split(';')).map(item => item.trim()).filter(Boolean);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
}

function readJsonIfExists(filePath) {
  return filePath && fs.existsSync(filePath) ? readJson(filePath) : null;
}

function writeText(filePath, body) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body, 'utf8');
}

function num(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(String(value ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : fallback;
}

function seasonFromPath(filePath) {
  const match = String(filePath || '').replace(/\\/g, '/').match(/ore_(\d+)_/i);
  return match ? Number(match[1]) : null;
}

function reviewItems(review) {
  if (!review) return [];
  if (Array.isArray(review.items)) return review.items;
  if (Array.isArray(review.itemResults)) return review.itemResults;
  if (Array.isArray(review.results)) return review.results;
  return [];
}

function bestVariant(variants) {
  const rows = variants.filter(v => Number.isFinite(num(v.rank)));
  if (!rows.length) return null;
  return rows.slice().sort((a, b) => num(a.rank, 999) - num(b.rank, 999))[0];
}

function normalizeReviewItem(raw) {
  const variants = Array.isArray(raw.variants) ? raw.variants : [];
  const best = bestVariant(variants);
  const variantCount = variants.length || num(raw.producedVariants, 0) || 5;
  const top10Variants = num(raw.top10Variants, null)
    ?? num(raw.top10Count, null)
    ?? variants.filter(v => num(v.rank, 999) <= 10).length;
  const firstPlaceVariants = num(raw.firstPlaceVariants, null)
    ?? num(raw.firstPlaceCount, null)
    ?? variants.filter(v => num(v.rank, 999) === 1).length;
  const bestRank = num(raw.bestRank, null) ?? (best ? num(best.rank, null) : null);
  const bestGap = num(raw.bestFirstPlaceGap, null)
    ?? num(raw.bestGapToFirst, null)
    ?? variants.reduce((min, variant) => {
      const gap = num(variant.firstPlaceGap, null);
      return gap === null ? min : Math.min(min, gap);
    }, Infinity);

  return {
    item: String(raw.item || raw.mode || '').toUpperCase(),
    mode: raw.mode || null,
    bestRank,
    top10Variants,
    firstPlaceVariants,
    variantCount,
    top10Cutoff: num(raw.top10Cutoff, null),
    firstPlaceValue: num(raw.firstPlaceValue, null),
    bestFirstPlaceGap: Number.isFinite(bestGap) ? bestGap : null,
    bestVariant: best ? {
      label: best.variant || best.label || null,
      rank: num(best.rank, null),
      value: num(best.value, null),
      firstPlaceGap: num(best.firstPlaceGap, null)
    } : null
  };
}

function loadReviewByItem(filePath) {
  const review = readJson(filePath);
  const items = new Map();
  for (const item of reviewItems(review).map(normalizeReviewItem)) {
    if (ITEMS.includes(item.item)) items.set(item.item, item);
  }
  return {
    path: filePath,
    season: review.targetSeason || review.season || seasonFromPath(filePath),
    sourceSeason: review.sourceSeason || (review.source && review.source.sourceSeason) || null,
    status: review.status || null,
    items
  };
}

function aggregateTraining(reviews) {
  const byItem = new Map();
  for (const item of ITEMS) {
    byItem.set(item, {
      item,
      reviewCount: 0,
      seasons: [],
      bestRank: null,
      top10Variants: 0,
      firstPlaceVariants: 0,
      variantCount: 0,
      sources: []
    });
  }

  for (const review of reviews) {
    for (const item of ITEMS) {
      const row = review.items.get(item);
      if (!row) continue;
      const target = byItem.get(item);
      target.reviewCount += 1;
      target.seasons.push(review.season);
      target.sources.push(review.path);
      target.bestRank = target.bestRank === null ? row.bestRank : Math.min(target.bestRank, row.bestRank ?? 999);
      target.top10Variants += row.top10Variants || 0;
      target.firstPlaceVariants += row.firstPlaceVariants || 0;
      target.variantCount += row.variantCount || 0;
    }
  }
  return byItem;
}

function loadDeliveredByItem(filePath) {
  const review = readJsonIfExists(filePath);
  const byItem = new Map();
  if (!review) return byItem;
  for (const item of reviewItems(review).map(normalizeReviewItem)) {
    if (ITEMS.includes(item.item)) byItem.set(item.item, item);
  }
  return byItem;
}

function loadUserAccountEvidence(filePath) {
  const empty = new Map(ITEMS.map(item => [item, {
    item,
    matchedAccounts: 0,
    highCoreAccounts: 0,
    firstPlaceAccounts: 0,
    bestAccountRank: null,
    accounts: []
  }]));
  const review = readJsonIfExists(filePath);
  if (!review || !Array.isArray(review.rows)) return empty;

  for (const row of review.rows) {
    for (const item of ITEMS) {
      const evidence = empty.get(item);
      const rank = row.ranks && row.ranks[item] ? num(row.ranks[item].rank, null) : null;
      const core = row.bestCoreOverlapBySundayItem && row.bestCoreOverlapBySundayItem[item]
        ? row.bestCoreOverlapBySundayItem[item]
        : null;
      const full = row.bestFullOverlap && row.bestFullOverlap.item === item ? row.bestFullOverlap : null;
      const highCore = core && num(core.total, 0) > 0 && num(core.overlap, 0) / num(core.total, 1) >= 0.66;

      if (full || core) evidence.matchedAccounts += 1;
      if (highCore) evidence.highCoreAccounts += 1;
      if (rank === 1) evidence.firstPlaceAccounts += 1;
      if (rank !== null) evidence.bestAccountRank = evidence.bestAccountRank === null ? rank : Math.min(evidence.bestAccountRank, rank);
      if (full || highCore) {
        evidence.accounts.push({
          account: row.account,
          rank,
          fullOverlap: full ? `${full.overlap}/${full.total}` : null,
          coreOverlap: core ? `${core.overlap}/${core.total}` : null
        });
      }
    }
  }
  return empty;
}

function top10Fraction(evidence) {
  return evidence && evidence.variantCount > 0
    ? Math.min(1, (evidence.top10Variants || 0) / evidence.variantCount)
    : 0;
}

function trainingRankBonus(rank) {
  if (!Number.isFinite(rank)) return 0;
  return Math.max(0, 12 - rank);
}

function holdoutRankScore(rank) {
  if (!Number.isFinite(rank)) return -12;
  if (rank === 1) return 24;
  if (rank <= 3) return 34;
  if (rank <= 10) return 18;
  if (rank <= 15) return 4;
  if (rank <= 20) return -4;
  return -14;
}

function gapScore(item, gap) {
  if (!Number.isFinite(gap)) return 0;
  if (gap === 0) return 16;
  const bands = CLOSE_GAP[item] || { close: 0, medium: 0 };
  if (gap <= bands.close) return 10;
  if (gap <= bands.medium) return 2;
  return -12;
}

function deliveredFailurePenalty(item, delivered) {
  if (!delivered || (delivered.firstPlaceVariants || 0) > 0) return 0;
  let penalty = 10;
  if ((delivered.top10Variants || 0) === 0) penalty += 12;
  if ((delivered.bestRank || 999) > 10) penalty += 8;
  if (gapScore(item, delivered.bestFirstPlaceGap) < 0) penalty += 6;
  if ((delivered.bestRank || 999) <= 3 && gapScore(item, delivered.bestFirstPlaceGap) >= 10) penalty -= 12;
  return Math.max(4, penalty);
}

function scoreItem(item, training, holdout, delivered, userEvidence) {
  let score = 0;
  const notes = [];
  const blockers = [];

  if (training && training.reviewCount > 0) {
    if (training.firstPlaceVariants > 0) {
      score += 34 + Math.min(training.firstPlaceVariants, 3) * 4;
      notes.push(`training<=775 had ${training.firstPlaceVariants}/${training.variantCount} first-place variants`);
    } else if ((training.bestRank || 999) <= 3) {
      score += 20;
      notes.push(`training<=775 was close: best rank #${training.bestRank}`);
    } else if ((training.bestRank || 999) <= 10) {
      score += 8;
      notes.push(`training<=775 reached top10 only: best rank #${training.bestRank}`);
    } else {
      blockers.push(`training<=775 no first-place signal: best rank #${training.bestRank || '-'}`);
    }
    score += top10Fraction(training) * 14;
    score += trainingRankBonus(training.bestRank);
  } else {
    blockers.push('missing training evidence');
  }

  if (holdout) {
    if ((holdout.firstPlaceVariants || 0) > 0) {
      score += 56 + Math.min(holdout.firstPlaceVariants, 3) * 4;
      notes.push(`776 holdout produced ${holdout.firstPlaceVariants}/${holdout.variantCount} first-place variants`);
    } else {
      score += holdoutRankScore(holdout.bestRank);
      if ((holdout.bestRank || 999) <= 3) notes.push(`776 holdout close: best rank #${holdout.bestRank}`);
      else blockers.push(`776 holdout did not reach first: best rank #${holdout.bestRank || '-'}`);
    }
    score += top10Fraction(holdout) * 18;
    score += gapScore(item, holdout.bestFirstPlaceGap);
  } else {
    blockers.push('missing holdout evidence');
  }

  if (delivered) {
    if ((delivered.firstPlaceVariants || 0) > 0) {
      score += 25;
      notes.push('delivered Sunday output won first');
    } else {
      const penalty = deliveredFailurePenalty(item, delivered);
      score -= penalty;
      blockers.push(`delivered Sunday output had no first-place variant; penalty ${penalty}`);
    }
  }

  if (userEvidence && userEvidence.highCoreAccounts > 0 && userEvidence.firstPlaceAccounts === 0) {
    const penalty = Math.min(18, userEvidence.highCoreAccounts * 5);
    score -= penalty;
    blockers.push(`${userEvidence.highCoreAccounts} high-overlap prediction-user accounts still had no first place; penalty ${penalty}`);
  }

  let status = 'candidate';
  if (STRATEGY_RISK_ITEMS.has(item)) {
    score -= 50;
    status = 'review_only';
    blockers.push('strategy-risk item: keep review-only unless explicitly requested');
  } else if (score >= 90) {
    status = 'primary';
  } else if (score >= 45) {
    status = 'strong_candidate';
  } else if (score >= 20) {
    status = 'recheck_candidate';
  } else {
    status = 'deprioritized';
  }

  return {
    item,
    score: Math.round(score * 10) / 10,
    status,
    training,
    holdout,
    delivered: delivered || null,
    userEvidence: userEvidence || null,
    notes,
    blockers
  };
}

function buildMarkdown(result) {
  const lines = [
    `# ORE ${result.targetSeason} First-Place Item Selection Calibration`,
    '',
    `- Status: ${result.status}`,
    `- Source/training seasons: <=${result.maxTrainingSeason}`,
    `- Holdout season: ${result.targetSeason}`,
    `- Reward rule: first place only; top10/top3 are diagnostics.`,
    `- Training review: ${result.trainingReviewPaths.join('; ')}`,
    `- Holdout review: ${result.holdoutReviewPath}`,
    '',
    '## Next Sunday Item Priority',
    '',
    '| Priority | Item | Score | Status | Why |',
    '|---:|---|---:|---|---|'
  ];

  result.recommendedItems.forEach((row, index) => {
    const why = [...row.notes, ...row.blockers.slice(0, 1)].join(' / ') || '-';
    lines.push(`| ${index + 1} | ${row.item} | ${row.score} | ${row.status} | ${why} |`);
  });
  if (!result.recommendedItems.length) lines.push('| - | - | - | - | No recommendable item. |');

  lines.push('', '## All Items', '');
  lines.push('| Item | Score | Status | Training best | 776 best | 776 first gap | Delivered | Account evidence |');
  lines.push('|---|---:|---|---:|---:|---:|---|---|');
  for (const row of result.items) {
    const delivered = row.delivered
      ? `best #${row.delivered.bestRank}, first variants ${row.delivered.firstPlaceVariants}`
      : '-';
    const accounts = row.userEvidence && row.userEvidence.highCoreAccounts
      ? `${row.userEvidence.highCoreAccounts} high-core, best account #${row.userEvidence.bestAccountRank || '-'}`
      : '-';
    lines.push(`| ${row.item} | ${row.score} | ${row.status} | ${row.training.bestRank || '-'} | ${row.holdout ? row.holdout.bestRank : '-'} | ${row.holdout && row.holdout.bestFirstPlaceGap !== null ? row.holdout.bestFirstPlaceGap : '-'} | ${delivered} | ${accounts} |`);
  }

  lines.push('', '## Model Action');
  for (const action of result.modelActions) lines.push(`- ${action}`);
  lines.push('');
  return lines.join('\n');
}

function main() {
  const opts = parseArgs(process.argv);
  const trainingReviewPaths = optionList(opts, 'training-review');
  const holdoutReviewPath = opts['holdout-review'];
  const deliveredVerdictPath = opts['delivered-verdict'] || null;
  const userAccountsPath = opts['user-accounts'] || null;
  const outPath = opts.out;
  const mdOutPath = opts['md-out'];
  const maxTrainingSeason = num(opts['max-training-season'], null);
  const targetSeason = num(opts['target-season'], null) || seasonFromPath(holdoutReviewPath);

  if (!trainingReviewPaths.length) throw new Error('Missing --training-review');
  if (!holdoutReviewPath) throw new Error('Missing --holdout-review');
  if (!outPath) throw new Error('Missing --out');
  if (!mdOutPath) throw new Error('Missing --md-out');

  const trainingReviews = trainingReviewPaths.map(loadReviewByItem);
  const holdoutReview = loadReviewByItem(holdoutReviewPath);
  const deliveredByItem = loadDeliveredByItem(deliveredVerdictPath);
  const userEvidenceByItem = loadUserAccountEvidence(userAccountsPath);
  const trainingByItem = aggregateTraining(trainingReviews);

  const items = ITEMS.map(item => scoreItem(
    item,
    trainingByItem.get(item),
    holdoutReview.items.get(item) || null,
    deliveredByItem.get(item) || null,
    userEvidenceByItem.get(item) || null
  )).sort((a, b) => b.score - a.score || ITEMS.indexOf(a.item) - ITEMS.indexOf(b.item));

  const recommendedItems = items
    .filter(row => !['review_only', 'deprioritized'].includes(row.status))
    .slice(0, 3);

  const result = {
    status: 'PASS',
    generatedAt: new Date().toISOString(),
    objective: 'Select next Sunday fantasy items by first-place probability, using <=training-season evidence and the target season as holdout judgment.',
    rewardRule: 'Only first place wins; top10/top3 are diagnostics only.',
    maxTrainingSeason,
    targetSeason,
    trainingReviewPaths,
    holdoutReviewPath,
    deliveredVerdictPath,
    userAccountsPath,
    recommendedItems: recommendedItems.map(row => ({
      item: row.item,
      score: row.score,
      status: row.status,
      notes: row.notes,
      blockers: row.blockers
    })),
    items,
    modelActions: [
      'Do not keep K/SV/RBI as a hard-coded Sunday trio.',
      'Prioritize HR and RBI in the next Sunday run unless fresh source evidence contradicts them.',
      'Use W as the third recheck candidate; only return K if fresh-source pitcher evidence repairs the 776 miss pattern.',
      'Keep SB review-only because it is strategy-risk, even when top10 diagnostics look strong.',
      'Do not patch player scoring weights directly from 776 winners; that would leak holdout answers.'
    ]
  };

  writeText(outPath, `${JSON.stringify(result, null, 2)}\n`);
  writeText(mdOutPath, buildMarkdown(result));
  console.log(JSON.stringify({
    status: result.status,
    targetSeason: result.targetSeason,
    recommendedItems: result.recommendedItems.map(row => row.item),
    out: outPath,
    mdOut: mdOutPath
  }, null, 2));
}

main();
