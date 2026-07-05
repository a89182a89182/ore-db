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

function fmt(value, digits = 2) {
  return value == null || !Number.isFinite(Number(value)) ? '-' : Number(value).toFixed(digits);
}

function bestVariantFor(weeklyAudit, item) {
  const ranking = (weeklyAudit.recommendation && weeklyAudit.recommendation.ranking) || [];
  const row = ranking.find(entry => entry.item === item) || {};
  return row.bestVariant || ((weeklyAudit.items || {})[item] || {}).bestVariant || null;
}

function itemRiskLevel(block) {
  const verdict = block && block.verdict || '';
  const counts = block && block.counts || {};
  const clearMissRate = Number(counts.clearMissRate || 0);
  const missedTop10 = ((block && block.missedCurrentTop10) || []).length;
  if (verdict === 'strong' && clearMissRate <= 0.25 && missedTop10 <= 2) return 'green';
  if (verdict === 'needs_review' || clearMissRate > 0.6 || missedTop10 >= 6) return 'red';
  return 'yellow';
}

function riskLabel(level) {
  if (level === 'green') return 'low';
  if (level === 'yellow') return 'caution';
  return 'high';
}

function manualRecheckReason(primaryRiskLevel, backupSafetyStatus, variantBackupSafetyStatus) {
  if (primaryRiskLevel === 'red') return 'primary_high_risk';
  if (
    primaryRiskLevel === 'yellow' &&
    backupSafetyStatus === 'no_safe_backup_from_current_signal' &&
    variantBackupSafetyStatus === 'no_variant_level_safer_alternate'
  ) {
    return 'primary_caution_with_no_safe_alternate';
  }
  return null;
}

function backupCandidates(weeklyAudit, hitRateAudit, primary) {
  const ranking = (weeklyAudit.recommendation && weeklyAudit.recommendation.ranking) || [];
  const hitItems = hitRateAudit.items || {};
  return ranking
    .filter(row => row.item && row.item !== primary)
    .map(row => {
      const hit = hitItems[row.item] || {};
      const counts = hit.counts || {};
      const level = itemRiskLevel(hit);
      const variant = row.bestVariant || ((weeklyAudit.items || {})[row.item] || {}).bestVariant || {};
      return {
        item: row.item,
        variantIndex: variant.variantIndex || null,
        level,
        label: riskLabel(level),
        score: row.score == null ? null : row.score,
        clearMissRate: counts.clearMissRate == null ? null : counts.clearMissRate,
        top10: row.top10 || (hit.coverage && hit.coverage.top10) || {},
        top20: row.top20 || (hit.coverage && hit.coverage.top20) || {}
      };
    });
}

function variantRiskLevel(variant) {
  const clearMissRate = Number(variant && variant.clearMissRate);
  const usefulTop20 = Number(variant && variant.selectedUsefulTop20);
  const topScorer = Number(variant && variant.selectedTopScorer);
  const top3 = Number(variant && variant.selectedTop3);
  if (Number.isFinite(clearMissRate) && clearMissRate <= 0.25 && usefulTop20 >= 7 && (topScorer >= 1 || top3 >= 2)) {
    return 'green';
  }
  if (Number.isFinite(clearMissRate) && clearMissRate <= 0.4 && usefulTop20 >= 6 && (topScorer >= 1 || top3 >= 1)) {
    return 'yellow';
  }
  return 'red';
}

