#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function arg(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find(item => item.startsWith(prefix));
  if (!found) return fallback;
  return found.slice(prefix.length);
}

function flag(name) {
  return process.argv.includes(`--${name}`);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readJsonIfExists(filePath) {
  return filePath && fs.existsSync(filePath) ? readJson(filePath) : null;
}

function argProvided(name) {
  return process.argv.some(item => item === `--${name}` || item.startsWith(`--${name}=`));
}

function writeFile(filePath, body) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body, 'utf8');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function num(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function compareText(value) {
  return String(value ?? '').trim();
}

function sameText(left, right) {
  return compareText(left) === compareText(right);
}

function comparePath(value) {
  const text = compareText(value);
  if (!text) return '';
  return path.resolve(text).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function samePath(left, right) {
  return comparePath(left) === comparePath(right);
}

function describeCompareValue(value) {
  const text = compareText(value);
  return text || '(missing)';
}

function fmt(value, digits = 2) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : '';
}

function sum(lineup, category, stat) {
  return (lineup || [])
    .filter(item => item.category === category)
    .reduce((total, item) => total + num(item.projectedStats && item.projectedStats[stat]), 0);
}

function avg(lineup, category, stat) {
  const values = (lineup || [])
    .filter(item => item.category === category)
    .map(item => num(item.projectedStats && item.projectedStats[stat], NaN))
    .filter(Number.isFinite);
  if (!values.length) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function abilityText(item) {
  const a = item.abilities || {};
  if (item.category === 'pitcher') {
    return `控${a.control ?? ''}/體${a.stamina ?? ''}/速${a.velocity ?? ''}`;
  }
  return `力${a.power ?? ''}/巧${a.contact ?? ''}/走${a.speed ?? ''}/肩${a.arm ?? ''}/守${a.defense ?? ''}`;
}

function projectionText(item, mode) {
  const p = item.projectedStats || {};
  if (item.category === 'pitcher') {
    const base = `K ${p.strikeouts ?? ''} / ERA ${p.era ?? ''}`;
    if (item.role === 'RP') {
      const usage = item.projectionMeta && item.projectionMeta.roleUsage;
      const factor = usage && usage.enabled ? ` / RP負荷 ${fmt(usage.effectiveWorkloadFactor, 3)}` : '';
      return `${base}${factor}`;
    }
    return base;
  }
  if (mode === 'K' || mode === 'ERA') return '合法補位';
  return `AVG ${p.batting_avg ?? ''} / HR ${p.home_runs ?? ''} / SB ${p.steals ?? ''}`;
}

function roleClass(role) {
  if (role === 'SP') return 'sp';
  if (role === 'RP') return 'rp';
  if (role === 'CP') return 'cp';
  return 'batter';
}

function legalityOk(report) {
  return Object.values(report.legality || {}).every(Boolean);
}

function legalitySummary(report) {
  const labels = {
    total18: '18人',
    nineBatters: '9野手',
    ninePitchers: '9投手',
    fiveSP: '5SP',
    threeRP: '3RP',
    oneCP: '1CP',
    fullBatterGrid: '守位齊全',
    twelveTeamsCovered: '12隊覆蓋',
    maxTwoPerTeam: '每隊最多2人',
    noComputerPlayers: '無電腦球員'
  };
  return Object.entries(report.legality || {})
    .map(([key, value]) => `${labels[key] || key}:${value ? '過' : '失敗'}`)
    .join(' / ');
}

function variantMetric(mode, variant) {
  const lineup = variant.lineup || [];
  if (mode === 'HR') return `batter HR ${sum(lineup, 'batter', 'home_runs')}`;
  if (mode === 'SB') return `batter SB ${sum(lineup, 'batter', 'steals')}`;
  if (mode === 'K') return `投手K ${sum(lineup, 'pitcher', 'strikeouts')}`;
  return `投手ERA ${fmt(avg(lineup, 'pitcher', 'era'), 2)}`;
}

function renderLeagueTables(projection) {
  const groups = new Map();
  for (const team of projection.teamProjections || []) {
    const league = team.league || '未分聯盟';
    if (!groups.has(league)) groups.set(league, []);
    groups.get(league).push(team);
  }
  return [...groups.entries()].map(([league, rows]) => {
    const body = rows
      .sort((a, b) => b.overallScore - a.overallScore)
      .map((team, index) => `<tr><td>${index + 1}</td><td class="player">${escapeHtml(team.team)}</td><td>${fmt(team.overallScore, 2)}</td><td>${fmt(team.rawOverallScore, 2)}</td><td>${fmt(team.sameLeagueAdjustment, 2)}</td></tr>`)
      .join('\n');
    return `<section class="league"><h2>${escapeHtml(league)}</h2><table><thead><tr><th>排名</th><th>隊伍</th><th>overall</th><th>raw</th><th>同盟調整</th></tr></thead><tbody>${body}</tbody></table></section>`;
  }).join('\n');
}

function renderAuditSummary(audit) {
  if (!audit) return '';
  const rec = audit.recommendation || {};
  const coverage = audit.coverage || {};
  const best = audit.best || {};
  const kBest = best.kVariantByCurrentK || {};
  const eraBest = best.eraVariantByCurrentWeightedEra || {};
  const kTop10 = coverage.kTop10 || {};
  const kTop20 = coverage.kTop20 || {};
  const eraTop10 = coverage.eraTop10 || {};
  const eraTop20 = coverage.eraTop20 || {};
  const missedK = ((audit.k || {}).missedCurrentTop10 || []).slice(0, 5).map(item => ({ mode: 'K', ...item }));
  const missedEra = ((audit.era || {}).missedCurrentTop10 || []).slice(0, 5).map(item => ({ mode: 'ERA', ...item }));
  const missedRows = [...missedK, ...missedEra]
    .map(item => `<tr><td>${escapeHtml(item.mode)}</td><td>${escapeHtml(item.rank)}</td><td>${escapeHtml(item.role)}</td><td>${escapeHtml(item.team)}</td><td class="player">${escapeHtml(item.name)}</td><td>${escapeHtml(item.owner)}</td><td>K ${escapeHtml(item.K ?? '')} / ERA ${escapeHtml(item.ERA ?? '')} / IP ${escapeHtml(item.IP ?? '')}</td></tr>`)
    .join('\n');
  return `<section class="section"><h2>本週項目命中訊號</h2><p>目前優先順序：<strong>${escapeHtml(rec.primary || '')}</strong>，第二順位：${escapeHtml(rec.secondary || '')}。${escapeHtml(rec.reason || '')}</p><div class="summary"><div class="card"><div class="label">K top10 命中</div><div class="value">${escapeHtml(kTop10.hit ?? '')}/${escapeHtml(kTop10.total ?? '')}</div></div><div class="card"><div class="label">K top20 命中</div><div class="value">${escapeHtml(kTop20.hit ?? '')}/${escapeHtml(kTop20.total ?? '')}</div></div><div class="card"><div class="label">ERA top10 命中</div><div class="value">${escapeHtml(eraTop10.hit ?? '')}/${escapeHtml(eraTop10.total ?? '')}</div></div><div class="card"><div class="label">ERA top20 命中</div><div class="value">${escapeHtml(eraTop20.hit ?? '')}/${escapeHtml(eraTop20.total ?? '')}</div></div></div><p>K 目前最佳版本：版本 ${escapeHtml(kBest.variantIndex ?? '')}，目前選中投手總 K ${escapeHtml(kBest.actualKTotal ?? '')}。ERA 目前最佳版本：版本 ${escapeHtml(eraBest.variantIndex ?? '')}，目前加權 ERA ${escapeHtml(fmt(eraBest.actualWeightedEra, 3))}。</p><table><thead><tr><th>項目</th><th>目前排名</th><th>角色</th><th>隊伍</th><th>球員</th><th>GM</th><th>目前成績</th></tr></thead><tbody>${missedRows}</tbody></table><p class="note">這是目前賽季進行中的訊號稽核，只用來調整本週押注優先順序；不取代合法性檢查、fresh source 驗證或投影模型。</p></section>`;
}

function renderLeagueAuditSummary(audit) {
  if (!audit) return '';
  const overall = audit.overall || {};
  const leagueCards = (audit.leagues || []).map(league => {
    return `<div class="card"><div class="label">${escapeHtml(league.league)}</div><div class="value">${escapeHtml(league.exactMatches ?? '')}/${escapeHtml(league.teamCount ?? '')} 命中</div><div class="label">平均名次誤差 ${escapeHtml(fmt(league.meanAbsRankError, 2))}</div></div>`;
  }).join('');
  const rows = (audit.leagues || []).flatMap(league => league.rows || [])
    .map(row => `<tr><td>${escapeHtml(row.league)}</td><td>${escapeHtml(row.predictedRank)}</td><td>${escapeHtml(row.currentRank)}</td><td class="player">${escapeHtml(row.team)}</td><td>${escapeHtml(row.rankDelta > 0 ? `+${row.rankDelta}` : row.rankDelta)}</td><td>${escapeHtml(fmt(row.overallScore, 2))}</td><td>${escapeHtml(row.wins)}-${escapeHtml(row.losses)}-${escapeHtml(row.ties)}</td><td>${escapeHtml(fmt(row.winPct, 3))}</td></tr>`)
    .join('\n');
  return `<section class="section"><h2>聯盟排名命中訊號</h2><p>冠軍預測：<strong>${escapeHtml(overall.projectedChampion || '')}</strong>；目前全聯盟領先：${escapeHtml(overall.currentOverallLeader || '')}。狀態：${escapeHtml(overall.status || '')}。</p><div class="summary"><div class="card"><div class="label">全體名次吻合</div><div class="value">${escapeHtml(overall.exactMatches ?? '')}/${escapeHtml(overall.teamCount ?? '')}</div></div><div class="card"><div class="label">平均名次誤差</div><div class="value">${escapeHtml(fmt(overall.meanAbsRankError, 2))}</div></div>${leagueCards}</div><table><thead><tr><th>聯盟</th><th>預測</th><th>目前</th><th>隊伍</th><th>差距</th><th>分數</th><th>戰績</th><th>勝率</th></tr></thead><tbody>${rows}</tbody></table><p class="note">這是目前戰績對預測排名的漂移監控；季中名次仍會波動，但大偏差會用來提示下次模型檢查。</p></section>`;
}

function renderLeagueRankingSubmissionCard(audit) {
  if (!audit) return '';
  const overall = audit.overall || {};
  const leagueCards = (audit.leagues || []).map(league => {
    const rows = (league.rows || [])
      .slice()
      .sort((a, b) => Number(a.predictedRank || 0) - Number(b.predictedRank || 0));
    const rankingText = rows.map(row => `${row.predictedRank}.${row.team}`).join(' > ');
    return `<div class="card"><div class="label">${escapeHtml(league.league)}</div><div class="value">${escapeHtml(league.predictedWinner || '')}</div><div class="label">${escapeHtml(rankingText)}</div></div>`;
  }).join('');
  const rows = (audit.leagues || []).flatMap(league => (league.rows || [])
    .slice()
    .sort((a, b) => Number(a.predictedRank || 0) - Number(b.predictedRank || 0))
    .map(row => ({ ...row, league: league.league })))
    .map(row => `<tr><td>${escapeHtml(row.league)}</td><td>${escapeHtml(row.predictedRank)}</td><td class="player">${escapeHtml(row.team)}</td><td>${escapeHtml(row.currentRank ?? '')}</td><td>${escapeHtml(row.rankDelta > 0 ? `+${row.rankDelta}` : row.rankDelta)}</td><td>${escapeHtml(fmt(row.overallScore, 2))}</td></tr>`)
    .join('\n');
  const watchRows = (audit.leagues || []).flatMap(league => (league.largestMisses || [])
    .map(row => ({ ...row, league: league.league })));
  const watchList = watchRows.length
    ? watchRows.map(row => `<li>${escapeHtml(row.league)} ${escapeHtml(row.team)}: submit rank ${escapeHtml(row.predictedRank)}, current rank ${escapeHtml(row.currentRank)}, delta ${escapeHtml(row.rankDelta > 0 ? `+${row.rankDelta}` : row.rankDelta)}</li>`).join('')
    : '<li>No material league-rank drift currently flagged.</li>';
  return `<section class="section"><h2>League ranking submission card</h2><p>Submit champion: <strong>${escapeHtml(overall.projectedChampion || '')}</strong>. Current alignment: ${escapeHtml(overall.status || '')}; exact rank matches ${escapeHtml(overall.exactMatches ?? '')}/${escapeHtml(overall.teamCount ?? '')}; mean rank error ${escapeHtml(fmt(overall.meanAbsRankError, 3))}.</p><div class="summary"><div class="card"><div class="label">Champion pick</div><div class="value">${escapeHtml(overall.projectedChampion || '')}</div></div><div class="card"><div class="label">Current leader</div><div class="value">${escapeHtml(overall.currentOverallLeader || '')}</div></div><div class="card"><div class="label">Exact ranks</div><div class="value">${escapeHtml(overall.exactMatches ?? '')}/${escapeHtml(overall.teamCount ?? '')}</div></div><div class="card"><div class="label">Mean rank error</div><div class="value">${escapeHtml(fmt(overall.meanAbsRankError, 3))}</div></div>${leagueCards}</div><table><thead><tr><th>League</th><th>Submit rank</th><th>Team</th><th>Current rank</th><th>Delta</th><th>Score</th></tr></thead><tbody>${rows}</tbody></table><h3>Watch list</h3><ul>${watchList}</ul><p class="note">This is the operational league-ranking card for the season prediction prize. Use the submit rank order unless a later fresh monitor shows a material drift or source change.</p></section>`;
}

function renderLeagueConfidenceAuditSummary(audit) {
  if (!audit) return '';
  const overall = audit.overall || {};
  const summary = audit.summary || {};
  const rows = (audit.leagues || []).flatMap(league => (league.rows || [])
    .slice()
    .sort((a, b) => Number(a.submitRank || 0) - Number(b.submitRank || 0))
    .map(row => ({ ...row, league: league.league })))
    .map(row => `<tr><td>${escapeHtml(row.league)}</td><td>${escapeHtml(row.submitRank ?? '')}</td><td class="player">${escapeHtml(row.team)}</td><td>${escapeHtml(row.currentRank ?? '')}</td><td>${escapeHtml(row.rankDelta > 0 ? `+${row.rankDelta}` : row.rankDelta)}</td><td>${escapeHtml(row.confidence || '')}</td><td>${escapeHtml(row.decision || '')}</td><td>${escapeHtml(fmt(row.overallScore, 2))}</td><td>${escapeHtml(fmt(row.driftScoreGap, 2))}</td></tr>`)
    .join('\n');
  const holdList = (audit.holdProjectionItems || []).length
    ? (audit.holdProjectionItems || []).map(row => `<li>${escapeHtml(row.league)} ${escapeHtml(row.team)}: hold projection, submit rank ${escapeHtml(row.submitRank)}, current rank ${escapeHtml(row.currentRank)}, drift score gap ${escapeHtml(fmt(row.driftScoreGap, 2))}</li>`).join('')
    : '<li>No current drift requires a hold-projection note.</li>';
  const watchList = (audit.watchItems || []).length
    ? (audit.watchItems || []).map(row => `<li>${escapeHtml(row.league)} ${escapeHtml(row.team)}: ${escapeHtml(row.confidence || '')}; ${escapeHtml(row.decision || '')}; submit rank ${escapeHtml(row.submitRank)}, current rank ${escapeHtml(row.currentRank)}</li>`).join('')
    : '<li>No swap-watch items currently flagged.</li>';
  return `<section class="section"><h2>League ranking confidence and swap watch</h2><p>Decision: <strong>${escapeHtml(overall.decision || '')}</strong>. Champion confidence: <strong>${escapeHtml(overall.championConfidence || '')}</strong>; champion gap to second ${escapeHtml(fmt(overall.championGapToSecond, 2))}; current alignment ${escapeHtml(overall.currentAlignment || '')}.</p><div class="summary"><div class="card"><div class="label">Confidence status</div><div class="value">${escapeHtml(audit.status || '')}</div></div><div class="card"><div class="label">Champion confidence</div><div class="value">${escapeHtml(overall.championConfidence || '')}</div></div><div class="card"><div class="label">Hold projection</div><div class="value">${escapeHtml(summary.holdProjectionCount ?? 0)}</div></div><div class="card"><div class="label">Swap watch</div><div class="value">${escapeHtml(summary.swapWatchCount ?? 0)}</div></div></div><table><thead><tr><th>League</th><th>Submit rank</th><th>Team</th><th>Current rank</th><th>Delta</th><th>Confidence</th><th>Decision</th><th>Score</th><th>Drift gap</th></tr></thead><tbody>${rows}</tbody></table><h3>Hold projection notes</h3><ul>${holdList}</ul><h3>Swap watch notes</h3><ul>${watchList}</ul><p class="note">This confidence layer separates normal current-standings drift from true reorder risk. Keep the league submission card unless a later fresh monitor moves a drift item into swap_watch or changes the champion confidence.</p></section>`;
}

function renderFinalSubmissionChecklist(weeklyAudit, hitRateAudit, submissionReadinessAudit, leagueAudit, leagueConfidenceAudit) {
  if (!weeklyAudit || !hitRateAudit || !submissionReadinessAudit || !leagueAudit || !leagueConfidenceAudit) return '';
  const rec = weeklyAudit.recommendation || {};
  const ranking = rec.ranking || [];
  const rowByItem = new Map(ranking.map(row => [row.item, row]));
  const primary = rec.primary || '';
  const secondary = rec.secondary || '';
  const primaryRow = rowByItem.get(primary) || {};
  const secondaryRow = rowByItem.get(secondary) || {};
  const primaryVariant = primaryRow.bestVariant || ((weeklyAudit.items || {})[primary] || {}).bestVariant || {};
  const secondaryVariant = secondaryRow.bestVariant || ((weeklyAudit.items || {})[secondary] || {}).bestVariant || {};
  const primaryHit = ((hitRateAudit.items || {})[primary]) || {};
  const readinessSubmission = submissionReadinessAudit.submission || {};
  const leagueOverall = leagueAudit.overall || {};
  const confidenceOverall = leagueConfidenceAudit.overall || {};
  const confidenceSummary = leagueConfidenceAudit.summary || {};
  const rankingRows = (leagueAudit.leagues || []).map(league => {
    const order = (league.rows || [])
      .slice()
      .sort((a, b) => Number(a.predictedRank || 0) - Number(b.predictedRank || 0))
      .map(row => row.team)
      .join(' > ');
    return `<tr><td>${escapeHtml(league.league)}</td><td>${escapeHtml(order)}</td><td>${escapeHtml(league.exactMatches ?? '')}/${escapeHtml(league.teamCount ?? '')}</td><td>${escapeHtml(fmt(league.meanAbsRankError, 3))}</td></tr>`;
  }).join('\n');
  const holdNotes = (leagueConfidenceAudit.holdProjectionItems || []).length
    ? (leagueConfidenceAudit.holdProjectionItems || []).map(row => `${row.league} ${row.team} hold projection gap ${fmt(row.driftScoreGap, 2)}`).join('; ')
    : 'none';
  const primaryVersion = primaryVariant.variantIndex ? `V${primaryVariant.variantIndex}` : '-';
  const backupVersion = secondaryVariant.variantIndex ? `V${secondaryVariant.variantIndex}` : '-';
  const readinessAction = readinessSubmission.action || (primary ? `submit ${primary} ${primaryVersion}` : '');
  const backupAction = readinessSubmission.backupAction || (secondary ? `backup ${secondary} ${backupVersion}` : '');
  const backupSafetyStatus = readinessSubmission.backupSafetyStatus || 'not_recorded';
  const backupSafetyDisplay = backupSafetyStatus === 'no_safe_backup_from_current_signal'
    ? 'no safe backup'
    : backupSafetyStatus === 'ranked_backup_is_safe'
      ? 'ranked backup safe'
      : backupSafetyStatus === 'alternate_safe_backup_available'
        ? 'alternate safe backup'
        : backupSafetyStatus;
  const backupRiskText = readinessSubmission.backupRiskLabel ? `${readinessSubmission.backupRiskLabel} risk` : '';
  const safeBackupText = readinessSubmission.safeBackupItem
    ? `${readinessSubmission.safeBackupItem} V${readinessSubmission.safeBackupVariantIndex ?? ''}`
    : 'none';
  const variantAlternateText = readinessSubmission.variantSafeBackupItem
    ? `${readinessSubmission.variantSafeBackupItem} V${readinessSubmission.variantSafeBackupVariantIndex ?? ''}`
    : 'none';
  const variantAlternateStatus = readinessSubmission.variantSafeBackupStatus || 'not_recorded';
  const variantAlternateNote = readinessSubmission.variantSafeBackupItem
    ? `clear miss ${fmt(Number(readinessSubmission.variantSafeBackupClearMissRate || 0) * 100, 1)}%; useful top20 ${readinessSubmission.variantSafeBackupUsefulTop20 ?? ''}/9`
    : 'no variant-level safer alternate';
  const rows = [
    ['Weekly item', readinessAction, primaryHit.verdict || '', `${backupAction}; readiness ${submissionReadinessAudit.status || ''}`],
    ['Backup safety', backupSafetyDisplay, backupRiskText, `safe backup candidate ${safeBackupText}`],
    ['Variant-level safer alternate', variantAlternateText, variantAlternateStatus, variantAlternateNote],
    ['Manual status', submissionReadinessAudit.doNotAutoSubmit ? 'Manual browser submission required' : 'Form controls available', submissionReadinessAudit.formAccessStatus || '', `doNotAutoSubmit=${submissionReadinessAudit.doNotAutoSubmit ? 'true' : 'false'}`],
    ['Champion', leagueOverall.projectedChampion || confidenceOverall.champion || '', confidenceOverall.championConfidence || '', `decision ${confidenceOverall.decision || ''}; gap ${fmt(confidenceOverall.championGapToSecond, 2)}`],
    ['League ranks', 'Use the two league orders below', leagueConfidenceAudit.status || '', `hold projection ${confidenceSummary.holdProjectionCount ?? 0}; swap watch ${confidenceSummary.swapWatchCount ?? 0}`]
  ].map(row => `<tr><td class="player">${escapeHtml(row[0])}</td><td>${escapeHtml(row[1])}</td><td>${escapeHtml(row[2])}</td><td>${escapeHtml(row[3])}</td></tr>`).join('\n');
  return `<section class="section"><h2>Final submission checklist</h2><p>Use this first-page checklist for the current weekly prize and league-ranking prize. Fresh source season ${escapeHtml((weeklyAudit.source || {}).season ?? '')} day ${escapeHtml((weeklyAudit.source || {}).day ?? '')}; fantasy form access is ${escapeHtml(submissionReadinessAudit.formAccessStatus || '')}.</p><div class="summary"><div class="card"><div class="label">Submit weekly item</div><div class="value">${escapeHtml(primary)} ${escapeHtml(primaryVersion)}</div></div><div class="card"><div class="label">Backup item</div><div class="value">${escapeHtml(secondary)} ${escapeHtml(backupVersion)}</div></div><div class="card"><div class="label">Backup safety</div><div class="value">${escapeHtml(backupSafetyDisplay)}</div></div><div class="card"><div class="label">Safer alternate</div><div class="value">${escapeHtml(variantAlternateText)}</div></div><div class="card"><div class="label">Champion</div><div class="value">${escapeHtml(leagueOverall.projectedChampion || '')}</div></div><div class="card"><div class="label">League confidence</div><div class="value">${escapeHtml(confidenceOverall.championConfidence || '')}</div></div></div><table><thead><tr><th>Field</th><th>Fill / action</th><th>Status</th><th>Note</th></tr></thead><tbody>${rows}</tbody></table><table><thead><tr><th>League</th><th>Submit order</th><th>Exact</th><th>Mean error</th></tr></thead><tbody>${rankingRows}</tbody></table><p class="note">Ranking drift note: ${escapeHtml(holdNotes)}. Re-run the monitor if the source day changes before entering the form.</p></section>`;
}

function renderFreshnessGuard(projection, weeklyAudit, submissionReadinessAudit, generatedAtIso) {
  if (!projection || !weeklyAudit) return '';
  const source = projection.sourceSnapshot || {};
  const auditSource = weeklyAudit.source || {};
  const draftKeys = ['hr', 'sb', 'k', 'era'];
  const draftStatus = key => {
    const block = auditSource[key] || {};
    return {
      item: key.toUpperCase(),
      sourceType: block.liveSourceType || 'missing',
      liveFetchSucceeded: block.liveFetchSucceeded === true,
      fallbackReason: block.fallbackReason || '',
      entryCount: block.fantasyGrid ? block.fantasyGrid.entryCount : null
    };
  };
  const draftRows = draftKeys.map(key => {
    const row = draftStatus(key);
    const status = row.sourceType === 'live_fetch' && row.liveFetchSucceeded ? 'ready' : 'recheck';
    return `<tr><td>${escapeHtml(row.item)}</td><td>${escapeHtml(row.sourceType)}</td><td>${escapeHtml(status)}</td><td>${escapeHtml(row.entryCount ?? '')}</td><td>${escapeHtml(row.fallbackReason)}</td></tr>`;
  }).join('\n');
  const liveFetchAll = draftKeys.every(key => {
    const row = draftStatus(key);
    return row.sourceType === 'live_fetch' && row.liveFetchSucceeded;
  });
  const freshnessStatus = source.sourceFreshnessStatus || 'not recorded';
  const summaryStatus = source.sourceFreshnessSummaryStatus || '';
  const historyStatus = source.sourceFreshnessHistoryStatus || '';
  const freshCount = source.sourceFreshTeisatuCount ?? '';
  const cacheCount = source.sourceCacheTeisatuCount ?? '';
  const scrapedAt = source.scrapedAt || auditSource.scrapedAt || '';
  const submissionStatus = submissionReadinessAudit ? submissionReadinessAudit.status || '' : '';
  const formStatus = submissionReadinessAudit ? submissionReadinessAudit.formAccessStatus || '' : '';
  return `<section class="section"><h2>Freshness guard</h2><p>This guard records the exact source snapshot behind the submission checklist. Re-run the monitor before submitting if the game advances to a new season/day, if a newer scrape timestamp appears, or if the fantasy form becomes accessible after being blocked.</p><div class="summary"><div class="card"><div class="label">Source snapshot</div><div class="value">season ${escapeHtml(source.season ?? auditSource.season ?? '')} day ${escapeHtml(source.day ?? auditSource.day ?? '')}</div></div><div class="card"><div class="label">Scraped at</div><div class="value">${escapeHtml(scrapedAt)}</div></div><div class="card"><div class="label">Fresh scrape</div><div class="value">${escapeHtml(freshnessStatus)}</div></div><div class="card"><div class="label">Draft source</div><div class="value">${liveFetchAll ? 'live_fetch all' : 'recheck'}</div></div></div><table><thead><tr><th>Check</th><th>Status</th><th>Detail</th><th>Submit action</th></tr></thead><tbody><tr><td>Source identity</td><td>${escapeHtml(source.season ?? auditSource.season ?? '')}/${escapeHtml(source.day ?? auditSource.day ?? '')}</td><td>scrapedAt ${escapeHtml(scrapedAt)}</td><td>Use only while this matches the live game day.</td></tr><tr><td>Web scrape freshness</td><td>${escapeHtml(freshnessStatus)}</td><td>teisatu fresh ${escapeHtml(freshCount)}; cache ${escapeHtml(cacheCount)}; summary ${escapeHtml(summaryStatus)}; history ${escapeHtml(historyStatus)}</td><td>Re-run if this is not fresh_web_scrape.</td></tr><tr><td>Submission readiness</td><td>${escapeHtml(submissionStatus)}</td><td>form access ${escapeHtml(formStatus)}</td><td>Manual browser action remains required when blocked.</td></tr><tr><td>Rerun trigger</td><td>mandatory</td><td>source season/day/scrapedAt changed, or new result day opened</td><td>Discard this checklist and publish a fresh one.</td></tr></tbody></table><table><thead><tr><th>Item</th><th>Fantasy source</th><th>Status</th><th>Grid entries</th><th>Fallback reason</th></tr></thead><tbody>${draftRows}</tbody></table></section>`;
}

function reportForItem(item, reports) {
  const key = String(item || '').toUpperCase();
  return reports[key] || null;
}

function findLineupVariant(report, variantIndex) {
  if (!report || variantIndex == null) return null;
  return (report.lineupVariants || []).find(variant => String(variant.variantIndex) === String(variantIndex)) || null;
}

function renderSelectedLineupTable(mode, variant) {
  if (!variant) return '<p class="note">Selected variant was not found in the rendered draft artifact.</p>';
  const rows = (variant.lineup || []).map((item, index) => {
    const skills = (item.skills || []).join('、');
    return `<tr class="selected-lineup-row"><td>${index + 1}</td><td>${escapeHtml(item.role)}</td><td>${escapeHtml(item.team)}</td><td class="player">${escapeHtml(item.name)}</td><td>${escapeHtml(item.owner)}</td><td class="skills">${escapeHtml(skills)}</td><td>${escapeHtml(projectionText(item, mode))}</td></tr>`;
  }).join('\n');
  return `<table><thead><tr><th>#</th><th>Position</th><th>Team</th><th>Player</th><th>GM</th><th>Skills</th><th>Projection</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function selectedLineupCopyLines(mode, variant) {
  if (!variant) return [];
  return (variant.lineup || []).map((item, index) => {
    const skills = (item.skills || []).join('、');
    return [
      String(index + 1).padStart(2, '0'),
      item.role || '',
      item.team || '',
      item.name || '',
      item.owner || '',
      projectionText(item, mode),
      skills
    ].join('\t');
  });
}

function renderSelectedLineupCopyBlock(label, mode, variantIndex, variant) {
  const lines = selectedLineupCopyLines(mode, variant);
  const header = '#\tPosition\tTeam\tPlayer\tGM\tProjection\tSkills';
  const body = [header, ...lines].join('\n');
  return `<div class="copy-panel"><div class="copy-title">${escapeHtml(label)} copy lines: ${escapeHtml(mode)} V${escapeHtml(variantIndex ?? '')} (${escapeHtml(lines.length)} rows)</div><pre class="copy-block selected-lineup-copy">${escapeHtml(body)}</pre></div>`;
}

function renderSelectedSubmissionLineup(submissionReadinessAudit, reports) {
  if (!submissionReadinessAudit) return '';
  const submission = submissionReadinessAudit.submission || {};
  const primaryItem = submission.item || '';
  const primaryVariantIndex = submission.variantIndex;
  const backupItem = submission.backupItem || '';
  const backupVariantIndex = submission.backupVariantIndex;
  const primaryVariant = findLineupVariant(reportForItem(primaryItem, reports), primaryVariantIndex);
  const backupVariant = findLineupVariant(reportForItem(backupItem, reports), backupVariantIndex);
  const primaryRows = primaryVariant ? (primaryVariant.lineup || []).length : 0;
  const backupRows = backupVariant ? (backupVariant.lineup || []).length : 0;
  return `<section class="section"><h2>Selected submission lineup</h2><p>Copy these player rows for the manual ORE fantasy form. Auto-submit remains disabled; this section only moves the validated primary and backup lineups to the first page.</p><div class="summary"><div class="card"><div class="label">Primary lineup</div><div class="value">${escapeHtml(primaryItem)} V${escapeHtml(primaryVariantIndex ?? '')}</div></div><div class="card"><div class="label">Primary rows</div><div class="value">${escapeHtml(primaryRows)}</div></div><div class="card"><div class="label">Backup lineup</div><div class="value">${escapeHtml(backupItem)} V${escapeHtml(backupVariantIndex ?? '')}</div></div><div class="card"><div class="label">Backup rows</div><div class="value">${escapeHtml(backupRows)}</div></div></div>${renderSelectedLineupCopyBlock('Primary', primaryItem, primaryVariantIndex, primaryVariant)}<h3>Primary: ${escapeHtml(primaryItem)} V${escapeHtml(primaryVariantIndex ?? '')}</h3>${renderSelectedLineupTable(primaryItem, primaryVariant)}${renderSelectedLineupCopyBlock('Backup', backupItem, backupVariantIndex, backupVariant)}<h3>Backup: ${escapeHtml(backupItem)} V${escapeHtml(backupVariantIndex ?? '')}</h3>${renderSelectedLineupTable(backupItem, backupVariant)}<p class="note">If the game source season/day/scrapedAt changes, rerun the weekly monitor before copying this lineup.</p></section>`;
}

function renderWeeklyItemsAuditSummary(audit) {
  if (!audit) return '';
  const rec = audit.recommendation || {};
  const ranking = rec.ranking || [];
  const metricValue = (item, value) => {
    if (value == null || !Number.isFinite(Number(value))) return '-';
    return item === 'ERA' ? fmt(value, 3) : String(Math.round(Number(value)));
  };
  const cards = ranking.slice(0, 4).map(row => {
    const top10 = row.top10 || {};
    const top20 = row.top20 || {};
    return `<div class="card"><div class="label">${escapeHtml(row.item)} signal</div><div class="value">${escapeHtml(fmt(row.score, 2))}</div><div class="label">top10 ${escapeHtml(top10.hit ?? '')}/${escapeHtml(top10.total ?? '')} / top20 ${escapeHtml(top20.hit ?? '')}/${escapeHtml(top20.total ?? '')}</div></div>`;
  }).join('');
  const rows = ranking.map((row, index) => {
    const top10 = row.top10 || {};
    const top20 = row.top20 || {};
    const best = row.bestVariant ? `V${row.bestVariant.variantIndex} ${metricValue(row.item, row.bestVariant.actualValue)}` : '-';
    return `<tr><td>${index + 1}</td><td class="player">${escapeHtml(row.item)}</td><td>${escapeHtml(fmt(row.score, 2))}</td><td>${escapeHtml(top10.hit ?? '')}/${escapeHtml(top10.total ?? '')}</td><td>${escapeHtml(top20.hit ?? '')}/${escapeHtml(top20.total ?? '')}</td><td>${escapeHtml(best)}</td><td>${escapeHtml(row.reason || '')}</td></tr>`;
  }).join('\n');
  return `<section class="section"><h2>Weekly HR/SB/K/ERA signal</h2><p>Primary weekly item: <strong>${escapeHtml(rec.primary || '')}</strong>; secondary: ${escapeHtml(rec.secondary || '')}. ${escapeHtml(rec.reason || '')}</p><div class="summary">${cards}</div><table><thead><tr><th>#</th><th>Item</th><th>Score</th><th>Top10</th><th>Top20</th><th>Best current variant</th><th>Reason</th></tr></thead><tbody>${rows}</tbody></table><p class="note">This scanner compares current partial-season leaders against legal HR, SB, K, and ERA draft variants. It is the weekly item-priority monitor; legality, fresh source validation, and the projection model still remain mandatory gates.</p></section>`;
}

function renderWeeklySubmissionCard(weeklyAudit, hitRateAudit) {
  if (!weeklyAudit || !hitRateAudit) return '';
  const rec = weeklyAudit.recommendation || {};
  const ranking = rec.ranking || [];
  const itemOrder = ['HR', 'SB', 'K', 'ERA'];
  const metricValue = (item, value) => {
    if (value == null || !Number.isFinite(Number(value))) return '-';
    return item === 'ERA' ? fmt(value, 3) : String(Math.round(Number(value)));
  };
  const rowByItem = new Map(ranking.map(row => [row.item, row]));
  const hitItems = hitRateAudit.items || {};
  const primary = rec.primary || '';
  const secondary = rec.secondary || '';
  const primaryRow = rowByItem.get(primary) || {};
  const secondaryRow = rowByItem.get(secondary) || {};
  const primaryHit = hitItems[primary] || {};
  const primaryVariant = primaryRow.bestVariant || ((weeklyAudit.items || {})[primary] || {}).bestVariant || {};
  const secondaryVariant = secondaryRow.bestVariant || ((weeklyAudit.items || {})[secondary] || {}).bestVariant || {};
  const actionFor = item => {
    if (item === primary) return 'submit';
    if (item === secondary) return 'backup';
    const verdict = (hitItems[item] || {}).verdict || '';
    if (verdict === 'strong' || verdict === 'usable') return 'watch';
    return 'avoid unless late signal improves';
  };
  const rows = itemOrder.map(item => {
    const row = rowByItem.get(item) || {};
    const best = row.bestVariant || ((weeklyAudit.items || {})[item] || {}).bestVariant || {};
    const hit = hitItems[item] || {};
    const counts = hit.counts || {};
    const top10 = row.top10 || (hit.coverage && hit.coverage.top10) || {};
    const top20 = row.top20 || (hit.coverage && hit.coverage.top20) || {};
    const variantLabel = best.variantIndex ? `V${best.variantIndex}` : '-';
    return `<tr><td class="player">${escapeHtml(item)}</td><td>${escapeHtml(actionFor(item))}</td><td>${escapeHtml(variantLabel)}</td><td>${escapeHtml(hit.verdict || '')}</td><td>${escapeHtml(fmt(row.score, 2))}</td><td>${escapeHtml(metricValue(item, best.actualValue))}</td><td>${escapeHtml(metricValue(item, best.projectedValue))}</td><td>${escapeHtml(top10.hit ?? '')}/${escapeHtml(top10.total ?? '')}</td><td>${escapeHtml(top20.hit ?? '')}/${escapeHtml(top20.total ?? '')}</td><td>${escapeHtml(counts.clearMisses ?? '')} (${escapeHtml(fmt(Number(counts.clearMissRate || 0) * 100, 0))}%)</td></tr>`;
  }).join('\n');
  const primaryVersion = primaryVariant.variantIndex ? `V${primaryVariant.variantIndex}` : '-';
  const backupVersion = secondaryVariant.variantIndex ? `V${secondaryVariant.variantIndex}` : '-';
  return `<section class="section"><h2>Weekly submission card</h2><p>Submit <strong>${escapeHtml(primary)}</strong> ${escapeHtml(primaryVersion)} first. Backup: ${escapeHtml(secondary)} ${escapeHtml(backupVersion)}. Current primary verdict: <strong>${escapeHtml(primaryHit.verdict || '')}</strong>.</p><div class="summary"><div class="card"><div class="label">Submit item</div><div class="value">${escapeHtml(primary)}</div></div><div class="card"><div class="label">Recommended version</div><div class="value">${escapeHtml(primaryVersion)}</div></div><div class="card"><div class="label">Backup item</div><div class="value">${escapeHtml(secondary)} ${escapeHtml(backupVersion)}</div></div><div class="card"><div class="label">Decision basis</div><div class="value">fresh results</div></div></div><table><thead><tr><th>Item</th><th>Action</th><th>Version</th><th>Verdict</th><th>Score</th><th>Current</th><th>Projected</th><th>Top10</th><th>Top20</th><th>Clear misses</th></tr></thead><tbody>${rows}</tbody></table><p class="note">Use this as the operational pick card for the weekly prize target. Re-run the monitor before submission if the ORE day/source changes, if HR stops being strong, or if public player-pick pages become accessible and contradict the current result signal.</p></section>`;
}

function itemRiskLevel(block) {
  const verdict = block.verdict || '';
  const counts = block.counts || {};
  const clearMissRate = Number(counts.clearMissRate || 0);
  const missedTop10 = (block.missedCurrentTop10 || []).length;
  if (verdict === 'strong' && clearMissRate <= 0.25 && missedTop10 <= 2) return 'green';
  if (verdict === 'needs_review' || clearMissRate > 0.6 || missedTop10 >= 6) return 'red';
  return 'yellow';
}

function itemRiskAction(item, primary, secondary, level) {
  if (item === primary && level === 'green') return 'submit primary';
  if (item === primary) return 'submit only after fresh rerun';
  if (item === secondary && level !== 'red') return 'backup only';
  if (item === secondary) return 'backup only with caution';
  if (level === 'green') return 'watch';
  return 'avoid this week';
}

function riskLabel(level) {
  if (level === 'green') return 'low';
  if (level === 'yellow') return 'caution';
  return 'high';
}

function riskCandidates(weeklyAudit, hitRateAudit, primary) {
  const ranking = weeklyAudit && weeklyAudit.recommendation ? weeklyAudit.recommendation.ranking || [] : [];
  const items = hitRateAudit && hitRateAudit.items ? hitRateAudit.items : {};
  return ranking
    .filter(row => row.item && row.item !== primary)
    .map(row => {
      const block = items[row.item] || {};
      const level = itemRiskLevel(block);
      return {
        item: row.item,
        variantIndex: row.bestVariant ? row.bestVariant.variantIndex : null,
        level,
        label: riskLabel(level),
        score: row.score
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

function variantRiskCandidates(weeklyAudit, hitRateAudit, primary) {
  const ranking = weeklyAudit && weeklyAudit.recommendation ? weeklyAudit.recommendation.ranking || [] : [];
  const items = hitRateAudit && hitRateAudit.items ? hitRateAudit.items : {};
  const scoreByItem = new Map(ranking.map((row, index) => [row.item, { score: row.score, rankIndex: index }]));
  return ranking
    .filter(row => row.item && row.item !== primary)
    .flatMap(row => {
      const block = items[row.item] || {};
      const variants = (block.variantHitRates || []).length
        ? block.variantHitRates
        : [row.bestVariant || {}];
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

function backupSafetyStatus(weeklyAudit, hitRateAudit) {
  const rec = weeklyAudit && weeklyAudit.recommendation ? weeklyAudit.recommendation : {};
  const primary = rec.primary || '';
  const secondary = rec.secondary || '';
  const candidates = riskCandidates(weeklyAudit, hitRateAudit, primary);
  const safeBackup = candidates.find(row => row.level !== 'red') || null;
  if (!safeBackup) {
    return {
      status: 'no_safe_backup_from_current_signal',
      label: 'no safe backup',
      safeBackupItem: null,
      safeBackupVariantIndex: null
    };
  }
  return {
    status: safeBackup.item === secondary ? 'ranked_backup_is_safe' : 'alternate_safe_backup_available',
    label: safeBackup.item === secondary ? 'ranked backup safe' : 'alternate safe backup',
    safeBackupItem: safeBackup.item,
    safeBackupVariantIndex: safeBackup.variantIndex
  };
}

function variantBackupSafetyStatus(weeklyAudit, hitRateAudit) {
  const rec = weeklyAudit && weeklyAudit.recommendation ? weeklyAudit.recommendation : {};
  const primary = rec.primary || '';
  const candidates = variantRiskCandidates(weeklyAudit, hitRateAudit, primary);
  const safeBackup = candidates.find(row => row.level !== 'red') || null;
  if (!safeBackup) {
    return {
      status: 'no_variant_level_safer_alternate',
      label: 'none',
      safeBackupItem: null,
      safeBackupVariantIndex: null,
      safeBackupRiskLevel: null,
      safeBackupClearMissRate: null,
      safeBackupUsefulTop20: null
    };
  }
  return {
    status: 'variant_level_safer_alternate_available',
    label: `${safeBackup.item} V${safeBackup.variantIndex}`,
    safeBackupItem: safeBackup.item,
    safeBackupVariantIndex: safeBackup.variantIndex,
    safeBackupRiskLevel: safeBackup.level,
    safeBackupClearMissRate: safeBackup.clearMissRate,
    safeBackupUsefulTop20: safeBackup.selectedUsefulTop20,
    safeBackupTopScorer: safeBackup.selectedTopScorer,
    safeBackupTop3: safeBackup.selectedTop3
  };
}

function renderWeeklyItemRiskGate(weeklyAudit, hitRateAudit) {
  if (!weeklyAudit || !hitRateAudit) return '';
  const rec = weeklyAudit.recommendation || {};
  const primary = rec.primary || '';
  const secondary = rec.secondary || '';
  const items = hitRateAudit.items || {};
  const backupSafety = backupSafetyStatus(weeklyAudit, hitRateAudit);
  const variantBackupSafety = variantBackupSafetyStatus(weeklyAudit, hitRateAudit);
  const variantAlternateText = variantBackupSafety.safeBackupItem
    ? `${variantBackupSafety.safeBackupItem} V${variantBackupSafety.safeBackupVariantIndex}`
    : 'none';
  const variantAlternateNote = variantBackupSafety.safeBackupItem
    ? `Variant-level safer alternate: ${variantAlternateText} (clear miss ${fmt(Number(variantBackupSafety.safeBackupClearMissRate || 0) * 100, 1)}%, useful top20 ${variantBackupSafety.safeBackupUsefulTop20}/9). Treat it as a recheck/watch alternate because item-level backup safety remains separate.`
    : 'Variant-level safer alternate: none from the current hit-rate audit.';
  const order = ['HR', 'K', 'SB', 'ERA'];
  const rows = order.map(item => {
    const block = items[item] || {};
    const counts = block.counts || {};
    const top10 = block.coverage && block.coverage.top10 ? block.coverage.top10 : {};
    const top20 = block.coverage && block.coverage.top20 ? block.coverage.top20 : {};
    const missedTop10 = (block.missedCurrentTop10 || []).length;
    const level = itemRiskLevel(block);
    return `<tr class="risk-${escapeHtml(level)}"><td class="player">${escapeHtml(item)}</td><td>${escapeHtml(riskLabel(level))}</td><td>${escapeHtml(itemRiskAction(item, primary, secondary, level))}</td><td>${escapeHtml(block.verdict || '')}</td><td>${escapeHtml(fmt(Number(counts.clearMissRate || 0) * 100, 1))}%</td><td>${escapeHtml(counts.selectedUsefulTop20 ?? '')}</td><td>${escapeHtml(top10.hit ?? '')}/${escapeHtml(top10.total ?? '')}</td><td>${escapeHtml(top20.hit ?? '')}/${escapeHtml(top20.total ?? '')}</td><td>${escapeHtml(missedTop10)}</td></tr>`;
  }).join('\n');
  const primaryRisk = riskLabel(itemRiskLevel(items[primary] || {}));
  const backupRisk = riskLabel(itemRiskLevel(items[secondary] || {}));
  return `<section class="section"><h2>Weekly item risk gate</h2><p>Primary risk: <strong>${escapeHtml(primary)} ${escapeHtml(primaryRisk)}</strong>. Backup risk: <strong>${escapeHtml(secondary)} ${escapeHtml(backupRisk)}</strong>. Backup safety: <strong>${escapeHtml(backupSafety.label)}</strong>. Use the backup only if the primary item becomes stale or contradicted by a later fresh monitor.</p><div class="summary"><div class="card"><div class="label">Primary gate</div><div class="value">${escapeHtml(primaryRisk)}</div></div><div class="card"><div class="label">Backup gate</div><div class="value">${escapeHtml(backupRisk)}</div></div><div class="card"><div class="label">Backup safety</div><div class="value">${escapeHtml(backupSafety.label)}</div></div><div class="card"><div class="label">Safer alternate</div><div class="value">${escapeHtml(variantAlternateText)}</div></div><div class="card"><div class="label">Public picks</div><div class="value">${escapeHtml((hitRateAudit.source && hitRateAudit.source.fantasyPublicAudit && hitRateAudit.source.fantasyPublicAudit.playerPicksStatus) || '')}</div></div><div class="card"><div class="label">Decision</div><div class="value">submit primary</div></div></div><p class="note">${escapeHtml(variantAlternateNote)}</p><table><thead><tr><th>Item</th><th>Risk</th><th>Action</th><th>Verdict</th><th>Clear miss</th><th>Useful top20</th><th>Top10</th><th>Top20</th><th>Missed top10</th></tr></thead><tbody>${rows}</tbody></table><p class="note">This gate turns the hit-rate audit into a first-page risk warning. It does not change the validated lineup by itself; it prevents a high-miss backup item from being treated as equally safe as the primary pick.</p></section>`;
}

function renderFantasyPublicAuditSummary(audit) {
  if (!audit) return '';
  const access = audit.access || {};
  const fantasy = audit.fantasy || {};
  const winners = (fantasy.categoryWinners || [])
    .filter(item => ['HR', 'SB', 'K', 'ERA'].includes(item.item))
    .map(item => `<tr><td>${escapeHtml(item.item)}</td><td>${escapeHtml(item.rawItem || '')}</td><td class="player">${escapeHtml(item.winner || '')}</td></tr>`)
    .join('\n') || '<tr><td colspan="3">No HR/SB/K/ERA winner rows parsed.</td></tr>';
  const findings = (audit.findings || [])
    .map(item => `<li>${escapeHtml(item)}</li>`)
    .join('') || '<li>No additional findings.</li>';
  return `<section class="section"><h2>Fantasy public-page access</h2><p>Status: <strong>${escapeHtml(audit.status || '')}</strong>. ${escapeHtml(audit.reason || '')}</p><div class="summary"><div class="card"><div class="label">Public page</div><div class="value">${escapeHtml(access.publicStatus || '')}</div></div><div class="card"><div class="label">Login</div><div class="value">${access.loginSucceeded ? 'ok' : 'not ok'}</div></div><div class="card"><div class="label">Participants</div><div class="value">${escapeHtml(fantasy.participantCount ?? '')}</div></div><div class="card"><div class="label">Player picks</div><div class="value">${escapeHtml(fantasy.playerPicksStatus || '')}</div></div></div><p>Latest fantasy outcome timestamp: ${escapeHtml(fantasy.outcomeTimestamp || '')}; per-item prize: ${escapeHtml(fantasy.perItemPrize || '')}.</p><table><thead><tr><th>Item</th><th>Source label</th><th>Latest winner</th></tr></thead><tbody>${winners}</tbody></table><ul>${findings}</ul><p class="note">Crowd/player-pick rosters are treated as a consensus prior only when the site exposes them. This audit records page access and historical outcome availability separately so the weekly recommendation does not overclaim unavailable public picks.</p></section>`;
}

function renderHitRateAuditSummary(audit) {
  if (!audit) return '';
  const itemOrder = ['HR', 'SB', 'K', 'ERA'];
  const metricValue = (item, value) => {
    if (value == null || !Number.isFinite(Number(value))) return '-';
    return item === 'ERA' ? fmt(value, 3) : String(Math.round(Number(value)));
  };
  const cards = itemOrder.map(item => {
    const block = (audit.items || {})[item] || {};
    const counts = block.counts || {};
    const top10 = (block.coverage && block.coverage.top10) || {};
    return `<div class="card"><div class="label">${escapeHtml(item)} hit-rate</div><div class="value">${escapeHtml(block.verdict || '')}</div><div class="label">top10 ${escapeHtml(top10.hit ?? '')}/${escapeHtml(top10.total ?? '')}; clear misses ${escapeHtml(counts.clearMisses ?? '')}</div></div>`;
  }).join('');
  const rows = itemOrder.map(item => {
    const block = (audit.items || {})[item] || {};
    const counts = block.counts || {};
    const top10 = (block.coverage && block.coverage.top10) || {};
    const top20 = (block.coverage && block.coverage.top20) || {};
    return `<tr><td class="player">${escapeHtml(item)}</td><td>${escapeHtml(block.verdict || '')}</td><td>${escapeHtml(counts.selectedUnique ?? '')}</td><td>${escapeHtml(counts.selectedTopScorer ?? '')}</td><td>${escapeHtml(counts.selectedTop3 ?? '')}</td><td>${escapeHtml(counts.selectedTop5 ?? '')}</td><td>${escapeHtml(counts.selectedUsefulTop20 ?? '')}</td><td>${escapeHtml(counts.clearMisses ?? '')} (${escapeHtml(fmt(Number(counts.clearMissRate || 0) * 100, 0))}%)</td><td>${escapeHtml(top10.hit ?? '')}/${escapeHtml(top10.total ?? '')}</td><td>${escapeHtml(top20.hit ?? '')}/${escapeHtml(top20.total ?? '')}</td></tr>`;
  }).join('\n');
  const underperformers = itemOrder.flatMap(item => {
    const block = (audit.items || {})[item] || {};
    return (block.underperformers || []).slice(0, 3).map(row => ({ item, ...row }));
  }).slice(0, 10);
  const underRows = underperformers.length ? underperformers.map(row => {
    return `<tr><td>${escapeHtml(row.item)}</td><td>${escapeHtml(row.rank ?? '')}</td><td>${escapeHtml(row.role || '')}</td><td>${escapeHtml(row.team || '')}</td><td class="player">${escapeHtml(row.name || '')}</td><td>${escapeHtml(row.owner || '')}</td><td>${escapeHtml(metricValue(row.item, row.current))}</td><td>${escapeHtml(metricValue(row.item, row.projected))}</td><td>${escapeHtml((row.likelyCauses || []).join(', '))}</td></tr>`;
  }).join('\n') : '<tr><td colspan="9">No outside-top20 selected players found.</td></tr>';
  const causeRows = (audit.rootCauseSummary || []).slice(0, 8)
    .map(row => `<tr><td>${escapeHtml(row.cause)}</td><td>${escapeHtml(row.count)}</td></tr>`)
    .join('\n') || '<tr><td colspan="2">No root causes recorded.</td></tr>';
  const actions = (audit.modelActions || [])
    .map(item => `<li>${escapeHtml(item)}</li>`)
    .join('') || '<li>No model actions recorded.</li>';
  return `<section class="section"><h2>Fantasy hit-rate and miss review</h2><p>Status: <strong>${escapeHtml(audit.status || '')}</strong>. Primary weekly item: <strong>${escapeHtml(audit.primaryItem || '')}</strong>.</p><div class="summary">${cards}</div><table><thead><tr><th>Item</th><th>Verdict</th><th>Unique selected</th><th>Top scorer</th><th>Top3</th><th>Top5</th><th>Useful top20</th><th>Clear misses</th><th>Top10 hit</th><th>Top20 hit</th></tr></thead><tbody>${rows}</tbody></table><h3>Largest selected misses</h3><table><thead><tr><th>Item</th><th>Rank</th><th>Role</th><th>Team</th><th>Player</th><th>GM</th><th>Current</th><th>Projected</th><th>Likely causes</th></tr></thead><tbody>${underRows}</tbody></table><div class="grid-two"><div><h3>Root-cause summary</h3><table><thead><tr><th>Cause</th><th>Count</th></tr></thead><tbody>${causeRows}</tbody></table></div><div><h3>Model actions</h3><ul>${actions}</ul></div></div><p class="note">This review audits the weekly recommendation after comparing every legal HR/SB/K/ERA variant with current leaders. It separates selected top hits, useful top20 picks, outside-top20 misses, missed leaders, and likely miss causes.</p></section>`;
}

function renderSubmissionReadinessAuditSummary(audit) {
  if (!audit) return '';
  const submission = audit.submission || {};
  const evidence = audit.evidence || {};
  const backupSafety = submission.backupSafetyStatus === 'no_safe_backup_from_current_signal'
    ? 'no safe backup'
    : submission.backupSafetyStatus || '';
  const backupRisk = submission.backupRiskLabel ? `${submission.backupRiskLabel} risk` : '';
  const variantAlternateText = submission.variantSafeBackupItem
    ? `${submission.variantSafeBackupItem} V${submission.variantSafeBackupVariantIndex ?? ''}`
    : 'none';
  const variantAlternateDetail = submission.variantSafeBackupItem
    ? `Variant-level safer alternate: ${variantAlternateText}; clear miss ${fmt(Number(submission.variantSafeBackupClearMissRate || 0) * 100, 1)}%; useful top20 ${submission.variantSafeBackupUsefulTop20 ?? ''}/9.`
    : 'Variant-level safer alternate: none.';
  const notes = (audit.riskNotes || [])
    .map(note => `<li>${escapeHtml(note)}</li>`)
    .join('') || '<li>No submission readiness notes recorded.</li>';
  return `<section class="section"><h2>Fantasy submission readiness</h2><p>Status: <strong>${escapeHtml(audit.status || '')}</strong>. Action: <strong>${escapeHtml(submission.action || '')}</strong>; backup: ${escapeHtml(submission.backupAction || '')}; backup safety: ${escapeHtml(backupSafety)}; variant-level safer alternate: ${escapeHtml(variantAlternateText)}.</p><div class="summary"><div class="card"><div class="label">Submit</div><div class="value">${escapeHtml(submission.item || '')} V${escapeHtml(submission.variantIndex ?? '')}</div></div><div class="card"><div class="label">Backup</div><div class="value">${escapeHtml(submission.backupItem || '')} V${escapeHtml(submission.backupVariantIndex ?? '')}</div></div><div class="card"><div class="label">Backup safety</div><div class="value">${escapeHtml(backupSafety)}</div><div class="label">${escapeHtml(backupRisk)}</div></div><div class="card"><div class="label">Safer alternate</div><div class="value">${escapeHtml(variantAlternateText)}</div></div><div class="card"><div class="label">Form access</div><div class="value">${escapeHtml(audit.formAccessStatus || '')}</div></div><div class="card"><div class="label">Auto-submit</div><div class="value">${audit.doNotAutoSubmit ? 'disabled' : 'enabled'}</div></div></div><table><thead><tr><th>Item</th><th>Verdict</th><th>Score</th><th>Top10</th><th>Top20</th><th>Best current</th><th>Projected</th><th>Clear-miss rate</th></tr></thead><tbody><tr><td class="player">${escapeHtml(submission.item || '')}</td><td>${escapeHtml(submission.primaryVerdict || '')}</td><td>${escapeHtml(fmt(evidence.primaryScore, 2))}</td><td>${escapeHtml((evidence.primaryTop10 && evidence.primaryTop10.hit) ?? '')}/${escapeHtml((evidence.primaryTop10 && evidence.primaryTop10.total) ?? '')}</td><td>${escapeHtml((evidence.primaryTop20 && evidence.primaryTop20.hit) ?? '')}/${escapeHtml((evidence.primaryTop20 && evidence.primaryTop20.total) ?? '')}</td><td>${escapeHtml(fmt(evidence.primaryBestActual, submission.item === 'ERA' ? 3 : 0))}</td><td>${escapeHtml(fmt(evidence.primaryBestProjected, submission.item === 'ERA' ? 3 : 0))}</td><td>${escapeHtml(fmt(Number(evidence.primaryClearMissRate || 0) * 100, 1))}%</td></tr></tbody></table><p class="note">${escapeHtml(variantAlternateDetail)}</p><ul>${notes}</ul><p class="note">This is a read-only readiness audit. It records the current operational pick and whether the ORE fantasy form path appears available, but it never submits picks automatically.</p></section>`;
}

function renderLineupTable(mode, variant) {
  const rows = (variant.lineup || []).map(item => {
    return `<tr class="${roleClass(item.role)}"><td class="pos">${escapeHtml(item.role)}</td><td>${escapeHtml(item.team)}</td><td class="player">${escapeHtml(item.name)}</td><td>${escapeHtml(item.owner)}</td><td class="ability">${escapeHtml(abilityText(item))}</td><td class="skills">${escapeHtml((item.skills || []).join('、'))}</td><td>${escapeHtml(projectionText(item, mode))}</td></tr>`;
  }).join('\n');
  return `<table class="lineup"><thead><tr><th>位置</th><th>隊伍</th><th>球員</th><th>GM</th><th>能力</th><th>技能</th><th>預測</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderMode(mode, report) {
  const title = mode === 'K' ? 'K 單項 5 版' : 'ERA 單項 5 版';
  const subtitle = mode === 'K'
    ? '投手優先，投手目標只看 projected strikeouts；打者只做合法補位。'
    : '投手優先，投手目標只看 projected ERA；打者只做合法補位。';
  const variants = (report.lineupVariants || []).map(variant => {
    return `<section class="variant"><div class="variant-head"><h3>${title} - 版本 ${variant.variantIndex}</h3><div class="variant-meta"><span>${escapeHtml(variantMetric(mode, variant))}</span><span>${variant.feasible ? '合法' : '不可行'}</span><span>差異 ${escapeHtml(JSON.stringify(variant.diffFromPrevious || {}))}</span></div></div>${renderLineupTable(mode, variant)}</section>`;
  }).join('\n');
  return `<section class="mode"><h2>${title}</h2><p>${subtitle}</p><p>Fantasy source: ${escapeHtml(report.source && report.source.liveSourceType)} / ${escapeHtml(report.source && report.source.liveSourceTimestamp)}；合法性：${escapeHtml(legalitySummary(report))}</p>${variants}</section>`;
}

function renderMode(mode, report) {
  if (!report) return '';
  const config = {
    HR: {
      title: 'HR 5 versions',
      subtitle: 'Batter objective is projected home runs; pitchers are legal fillers under the same roster constraints.'
    },
    SB: {
      title: 'SB 5 versions',
      subtitle: 'Batter objective is projected steals; team running strategy and same-league environment are respected.'
    },
    K: {
      title: 'K 5 versions',
      subtitle: 'Pitcher-first single item mode: projected strikeouts only, with batters as legal fillers.'
    },
    ERA: {
      title: 'ERA 5 versions',
      subtitle: 'Pitcher-first single item mode: projected ERA only, with batters as legal fillers.'
    }
  }[mode] || { title: `${mode} versions`, subtitle: '' };
  const variants = (report.lineupVariants || []).map(variant => {
    return `<section class="variant"><div class="variant-head"><h3>${escapeHtml(config.title)} - version ${escapeHtml(variant.variantIndex)}</h3><div class="variant-meta"><span>${escapeHtml(variantMetric(mode, variant))}</span><span>${variant.feasible ? 'legal' : 'not feasible'}</span><span>diff ${escapeHtml(JSON.stringify(variant.diffFromPrevious || {}))}</span></div></div>${renderLineupTable(mode, variant)}</section>`;
  }).join('\n');
  return `<section class="mode"><h2>${escapeHtml(config.title)}</h2><p>${escapeHtml(config.subtitle)}</p><p>Fantasy source: ${escapeHtml(report.source && report.source.liveSourceType)} / ${escapeHtml(report.source && report.source.liveSourceTimestamp)}; legality: ${escapeHtml(legalitySummary(report))}</p>${variants}</section>`;
}

function roleUsageSummary(projection, reports) {
  const pitchers = (projection.playerProjections || []).filter(item => item.category === 'pitcher');
  const counts = { SP: 0, RP: 0, CP: 0, rpEnabled: 0, spEnabled: 0, cpEnabled: 0 };
  for (const pitcher of pitchers) {
    counts[pitcher.role] = (counts[pitcher.role] || 0) + 1;
    const usage = pitcher.projectionMeta && pitcher.projectionMeta.roleUsage;
    if (usage && usage.enabled) {
      if (pitcher.role === 'RP') counts.rpEnabled += 1;
      if (pitcher.role === 'SP') counts.spEnabled += 1;
      if (pitcher.role === 'CP') counts.cpEnabled += 1;
    }
  }

  const selectedRp = new Map();
  for (const report of reports) {
    for (const variant of report.lineupVariants || []) {
      for (const item of variant.lineup || []) {
        if (item.role !== 'RP') continue;
        const key = `${item.team}::${item.name}::${item.owner}`;
        const usage = item.projectionMeta && item.projectionMeta.roleUsage;
        if (!selectedRp.has(key)) {
          selectedRp.set(key, {
            team: item.team,
            name: item.name,
            owner: item.owner,
            factor: usage && usage.enabled ? usage.effectiveWorkloadFactor : null,
            deficit: usage && usage.enabled ? usage.starterCapacityDeficit : null
          });
        }
      }
    }
  }
  const rows = [...selectedRp.values()].slice(0, 12).map(item => `<tr><td>${escapeHtml(item.team)}</td><td class="player">${escapeHtml(item.name)}</td><td>${escapeHtml(item.owner)}</td><td>${fmt(item.factor, 3)}</td><td>${fmt(item.deficit, 2)}</td></tr>`).join('\n');

  return `<section class="section"><h2>RP 工作量模型檢查</h2><p>模型已把 RP 從 SP workload 拆開：同隊 SP 體力/吃局能力弱時，RP 局數與使用量會上升；CP/CL 仍只看救援機會，不吃一般 RP 負荷。</p><div class="summary"><div class="card"><div class="label">SP</div><div class="value">${counts.SP} 人 / RP負荷 ${counts.spEnabled}</div></div><div class="card"><div class="label">RP</div><div class="value">${counts.RP} 人 / RP負荷 ${counts.rpEnabled}</div></div><div class="card"><div class="label">CP</div><div class="value">${counts.CP} 人 / RP負荷 ${counts.cpEnabled}</div></div><div class="card"><div class="label">規則</div><div class="value">只套 RP</div></div></div><table><thead><tr><th>隊伍</th><th>RP</th><th>GM</th><th>有效負荷</th><th>SP capacity deficit</th></tr></thead><tbody>${rows}</tbody></table></section>`;
}

function validation(projection, hrReport, sbReport, kReport, eraReport, html, paths, audit, leagueAudit, leagueConfidenceAudit, weeklyItemsAudit, fantasyPublicAudit, hitRateAudit, submissionReadinessAudit, requireAudits, generatedAtIso = new Date().toISOString()) {
  const variantSections = (html.match(/<section class="variant">/g) || []).length;
  const lineupRows = (html.match(/<tr class="(?:batter|sp|rp|cp)">/g) || []).length;
  const renderedReports = [hrReport, sbReport, kReport, eraReport].filter(Boolean);
  const expectedVariantSections = renderedReports.reduce((total, report) => total + (report.lineupVariants || []).length, 0);
  const expectedLineupRows = renderedReports.reduce((total, report) => {
    return total + (report.lineupVariants || []).reduce((sumRows, variant) => sumRows + (variant.lineup || []).length, 0);
  }, 0);
  const allLineupItems = renderedReports.flatMap(report => report.lineupVariants || [])
    .flatMap(variant => variant.lineup || []);
  const replacementLineupRows = allLineupItems.filter(item =>
    /replacement/i.test(`${item.name || ''} ${item.owner || ''}`) ||
    item.matchMethod === 'retirement_replacement'
  ).length;
  const pitchers = (projection.playerProjections || []).filter(item => item.category === 'pitcher');
  const counts = { SP: 0, RP: 0, CP: 0, rpEnabled: 0, spEnabled: 0, cpEnabled: 0 };
  for (const pitcher of pitchers) {
    counts[pitcher.role] = (counts[pitcher.role] || 0) + 1;
    const usage = pitcher.projectionMeta && pitcher.projectionMeta.roleUsage;
    if (usage && usage.enabled) {
      if (pitcher.role === 'RP') counts.rpEnabled += 1;
      if (pitcher.role === 'SP') counts.spEnabled += 1;
      if (pitcher.role === 'CP') counts.cpEnabled += 1;
    }
  }
  const sourceSnapshot = projection.sourceSnapshot || {};
  const targetSeason = num(sourceSnapshot.season) + 1;
  const auditConsistencyFailures = [];
  const failReasons = [];
  const failAuditConsistency = message => {
    auditConsistencyFailures.push(message);
    failReasons.push(message);
  };
  const expectSameSourceValue = (label, actual, expected) => {
    if (!sameText(actual, expected)) {
      failAuditConsistency(`${label} mismatch: audit=${describeCompareValue(actual)} report=${describeCompareValue(expected)}`);
    }
  };
  const expectSameSourcePath = (label, actual, expected) => {
    if (!samePath(actual, expected)) {
      failAuditConsistency(`${label} mismatch: audit=${describeCompareValue(actual)} report=${describeCompareValue(expected)}`);
    }
  };
  if (variantSections !== expectedVariantSections) failReasons.push(`expected ${expectedVariantSections} variant sections, got ${variantSections}`);
  if (lineupRows !== expectedLineupRows) failReasons.push(`expected ${expectedLineupRows} lineup rows, got ${lineupRows}`);
  const submissionCardIncluded = html.includes('Weekly submission card');
  if (weeklyItemsAudit && hitRateAudit && !submissionCardIncluded) {
    failReasons.push('weekly submission card was not rendered');
  }
  const weeklyItemRiskGateIncluded = html.includes('Weekly item risk gate');
  const weeklyRiskPrimaryItem = weeklyItemsAudit && weeklyItemsAudit.recommendation ? weeklyItemsAudit.recommendation.primary : null;
  const weeklyRiskBackupItem = weeklyItemsAudit && weeklyItemsAudit.recommendation ? weeklyItemsAudit.recommendation.secondary : null;
  const hitRateItems = hitRateAudit && hitRateAudit.items ? hitRateAudit.items : {};
  const weeklyRiskPrimaryLevel = weeklyRiskPrimaryItem ? itemRiskLevel(hitRateItems[weeklyRiskPrimaryItem] || {}) : null;
  const weeklyRiskBackupLevel = weeklyRiskBackupItem ? itemRiskLevel(hitRateItems[weeklyRiskBackupItem] || {}) : null;
  const weeklyRiskPrimaryClearMissRate = weeklyRiskPrimaryItem && hitRateItems[weeklyRiskPrimaryItem] && hitRateItems[weeklyRiskPrimaryItem].counts ? hitRateItems[weeklyRiskPrimaryItem].counts.clearMissRate : null;
  const weeklyRiskBackupClearMissRate = weeklyRiskBackupItem && hitRateItems[weeklyRiskBackupItem] && hitRateItems[weeklyRiskBackupItem].counts ? hitRateItems[weeklyRiskBackupItem].counts.clearMissRate : null;
  const weeklyBackupSafety = weeklyItemsAudit && hitRateAudit ? backupSafetyStatus(weeklyItemsAudit, hitRateAudit) : {};
  const weeklyRiskSafeBackupAvailable = weeklyBackupSafety.status ? weeklyBackupSafety.status !== 'no_safe_backup_from_current_signal' : null;
  const weeklyRiskSafeBackupItem = weeklyBackupSafety.safeBackupItem || null;
  const weeklyRiskSafeBackupVariant = weeklyBackupSafety.safeBackupVariantIndex ?? null;
  const weeklyRiskBackupSafetyStatus = weeklyBackupSafety.status || null;
  const weeklyRiskBackupSafetyLabel = weeklyBackupSafety.label || null;
  const weeklyRiskBackupSafetyIncluded = !weeklyItemsAudit || !hitRateAudit || html.includes('Backup safety:') || html.includes('<div class="label">Backup safety</div>');
  const weeklyVariantBackupSafety = weeklyItemsAudit && hitRateAudit ? variantBackupSafetyStatus(weeklyItemsAudit, hitRateAudit) : {};
  const weeklyRiskVariantSafeBackupAvailable = weeklyVariantBackupSafety.status ? weeklyVariantBackupSafety.status === 'variant_level_safer_alternate_available' : null;
  const weeklyRiskVariantSafeBackupItem = weeklyVariantBackupSafety.safeBackupItem || null;
  const weeklyRiskVariantSafeBackupVariant = weeklyVariantBackupSafety.safeBackupVariantIndex ?? null;
  const weeklyRiskVariantSafeBackupLevel = weeklyVariantBackupSafety.safeBackupRiskLevel || null;
  const weeklyRiskVariantSafeBackupClearMissRate = weeklyVariantBackupSafety.safeBackupClearMissRate ?? null;
  const weeklyRiskVariantSafeBackupUsefulTop20 = weeklyVariantBackupSafety.safeBackupUsefulTop20 ?? null;
  const weeklyRiskVariantBackupSafetyStatus = weeklyVariantBackupSafety.status || null;
  const weeklyRiskVariantBackupSafetyLabel = weeklyVariantBackupSafety.label || null;
  const weeklyRiskVariantBackupSafetyIncluded = !weeklyItemsAudit || !hitRateAudit || html.includes('Variant-level safer alternate') || html.includes('<div class="label">Safer alternate</div>');
  if (weeklyItemsAudit && hitRateAudit && !weeklyItemRiskGateIncluded) {
    failReasons.push('weekly item risk gate was not rendered');
  }
  if (weeklyItemsAudit && hitRateAudit && !weeklyRiskBackupSafetyIncluded) {
    failReasons.push('weekly backup safety status was not rendered');
  }
  if (weeklyItemsAudit && hitRateAudit && !weeklyRiskVariantBackupSafetyIncluded) {
    failReasons.push('weekly variant-level safer alternate was not rendered');
  }
  if (weeklyItemsAudit && hitRateAudit && weeklyRiskBackupSafetyStatus === 'no_safe_backup_from_current_signal' && !html.includes('no safe backup')) {
    failReasons.push('weekly backup safety no-safe-backup warning was not rendered');
  }
  if (weeklyItemsAudit && hitRateAudit && weeklyRiskVariantSafeBackupAvailable && weeklyRiskVariantSafeBackupItem && !html.includes(`${weeklyRiskVariantSafeBackupItem} V${weeklyRiskVariantSafeBackupVariant}`)) {
    failReasons.push('weekly variant-level safer alternate label was not rendered');
  }
  const finalSubmissionChecklistIncluded = html.includes('Final submission checklist');
  if (weeklyItemsAudit && hitRateAudit && submissionReadinessAudit && leagueAudit && leagueConfidenceAudit && !finalSubmissionChecklistIncluded) {
    failReasons.push('final submission checklist was not rendered');
  }
  const freshnessGuardIncluded = html.includes('Freshness guard');
  if (weeklyItemsAudit && !freshnessGuardIncluded) {
    failReasons.push('freshness guard was not rendered');
  }
  const freshnessGuardDraftKeys = ['hr', 'sb', 'k', 'era'];
  const freshnessGuardLiveFetchAll = weeklyItemsAudit ? freshnessGuardDraftKeys.every(key => {
    const block = (weeklyItemsAudit.source || {})[key] || {};
    return block.liveSourceType === 'live_fetch' && block.liveFetchSucceeded === true;
  }) : null;
  const selectedSubmissionLineupIncluded = html.includes('Selected submission lineup');
  const selectedSubmission = submissionReadinessAudit && submissionReadinessAudit.submission ? submissionReadinessAudit.submission : {};
  const selectedReports = { HR: hrReport, SB: sbReport, K: kReport, ERA: eraReport };
  const selectedPrimaryVariant = findLineupVariant(reportForItem(selectedSubmission.item, selectedReports), selectedSubmission.variantIndex);
  const selectedBackupVariant = findLineupVariant(reportForItem(selectedSubmission.backupItem, selectedReports), selectedSubmission.backupVariantIndex);
  const selectedPrimaryRows = selectedPrimaryVariant ? (selectedPrimaryVariant.lineup || []).length : 0;
  const selectedBackupRows = selectedBackupVariant ? (selectedBackupVariant.lineup || []).length : 0;
  const selectedSubmissionCopyBlockCount = (html.match(/selected-lineup-copy/g) || []).length;
  const selectedSubmissionPrimaryCopyRows = selectedLineupCopyLines(selectedSubmission.item, selectedPrimaryVariant).length;
  const selectedSubmissionBackupCopyRows = selectedLineupCopyLines(selectedSubmission.backupItem, selectedBackupVariant).length;
  if (submissionReadinessAudit && !selectedSubmissionLineupIncluded) {
    failReasons.push('selected submission lineup was not rendered');
  }
  if (submissionReadinessAudit && selectedSubmissionCopyBlockCount < 2) {
    failReasons.push(`selected submission copy blocks ${selectedSubmissionCopyBlockCount}, expected 2`);
  }
  if (submissionReadinessAudit && selectedPrimaryRows !== 18) {
    failReasons.push(`selected primary lineup rows ${selectedPrimaryRows}, expected 18`);
  }
  if (submissionReadinessAudit && selectedSubmission.backupItem && selectedBackupRows !== 18) {
    failReasons.push(`selected backup lineup rows ${selectedBackupRows}, expected 18`);
  }
  if (submissionReadinessAudit && selectedSubmissionPrimaryCopyRows !== 18) {
    failReasons.push(`selected primary copy rows ${selectedSubmissionPrimaryCopyRows}, expected 18`);
  }
  if (submissionReadinessAudit && selectedSubmission.backupItem && selectedSubmissionBackupCopyRows !== 18) {
    failReasons.push(`selected backup copy rows ${selectedSubmissionBackupCopyRows}, expected 18`);
  }
  const leagueRankingCardIncluded = html.includes('League ranking submission card');
  if (leagueAudit && !leagueRankingCardIncluded) {
    failReasons.push('league ranking submission card was not rendered');
  }
  const leagueConfidenceSectionIncluded = html.includes('League ranking confidence and swap watch');
  if (leagueConfidenceAudit && !leagueConfidenceSectionIncluded) {
    failReasons.push('league ranking confidence audit was not rendered');
  }
  if (hrReport && !hrReport.feasible) failReasons.push('HR report is not feasible');
  if (sbReport && !sbReport.feasible) failReasons.push('SB report is not feasible');
  if (!kReport.feasible) failReasons.push('K report is not feasible');
  if (!eraReport.feasible) failReasons.push('ERA report is not feasible');
  if (hrReport && !legalityOk(hrReport)) failReasons.push('HR legality failed');
  if (sbReport && !legalityOk(sbReport)) failReasons.push('SB legality failed');
  if (!legalityOk(kReport)) failReasons.push('K legality failed');
  if (!legalityOk(eraReport)) failReasons.push('ERA legality failed');
  if (!(projection.modelRules && projection.modelRules.pitcherRoleUsageModelUsed)) failReasons.push('projection missing RP workload model rule');
  if (counts.rpEnabled !== counts.RP) failReasons.push(`RP workload enabled ${counts.rpEnabled}/${counts.RP}`);
  if (counts.spEnabled !== 0) failReasons.push(`SP workload should be disabled, got ${counts.spEnabled}`);
  if (counts.cpEnabled !== 0) failReasons.push(`CP workload should be disabled, got ${counts.cpEnabled}`);
  if (replacementLineupRows !== 0) failReasons.push(`replacement lineup rows found: ${replacementLineupRows}`);
  if (html.includes('undefined')) failReasons.push('HTML contains undefined');
  if (html.includes('None')) failReasons.push('HTML contains None');
  if (html.includes('\uFFFD')) failReasons.push('HTML contains replacement character');
  if (requireAudits && !sourceSnapshot.scrapedAt) failReasons.push('source snapshot scrapedAt is missing');
  if (requireAudits && sourceSnapshot.sourceFreshnessStatus !== 'fresh_web_scrape') {
    failReasons.push(`source freshness status is ${describeCompareValue(sourceSnapshot.sourceFreshnessStatus)}, expected fresh_web_scrape`);
  }
  if (requireAudits && sourceSnapshot.sourceFreshTeisatuCount != null && num(sourceSnapshot.sourceFreshTeisatuCount, NaN) !== 12) {
    failReasons.push(`fresh teisatu page count is ${sourceSnapshot.sourceFreshTeisatuCount}, expected 12`);
  }
  if (requireAudits && !audit) failReasons.push('required item audit JSON was not provided');
  if (requireAudits && !leagueAudit) failReasons.push('required league audit JSON was not provided');
  if (requireAudits && !leagueConfidenceAudit) failReasons.push('required league confidence audit JSON was not provided');
  if (requireAudits && !hitRateAudit) failReasons.push('required fantasy hit-rate audit JSON was not provided');
  if (requireAudits && !submissionReadinessAudit) failReasons.push('required fantasy submission readiness audit JSON was not provided');
  if (audit) {
    const auditSource = audit.source || {};
    if (num(audit.targetSeason, NaN) !== targetSeason) {
      failAuditConsistency(`item audit targetSeason mismatch: audit=${describeCompareValue(audit.targetSeason)} report=${targetSeason}`);
    }
    expectSameSourceValue('item audit source season', auditSource.season, sourceSnapshot.season);
    expectSameSourceValue('item audit source day', auditSource.day, sourceSnapshot.day);
    expectSameSourceValue('item audit source scrapedAt', auditSource.scrapedAt, sourceSnapshot.scrapedAt);
    expectSameSourcePath('item audit K path', auditSource.k && auditSource.k.path, paths.kPath);
    expectSameSourcePath('item audit ERA path', auditSource.era && auditSource.era.path, paths.eraPath);
    if (!(audit.recommendation && audit.recommendation.primary)) {
      failAuditConsistency('item audit recommendation primary is missing');
    }
  }
  if (leagueAudit) {
    const leagueSource = leagueAudit.source || {};
    if (num(leagueAudit.targetSeason, NaN) !== targetSeason) {
      failAuditConsistency(`league audit targetSeason mismatch: audit=${describeCompareValue(leagueAudit.targetSeason)} report=${targetSeason}`);
    }
    expectSameSourceValue('league audit source season', leagueSource.season, sourceSnapshot.season);
    expectSameSourceValue('league audit source day', leagueSource.day, sourceSnapshot.day);
    expectSameSourceValue('league audit source scrapedAt', leagueSource.scrapedAt, sourceSnapshot.scrapedAt);
    expectSameSourcePath('league audit projection path', leagueSource.projectionPath, paths.projectionPath);
    if (!(leagueAudit.overall && leagueAudit.overall.status)) {
      failAuditConsistency('league audit overall status is missing');
    }
  }
  if (leagueConfidenceAudit) {
    const confidenceSource = leagueConfidenceAudit.source || {};
    if (num(leagueConfidenceAudit.targetSeason, NaN) !== targetSeason) {
      failAuditConsistency(`league confidence audit targetSeason mismatch: audit=${describeCompareValue(leagueConfidenceAudit.targetSeason)} report=${targetSeason}`);
    }
    expectSameSourceValue('league confidence audit source season', confidenceSource.season, sourceSnapshot.season);
    expectSameSourceValue('league confidence audit source day', confidenceSource.day, sourceSnapshot.day);
    expectSameSourceValue('league confidence audit source scrapedAt', confidenceSource.scrapedAt, sourceSnapshot.scrapedAt);
    expectSameSourcePath('league confidence audit league-audit path', confidenceSource.leagueAudit && confidenceSource.leagueAudit.path, paths.leagueAuditPath);
    if (!(leagueConfidenceAudit.overall && leagueConfidenceAudit.overall.championConfidence)) {
      failAuditConsistency('league confidence audit champion confidence is missing');
    }
    if (!leagueConfidenceAudit.status) {
      failAuditConsistency('league confidence audit status is missing');
    }
  }
  if (weeklyItemsAudit) {
    const weeklySource = weeklyItemsAudit.source || {};
    if (num(weeklyItemsAudit.targetSeason, NaN) !== targetSeason) {
      failAuditConsistency(`weekly items audit targetSeason mismatch: audit=${describeCompareValue(weeklyItemsAudit.targetSeason)} report=${targetSeason}`);
    }
    expectSameSourceValue('weekly items audit source season', weeklySource.season, sourceSnapshot.season);
    expectSameSourceValue('weekly items audit source day', weeklySource.day, sourceSnapshot.day);
    expectSameSourceValue('weekly items audit source scrapedAt', weeklySource.scrapedAt, sourceSnapshot.scrapedAt);
    expectSameSourcePath('weekly items audit HR path', weeklySource.hr && weeklySource.hr.path, paths.hrPath);
    expectSameSourcePath('weekly items audit SB path', weeklySource.sb && weeklySource.sb.path, paths.sbPath);
    expectSameSourcePath('weekly items audit K path', weeklySource.k && weeklySource.k.path, paths.kPath);
    expectSameSourcePath('weekly items audit ERA path', weeklySource.era && weeklySource.era.path, paths.eraPath);
    if (!(weeklyItemsAudit.recommendation && weeklyItemsAudit.recommendation.primary)) {
      failAuditConsistency('weekly items audit recommendation primary is missing');
    }
  }
  if (fantasyPublicAudit) {
    const fantasySource = fantasyPublicAudit.source || {};
    if (num(fantasySource.targetSeason, NaN) !== targetSeason) {
      failAuditConsistency(`fantasy public audit targetSeason mismatch: audit=${describeCompareValue(fantasySource.targetSeason)} report=${targetSeason}`);
    }
    expectSameSourceValue('fantasy public audit source season', fantasySource.season, sourceSnapshot.season);
    expectSameSourceValue('fantasy public audit source day', fantasySource.day, sourceSnapshot.day);
    expectSameSourceValue('fantasy public audit source scrapedAt', fantasySource.scrapedAt, sourceSnapshot.scrapedAt);
    if (!fantasyPublicAudit.status) {
      failAuditConsistency('fantasy public audit status is missing');
    }
  }
  if (hitRateAudit) {
    const hitRateSource = hitRateAudit.source || {};
    if (num(hitRateAudit.targetSeason, NaN) !== targetSeason) {
      failAuditConsistency(`fantasy hit-rate audit targetSeason mismatch: audit=${describeCompareValue(hitRateAudit.targetSeason)} report=${targetSeason}`);
    }
    expectSameSourceValue('fantasy hit-rate audit source season', hitRateSource.season, sourceSnapshot.season);
    expectSameSourceValue('fantasy hit-rate audit source day', hitRateSource.day, sourceSnapshot.day);
    expectSameSourceValue('fantasy hit-rate audit source scrapedAt', hitRateSource.scrapedAt, sourceSnapshot.scrapedAt);
    expectSameSourcePath('fantasy hit-rate audit HR path', hitRateSource.hr && hitRateSource.hr.path, paths.hrPath);
    expectSameSourcePath('fantasy hit-rate audit SB path', hitRateSource.sb && hitRateSource.sb.path, paths.sbPath);
    expectSameSourcePath('fantasy hit-rate audit K path', hitRateSource.k && hitRateSource.k.path, paths.kPath);
    expectSameSourcePath('fantasy hit-rate audit ERA path', hitRateSource.era && hitRateSource.era.path, paths.eraPath);
    expectSameSourcePath('fantasy hit-rate audit weekly items path', hitRateSource.weeklyItemsAudit && hitRateSource.weeklyItemsAudit.path, paths.weeklyItemsAuditPath);
    if (!hitRateAudit.status) {
      failAuditConsistency('fantasy hit-rate audit status is missing');
    }
  }
  if (submissionReadinessAudit) {
    const submissionSource = submissionReadinessAudit.source || {};
    if (num(submissionReadinessAudit.targetSeason, NaN) !== targetSeason) {
      failAuditConsistency(`fantasy submission readiness audit targetSeason mismatch: audit=${describeCompareValue(submissionReadinessAudit.targetSeason)} report=${targetSeason}`);
    }
    expectSameSourceValue('fantasy submission readiness audit source season', submissionSource.season, sourceSnapshot.season);
    expectSameSourceValue('fantasy submission readiness audit source day', submissionSource.day, sourceSnapshot.day);
    expectSameSourceValue('fantasy submission readiness audit source scrapedAt', submissionSource.scrapedAt, sourceSnapshot.scrapedAt);
    expectSameSourcePath('fantasy submission readiness audit weekly items path', submissionSource.weeklyItemsAudit && submissionSource.weeklyItemsAudit.path, paths.weeklyItemsAuditPath);
    expectSameSourcePath('fantasy submission readiness audit hit-rate path', submissionSource.hitRateAudit && submissionSource.hitRateAudit.path, paths.hitRateAuditPath);
    expectSameSourcePath('fantasy submission readiness audit public path', submissionSource.fantasyPublicAudit && submissionSource.fantasyPublicAudit.path, paths.fantasyPublicAuditPath);
    if (!submissionReadinessAudit.status) {
      failAuditConsistency('fantasy submission readiness audit status is missing');
    }
    if (!(submissionReadinessAudit.submission && submissionReadinessAudit.submission.item && submissionReadinessAudit.submission.variantIndex)) {
      failAuditConsistency('fantasy submission readiness audit submission action is missing');
    }
  }

  const output = {
    ...paths,
    sha256: crypto.createHash('sha256').update(html, 'utf8').digest('hex'),
    modelVersion: projection.modelVersion,
    generatedAt: generatedAtIso,
    targetSeason,
    sourceSnapshotSeason: sourceSnapshot.season ?? null,
    sourceSnapshotDay: sourceSnapshot.day ?? null,
    sourceSnapshotScrapedAt: sourceSnapshot.scrapedAt ?? null,
    sourceFreshnessStatus: sourceSnapshot.sourceFreshnessStatus ?? null,
    sourceFreshnessSummaryStatus: sourceSnapshot.sourceFreshnessSummaryStatus ?? null,
    sourceFreshnessHistoryStatus: sourceSnapshot.sourceFreshnessHistoryStatus ?? null,
    sourceFreshTeisatuCount: sourceSnapshot.sourceFreshTeisatuCount ?? null,
    sourceCacheTeisatuCount: sourceSnapshot.sourceCacheTeisatuCount ?? null,
    expectedVariantSections,
    expectedLineupRows,
    variantSections,
    lineupRows,
    hrLegal: hrReport ? legalityOk(hrReport) : null,
    sbLegal: sbReport ? legalityOk(sbReport) : null,
    kLegal: legalityOk(kReport),
    eraLegal: legalityOk(eraReport),
    hrVariants: hrReport ? (hrReport.lineupVariants || []).length : 0,
    sbVariants: sbReport ? (sbReport.lineupVariants || []).length : 0,
    kVariants: (kReport.lineupVariants || []).length,
    eraVariants: (eraReport.lineupVariants || []).length,
    replacementLineupRows,
    roleUsageCounts: counts,
    hasUndefined: html.includes('undefined'),
    hasNone: html.includes('None'),
    hasReplacementChar: html.includes('\uFFFD'),
    auditIncluded: Boolean(audit),
    auditTargetSeason: audit ? audit.targetSeason : null,
    auditSourceSeason: audit && audit.source ? audit.source.season : null,
    auditSourceDay: audit && audit.source ? audit.source.day : null,
    auditRecommendation: audit && audit.recommendation ? audit.recommendation.primary : null,
    leagueAuditIncluded: Boolean(leagueAudit),
    leagueAuditTargetSeason: leagueAudit ? leagueAudit.targetSeason : null,
    leagueAuditSourceSeason: leagueAudit && leagueAudit.source ? leagueAudit.source.season : null,
    leagueAuditSourceDay: leagueAudit && leagueAudit.source ? leagueAudit.source.day : null,
    leagueAuditStatus: leagueAudit && leagueAudit.overall ? leagueAudit.overall.status : null,
    leagueRankingCardIncluded,
    leagueRankingCardChampion: leagueAudit && leagueAudit.overall ? leagueAudit.overall.projectedChampion : null,
    leagueRankingCardExactMatches: leagueAudit && leagueAudit.overall ? leagueAudit.overall.exactMatches : null,
    leagueRankingCardTeamCount: leagueAudit && leagueAudit.overall ? leagueAudit.overall.teamCount : null,
    leagueRankingCardMeanAbsRankError: leagueAudit && leagueAudit.overall ? leagueAudit.overall.meanAbsRankError : null,
    leagueConfidenceAuditIncluded: Boolean(leagueConfidenceAudit),
    leagueConfidenceSectionIncluded,
    leagueConfidenceStatus: leagueConfidenceAudit ? leagueConfidenceAudit.status : null,
    leagueConfidenceChampionConfidence: leagueConfidenceAudit && leagueConfidenceAudit.overall ? leagueConfidenceAudit.overall.championConfidence : null,
    leagueConfidenceDecision: leagueConfidenceAudit && leagueConfidenceAudit.overall ? leagueConfidenceAudit.overall.decision : null,
    leagueConfidenceHoldProjectionCount: leagueConfidenceAudit && leagueConfidenceAudit.summary ? leagueConfidenceAudit.summary.holdProjectionCount : null,
    leagueConfidenceSwapWatchCount: leagueConfidenceAudit && leagueConfidenceAudit.summary ? leagueConfidenceAudit.summary.swapWatchCount : null,
    leagueConfidenceWatchCount: leagueConfidenceAudit && leagueConfidenceAudit.summary ? leagueConfidenceAudit.summary.watchCount : null,
    finalSubmissionChecklistIncluded,
    finalSubmissionChecklistWeeklyItem: weeklyItemsAudit && weeklyItemsAudit.recommendation ? weeklyItemsAudit.recommendation.primary : null,
    finalSubmissionChecklistLeagueChampion: leagueAudit && leagueAudit.overall ? leagueAudit.overall.projectedChampion : null,
    freshnessGuardIncluded,
    freshnessGuardSourceSeason: sourceSnapshot.season ?? null,
    freshnessGuardSourceDay: sourceSnapshot.day ?? null,
    freshnessGuardSourceScrapedAt: sourceSnapshot.scrapedAt ?? null,
    freshnessGuardSourceFreshnessStatus: sourceSnapshot.sourceFreshnessStatus ?? null,
    freshnessGuardLiveFetchAll,
    freshnessGuardRerunRule: 'rerun_if_source_season_day_or_scrapedAt_changes',
    selectedSubmissionLineupIncluded,
    selectedSubmissionLineupPrimaryItem: selectedSubmission.item || null,
    selectedSubmissionLineupPrimaryVariant: selectedSubmission.variantIndex ?? null,
    selectedSubmissionLineupPrimaryRows: selectedPrimaryRows,
    selectedSubmissionLineupBackupItem: selectedSubmission.backupItem || null,
    selectedSubmissionLineupBackupVariant: selectedSubmission.backupVariantIndex ?? null,
    selectedSubmissionLineupBackupRows: selectedBackupRows,
    selectedSubmissionCopyBlockCount,
    selectedSubmissionPrimaryCopyRows,
    selectedSubmissionBackupCopyRows,
    weeklyItemsAuditIncluded: Boolean(weeklyItemsAudit),
    weeklyItemsAuditTargetSeason: weeklyItemsAudit ? weeklyItemsAudit.targetSeason : null,
    weeklyItemsAuditSourceSeason: weeklyItemsAudit && weeklyItemsAudit.source ? weeklyItemsAudit.source.season : null,
    weeklyItemsAuditSourceDay: weeklyItemsAudit && weeklyItemsAudit.source ? weeklyItemsAudit.source.day : null,
    weeklyItemsAuditRecommendation: weeklyItemsAudit && weeklyItemsAudit.recommendation ? weeklyItemsAudit.recommendation.primary : null,
    fantasyPublicAuditIncluded: Boolean(fantasyPublicAudit),
    fantasyPublicAuditStatus: fantasyPublicAudit ? fantasyPublicAudit.status : null,
    fantasyPublicAuditSourceSeason: fantasyPublicAudit && fantasyPublicAudit.source ? fantasyPublicAudit.source.season : null,
    fantasyPublicAuditSourceDay: fantasyPublicAudit && fantasyPublicAudit.source ? fantasyPublicAudit.source.day : null,
    fantasyPublicPlayerPicksStatus: fantasyPublicAudit && fantasyPublicAudit.fantasy ? fantasyPublicAudit.fantasy.playerPicksStatus : null,
    fantasyPublicParticipantCount: fantasyPublicAudit && fantasyPublicAudit.fantasy ? fantasyPublicAudit.fantasy.participantCount : null,
    hitRateAuditIncluded: Boolean(hitRateAudit),
    hitRateAuditStatus: hitRateAudit ? hitRateAudit.status : null,
    hitRateAuditTargetSeason: hitRateAudit ? hitRateAudit.targetSeason : null,
    hitRateAuditSourceSeason: hitRateAudit && hitRateAudit.source ? hitRateAudit.source.season : null,
    hitRateAuditSourceDay: hitRateAudit && hitRateAudit.source ? hitRateAudit.source.day : null,
    hitRateAuditPrimaryItem: hitRateAudit ? hitRateAudit.primaryItem : null,
    submissionCardIncluded,
    submissionCardPrimaryItem: weeklyItemsAudit && weeklyItemsAudit.recommendation ? weeklyItemsAudit.recommendation.primary : null,
    submissionCardSecondaryItem: weeklyItemsAudit && weeklyItemsAudit.recommendation ? weeklyItemsAudit.recommendation.secondary : null,
    submissionCardRecommendedVariant: weeklyItemsAudit && weeklyItemsAudit.recommendation && weeklyItemsAudit.recommendation.ranking && weeklyItemsAudit.recommendation.ranking[0] && weeklyItemsAudit.recommendation.ranking[0].bestVariant ? weeklyItemsAudit.recommendation.ranking[0].bestVariant.variantIndex : null,
    weeklyItemRiskGateIncluded,
    weeklyRiskPrimaryItem,
    weeklyRiskPrimaryLevel,
    weeklyRiskPrimaryClearMissRate,
    weeklyRiskBackupItem,
    weeklyRiskBackupLevel,
    weeklyRiskBackupClearMissRate,
    weeklyRiskSafeBackupAvailable,
    weeklyRiskSafeBackupItem,
    weeklyRiskSafeBackupVariant,
    weeklyRiskBackupSafetyStatus,
    weeklyRiskBackupSafetyLabel,
    weeklyRiskBackupSafetyIncluded,
    weeklyRiskVariantSafeBackupAvailable,
    weeklyRiskVariantSafeBackupItem,
    weeklyRiskVariantSafeBackupVariant,
    weeklyRiskVariantSafeBackupLevel,
    weeklyRiskVariantSafeBackupClearMissRate,
    weeklyRiskVariantSafeBackupUsefulTop20,
    weeklyRiskVariantBackupSafetyStatus,
    weeklyRiskVariantBackupSafetyLabel,
    weeklyRiskVariantBackupSafetyIncluded,
    submissionReadinessAuditIncluded: Boolean(submissionReadinessAudit),
    submissionReadinessStatus: submissionReadinessAudit ? submissionReadinessAudit.status : null,
    submissionReadinessFormAccessStatus: submissionReadinessAudit ? submissionReadinessAudit.formAccessStatus : null,
    submissionReadinessItem: submissionReadinessAudit && submissionReadinessAudit.submission ? submissionReadinessAudit.submission.item : null,
    submissionReadinessVariant: submissionReadinessAudit && submissionReadinessAudit.submission ? submissionReadinessAudit.submission.variantIndex : null,
    submissionReadinessDoNotAutoSubmit: submissionReadinessAudit ? submissionReadinessAudit.doNotAutoSubmit : null,
    auditConsistencyOk: auditConsistencyFailures.length === 0,
    auditConsistencyFailures,
    requireAudits,
    failReasons,
    status: failReasons.length ? 'FAIL' : 'PASS'
  };
  return output;
}

function main() {
  const reportsDir = arg('reports-dir', path.resolve(__dirname, '..', '..', 'reports'));
  const projectionPath = arg('projection', path.join(reportsDir, 'ore_projection_snapshot.json'));
  const hrPath = argProvided('hr') ? arg('hr') : null;
  const sbPath = argProvided('sb') ? arg('sb') : null;
  const kPath = arg('k', path.join(reportsDir, 'ore_draft_k.json'));
  const eraPath = arg('era', path.join(reportsDir, 'ore_draft_era.json'));
  const auditPath = arg('audit', null);
  const leagueAuditPath = arg('league-audit', null);
  const leagueConfidenceAuditPath = arg('league-confidence-audit', null);
  const weeklyItemsAuditPath = arg('weekly-items-audit', null);
  const fantasyPublicAuditPath = arg('fantasy-public-audit', null);
  const hitRateAuditPath = arg('hit-rate-audit', null);
  const submissionReadinessAuditPath = arg('submission-readiness-audit', null);
  const requireAudits = flag('require-audits');
  const dateLabel = arg('date', new Date().toISOString().slice(0, 10));

  const projection = readJson(projectionPath);
  const hrReport = readJsonIfExists(hrPath);
  const sbReport = readJsonIfExists(sbPath);
  const kReport = readJson(kPath);
  const eraReport = readJson(eraPath);
  const audit = auditPath ? readJson(auditPath) : null;
  const leagueAudit = leagueAuditPath ? readJson(leagueAuditPath) : null;
  const leagueConfidenceAudit = leagueConfidenceAuditPath ? readJson(leagueConfidenceAuditPath) : null;
  const weeklyItemsAudit = weeklyItemsAuditPath ? readJson(weeklyItemsAuditPath) : null;
  const fantasyPublicAudit = fantasyPublicAuditPath ? readJson(fantasyPublicAuditPath) : null;
  const hitRateAudit = hitRateAuditPath ? readJson(hitRateAuditPath) : null;
  const submissionReadinessAudit = submissionReadinessAuditPath ? readJson(submissionReadinessAuditPath) : null;
  const targetSeason = num(projection.sourceSnapshot && projection.sourceSnapshot.season) + 1;
  const modelLabel = projection.modelVersion && projection.modelVersion.includes('v7')
    ? 'v7 role-skill-filter + RP workload'
    : 'v6 RP workload';
  const fileLabel = projection.modelVersion && projection.modelVersion.includes('v7')
    ? 'v7_role_skill_filter'
    : 'v6_rp_workload';
  const baseName = `ore_${targetSeason}_k_era_${fileLabel}_html`;
  const htmlPath = arg('out', path.join(reportsDir, `${baseName}_report_${dateLabel}.html`));
  const bodyPath = arg('body-out', path.join(reportsDir, `${baseName}_email_body_${dateLabel}.html`));
  const textPath = arg('text-out', path.join(reportsDir, `${baseName}_email_fallback_${dateLabel}.txt`));
  const subjectPath = arg('subject-out', path.join(reportsDir, `${baseName}_email_subject_${dateLabel}.txt`));
  const validationPath = arg('validation-out', path.join(reportsDir, `${baseName}_validation_${dateLabel}.json`));

  const champion = [...(projection.teamProjections || [])].sort((a, b) => b.overallScore - a.overallScore)[0];
  const trainingSeasons = (projection.trainingSeasons || []).map(item => item.season || item).join(', ');
  const retired = ((projection.retirementReplacementPolicy || {}).retiredPlayers || []).length;
  const replacements = ((projection.retirementReplacementPolicy || {}).replacementRookies || []).length;
  const source = projection.sourceSnapshot || {};
  const includedModes = [
    hrReport ? 'HR 5' : null,
    sbReport ? 'SB 5' : null,
    'K 5',
    'ERA 5'
  ].filter(Boolean).join(' + ');
  const reportTitle = `ORE ${targetSeason} Weekly Goal Monitor - ${includedModes} ${modelLabel}`;
  const generatedAtIso = new Date().toISOString();

  const html = `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(reportTitle)}</title>
<style>
:root{color-scheme:light;--ink:#17202a;--muted:#5a6472;--line:#d9e1ea;--soft:#f6f8fb;--green:#0f7b5c;--red:#9b2c2c;--sp:#eef6ff;--rp:#fff7e8;--cp:#edf8f2;--mode:#f9fbff}
body{margin:0;background:#eef2f6;color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans TC","Microsoft JhengHei",Arial,sans-serif;line-height:1.5}
.wrapper{max-width:1180px;margin:0 auto;padding:24px 18px 40px}.hero,.section,.mode,.variant,.league{background:#fff;border:1px solid var(--line);border-radius:12px;padding:18px;margin-bottom:16px;box-shadow:0 1px 2px rgba(20,30,45,.04)}
.hero{padding:22px 24px}.mode{background:var(--mode)}h1{font-size:26px;margin:0 0 8px;letter-spacing:0}h2{font-size:20px;margin:0 0 10px;letter-spacing:0}h3{font-size:17px;margin:0;letter-spacing:0}p{margin:6px 0;color:var(--muted)}
.summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:14px 0}.card{background:#fff;border:1px solid var(--line);border-radius:10px;padding:12px 14px}.label{font-size:12px;color:var(--muted)}.value{font-size:17px;font-weight:700;margin-top:3px}.ok{color:var(--green)}.warn{color:var(--red)}
.grid-two{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin:16px 0}.note{background:#fffdf5;border:1px solid #ead99f;border-radius:10px;padding:12px 14px;margin:12px 0;color:#4d3b00}
.copy-panel{border:1px solid var(--line);border-radius:10px;background:#f8fafc;margin:12px 0;overflow:hidden}.copy-title{font-size:13px;font-weight:700;color:#314156;padding:9px 12px;border-bottom:1px solid var(--line)}.copy-block{margin:0;padding:12px;overflow:auto;background:#fff;font-family:"Cascadia Mono","Consolas","Noto Sans Mono CJK TC",monospace;font-size:13px;line-height:1.55;white-space:pre}
.risk-green{background:#effaf5}.risk-yellow{background:#fffbea}.risk-red{background:#fff1f1}
table{width:100%;border-collapse:collapse;font-size:14px;background:#fff}th{background:#f1f5f9;color:#314156;text-align:left;font-weight:700}th,td{border-bottom:1px solid var(--line);padding:8px 9px;vertical-align:top}tr:last-child td{border-bottom:0}.lineup th:first-child,.lineup td:first-child{width:52px;text-align:center;font-weight:700}.player{font-weight:700}.ability{white-space:nowrap;color:#25364b}.skills{color:#39495f}.sp{background:var(--sp)}.rp{background:var(--rp)}.cp{background:var(--cp)}
.variant-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:10px}.variant-meta{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}.variant-meta span{border:1px solid var(--line);border-radius:999px;background:var(--soft);padding:4px 9px;font-size:12px;color:#314156}.footer{font-size:12px;color:var(--muted);margin-top:18px}
ul{margin:8px 0 0 20px;padding:0}@media(max-width:820px){.summary,.grid-two{grid-template-columns:1fr}.wrapper{padding:14px 10px}.hero,.league,.variant,.section,.mode{border-radius:8px;padding:13px}.variant-head{display:block}.variant-meta{justify-content:flex-start;margin-top:8px}table{font-size:12px;display:block;overflow-x:auto;white-space:nowrap}.skills{white-space:normal;min-width:260px}.ability{white-space:nowrap}}
</style>
</head>
<body>
<div class="wrapper">
<section class="hero">
<h1>${escapeHtml(reportTitle)}</h1>
<p>這版已重跑模型，使用 <strong>${escapeHtml(projection.modelVersion)}</strong>。RP workload 仍只套 RP；同時新增角色/情境技能濾波，像中繼能力○、人氣者、牽制、勝運/負運不再把 RP KNN 拉去錯的三振歷史群。CP/CL 保持救援機會模型。</p>
<div class="summary">
<div class="card"><div class="label">資料來源</div><div class="value">season ${escapeHtml(source.season)} day ${escapeHtml(source.day)}</div></div>
<div class="card"><div class="label">targetSeason</div><div class="value">${targetSeason}</div></div>
<div class="card"><div class="label">冠軍預測</div><div class="value">${escapeHtml(champion ? champion.team : '')}</div></div>
<div class="card"><div class="label">報告內容</div><div class="value ok">${escapeHtml(includedModes)}</div></div>
</div>
<p>Fresh scrape timestamp: ${escapeHtml(source.scrapedAt)}；training seasons: ${escapeHtml(trainingSeasons)}；direct same-player carry-forward weight = 0。</p>
</section>
${renderFinalSubmissionChecklist(weeklyItemsAudit, hitRateAudit, submissionReadinessAudit, leagueAudit, leagueConfidenceAudit)}
${renderFreshnessGuard(projection, weeklyItemsAudit, submissionReadinessAudit, generatedAtIso)}
${renderSelectedSubmissionLineup(submissionReadinessAudit, { HR: hrReport, SB: sbReport, K: kReport, ERA: eraReport })}
<section class="section"><h2>資料與模型檢查</h2><ul><li>Parser contract：12 隊、每隊 9 野手 + 9 投手，總計 216 人。</li><li>SP/RP/CP 分開；RP workload 只套 RP；CP/CL 是救援機會，不當 SP，也不吃一般 RP workload。</li><li>退休替補：retired ${retired} / replacement rookies ${replacements}。</li><li>本報告沒有使用或假設缺失的 2026-06-12 / season-775 / live-2026-06-12 資料。</li></ul></section>
${renderWeeklyItemsAuditSummary(weeklyItemsAudit)}
${renderWeeklySubmissionCard(weeklyItemsAudit, hitRateAudit)}
${renderWeeklyItemRiskGate(weeklyItemsAudit, hitRateAudit)}
${renderSubmissionReadinessAuditSummary(submissionReadinessAudit)}
${renderHitRateAuditSummary(hitRateAudit)}
${renderFantasyPublicAuditSummary(fantasyPublicAudit)}
${renderAuditSummary(audit)}
${renderLeagueAuditSummary(leagueAudit)}
${renderLeagueRankingSubmissionCard(leagueAudit)}
${renderLeagueConfidenceAuditSummary(leagueConfidenceAudit)}
<div class="grid-two">${renderLeagueTables(projection)}</div>
${roleUsageSummary(projection, [hrReport, sbReport, kReport, eraReport].filter(Boolean))}
${renderMode('HR', hrReport)}
${renderMode('SB', sbReport)}
${renderMode('K', kReport)}
${renderMode('ERA', eraReport)}
<p class="footer">Generated at ${generatedAtIso} from ${escapeHtml(projectionPath)}, ${escapeHtml(hrPath || '')}, ${escapeHtml(sbPath || '')}, ${escapeHtml(kPath)}, ${escapeHtml(eraPath)}.</p>
</div>
</body>
</html>`;

  const paths = { htmlPath, bodyPath, textPath, subjectPath, validationPath, projectionPath, hrPath, sbPath, kPath, eraPath, auditPath, leagueAuditPath, leagueConfidenceAuditPath, weeklyItemsAuditPath, fantasyPublicAuditPath, hitRateAuditPath, submissionReadinessAuditPath };
  const check = validation(projection, hrReport, sbReport, kReport, eraReport, html, paths, audit, leagueAudit, leagueConfidenceAudit, weeklyItemsAudit, fantasyPublicAudit, hitRateAudit, submissionReadinessAudit, requireAudits, generatedAtIso);
  const subject = `ORE ${targetSeason} Weekly Goal Monitor：${includedModes} HTML（${dateLabel}）`;
  const text = [
    `ORE ${targetSeason} Weekly Goal Monitor - ${includedModes} ${modelLabel}`,
    `HTML report: ${htmlPath}`,
    `Model: ${projection.modelVersion}`,
    `HR variants: ${hrReport ? (hrReport.lineupVariants || []).length : 0}, legal: ${hrReport ? legalityOk(hrReport) : 'not included'}`,
    `SB variants: ${sbReport ? (sbReport.lineupVariants || []).length : 0}, legal: ${sbReport ? legalityOk(sbReport) : 'not included'}`,
    `K variants: ${(kReport.lineupVariants || []).length}, legal: ${legalityOk(kReport)}`,
    `ERA variants: ${(eraReport.lineupVariants || []).length}, legal: ${legalityOk(eraReport)}`,
    `Final submission checklist: ${check.finalSubmissionChecklistIncluded ? `submit=${check.finalSubmissionChecklistWeeklyItem} V${check.submissionCardRecommendedVariant}; champion=${check.finalSubmissionChecklistLeagueChampion}` : 'not included'}`,
    `Freshness guard: ${check.freshnessGuardIncluded ? `source=${check.freshnessGuardSourceSeason}/day${check.freshnessGuardSourceDay}; scrapedAt=${check.freshnessGuardSourceScrapedAt}; liveFetchAll=${check.freshnessGuardLiveFetchAll}` : 'not included'}`,
    `Selected submission lineup: ${check.selectedSubmissionLineupIncluded ? `${check.selectedSubmissionLineupPrimaryItem} V${check.selectedSubmissionLineupPrimaryVariant} rows=${check.selectedSubmissionLineupPrimaryRows} copyRows=${check.selectedSubmissionPrimaryCopyRows}; backup=${check.selectedSubmissionLineupBackupItem} V${check.selectedSubmissionLineupBackupVariant} rows=${check.selectedSubmissionLineupBackupRows} copyRows=${check.selectedSubmissionBackupCopyRows}` : 'not included'}`,
    `Weekly item risk gate: ${check.weeklyItemRiskGateIncluded ? `primary=${check.weeklyRiskPrimaryItem} ${check.weeklyRiskPrimaryLevel} clearMiss=${fmt(Number(check.weeklyRiskPrimaryClearMissRate || 0) * 100, 1)}%; backup=${check.weeklyRiskBackupItem} ${check.weeklyRiskBackupLevel} clearMiss=${fmt(Number(check.weeklyRiskBackupClearMissRate || 0) * 100, 1)}%` : 'not included'}`,
    `Weekly items audit: ${weeklyItemsAudit ? `primary=${weeklyItemsAudit.recommendation && weeklyItemsAudit.recommendation.primary}` : 'not included'}`,
    `Fantasy hit-rate audit: ${hitRateAudit ? `status=${hitRateAudit.status}; primary=${hitRateAudit.primaryItem}` : 'not included'}`,
    `Fantasy submission readiness: ${submissionReadinessAudit ? `status=${submissionReadinessAudit.status}; action=${submissionReadinessAudit.submission && submissionReadinessAudit.submission.action}` : 'not included'}`,
    `Fantasy public audit: ${fantasyPublicAudit ? `status=${fantasyPublicAudit.status}; playerPicks=${fantasyPublicAudit.fantasy && fantasyPublicAudit.fantasy.playerPicksStatus}` : 'not included'}`,
    `Signal audit: ${audit ? `primary=${audit.recommendation && audit.recommendation.primary}` : 'not included'}`,
    `League audit: ${leagueAudit ? `status=${leagueAudit.overall && leagueAudit.overall.status}` : 'not included'}`,
    `League ranking submission card: ${leagueAudit ? `champion=${leagueAudit.overall && leagueAudit.overall.projectedChampion}; exact=${leagueAudit.overall && leagueAudit.overall.exactMatches}/${leagueAudit.overall && leagueAudit.overall.teamCount}` : 'not included'}`,
    `League ranking confidence: ${leagueConfidenceAudit ? `status=${leagueConfidenceAudit.status}; championConfidence=${leagueConfidenceAudit.overall && leagueConfidenceAudit.overall.championConfidence}; decision=${leagueConfidenceAudit.overall && leagueConfidenceAudit.overall.decision}; swapWatch=${leagueConfidenceAudit.summary && leagueConfidenceAudit.summary.swapWatchCount}` : 'not included'}`,
    `RP workload: ${check.roleUsageCounts.rpEnabled}/${check.roleUsageCounts.RP} RP enabled; SP=${check.roleUsageCounts.spEnabled}, CP=${check.roleUsageCounts.cpEnabled}`,
    `Validation: ${check.status}`
  ].join('\n');

  writeFile(htmlPath, html);
  writeFile(bodyPath, html);
  writeFile(textPath, text);
  writeFile(subjectPath, subject);
  writeFile(validationPath, JSON.stringify(check, null, 2));
  console.log(JSON.stringify(check, null, 2));
}

main();
