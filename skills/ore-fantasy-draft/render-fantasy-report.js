#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

function getArg(name, fallback = null) {
  const prefix = `${name}=`;
  const found = process.argv.find(arg => arg.startsWith(prefix));
  if (!found) return fallback;
  return found.slice(prefix.length);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function trainingSeasonLabel(season) {
  if (season && typeof season === 'object') return season.season;
  return season;
}

function lineForLegality(legality) {
  const labels = {
    total18: '\u5171 18 \u4eba',
    nineBatters: '9 \u540d\u91ce\u624b',
    ninePitchers: '9 \u540d\u6295\u624b',
    fiveSP: '5 \u540d\u5148\u767c',
    threeRP: '3 \u540d\u4e2d\u7e7c',
    oneCP: '1 \u540d\u6551\u63f4',
    fullBatterGrid: '\u91ce\u624b\u5b88\u4f4d\u9f4a\u5168',
    twelveTeamsCovered: '12 \u968a\u5168\u8986\u84cb',
    maxTwoPerTeam: '\u6bcf\u968a\u6700\u591a 2 \u4eba',
    noComputerPlayers: '\u7121\u96fb\u8166\u7403\u54e1'
  };
  return Object.entries(legality || {})
    .map(([key, value]) => `${labels[key] || key}=${value ? '\u901a\u904e' : '\u5931\u6557'}`)
    .join(', ');
}

function sourceTypeLabel(value) {
  const labels = {
    live_fetch: '\u5373\u6642\u6293\u53d6',
    fallback: '\u5099\u63f4\u8cc7\u6599',
    live_dir: '\u6307\u5b9a\u5373\u6642\u8cc7\u6599\u593e'
  };
  return labels[value] || value || '';
}

function value(row, key) {
  const item = row && Object.prototype.hasOwnProperty.call(row, key) ? row[key] : '';
  return item == null ? '' : String(item);
}

function sumProjected(lineup, category, stat) {
  return asArray(lineup)
    .filter(item => item && item.category === category)
    .reduce((sum, item) => sum + Number((item.projectedStats && item.projectedStats[stat]) || 0), 0);
}

function avgProjected(lineup, category, stat) {
  const values = asArray(lineup)
    .filter(item => item && item.category === category)
    .map(item => Number((item.projectedStats && item.projectedStats[stat]) || 0))
    .filter(Number.isFinite);
  if (!values.length) return 0;
  return Number((values.reduce((sum, item) => sum + item, 0) / values.length).toFixed(2));
}

function avgProjectedFixed(lineup, category, stat, digits = 3) {
  const values = asArray(lineup)
    .filter(item => item && item.category === category)
    .map(item => Number((item.projectedStats && item.projectedStats[stat]) || 0))
    .filter(Number.isFinite);
  if (!values.length) return (0).toFixed(digits);
  return (values.reduce((sum, item) => sum + item, 0) / values.length).toFixed(digits);
}

function versionTitle(report, variant) {
  const prefix = `\u7248\u672c ${variant.variantIndex}`;
  const lineup = variant.lineup || [];
  if (report.mode === 'k') {
    return `${prefix}\uff08\u9810\u4f30\u4e09\u632f ${sumProjected(lineup, 'pitcher', 'strikeouts')}\uff1b\u6253\u8005\u50c5\u5408\u6cd5\u586b\u683c\uff09`;
  }
  if (report.mode === 'kavg') {
    return `${prefix}\uff08\u9810\u4f30\u4e09\u632f ${sumProjected(lineup, 'pitcher', 'strikeouts')}\uff1b\u9810\u4f30\u6253\u64ca\u7387 ${avgProjectedFixed(lineup, 'batter', 'batting_avg', 3)}\uff09`;
  }
  if (report.mode === 'svsb') {
    return `${prefix}\uff08\u9810\u4f30\u6551\u63f4 ${sumProjected(lineup, 'pitcher', 'saves')}\uff1b\u9810\u4f30\u76dc\u58d8 ${sumProjected(lineup, 'batter', 'steals')}\uff09`;
  }
  if (report.mode === 'sbk') {
    return `${prefix}\uff08\u9810\u4f30\u76dc\u58d8 ${sumProjected(lineup, 'batter', 'steals')}\uff1b\u9810\u4f30\u4e09\u632f ${sumProjected(lineup, 'pitcher', 'strikeouts')}\uff09`;
  }
  if (report.mode === 'sbera') {
    return `${prefix}\uff08\u9810\u4f30\u76dc\u58d8 ${sumProjected(lineup, 'batter', 'steals')}\uff1b\u9810\u4f30ERA ${avgProjected(lineup, 'pitcher', 'era')}\uff09`;
  }
  if (report.mode === 'eraavg') {
    return `${prefix}\uff08\u9810\u4f30ERA ${avgProjected(lineup, 'pitcher', 'era')}\uff1b\u9810\u4f30\u6253\u64ca\u7387 ${avgProjectedFixed(lineup, 'batter', 'batting_avg', 3)}\uff09`;
  }
  if (report.mode === 'era') {
    return `${prefix}\uff08\u9810\u4f30ERA ${avgProjected(lineup, 'pitcher', 'era')}\uff1b\u6253\u8005\u50c5\u5408\u6cd5\u586b\u683c\uff09`;
  }
  if (report.mode === 'sb') {
    return `${prefix}\uff08\u9810\u4f30\u76dc\u58d8 ${sumProjected(lineup, 'batter', 'steals')}\uff1b\u9810\u4f30\u6551\u63f4 ${sumProjected(lineup, 'pitcher', 'saves')}\uff09`;
  }
  return `${prefix}\uff08\u9810\u4f30\u5168\u58d8\u6253 ${sumProjected(lineup, 'batter', 'home_runs')}\uff1b\u9810\u4f30\u6551\u63f4 ${sumProjected(lineup, 'pitcher', 'saves')}\uff09`;
}

function render(report) {
  const cols = [
    '\u4f4d\u7f6e',
    '\u968a\u4f0d',
    '\u7403\u54e1\u540d\u7a31',
    'GM\u540d\u7a31',
    '\u80fd\u529b',
    '\u6280\u80fd'
  ];
  const lines = [];
  const isKOnly = report.mode === 'k';
  const isKAvg = report.mode === 'kavg';
  const isSvSb = report.mode === 'svsb';
  const isSbk = report.mode === 'sbk';
  const isSbEra = report.mode === 'sbera';
  const isEraOnly = report.mode === 'era';
  const isEraAvg = report.mode === 'eraavg';
  const isSb = report.mode === 'sb' || isSbk || isSbEra || isSvSb;
  const modeTitle = isKOnly
    ? '\u4e09\u632f\u55ae\u9805\u5922\u5e7b\u968a 5 \u7248 - \u6295\u624b\u512a\u5148'
    : isKAvg
    ? '\u4e09\u632f+\u6253\u64ca\u7387\u5922\u5e7b\u968a 5 \u7248 - \u6295\u624b\u512a\u5148'
    : isSvSb
      ? '\u6551\u63f4+\u76dc\u58d8\u5922\u5e7b\u968a 5 \u7248 - \u6295\u624b\u512a\u5148'
    : isEraOnly
      ? 'ERA\u55ae\u9805\u5922\u5e7b\u968a 5 \u7248 - \u6295\u624b\u512a\u5148'
    : isEraAvg
      ? 'ERA+\u6253\u64ca\u7387\u5922\u5e7b\u968a 5 \u7248 - \u6295\u624b\u512a\u5148'
    : isSbk
    ? '\u76dc\u58d8+\u4e09\u632f\u5922\u5e7b\u968a 5 \u7248'
    : isSbEra
      ? '\u76dc\u58d8+ERA\u5922\u5e7b\u968a 5 \u7248'
    : isSb
      ? '\u76dc\u58d8+\u6551\u63f4\u5922\u5e7b\u968a 5 \u7248 - \u7b56\u7565\u500d\u7387\u4fee\u6b63\u7248'
      : '\u5168\u58d8\u6253+\u6551\u63f4\u5922\u5e7b\u968a 5 \u7248';

  lines.push(modeTitle);
  lines.push(`\u7522\u751f\u6642\u9593: ${report.generatedAt || ''}`);
  lines.push(`\u7403\u54e1\u8cc7\u6599: ${(report.source && report.source.seasonDir) || ''}`);
  lines.push(`\u9bae\u6293\u6642\u9593: ${(report.source && report.source.seasonScrapedAt) || ''}`);
  lines.push(`\u5922\u5e7b\u968a\u5373\u6642\u4f86\u6e90: ${sourceTypeLabel(report.source && report.source.liveSourceType)} ${(report.source && report.source.liveSourceTimestamp) || ''}`.trim());
  lines.push(`\u6a21\u578b: ${(report.projection && report.projection.modelVersion) || ''} / ${(report.projection && report.projection.confidence) || ''}`);
  lines.push(`\u8a13\u7df4\u5b63: ${asArray(report.projection && report.projection.trainingSeasons).map(trainingSeasonLabel).join(', ')}`);
  lines.push('\u6a21\u578b\u898f\u5247: \u5b88\u4f4d\u8207\u6295\u624b\u89d2\u8272\u7d0d\u5165\u7279\u5fb5\uff1b\u4e2d\u7e7c\u80fd\u529b\u50c5\u5728\u5148\u767c\u89d2\u8272\u751f\u6548\uff0c\u5f8c\u63f4/\u6551\u63f4\u986f\u793a\u70ba\u539f\u59cb\u6280\u80fd\u4f46\u4e0d\u8a08\u52a0\u6210\u3002');
  if (report.assumptions && report.assumptions.sameLeagueOpponentContextUsedInProjection) {
    lines.push('\u540c\u806f\u76df\u4fee\u6b63: \u7403\u968a\u6295\u5f71 overallScore \u5df2\u7d0d\u5165\u540c\u806f\u76df\u5c0d\u624b\u74b0\u5883\u8207\u76f8\u5c0d\u5dee\u8ddd\uff0c\u4e0d\u53ea\u662f\u8cfd\u5f8c\u5206\u806f\u76df\u6392\u5e8f\u3002');
  }
  if (report.assumptions && report.assumptions.sameLeagueBatterEnvironmentUsedInPlayerProjection && report.assumptions.sameLeaguePitcherEnvironmentUsedInPlayerProjection) {
    lines.push('球員層環境: 打者已套用同聯盟對手投手難度；投手已套用同聯盟對手打者強度、contact 與 power，ERA/K/AVG 名單使用修正後投影。');
  }
  if (isSb) {
    lines.push('\u898f\u5247\u4fee\u6b63: \u76dc\u58d85 = 1.0 \u500d\uff0c\u76dc\u58d810 = 2.0 \u500d\uff0c\u76dc\u58d81 = 0\uff1b\u540c\u806f\u76df\u727d\u5236X\u74b0\u5883\u4ecd\u6703\u8abf\u6574\u76dc\u58d8\u3002');
  }
  if (isSbk) {
    lines.push('\u6295\u624b\u76ee\u6a19: \u9810\u4f30\u4e09\u632f\u512a\u5148\uff1b\u6551\u63f4\u3001\u9632\u79a6\u7387\u3001\u52dd\u6557\u4e0d\u62ff\u4f86\u62c9\u9ad8\u6295\u624b\u5206\u6578\u3002');
  }
  if (isKAvg) {
    lines.push('\u9078\u4eba\u512a\u5148\u9806\u5e8f: \u5148\u9078\u6295\u624b\u3001\u518d\u88dc\u91ce\u624b\uff1b\u6295\u624b\u76ee\u6a19\u662f\u9810\u4f30\u4e09\u632f\uff0c\u91ce\u624b\u76ee\u6a19\u662f\u9810\u4f30\u6253\u64ca\u7387\u3002');
  }
  if (isKOnly) {
    lines.push('\u9078\u4eba\u512a\u5148\u9806\u5e8f: \u5148\u9078\u6295\u624b\u3001\u518d\u88dc\u91ce\u624b\uff1b\u6295\u624b\u76ee\u6a19\u662f\u9810\u4f30\u4e09\u632f\uff0c\u6253\u8005\u53ea\u8ca0\u8cac\u5408\u6cd5\u586b\u683c\uff0c\u4e0d\u4ee5AVG/HR/SB\u6700\u4f73\u5316\u3002');
  }
  if (isEraAvg) {
    lines.push('\u9078\u4eba\u512a\u5148\u9806\u5e8f: \u5148\u9078\u6295\u624b\u3001\u518d\u88dc\u91ce\u624b\uff1b\u6295\u624b\u76ee\u6a19\u662f\u9810\u4f30ERA\u8d8a\u4f4e\u8d8a\u597d\uff0c\u91ce\u624b\u76ee\u6a19\u662f\u9810\u4f30\u6253\u64ca\u7387\u3002');
  }
  if (isEraOnly) {
    lines.push('\u9078\u4eba\u512a\u5148\u9806\u5e8f: \u5148\u9078\u6295\u624b\u3001\u518d\u88dc\u91ce\u624b\uff1b\u6295\u624b\u76ee\u6a19\u662f\u9810\u4f30ERA\u8d8a\u4f4e\u8d8a\u597d\uff0c\u6253\u8005\u53ea\u8ca0\u8cac\u5408\u6cd5\u586b\u683c\uff0c\u4e0d\u4ee5AVG/HR/SB\u6700\u4f73\u5316\u3002');
  }
  if (isSvSb) {
    lines.push('\u9078\u4eba\u512a\u5148\u9806\u5e8f: \u5148\u9078\u6295\u624b\u3001\u518d\u88dc\u91ce\u624b\uff1b\u6295\u624b\u76ee\u6a19\u662f\u9810\u4f30\u6551\u63f4\uff0c\u91ce\u624b\u76ee\u6a19\u662f\u9810\u4f30\u76dc\u58d8\u3002');
  }
  if (isSbEra) {
    lines.push('\u6295\u624b\u76ee\u6a19: \u9810\u4f30ERA\u8d8a\u4f4e\u8d8a\u512a\u5148\uff1b\u6551\u63f4\u3001\u4e09\u632f\u3001\u52dd\u6557\u4e0d\u62ff\u4f86\u62c9\u9ad8\u6295\u624b\u5206\u6578\u3002');
  }
  lines.push(`\u5408\u6cd5\u6027: ${lineForLegality(report.legality)}`);
  lines.push(`\u7248\u672c\u6578: ${(report.lineupVariantPolicy && report.lineupVariantPolicy.produced) || 0}/${(report.lineupVariantPolicy && report.lineupVariantPolicy.requested) || 0}`);
  lines.push('');

  for (const variant of asArray(report.lineupVariants)) {
    lines.push(versionTitle(report, variant));
    lines.push(cols.join(' | '));
    for (const row of asArray(variant.displayRows)) {
      lines.push(cols.map(col => value(row, col)).join(' | '));
    }
    lines.push('');
  }

  return lines.join('\n');
}

const input = getArg('--input', path.join(__dirname, '..', '..', 'reports', 'ore_draft_sb.json'));
const output = getArg('--output', path.join(__dirname, '..', '..', 'reports', 'ore_sb_5_versions_strategy_multiplier_utf8.txt'));
const report = JSON.parse(fs.readFileSync(input, 'utf8'));

fs.writeFileSync(output, `\ufeff${render(report)}\n`, 'utf8');
console.log(output);