function variantBackupCandidates(weeklyAudit, hitRateAudit, primary) {
  const ranking = (weeklyAudit.recommendation && weeklyAudit.recommendation.ranking) || [];
  const hitItems = hitRateAudit.items || {};
  const scoreByItem = new Map(ranking.map((row, index) => [row.item, { score: row.score, rankIndex: index }]));
  return ranking
    .filter(row => row.item && row.item !== primary)
    .flatMap(row => {
      const hit = hitItems[row.item] || {};
      const variants = (hit.variantHitRates || []).length
        ? hit.variantHitRates
        : [row.bestVariant || ((weeklyAudit.items || {})[row.item] || {}).bestVariant || {}];
      return variants
        .filter(variant => variant && variant.variantIndex != null && variant.feasible !== false)
        .map(variant => {
          const level = variantRiskLevel(variant);
          const scoreRow = scoreByItem.get(row.item) || {};
          return {
            item: row.item,
            variantIndex: variant.variantIndex,
            level,
            label: riskLabel(level),
            score: scoreRow.score == null ? null : scoreRow.score,
            rankIndex: scoreRow.rankIndex == null ? null : scoreRow.rankIndex,
            actualValue: variant.actualValue == null ? null : variant.actualValue,
            projectedValue: variant.projectedValue == null ? null : variant.projectedValue,
            selectedTopScorer: variant.selectedTopScorer == null ? null : variant.selectedTopScorer,
            selectedTop3: variant.selectedTop3 == null ? null : variant.selectedTop3,
            selectedTop5: variant.selectedTop5 == null ? null : variant.selectedTop5,
            selectedUsefulTop20: variant.selectedUsefulTop20 == null ? null : variant.selectedUsefulTop20,
            clearMisses: variant.clearMisses == null ? null : variant.clearMisses,
            clearMissRate: variant.clearMissRate == null ? null : variant.clearMissRate
          };
        });
    })
    .sort((a, b) => {
      const levelOrder = { green: 0, yellow: 1, red: 2 };
      const clearA = a.clearMissRate == null ? Number.POSITIVE_INFINITY : Number(a.clearMissRate);
      const clearB = b.clearMissRate == null ? Number.POSITIVE_INFINITY : Number(b.clearMissRate);
      return (levelOrder[a.level] - levelOrder[b.level])
        || (clearA - clearB)
        || (Number(b.selectedUsefulTop20 || 0) - Number(a.selectedUsefulTop20 || 0))
        || (Number(b.selectedTopScorer || 0) - Number(a.selectedTopScorer || 0))
        || (Number(b.selectedTop3 || 0) - Number(a.selectedTop3 || 0))
        || (Number(b.score || 0) - Number(a.score || 0))
        || (Number(a.rankIndex || 0) - Number(b.rankIndex || 0))
        || String(a.item).localeCompare(String(b.item))
        || (Number(a.variantIndex || 0) - Number(b.variantIndex || 0));
    });
}

function formAccessFromPublicAudit(publicAudit) {
  const fantasy = publicAudit && publicAudit.fantasy || {};
  const markers = fantasy.pageMarkers || {};
  if (markers.hasPickMyTeam || markers.hasListType || markers.hasFinepix) return 'candidate_controls_detected';
  const status = publicAudit && publicAudit.status || '';
  const playerPicksStatus = fantasy.playerPicksStatus || '';
  if (/blocked/i.test(status) || /blocked/i.test(playerPicksStatus)) return 'blocked_auth_required_after_login';
  if (/available/i.test(status) && fantasy.outcomeSummaryFound) return 'outcome_page_only_no_submission_controls_detected';
  if (/available/i.test(status)) return 'available_but_submission_controls_not_detected';
  return 'not_verified';
}

function readinessStatus(primary, primaryVariant, formAccessStatus, recheckReason) {
  if (!primary || !(primaryVariant && primaryVariant.variantIndex)) return 'blocked_submission_card_missing';
  if (recheckReason === 'primary_high_risk') return 'manual_recheck_required_high_primary_risk';
  if (recheckReason === 'primary_caution_with_no_safe_alternate') return 'manual_recheck_required_no_safe_alternate';
  if (formAccessStatus === 'candidate_controls_detected') return 'ready_for_manual_form_entry';
  if (formAccessStatus === 'blocked_auth_required_after_login') return 'manual_submit_required_page_access_blocked';
  if (formAccessStatus === 'outcome_page_only_no_submission_controls_detected') return 'manual_submit_required_no_form_controls_detected';
  return 'manual_submit_required_form_unverified';
}

function buildRiskNotes(status, publicAudit, hitRateAudit) {
  const notes = [];
  const fantasy = publicAudit && publicAudit.fantasy || {};
  const publicStatus = publicAudit && publicAudit.status || '';
  if (/blocked/i.test(status) || /blocked/i.test(publicStatus) || /blocked/i.test(fantasy.playerPicksStatus || '')) {
    notes.push('ORE fantasy page access is blocked after the saved-login path; submit manually in a browser if the game UI is accessible there.');
  }
  if (fantasy.playerPicksStatus && /blocked|unavailable|not_found/i.test(fantasy.playerPicksStatus)) {
    notes.push(`Public/crowd player-pick rosters were not reviewed (${fantasy.playerPicksStatus}).`);
  }
  if (hitRateAudit && hitRateAudit.backupSafetyStatus === 'no_safe_backup_from_current_signal') {
    notes.push('No non-red backup item is available from the current hit-rate audit; keep the backup as an emergency-only lineup until a fresh rerun improves it.');
  }
  if (hitRateAudit && hitRateAudit.manualActionRequired) {
    notes.push(`Primary item ${hitRateAudit.primaryItem || ''} is ${riskLabel(hitRateAudit.primaryRiskLevel || 'red')} risk; rerun or manually recheck the item before treating it as the weekly bet.`);
  }
  if (hitRateAudit && hitRateAudit.variantBackupSafetyStatus === 'variant_level_safer_alternate_available' && hitRateAudit.variantSafeBackup) {
    const row = hitRateAudit.variantSafeBackup;
    notes.push(`Variant-level safer alternate available: ${row.item} V${row.variantIndex} (clear miss ${fmt(Number(row.clearMissRate || 0) * 100, 1)}%, useful top20 ${row.selectedUsefulTop20}/9). Treat it as a recheck/watch alternate, not an automatic replacement for the ranked backup.`);
  }
  const rootCauses = (hitRateAudit && hitRateAudit.rootCauseSummary || []).slice(0, 3)
    .map(row => `${row.cause}:${row.count}`);
  if (rootCauses.length) notes.push(`Top miss causes: ${rootCauses.join(', ')}.`);
  return notes;
}

function renderMarkdown(audit) {
  const lines = [];
  lines.push(`# ORE ${audit.targetSeason} Fantasy Submission Readiness`);
  lines.push('');
  lines.push(`Generated: ${audit.generatedAt}`);
  lines.push(`Status: ${audit.status}`);
  lines.push(`Source: season ${audit.source.season} day ${audit.source.day}; scraped at ${audit.source.scrapedAt}`);
  lines.push('');
  lines.push('## Submission card');
  lines.push(`- Submit: ${audit.submission.item} V${audit.submission.variantIndex}`);
  lines.push(`- Backup: ${audit.submission.backupItem} V${audit.submission.backupVariantIndex}`);
  lines.push(`- Backup safety: ${audit.submission.backupSafetyStatus}; risk ${audit.submission.backupRiskLabel}`);
  lines.push(`- Variant-level safer alternate: ${audit.submission.variantSafeBackupItem ? `${audit.submission.variantSafeBackupItem} V${audit.submission.variantSafeBackupVariantIndex}` : 'none'}; status ${audit.submission.variantSafeBackupStatus}`);
  lines.push(`- Primary verdict: ${audit.submission.primaryVerdict}`);
  lines.push(`- Primary risk: ${audit.submission.primaryRiskLevel}; manual recheck required: ${audit.submission.manualActionRequired ? 'yes' : 'no'}`);
  lines.push(`- Form access: ${audit.formAccessStatus}`);
  lines.push(`- Auto-submit: ${audit.doNotAutoSubmit ? 'disabled' : 'enabled'}`);
  lines.push('');
  lines.push('## Evidence');
  lines.push(`- Weekly score: ${fmt(audit.evidence.primaryScore, 2)}`);
  lines.push(`- Top10 overlap: ${audit.evidence.primaryTop10.hit}/${audit.evidence.primaryTop10.total}`);
  lines.push(`- Top20 overlap: ${audit.evidence.primaryTop20.hit}/${audit.evidence.primaryTop20.total}`);
  lines.push(`- Clear-miss rate: ${fmt(audit.evidence.primaryClearMissRate * 100, 1)}%`);
  lines.push('');
  lines.push('## Notes');
  for (const note of audit.riskNotes) lines.push(`- ${note}`);
  return `${lines.join('\n')}\n`;
}

function main() {
  const reportsDir = arg('reports-dir', path.resolve(__dirname, '..', '..', 'reports'));
  const weeklyPath = arg('weekly-items-audit');
  const hitRatePath = arg('hit-rate-audit');
  const fantasyPublicPath = arg('fantasy-public-audit');
  if (!weeklyPath) throw new Error('Missing --weekly-items-audit');
  if (!hitRatePath) throw new Error('Missing --hit-rate-audit');
  if (!fantasyPublicPath) throw new Error('Missing --fantasy-public-audit');

  const weeklyAudit = readJson(weeklyPath);
  const hitRateAudit = readJson(hitRatePath);
  const publicAudit = readJson(fantasyPublicPath);
  const source = weeklyAudit.source || {};
  const targetSeason = Number(weeklyAudit.targetSeason || (Number(source.season) + 1));
  const sourceDay = source.day == null ? null : String(source.day);
  const dayLabel = sourceDay == null ? 'dayx' : `day${sourceDay}`;
  const dateLabel = arg('date', new Date().toISOString().slice(0, 10));
  const outPath = arg('out', path.join(reportsDir, `ore_${targetSeason}_fantasy_submission_${dayLabel}_readiness_${dateLabel}.json`));
  const mdPath = arg('md-out', path.join(reportsDir, `ore_${targetSeason}_fantasy_submission_${dayLabel}_readiness_${dateLabel}.md`));

  const recommendation = weeklyAudit.recommendation || {};
  const primary = recommendation.primary || null;
  const secondary = recommendation.secondary || null;
  const primaryVariant = bestVariantFor(weeklyAudit, primary) || {};
  const secondaryVariant = bestVariantFor(weeklyAudit, secondary) || {};
  const ranking = recommendation.ranking || [];
  const primaryRanking = ranking.find(row => row.item === primary) || {};
  const hitItems = hitRateAudit.items || {};
  const primaryHit = hitItems[primary] || {};
  const secondaryHit = hitItems[secondary] || {};
  const primaryCounts = primaryHit.counts || {};
  const primaryRiskLevel = itemRiskLevel(primaryHit);
  const candidates = backupCandidates(weeklyAudit, hitRateAudit, primary);
  const safeBackup = candidates.find(row => row.level !== 'red') || null;
  const variantCandidates = variantBackupCandidates(weeklyAudit, hitRateAudit, primary);
  const variantSafeBackup = variantCandidates.find(row => row.level !== 'red') || null;
  const secondaryRiskLevel = itemRiskLevel(secondaryHit);
  const backupSafetyStatus = safeBackup
    ? (safeBackup.item === secondary ? 'ranked_backup_is_safe' : 'alternate_safe_backup_available')
    : 'no_safe_backup_from_current_signal';
  const variantBackupSafetyStatus = variantSafeBackup
    ? 'variant_level_safer_alternate_available'
    : 'no_variant_level_safer_alternate';
  const recheckReason = manualRecheckReason(primaryRiskLevel, backupSafetyStatus, variantBackupSafetyStatus);
  const manualActionRequired = Boolean(recheckReason);
  const hitRateWithBackupStatus = {
    ...hitRateAudit,
    primaryItem: primary,
    primaryRiskLevel,
    manualActionRequired,
    backupSafetyStatus,
    variantBackupSafetyStatus,
    variantSafeBackup
  };
  const formAccessStatus = formAccessFromPublicAudit(publicAudit);
  const status = readinessStatus(primary, primaryVariant, formAccessStatus, recheckReason);

  const audit = {
    generatedAt: new Date().toISOString(),
    dateLabel,
    targetSeason,
    status,
    source: {
      seasonDir: source.seasonDir || null,
      season: source.season == null ? null : String(source.season),
      day: sourceDay,
      scrapedAt: source.scrapedAt || null,
      weeklyItemsAudit: { path: weeklyPath },
      hitRateAudit: { path: hitRatePath, status: hitRateAudit.status || null },
      fantasyPublicAudit: {
        path: fantasyPublicPath,
        status: publicAudit.status || null,
        playerPicksStatus: publicAudit.fantasy && publicAudit.fantasy.playerPicksStatus || null
      }
    },
    submission: {
      item: primary,
      variantIndex: primaryVariant.variantIndex || null,
      backupItem: secondary,
      backupVariantIndex: secondaryVariant.variantIndex || null,
      primaryVerdict: primaryHit.verdict || null,
      primaryRiskLevel,
      primaryRiskLabel: riskLabel(primaryRiskLevel),
      backupVerdict: secondaryHit.verdict || null,
      backupRiskLevel: secondaryRiskLevel,
      backupRiskLabel: riskLabel(secondaryRiskLevel),
      backupSafetyStatus,
      safeBackupItem: safeBackup ? safeBackup.item : null,
      safeBackupVariantIndex: safeBackup ? safeBackup.variantIndex : null,
      safeBackupRiskLevel: safeBackup ? safeBackup.level : null,
      variantSafeBackupStatus: variantBackupSafetyStatus,
      variantSafeBackupItem: variantSafeBackup ? variantSafeBackup.item : null,
      variantSafeBackupVariantIndex: variantSafeBackup ? variantSafeBackup.variantIndex : null,
      variantSafeBackupRiskLevel: variantSafeBackup ? variantSafeBackup.level : null,
      variantSafeBackupRiskLabel: variantSafeBackup ? variantSafeBackup.label : null,
      variantSafeBackupClearMissRate: variantSafeBackup ? variantSafeBackup.clearMissRate : null,
      variantSafeBackupUsefulTop20: variantSafeBackup ? variantSafeBackup.selectedUsefulTop20 : null,
      variantSafeBackupTopScorer: variantSafeBackup ? variantSafeBackup.selectedTopScorer : null,
      variantSafeBackupTop3: variantSafeBackup ? variantSafeBackup.selectedTop3 : null,
      manualActionRequired,
      manualActionReason: recheckReason,
      action: primary && primaryVariant.variantIndex
        ? (manualActionRequired
          ? `recheck_required ${primary} V${primaryVariant.variantIndex} (${recheckReason})`
          : `submit ${primary} V${primaryVariant.variantIndex}`)
        : null,
      backupAction: secondary && secondaryVariant.variantIndex ? `backup ${secondary} V${secondaryVariant.variantIndex}${secondaryRiskLevel === 'red' ? ' (high-risk backup)' : ''}` : null
    },
    formAccessStatus,
    doNotAutoSubmit: true,
    evidence: {
      primaryScore: primaryRanking.score || null,
      primaryTop10: primaryRanking.top10 || (primaryHit.coverage && primaryHit.coverage.top10) || {},
      primaryTop20: primaryRanking.top20 || (primaryHit.coverage && primaryHit.coverage.top20) || {},
      primaryClearMisses: primaryCounts.clearMisses == null ? null : primaryCounts.clearMisses,
      primaryClearMissRate: primaryCounts.clearMissRate == null ? null : primaryCounts.clearMissRate,
      primaryBestActual: primaryVariant.actualValue == null ? null : primaryVariant.actualValue,
      primaryBestProjected: primaryVariant.projectedValue == null ? null : primaryVariant.projectedValue
    },
    backupCandidates: candidates,
    variantBackupCandidates: variantCandidates,
    riskNotes: buildRiskNotes(status, publicAudit, hitRateWithBackupStatus)
  };

  writeFile(outPath, JSON.stringify(audit, null, 2));
  writeFile(mdPath, renderMarkdown(audit));
  console.log(JSON.stringify({
    status: audit.status,
    outPath,
    mdPath,
    submit: audit.submission.action,
    backup: audit.submission.backupAction,
    backupSafetyStatus: audit.submission.backupSafetyStatus,
    variantSafeBackupStatus: audit.submission.variantSafeBackupStatus,
    variantSafeBackup: audit.submission.variantSafeBackupItem
      ? `${audit.submission.variantSafeBackupItem} V${audit.submission.variantSafeBackupVariantIndex}`
      : null,
    formAccessStatus: audit.formAccessStatus
  }, null, 2));
}

main();
