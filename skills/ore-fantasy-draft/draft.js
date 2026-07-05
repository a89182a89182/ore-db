const fs = require('fs');
const http = require('http');
const https = require('https');
const iconv = require('iconv-lite');
const path = require('path');
const solver = require('javascript-lp-solver');
const projection = require('./projection');

const WORKSPACE = path.resolve(__dirname, '..', '..');
const USER_HOME = process.env.USERPROFILE || 'C:\\Users\\a8918';
const ORE_DB_BASE = path.join(USER_HOME, 'Documents', 'ore-db');
const ORE_BASE_URL = 'http://game.tinycafe.com/ore/ore.cgi';
const ORE_KAKUNINN_URL = 'http://game.tinycafe.com/ore/ore.cgi?hello=1776650752&kakuninn=%B0%7D%AEe%A4%B6%B2%D0';
const ORE_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) OpenClaw ORE Draft';
const TEAM_ORDER = ['年代勇士', '興農牛隊', '誠泰Cobras', '時報鷹隊', '三商虎隊', '兄弟象隊', '俊國熊隊', 'Lamigo桃猿', '味全龍隊', '統一獅隊', '中信鯨隊', '生活雷公'];
const BATTER_SLOTS = ['C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF', 'DH'];
const PITCH_SLOTS = ['SP', 'RP', 'CP'];
const CANONICAL_HANDOFF = path.join(USER_HOME, '.codex', 'automations', 'ore-sunday-preview', 'openclaw-handoff.md');
const WORKSPACE_LIVE_DIR = path.join(WORKSPACE, 'tmp', 'ore-live');
const LIVE_FILES = ['kakuninn.html', ...Array.from({ length: 12 }, (_, i) => `saku_${i}.html`)];
const MAX_BATTER_SEARCH_ATTEMPTS = 250;
const MIN_USABLE_KAKUNINN_ENTRIES = 50;
const DEFAULT_VARIANT_COUNT = 5;
const ALLOW_FANTASY_RETIREMENT_REPLACEMENTS = false;
const AGE43_FORMAL_LINEUP_THRESHOLD = 43;
const DEFAULT_WEIGHT_PROFILE_PATH = path.join(__dirname, 'weight-profiles', 'default.json');
let ACTIVE_WEIGHT_PROFILE = null;
let DIAGNOSTIC_ACTUAL_STATS = null;

// Legacy ORE pages can surface Big5-decoded role labels as these keys; keep them for parser compatibility.
const BATTER_ROLE_MAP = {
  '??': 'C',
  '銝憯?': '1B',
  '鈭?': '2B',
  '銝?': '3B',
  '皜豢?': 'SS',
  '撌血?': 'LF',
  '銝剖?': 'CF',
  '?喳?': 'RF',
  '??': 'DH',
  'DH': 'DH'
};

const BATTER_SKILL_WEIGHTS = {
  hr: {
    '豪力': 34, '豪力打者': 34, '強力打者': 24, '得點圈◎': 12, '得點圈○': 8,
    '滿壘男': 6, '再見男': 4, '安定感': 7, '巧打打者': 6, '固定打者': 4,
    '威壓感': 4, '鬥氣': 8, '鬥氣打者': 10, '難纏': 6, '奪力': 4,
    '對左投Ｘ': -6, '對右投Ｘ': -6, '不安定感': -5
  },
  sb: {
    '神速': 20, '神速打者': 20, '盜壘○': 18, '開路先鋒': 12, '內野安打': 8,
    '巧打打者': 6, '固定打者': 4, '安定感': 4, '盜壘Ｘ': -25,
    '不安定感': -5, '對左投Ｘ': -4, '對右投Ｘ': -4
  }
};

const PITCH_SKILL_WEIGHTS = {
  SP: { '威壓感': 10, '安定感': 8, '勝運': 6, '直球○': 6, '變化○': 6, '危機○': 8, '逃球': 8, '重球': 6, '氣魄': 6, '對左打○': 5, '對右打○': 5, '一發病': -12, '不安定感': -8, '危機Ｘ': -8 },
  RP: { '威壓感': 10, '安定感': 6, '危機○': 10, '逃球': 10, '重球': 8, '氣魄': 8, '直球○': 8, '對左打○': 5, '一發病': -15, '不安定感': -6, '危機Ｘ': -10, '對左打Ｘ': -5 },
  CP: { '威壓感': 12, '安定感': 6, '危機○': 15, '逃球': 12, '重球': 10, '氣魄': 12, '直球○': 10, '對左打○': 6, '一發病': -18, '不安定感': -6, '危機Ｘ': -14, '對左打Ｘ': -6 }
};
const STARTER_ONLY_PITCHER_SKILLS = new Set(['中繼能力', '中繼能力○']);

const PITCHER_STRIKEOUT_SKILL_WEIGHTS = {
  '直球○': 12,
  '變化○': 12,
  '剛球': 14,
  '鐵腕': 10,
  '超人': 8,
  '氣魄': 7,
  '威壓感': 6,
  '安定感': 4,
  '對左打○': 4,
  '對右打○': 4,
  '直球Ｘ': -12,
  '變化Ｘ': -12,
  '不安定感': -5,
  '一發病': -4
};

const IMG_SKILL_MAP = {
  bantbatsu: '觸擊Ｘ',
  bantmaru: '觸擊○',
  bant5: '觸擊◎',
  chancebatsu: '得點圈Ｘ',
  chancemaru: '得點圈○',
  chance5: '得點圈◎',
  hidaritobatsu: '對左投Ｘ',
  hidaritomaru: '對左投○',
  hidarito5: '對左投◎',
  touruibatsu: '盜壘Ｘ',
  tourui: '盜壘○',
  timelyerror: '守備能力Ｘ',
  syubimaru: '守備能力○',
  powerhitter: '強力打者',
  contacthitter: '巧打打者',
  gouryoku: '豪力',
  gyakkyou: '逆境○',
  manrui: '滿壘男',
  uchiuti: '內野安打',
  flirt: '固定打者',
  leadoffman: '開路先鋒',
  sayonara: '再見男',
  shoulder: '傳球○',
  iatsukan: '威壓感',
  anteikan: '安定感',
  huanteikan: '不安定感',
  ninkimono: '人氣者',
  jinsoku: '神速',
  toukon: '鬥氣',
  dappower: '奪力',
  kusemono: '難纏',
  nobimaru: '直球○',
  nobibatsu: '直球Ｘ',
  henkamaru: '變化○',
  henkabatsu: '變化Ｘ',
  pinchimaru: '危機○',
  pinchibatsu: '危機Ｘ',
  hidaridamaru: '對左打○',
  hidaridabatsu: '對左打Ｘ',
  quickmaru: '牽制○',
  quickbatsu: '牽制Ｘ',
  makeun: '負運',
  kachiun: '勝運',
  utareduyoi: '被連打○',
  utareduibatsu: '被連打Ｘ',
  ippatsubyo: '一發病',
  nigedama: '逃球',
  omoitama: '重球',
  siriagari: '中繼能力○',
  hannoumaru: '投球反應○',
  tetsuwan: '鐵腕',
  goukyu: '剛球',
  zetsurin: '超人',
  jubaku: '束縛',
  kihaku: '氣魄'
};

function parseArgs(argv) {
  const opts = {};
  for (let i = 2; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const [rawKey, inlineValue] = token.slice(2).split('=');
      if (inlineValue !== undefined) {
        opts[rawKey] = inlineValue;
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        opts[rawKey] = argv[++i];
      } else {
        opts[rawKey] = true;
      }
    } else if (!opts.mode) {
      opts.mode = token;
    }
  }
  return opts;
}

function profileGet(pathParts, fallback = undefined) {
  let current = ACTIVE_WEIGHT_PROFILE;
  for (const part of pathParts) {
    if (!current || !Object.prototype.hasOwnProperty.call(current, part)) return fallback;
    current = current[part];
  }
  return current === undefined ? fallback : current;
}

function profileNum(pathParts, fallback) {
  const value = profileGet(pathParts, fallback);
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function profileSkillWeights(pathParts, fallback) {
  const value = profileGet(pathParts, null);
  return value && typeof value === 'object' && !value.useBuiltin ? value : fallback;
}

function profilePathSummary(profilePath) {
  return profilePath ? path.resolve(profilePath) : DEFAULT_WEIGHT_PROFILE_PATH;
}

function parseRateValue(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  const text = String(value).trim();
  if (!text) return fallback;
  const n = Number(text.startsWith('.') ? `0${text}` : text);
  return Number.isFinite(n) ? n : fallback;
}

function loadDiagnosticActualStats(filePath) {
  if (!filePath) return null;
  const rows = readJson(filePath);
  const byName = new Map();
  for (const player of rows) {
    const summary = player.season_summary || {};
    const batting = player.current_batting || {};
    const pitching = player.current_pitching || {};
    const category = player.category || (pitching.era != null ? 'pitcher' : 'batter');
    byName.set(player.name, {
      category,
      AVG: parseRateValue(summary.batting_avg, parseRateValue(batting.batting_avg)),
      HR: asNum(summary.home_runs, asNum(batting.home_runs)),
      RBI: asNum(summary.rbi, asNum(batting.rbi)),
      SB: asNum(summary.steals, asNum(batting.steals)),
      ERA: parseRateValue(summary.era, parseRateValue(pitching.era, 99)),
      W: asNum(summary.wins, asNum(pitching.wins)),
      SV: asNum(summary.saves, asNum(pitching.saves)),
      K: asNum(summary.strikeouts, asNum(pitching.strikeouts))
    });
  }
  return { filePath: path.resolve(filePath), byName };
}

function loadWeightProfile(profilePath, { allowDiagnostic = false } = {}) {
  const resolved = profilePathSummary(profilePath);
  const profile = readJson(resolved);
  profile.__path = resolved;
  if (profile.diagnosticOnly && !allowDiagnostic) {
    throw new Error(`Refusing diagnosticOnly weight profile without --allow-diagnostic-profile: ${resolved}`);
  }
  ACTIVE_WEIGHT_PROFILE = profile;
  const actualPath = profile && profile.diagnostic && profile.diagnostic.actualStatsPath;
  DIAGNOSTIC_ACTUAL_STATS = profile && profile.diagnostic && profile.diagnostic.enabled
    ? loadDiagnosticActualStats(actualPath)
    : null;
  return profile;
}

function currentWeightProfileSummary() {
  const profile = ACTIVE_WEIGHT_PROFILE || {};
  return {
    schemaVersion: profile.schemaVersion || null,
    name: profile.name || null,
    path: profile.__path || null,
    diagnosticOnly: !!profile.diagnosticOnly,
    diagnosticEnabled: !!(profile.diagnostic && profile.diagnostic.enabled),
    variantCount: profileNum(['variantCount'], DEFAULT_VARIANT_COUNT),
    skillWeights: profile.skillWeights && profile.skillWeights.useBuiltin ? 'builtin' : 'profile',
    actualStatsPath: DIAGNOSTIC_ACTUAL_STATS ? DIAGNOSTIC_ACTUAL_STATS.filePath : null
  };
}

function diagnosticActualScore({ name, category, mode }) {
  if (!DIAGNOSTIC_ACTUAL_STATS) return null;
  const item = String(profileGet(['diagnostic', 'item'], mode) || mode).toUpperCase();
  const row = DIAGNOSTIC_ACTUAL_STATS.byName.get(name);
  if (!row) return null;
  const batterItems = new Set(['AVG', 'HR', 'RBI', 'SB']);
  const pitcherItems = new Set(['ERA', 'W', 'SV', 'K']);
  if (batterItems.has(item) && category !== 'batter') return null;
  if (pitcherItems.has(item) && category !== 'pitcher') return null;
  const value = asNum(row[item], null);
  if (value === null) return null;
  const scale = profileNum(['diagnostic', 'scoreScale'], 1000000);
  const score = item === 'ERA' ? -value * scale : value * scale;
  return {
    item,
    value,
    score,
    source: 'diagnostic_actual_final_stats'
  };
}

function isStealsMode(mode) {
  return mode === 'sb' || mode === 'sbk' || mode === 'sbera' || mode === 'svsb';
}

function isStrikeoutPitcherMode(mode) {
  return mode === 'sbk' || mode === 'kavg' || mode === 'k';
}

function isEraPitcherMode(mode) {
  return mode === 'sbera' || mode === 'eraavg' || mode === 'era';
}

function isSavesPitcherMode(mode) {
  return mode === 'svsb' || mode === 'sv';
}

function isAverageBatterMode(mode) {
  return mode === 'kavg' || mode === 'eraavg' || mode === 'avg';
}

function isRbiBatterMode(mode) {
  return mode === 'rbi';
}

function isWinsPitcherMode(mode) {
  return mode === 'w';
}

function isLegalFillerBatterMode(mode) {
  return mode === 'k' || mode === 'era' || mode === 'w' || mode === 'sv';
}

function isPitcherFirstMode(mode) {
  return mode === 'kavg' || mode === 'eraavg' || mode === 'svsb' || mode === 'k' || mode === 'era' || mode === 'w' || mode === 'sv';
}

function readUtf8(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function readJson(filePath) {
  return JSON.parse(readUtf8(filePath));
}

function asNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function latestDir(base, prefix, numericSuffix = false) {
  const dirs = fs.readdirSync(base, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.startsWith(prefix))
    .map(entry => entry.name);
  if (!dirs.length) throw new Error(`No ${prefix}* directory found under ${base}`);
  dirs.sort((a, b) => {
    if (numericSuffix) return Number(b.split('-').pop()) - Number(a.split('-').pop());
    return a.localeCompare(b);
  });
  return path.join(base, dirs[0]);
}

function latestSeasonDir(base) {
  const dirs = fs.readdirSync(base, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^season-\d+$/.test(entry.name))
    .map(entry => entry.name)
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  if (!dirs.length) throw new Error(`No season-* directories found under ${base}`);
  return path.join(base, dirs[0]);
}

function pathExists(targetPath) {
  try {
    fs.accessSync(targetPath);
    return true;
  } catch {
    return false;
  }
}

function isValidLiveDir(dirPath) {
  return !!dirPath && LIVE_FILES.every(file => pathExists(path.join(dirPath, file)));
}

function hasUsableFantasyGrid(dirPath) {
  if (!isValidLiveDir(dirPath)) return false;
  try {
    const kakuninnPath = path.join(dirPath, 'kakuninn.html');
    return parseKakuninn(readUtf8(kakuninnPath)).length >= MIN_USABLE_KAKUNINN_ENTRIES;
  } catch {
    return false;
  }
}

function hasUsableTeisatuPages(dirPath) {
  if (!dirPath) return false;
  try {
    for (let saku = 0; saku < 12; saku++) {
      const filePath = path.join(dirPath, `saku_${saku}.html`);
      if (!pathExists(filePath)) return false;
      const html = readUtf8(filePath);
      if (!html.includes('name=team')) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function maxFileTimestamp(dirPath, files = LIVE_FILES) {
  const timestamps = files
    .map(file => path.join(dirPath, file))
    .filter(file => pathExists(file))
    .map(file => fs.statSync(file).mtimeMs);
  if (!timestamps.length) return null;
  return new Date(Math.max(...timestamps)).toISOString();
}

function readLiveMeta(dirPath) {
  const metaPath = path.join(dirPath, '__meta.json');
  if (!pathExists(metaPath)) return null;
  try {
    return readJson(metaPath);
  } catch {
    return null;
  }
}

function buildLiveSourceInfo(type, dirPath, extra = {}) {
  const meta = readLiveMeta(dirPath);
  return {
    type,
    liveDir: dirPath,
    liveTimestamp: meta && meta.fetchedAt ? meta.fetchedAt : maxFileTimestamp(dirPath),
    liveMeta: meta,
    ...extra
  };
}

function latestLocalLiveDir(base, { requireFantasyGrid = true } = {}) {
  const dirs = fs.readdirSync(base, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^live-\d{4}-\d{2}-\d{2}$/.test(entry.name))
    .map(entry => path.join(base, entry.name))
    .sort((a, b) => path.basename(b).localeCompare(path.basename(a)));
  return dirs.find(dir => requireFantasyGrid ? hasUsableFantasyGrid(dir) : hasUsableTeisatuPages(dir)) || null;
}

function httpText(url, { method = 'GET', body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    const req = client.request(url, {
      method,
      headers: {
        'User-Agent': ORE_USER_AGENT,
        ...headers
      }
    }, res => {
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        res.resume();
        return;
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolve(iconv.decode(buffer, 'cp950'));
      });
    });

    req.setTimeout(30000, () => req.destroy(new Error(`Timeout fetching ${url}`)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function fetchLiveSnapshot(targetDir, { requireFantasyGrid = true } = {}) {
  const stagingDir = `${targetDir}.staging-${process.pid}-${Date.now()}`;
  fs.rmSync(stagingDir, { recursive: true, force: true });
  fs.mkdirSync(stagingDir, { recursive: true });

  try {
    let kakuninn = '';
    let kakuninnError = null;
    let kakuninnUsable = false;
    try {
      kakuninn = await httpText(ORE_KAKUNINN_URL, {
        method: 'GET'
      });
      kakuninnUsable = parseKakuninn(kakuninn).length >= MIN_USABLE_KAKUNINN_ENTRIES;
    } catch (error) {
      kakuninnError = String(error.message || error);
    }
    fs.writeFileSync(path.join(stagingDir, 'kakuninn.html'), kakuninn || '', 'utf8');

    for (let saku = 0; saku < 12; saku++) {
      const pageHtml = await httpText(`${ORE_BASE_URL}?mode=teisatu&saku=${saku}`);
      if (!pageHtml.includes('name=team')) throw new Error(`Live teisatu page ${saku} missing team marker`);
      fs.writeFileSync(path.join(stagingDir, `saku_${saku}.html`), pageHtml, 'utf8');
    }

    if (requireFantasyGrid && !kakuninnUsable) {
      throw new Error(kakuninnError || 'Live kakuninn page did not contain a valid fantasy roster grid');
    }

    const meta = {
      fetchedAt: new Date().toISOString(),
      source: ORE_BASE_URL,
      kakuninnUsable,
      kakuninnError,
      pages: {
        kakuninn: ORE_KAKUNINN_URL,
        teisatu: Array.from({ length: 12 }, (_, i) => `${ORE_BASE_URL}?mode=teisatu&saku=${i}`)
      }
    };
    fs.writeFileSync(path.join(stagingDir, '__meta.json'), JSON.stringify(meta, null, 2), 'utf8');

    fs.rmSync(targetDir, { recursive: true, force: true });
    fs.renameSync(stagingDir, targetDir);
    return buildLiveSourceInfo('live_fetch', targetDir, {
      liveFetchAttempted: true,
      liveFetchSucceeded: true,
      liveFetchError: kakuninnError,
      kakuninnUsable
    });
  } catch (error) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    throw error;
  }
}

async function resolveLiveSource(explicitDir, { disableLiveFetch = false, requireFantasyGrid = true } = {}) {
  if (explicitDir) {
    const usable = requireFantasyGrid ? hasUsableFantasyGrid(explicitDir) : hasUsableTeisatuPages(explicitDir);
    if (!usable) throw new Error(`Explicit live dir is missing usable ${requireFantasyGrid ? 'fantasy kakuninn' : 'teisatu'} data: ${explicitDir}`);
    return buildLiveSourceInfo('explicit', explicitDir, { liveFetchAttempted: false, liveFetchSucceeded: false, liveFetchError: null });
  }

  let liveFetchError = null;
  if (!disableLiveFetch) {
    try {
      return await fetchLiveSnapshot(WORKSPACE_LIVE_DIR, { requireFantasyGrid });
    } catch (error) {
      liveFetchError = error;
    }
  }

  const localLiveDir = latestLocalLiveDir(ORE_DB_BASE, { requireFantasyGrid });
  if (localLiveDir) {
    return buildLiveSourceInfo('local_live_fallback', localLiveDir, {
      liveFetchAttempted: !disableLiveFetch,
      liveFetchSucceeded: false,
      liveFetchError: liveFetchError ? String(liveFetchError.message || liveFetchError) : null,
      fallbackReason: liveFetchError ? 'live_fetch_failed' : 'live_fetch_disabled'
    });
  }

  if (hasUsableFantasyGrid(WORKSPACE_LIVE_DIR)) {
    return buildLiveSourceInfo('workspace_live_cache', WORKSPACE_LIVE_DIR, {
      liveFetchAttempted: !disableLiveFetch,
      liveFetchSucceeded: false,
      liveFetchError: liveFetchError ? String(liveFetchError.message || liveFetchError) : null,
      fallbackReason: liveFetchError ? 'local_live_missing_used_workspace_cache' : 'live_fetch_disabled_used_workspace_cache'
    });
  }

  const suffix = liveFetchError ? ` Live fetch error: ${liveFetchError.message || liveFetchError}` : '';
  throw new Error(`Unable to resolve any live ORE source.${suffix}`);
}

function readSeasonMeta(seasonDir) {
  const metaPath = path.join(seasonDir, 'meta.json');
  if (!pathExists(metaPath)) return null;
  try {
    return readJson(metaPath);
  } catch {
    return null;
  }
}

function scoreSkills(skills, weights) {
  return (skills || []).reduce((sum, skill) => sum + (weights[skill] || 0), 0);
}

function skillDensity(skills) {
  return dedupe(skills || []).length;
}

function markedPitchSkillCount(skills) {
  return dedupe(skills || []).filter(skill => /\(\d+\)/.test(String(skill))).length;
}

function pitcherRiskPenalty(skills) {
  return dedupe(skills || []).reduce((sum, skill) => {
    const text = String(skill || '');
    if (text.includes('一發')) return sum + 6;
    if (text.includes('不安定')) return sum + 4;
    if (text.includes('負運')) return sum + 3;
    return sum;
  }, 0);
}

function batterCoreRunScore({ projectedStats, hrSkillScore, power, contact, skills }) {
  return asNum(projectedStats && projectedStats.home_runs) * profileNum(['itemWeights', 'batterCoreRun', 'homeRuns'], 0.75) +
    asNum(projectedStats && projectedStats.rbi) * profileNum(['itemWeights', 'batterCoreRun', 'rbi'], 0.25) +
    asNum(hrSkillScore) * profileNum(['itemWeights', 'batterCoreRun', 'hrSkillScore'], 0.45) +
    asNum(power) * profileNum(['itemWeights', 'batterCoreRun', 'power'], 0.18) +
    asNum(contact) * profileNum(['itemWeights', 'batterCoreRun', 'contact'], 6) +
    skillDensity(skills) * profileNum(['itemWeights', 'batterCoreRun', 'skillDensity'], 2);
}

function pitcherCoreQualityScore({
  role,
  projectedStats,
  strikeoutCalibration,
  control,
  stamina,
  velocity,
  skills
}) {
  const calibratedK = strikeoutCalibration ? asNum(strikeoutCalibration.calibratedStrikeouts) : asNum(projectedStats && projectedStats.strikeouts);
  const density = skillDensity(skills);
  const pitchMarks = markedPitchSkillCount(skills);
  const risk = pitcherRiskPenalty(skills);
  const roleFactor = role === 'CP' ? 0.88 : (role === 'RP' ? 1.08 : 1);
  return (
    calibratedK * profileNum(['itemWeights', 'pitcherCoreQuality', 'calibratedK'], 0.42) +
    asNum(control) * profileNum(['itemWeights', 'pitcherCoreQuality', 'control'], 0.42) +
    asNum(stamina) * profileNum(['itemWeights', 'pitcherCoreQuality', 'stamina'], 0.32) +
    asNum(velocity) * profileNum(['itemWeights', 'pitcherCoreQuality', 'velocity'], 4.8) +
    density * profileNum(['itemWeights', 'pitcherCoreQuality', 'skillDensity'], 18) +
    pitchMarks * profileNum(['itemWeights', 'pitcherCoreQuality', 'pitchMarks'], 48) -
    asNum(projectedStats && projectedStats.era) * profileNum(['itemWeights', 'pitcherCoreQuality', 'eraPenalty'], 18) -
    risk * profileNum(['itemWeights', 'pitcherCoreQuality', 'riskPenalty'], 28)
  ) * roleFactor;
}

function pitcherEraCoreScore({ role, projectedStats, strikeoutCalibration, control, stamina, velocity, skills }) {
  const calibratedK = strikeoutCalibration ? asNum(strikeoutCalibration.calibratedStrikeouts) : asNum(projectedStats && projectedStats.strikeouts);
  const density = skillDensity(skills);
  const pitchMarks = markedPitchSkillCount(skills);
  const risk = pitcherRiskPenalty(skills);
  const eraWeight = role === 'SP' ? 420 : 270;
  return -asNum(projectedStats && projectedStats.era) * eraWeight +
    calibratedK * profileNum(['itemWeights', 'era', role, 'calibratedK'], role === 'SP' ? 12 : 15) +
    asNum(control) * profileNum(['itemWeights', 'era', role, 'control'], role === 'SP' ? 1.8 : 2.4) +
    asNum(stamina) * profileNum(['itemWeights', 'era', role, 'stamina'], role === 'SP' ? 1.2 : 1.5) +
    asNum(velocity) * profileNum(['itemWeights', 'era', role, 'velocity'], role === 'SP' ? 24 : 29) +
    density * profileNum(['itemWeights', 'era', role, 'skillDensity'], role === 'SP' ? 90 : 105) +
    pitchMarks * profileNum(['itemWeights', 'era', role, 'pitchMarks'], 170) -
    asNum(projectedStats && projectedStats.walks) * profileNum(['itemWeights', 'era', role, 'walksPenalty'], 1.6) -
    asNum(projectedStats && projectedStats.home_runs_allowed) * profileNum(['itemWeights', 'era', role, 'homeRunsAllowedPenalty'], 9) -
    risk * profileNum(['itemWeights', 'era', role, 'riskPenalty'], 110);
}

function pitcherWinCoreScore({ role, projectedStats, strikeoutCalibration, control, stamina, velocity, skills }) {
  const calibratedK = strikeoutCalibration ? asNum(strikeoutCalibration.calibratedStrikeouts) : asNum(projectedStats && projectedStats.strikeouts);
  const eraWeight = role === 'RP' ? 120 : 45;
  return asNum(projectedStats && projectedStats.wins) * profileNum(['itemWeights', 'w', role, 'wins'], 70) +
    calibratedK * profileNum(['itemWeights', 'w', role, 'calibratedK'], 14) -
    asNum(projectedStats && projectedStats.era) * eraWeight +
    asNum(control) * profileNum(['itemWeights', 'w', role, 'control'], 1.2) +
    asNum(stamina) * profileNum(['itemWeights', 'w', role, 'stamina'], 1.6) +
    asNum(velocity) * profileNum(['itemWeights', 'w', role, 'velocity'], 16) +
    skillDensity(skills) * profileNum(['itemWeights', 'w', role, 'skillDensity'], 95) +
    markedPitchSkillCount(skills) * profileNum(['itemWeights', 'w', role, 'pitchMarks'], 150) -
    pitcherRiskPenalty(skills) * profileNum(['itemWeights', 'w', role, 'riskPenalty'], 70);
}

function pitcherSaveOpportunity({ role, projectedStats, strikeoutCalibration, control, skills }) {
  const rawSaves = asNum(projectedStats && projectedStats.saves);
  if (role === 'SP') {
    return {
      rawSaves,
      calibratedSaves: 0,
      workloadBonus: 0,
      controlBonus: 0,
      stabilityBonus: 0,
      riskPenalty: 0
    };
  }

  const calibratedK = strikeoutCalibration ? asNum(strikeoutCalibration.calibratedStrikeouts) : asNum(projectedStats && projectedStats.strikeouts);
  const uniqueSkills = dedupe(skills || []);
  const hasStability = uniqueSkills.some(skill => String(skill).includes('安定'));
  const riskPenalty = uniqueSkills.reduce((sum, skill) => {
    const text = String(skill || '');
    if (text.includes('一發')) return sum + 5;
    if (text.includes('不安定')) return sum + 4;
    return sum;
  }, 0);
  const stabilityBonus = role === 'CP'
    ? (hasStability ? (riskPenalty > 0 ? profileNum(['calibrationWeights', 'saves', 'CP', 'stabilityRiskBonus'], 3) : profileNum(['calibrationWeights', 'saves', 'CP', 'stabilityBonus'], 13)) : 0)
    : (hasStability ? profileNum(['calibrationWeights', 'saves', 'RP', 'stabilityBonus'], 2) : 0);
  const workloadBonus = role === 'CP'
    ? positiveAmount(asNum(projectedStats && projectedStats.wins) - profileNum(['calibrationWeights', 'saves', 'CP', 'winsThreshold'], 2)) * profileNum(['calibrationWeights', 'saves', 'CP', 'winsBonus'], 4) +
      positiveAmount(calibratedK - profileNum(['calibrationWeights', 'saves', 'CP', 'kThreshold'], 30)) * profileNum(['calibrationWeights', 'saves', 'CP', 'kBonus'], 0.35)
    : positiveAmount(asNum(projectedStats && projectedStats.wins) - profileNum(['calibrationWeights', 'saves', 'RP', 'winsThreshold'], 6)) * profileNum(['calibrationWeights', 'saves', 'RP', 'winsBonus'], 0.15) +
      positiveAmount(calibratedK - profileNum(['calibrationWeights', 'saves', 'RP', 'kThreshold'], 70)) * profileNum(['calibrationWeights', 'saves', 'RP', 'kBonus'], 0.005);
  const controlBonus = role === 'CP'
    ? positiveAmount(asNum(control) - profileNum(['calibrationWeights', 'saves', 'CP', 'controlThreshold'], 210)) * profileNum(['calibrationWeights', 'saves', 'CP', 'controlBonus'], 0.15)
    : positiveAmount(asNum(control) - profileNum(['calibrationWeights', 'saves', 'RP', 'controlThreshold'], 225)) * profileNum(['calibrationWeights', 'saves', 'RP', 'controlBonus'], 0.04);
  const calibratedSaves = Math.max(0, rawSaves + workloadBonus + controlBonus + stabilityBonus - riskPenalty);
  return {
    rawSaves,
    calibratedSaves: Number(calibratedSaves.toFixed(3)),
    workloadBonus: Number(workloadBonus.toFixed(3)),
    controlBonus: Number(controlBonus.toFixed(3)),
    stabilityBonus,
    riskPenalty
  };
}

function pitcherSaveCoreScore({ role, projectedStats, strikeoutCalibration, control, stamina, velocity, skills }) {
  if (role === 'SP') return 0;
  const calibratedK = strikeoutCalibration ? asNum(strikeoutCalibration.calibratedStrikeouts) : asNum(projectedStats && projectedStats.strikeouts);
  const saveOpportunity = pitcherSaveOpportunity({ role, projectedStats, strikeoutCalibration, control, skills });
  const closerBonus = role === 'CP' ? profileNum(['itemWeights', 'sv', role, 'closerBonus'], 2000) : 0;
  const kWeight = profileNum(['itemWeights', 'sv', role, 'calibratedK'], role === 'CP' ? 2.5 : 0.4);
  const skillWeight = profileNum(['itemWeights', 'sv', role, 'skillDensity'], role === 'CP' ? 35 : 20);
  const eraPenalty = profileNum(['itemWeights', 'sv', role, 'eraPenalty'], role === 'CP' ? 20 : 90);
  return saveOpportunity.calibratedSaves * profileNum(['itemWeights', 'sv', role, 'calibratedSaves'], 1000) +
    calibratedK * kWeight +
    asNum(control) * profileNum(['itemWeights', 'sv', role, 'control'], 0.8) +
    asNum(stamina) * profileNum(['itemWeights', 'sv', role, 'stamina'], 0.5) +
    asNum(velocity) * profileNum(['itemWeights', 'sv', role, 'velocity'], 4) +
    skillDensity(skills) * skillWeight +
    markedPitchSkillCount(skills) * profileNum(['itemWeights', 'sv', role, 'pitchMarks'], role === 'CP' ? 70 : 35) +
    closerBonus -
    asNum(projectedStats && projectedStats.era) * eraPenalty -
    asNum(projectedStats && projectedStats.losses) * profileNum(['itemWeights', 'sv', role, 'lossesPenalty'], 10) -
    pitcherRiskPenalty(skills) * profileNum(['itemWeights', 'sv', role, 'riskPenalty'], 50);
}

function effectivePitcherSkills(skills, role) {
  const unique = dedupe(skills || []);
  if (role === 'SP') return unique;
  return unique.filter(skill => !STARTER_ONLY_PITCHER_SKILLS.has(skill));
}

function positiveAmount(value) {
  return Math.max(0, asNum(value));
}

function hasSkill(skills, skillName) {
  return (skills || []).includes(skillName);
}

function buildStrikeoutCalibration({ role, projectedStats, strikeoutSkillScore, velocity, control, stamina, skills }) {
  const projectedStrikeouts = asNum(projectedStats && projectedStats.strikeouts);
  const skillScore = asNum(strikeoutSkillScore);
  let skillBonus = 0;
  let roleSkillBonus = 0;
  let roleAbilityBonus = 0;
  let roleRiskPenalty = 0;

  if (role === 'SP') {
    skillBonus = skillScore * profileNum(['calibrationWeights', 'strikeouts', 'SP', 'skillMultiplier'], 0.72);
    roleSkillBonus =
      (hasSkill(skills, '中繼能力○') ? 6 : 0) +
      (hasSkill(skills, '安定感') ? 4 : 0) +
      (hasSkill(skills, '中繼能力○') && hasSkill(skills, '安定感') && asNum(velocity) >= 145 ? 12 : 0);
    roleAbilityBonus =
      positiveAmount(velocity - profileNum(['calibrationWeights', 'strikeouts', 'SP', 'velocityThreshold'], 145)) * profileNum(['calibrationWeights', 'strikeouts', 'SP', 'velocityBonus'], 0.3) +
      positiveAmount(stamina - profileNum(['calibrationWeights', 'strikeouts', 'SP', 'staminaThreshold'], 190)) * profileNum(['calibrationWeights', 'strikeouts', 'SP', 'staminaBonus'], 0.04) +
      positiveAmount(control - profileNum(['calibrationWeights', 'strikeouts', 'SP', 'controlThreshold'], 195)) * profileNum(['calibrationWeights', 'strikeouts', 'SP', 'controlBonus'], 0.03);
    roleRiskPenalty =
      positiveAmount(profileNum(['calibrationWeights', 'strikeouts', 'SP', 'velocityRiskThreshold'], 145) - velocity) * profileNum(['calibrationWeights', 'strikeouts', 'SP', 'velocityRiskPenalty'], 0.8) +
      positiveAmount(profileNum(['calibrationWeights', 'strikeouts', 'SP', 'staminaRiskThreshold'], 185) - stamina) * profileNum(['calibrationWeights', 'strikeouts', 'SP', 'staminaRiskPenalty'], 0.12);
  } else if (role === 'RP') {
    skillBonus = skillScore * profileNum(['calibrationWeights', 'strikeouts', 'RP', 'skillMultiplier'], 2.4);
    roleAbilityBonus =
      positiveAmount(velocity - profileNum(['calibrationWeights', 'strikeouts', 'RP', 'velocityThreshold'], 150)) * profileNum(['calibrationWeights', 'strikeouts', 'RP', 'velocityBonus'], 0.35) +
      positiveAmount(stamina - profileNum(['calibrationWeights', 'strikeouts', 'RP', 'staminaThreshold'], 210)) * profileNum(['calibrationWeights', 'strikeouts', 'RP', 'staminaBonus'], 0.16) +
      positiveAmount(control - profileNum(['calibrationWeights', 'strikeouts', 'RP', 'controlThreshold'], 225)) * profileNum(['calibrationWeights', 'strikeouts', 'RP', 'controlBonus'], 0.06);
    roleRiskPenalty =
      positiveAmount(profileNum(['calibrationWeights', 'strikeouts', 'RP', 'velocityRiskThreshold'], 150) - velocity) * profileNum(['calibrationWeights', 'strikeouts', 'RP', 'velocityRiskPenalty'], 0.8) +
      positiveAmount(profileNum(['calibrationWeights', 'strikeouts', 'RP', 'staminaRiskThreshold'], 205) - stamina) * profileNum(['calibrationWeights', 'strikeouts', 'RP', 'staminaRiskPenalty'], 0.35);
    if ((skills || []).length <= 2 && skillScore <= 6) roleRiskPenalty += 12;
    if (hasSkill(skills, '人氣者') && skillScore <= 6) roleRiskPenalty += 6;
  } else {
    skillBonus = skillScore * profileNum(['calibrationWeights', 'strikeouts', 'CP', 'skillMultiplier'], 0.25);
    roleAbilityBonus =
      positiveAmount(velocity - profileNum(['calibrationWeights', 'strikeouts', 'CP', 'velocityThreshold'], 150)) * profileNum(['calibrationWeights', 'strikeouts', 'CP', 'velocityBonus'], 0.35) +
      positiveAmount(stamina - profileNum(['calibrationWeights', 'strikeouts', 'CP', 'staminaThreshold'], 210)) * profileNum(['calibrationWeights', 'strikeouts', 'CP', 'staminaBonus'], 0.08) +
      positiveAmount(control - profileNum(['calibrationWeights', 'strikeouts', 'CP', 'controlThreshold'], 225)) * profileNum(['calibrationWeights', 'strikeouts', 'CP', 'controlBonus'], 0.05);
    roleRiskPenalty =
      positiveAmount(profileNum(['calibrationWeights', 'strikeouts', 'CP', 'velocityRiskThreshold'], 150) - velocity) * profileNum(['calibrationWeights', 'strikeouts', 'CP', 'velocityRiskPenalty'], 0.4) +
      positiveAmount(profileNum(['calibrationWeights', 'strikeouts', 'CP', 'staminaRiskThreshold'], 195) - stamina) * profileNum(['calibrationWeights', 'strikeouts', 'CP', 'staminaRiskPenalty'], 0.12);
  }

  const calibratedStrikeouts = Math.max(
    0,
    projectedStrikeouts + skillBonus + roleSkillBonus + roleAbilityBonus - roleRiskPenalty
  );

  return {
    projectedStrikeouts,
    calibratedStrikeouts: Number(calibratedStrikeouts.toFixed(3)),
    skillBonus: Number(skillBonus.toFixed(3)),
    roleSkillBonus: Number(roleSkillBonus.toFixed(3)),
    roleAbilityBonus: Number(roleAbilityBonus.toFixed(3)),
    roleRiskPenalty: Number(roleRiskPenalty.toFixed(3))
  };
}

function normalizeCellText(value) {
  return value
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseDualStatCell(cellHtml) {
  const current = normalizeCellText((cellHtml.match(/^(.*?)<br/i) || [])[1] || cellHtml);
  const career = normalizeCellText((cellHtml.match(/<span class=tx>(.*?)<\/span>/i) || [])[1] || '');
  return { current, career };
}

function dedupe(list) {
  return [...new Set((list || []).filter(Boolean))];
}

function parseKakuninnTeamOrder(html, sakuTeamMap = {}) {
  const header = html.match(/<tr align=center bgcolor='#FFFFFF'><td>#<\/td>([\s\S]*?)<tr align=center><td bgcolor="#FFFFFF">1<\/td>/i);
  if (!header) return TEAM_ORDER;
  const sakuOrder = [...header[1].matchAll(/mode=teisatu&saku=(\d+)/gi)].map(match => Number(match[1]));
  if (sakuOrder.length < TEAM_ORDER.length) return TEAM_ORDER;
  return sakuOrder.slice(0, TEAM_ORDER.length).map((saku, index) => sakuTeamMap[saku] || TEAM_ORDER[index]);
}

function parseKakuninn(html, teamOrder = TEAM_ORDER) {
  const entries = [];
  const rowStarts = [...html.matchAll(/<tr\s+align=center><td\s+bgcolor="#FFFFFF">(?:<B>)?(\d+)(?:<\/B>)?<\/td>/gi)];
  for (let idx = 0; idx < rowStarts.length; idx++) {
    const match = rowStarts[idx];
    const row = Number(match[1]);
    const start = match.index || 0;
    const end = idx + 1 < rowStarts.length ? (rowStarts[idx + 1].index || html.length) : html.length;
    const chunk = html.slice(start, end);
    const cells = [...chunk.matchAll(/<td[^>]*class=['"]k1473['"][^>]*>([\s\S]*?)<\/td>/gi)].map(item => item[1]);
    cells.forEach((cell, index) => {
      const checkboxSlot = (
        cell.match(/<FONT STYLE='font-size:18px;'><B>([A-Z0-9]+)<\/B><\/FONT>/i) ||
        cell.match(/(?:^|>)([A-Z0-9]+)\.<B>/i) ||
        []
      )[1];
      const nameOwner = cell.match(/<BR><B>(.*?)<\/B><BR>\((.*?)\)/is);
      if (checkboxSlot && nameOwner && teamOrder[index]) {
        entries.push({
          row,
          team: teamOrder[index],
          slot: checkboxSlot,
          name: normalizeCellText(nameOwner[1]),
          owner: normalizeCellText(nameOwner[2]),
          source: 'fantasy_checkbox_grid'
        });
        return;
      }

      const roster = cell.match(/(?:^|>)([A-Z0-9]+)\.<B>(.*?)<\/B>/is);
      if (!roster || !teamOrder[index]) return;
      entries.push({
        row,
        team: teamOrder[index],
        slot: roster[1],
        name: normalizeCellText(roster[2]),
        owner: '',
        source: 'kakuninn_roster_grid'
      });
    });
  }
  return entries;
}

function isComputerFantasyEntry(entry) {
  if (!entry) return true;
  if (entry.name === '★★★★★' || entry.owner === '電腦') return true;
  if (entry.source === 'kakuninn_roster_grid') return false;
  return !entry.owner;
}

function loadSakuTeamMap(seasonDir) {
  const snapshotPath = path.join(seasonDir, 'season_snapshot.json');
  const snapshot = readJson(snapshotPath);
  const map = {};
  for (const team of snapshot.teams || []) map[team.saku] = team.team;
  return map;
}

function loadTeamLeagueMap(seasonDir) {
  const snapshotPath = path.join(seasonDir, 'season_snapshot.json');
  const snapshot = readJson(snapshotPath);
  const map = {};
  for (const team of snapshot.teams || []) {
    if (team.team) map[team.team] = team.league || null;
  }
  return map;
}

function buildStealEnvironments(players, teamLeagueMap) {
  const pitchers = players.filter(player => player.category === 'pitcher');
  const globalPitcherCount = Math.max(pitchers.length, 1);
  const globalQuickXCount = pitchers.filter(player => (player.skills || []).includes('牽制Ｘ')).length;
  const globalQuickXRate = globalQuickXCount / globalPitcherCount;
  const teams = [...new Set(players.map(player => player.team).filter(Boolean))].sort();
  const environments = {};

  for (const team of teams) {
    const league = teamLeagueMap[team] || null;
    const opponents = pitchers.filter(player => {
      if (!league) return player.team !== team;
      return player.team !== team && teamLeagueMap[player.team] === league;
    });
    const pitcherCount = opponents.length;
    const quickXCount = opponents.filter(player => (player.skills || []).includes('牽制Ｘ')).length;
    const quickORate = pitcherCount
      ? opponents.filter(player => (player.skills || []).includes('牽制○')).length / pitcherCount
      : 0;
    const quickXRate = pitcherCount ? quickXCount / pitcherCount : globalQuickXRate;
    const factor = Math.min(1.2, Math.max(0.9, 1 + ((quickXRate - globalQuickXRate) * 1.2)));
    environments[team] = {
      team,
      league,
      opponentPitchers: pitcherCount,
      opponentQuickX: quickXCount,
      opponentQuickXRate: Number(quickXRate.toFixed(4)),
      opponentQuickORate: Number(quickORate.toFixed(4)),
      globalQuickXRate: Number(globalQuickXRate.toFixed(4)),
      stealFactor: Number(factor.toFixed(4))
    };
  }

  return {
    rule: 'Only same-league opposing pitchers are used; more 牽制Ｘ raises projected steals.',
    globalQuickXRate: Number(globalQuickXRate.toFixed(4)),
    byTeam: environments
  };
}

function parseStealStrategy(html) {
  const lines = html.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes('盜壘戰術') || !lines[i].includes('name=b_ste')) continue;
    for (let j = i; j < Math.min(lines.length, i + 20); j++) {
      const match = lines[j].match(/option value=(\d+) selected/i);
      if (match) return Number(match[1]);
    }
    return 1;
  }
  return 1;
}

function stealStrategyFactor(tactic) {
  const value = asNum(tactic, 1);
  if (value <= 1) return 0;
  return Number(Math.max(0, value / 5).toFixed(4));
}

function parseSkillImages(html) {
  return dedupe([...html.matchAll(/img\/([a-z0-9_]+)\.gif/gi)].map(m => IMG_SKILL_MAP[m[1]]).filter(Boolean));
}

function parseLiveBatterRowChunk(chunk, team) {
  const roleMatch = chunk.match(/name=jun\d+[^>]*value=\d+[^>]*>([^<]+)/i);
  if (!roleMatch) return null;
  const roleMap = { '捕手': 'C', '一壘': '1B', '二壘': '2B', '三壘': '3B', '游擊': 'SS', '左外': 'LF', '中外': 'CF', '右外': 'RF', '指定': 'DH', 'DH': 'DH' };
  const role = roleMap[normalizeCellText(roleMatch[1])];
  if (!role) return null;

  const cells = [...chunk.matchAll(/<td[^>]*>(.*?)<\/td>/gis)].map(m => m[1]);
  if (cells.length < 18) return null;

  const nameCell = cells[1] || '';
  const ownerCell = cells[2] || '';
  const anchorText = [...nameCell.matchAll(/<a [^>]*>(.*?)<\/a>/gis)].map(m => normalizeCellText(m[1])).filter(Boolean);
  let name = anchorText.length ? anchorText[anchorText.length - 1] : normalizeCellText(nameCell);
  let owner = normalizeCellText(ownerCell).replace(/^[LRS]\s*/i, '').trim();
  owner = owner.replace(/^一般\s*/,'').trim();
  if (!name || name === '★★★★★' || owner === '電腦') return null;

  const nums = [...chunk.matchAll(/<small><B>(\d+)<\/B><\/small>/gi)].map(m => Number(m[1]));
  const skills = parseSkillImages(chunk);
  const statCells = cells.slice(-10);
  const avgCell = parseDualStatCell(statCells[0] || '');
  const hrCell = parseDualStatCell(statCells[3] || '');
  const sbCell = parseDualStatCell(statCells[6] || '');
  const ageText = normalizeCellText(cells[cells.length - 2] || '');
  const age = asNum((ageText.match(/(\d+)\s*歲/) || [])[1], 0);

  return {
    team,
    slot: role,
    role,
    name,
    owner,
    power: nums[0] || 0,
    contact: nums[1] || 0,
    speed: nums[2] || 0,
    arm: nums[3] || 0,
    defense: nums[4] || 0,
    liveSkills: skills,
    careerAvg: avgCell.career || avgCell.current,
    careerHr: asNum(hrCell.career || hrCell.current, 0),
    careerSb: asNum(sbCell.career || sbCell.current, 0),
    age
  };
}

function parsePitcherRowChunk(chunk, team) {
  const roleRaw = (chunk.match(/name=posit\d+ value=([^>\s]+)/i) || [])[1];
  if (!['先發', '中繼', '救援'].includes(roleRaw)) return null;

  const cells = [...chunk.matchAll(/<td[^>]*>(.*?)<\/td>/gis)].map(m => m[1]);
  if (cells.length < 11) return null;

  const nameCell = cells[1] || '';
  let name = normalizeCellText(nameCell);
  let owner = '';
  const ownerMatch = name.match(/(.+?)\(([^()]*)\)\s*$/);
  if (ownerMatch) {
    name = ownerMatch[1].trim();
    owner = ownerMatch[2].trim();
  }
  if (!name || name === '★★★★★' || owner === '電腦') return null;

  const nums = [...chunk.matchAll(/<small><B>(\d+)<\/B><\/small>/gi)].map(m => Number(m[1]));
  const velocity = Number((chunk.match(/font-weight:BOLD;'>(\d+)<\/font>/i) || [])[1] || 0);
  const skillImages = [...chunk.matchAll(/img\/([a-z0-9_]+)\.gif/gi)].map(m => IMG_SKILL_MAP[m[1]]).filter(Boolean);
  const eraCell = parseDualStatCell(cells[7] || '');
  const savesCell = parseDualStatCell(cells[10] || '');
  const ageText = normalizeCellText(cells[cells.length - 2] || '');
  const age = asNum((ageText.match(/(\d+)\s*歲/) || chunk.match(/<B>(\d+)<\/B><\/font>\s*歲/i) || [])[1], 0);

  return {
    team,
    role: roleRaw === '先發' ? 'SP' : roleRaw === '中繼' ? 'RP' : 'CP',
    name,
    owner,
    control: nums[0] || 0,
    stamina: nums[1] || 0,
    velocity,
    liveSkills: dedupe(skillImages),
    careerEra: asNum(eraCell.career || eraCell.current, 0),
    careerSaves: asNum(savesCell.career || savesCell.current, 0),
    age
  };
}

function parseLiveRosters(liveDir, sakuTeamMap) {
  const pitchers = [];
  const batters = [];
  const strategies = {};
  const files = fs.readdirSync(liveDir)
    .filter(name => /^saku_\d+\.html$/.test(name))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));

  for (const file of files) {
    const saku = Number(file.match(/\d+/)[0]);
    const team = sakuTeamMap[saku];
    const html = readUtf8(path.join(liveDir, file));
    if (team) strategies[team] = parseStealStrategy(html);
    if (!team) continue;
    const chunks = html.split('<tr align=center BgColor=');
    for (const chunk of chunks) {
      if (chunk.includes('name=jun')) {
        const row = parseLiveBatterRowChunk(chunk, team);
        if (row) batters.push(row);
      }
      if (chunk.includes('name=posit')) {
        const row = parsePitcherRowChunk(chunk, team);
        if (row) pitchers.push(row);
      }
    }
  }
  return { batters, pitchers, strategies };
}

function buildCurrentPlayerIndex(players) {
  const byTeam = new Map();
  for (const player of players) {
    if (player.is_computer) continue;
    if (!byTeam.has(player.team)) byTeam.set(player.team, []);
    byTeam.get(player.team).push(player);
  }
  return byTeam;
}

function mergeLiveBatterWithCurrent(live, currentPlayer) {
  const currentSkills = dedupe((currentPlayer && currentPlayer.skills) || []);
  const liveSkills = dedupe(live.liveSkills || []);
  const currentAbilities = (currentPlayer && currentPlayer.abilities) || {};
  const abilityValue = (liveValue, currentValue) => liveValue !== undefined ? liveValue : asNum(currentValue);
  return {
    team: live.team,
    category: 'batter',
    name: live.name || (currentPlayer && currentPlayer.name) || '',
    owner: live.owner || (currentPlayer && currentPlayer.owner) || '',
    is_computer: !!(currentPlayer && currentPlayer.is_computer) || isComputerFantasyEntry(live),
    age: live.age !== undefined ? live.age : asNum(currentPlayer && currentPlayer.age),
    abilities: {
      power: { value: abilityValue(live.power, currentAbilities.power && currentAbilities.power.value) },
      contact: { value: abilityValue(live.contact, currentAbilities.contact && currentAbilities.contact.value) },
      speed: { value: abilityValue(live.speed, currentAbilities.speed && currentAbilities.speed.value) },
      arm: { value: abilityValue(live.arm, currentAbilities.arm && currentAbilities.arm.value) },
      defense: { value: abilityValue(live.defense, currentAbilities.defense && currentAbilities.defense.value) }
    },
    skills: dedupe([...liveSkills, ...currentSkills]),
    career_batting: {
      batting_avg: live.careerAvg || (currentPlayer && currentPlayer.career_batting && currentPlayer.career_batting.batting_avg) || '.000',
      home_runs: live.careerHr || asNum(currentPlayer && currentPlayer.career_batting && currentPlayer.career_batting.home_runs),
      rbi: asNum(currentPlayer && currentPlayer.career_batting && currentPlayer.career_batting.rbi),
      steals: live.careerSb || asNum(currentPlayer && currentPlayer.career_batting && currentPlayer.career_batting.steals)
    }
  };
}

function mergeLivePitcherWithCurrent(live, currentPlayer) {
  const currentSkills = dedupe((currentPlayer && currentPlayer.skills) || []);
  const liveSkills = dedupe(live.liveSkills || []);
  const currentAbilities = (currentPlayer && currentPlayer.abilities) || {};
  const abilityValue = (liveValue, currentValue) => liveValue !== undefined ? liveValue : asNum(currentValue);
  return {
    team: live.team,
    category: 'pitcher',
    name: live.name || (currentPlayer && currentPlayer.name) || '',
    owner: live.owner || (currentPlayer && currentPlayer.owner) || '',
    is_computer: !!(currentPlayer && currentPlayer.is_computer) || isComputerFantasyEntry(live),
    age: live.age !== undefined ? live.age : asNum(currentPlayer && currentPlayer.age),
    season_summary_role: live.role,
    position_or_role: live.role,
    abilities: {
      control: { value: abilityValue(live.control, currentAbilities.control && currentAbilities.control.value) },
      stamina: { value: abilityValue(live.stamina, currentAbilities.stamina && currentAbilities.stamina.value) },
      velocity: abilityValue(live.velocity, currentAbilities.velocity)
    },
    skills: dedupe([...liveSkills, ...currentSkills]),
    current_pitching: {
      era: live.careerEra || asNum(currentPlayer && currentPlayer.current_pitching && currentPlayer.current_pitching.era),
      saves: live.careerSaves || asNum(currentPlayer && currentPlayer.current_pitching && currentPlayer.current_pitching.saves)
    }
  };
}

function findBatterMatch(teamPlayers, live) {
  const exact = teamPlayers.filter(p => p.category === 'batter' && p.name === live.name && p.owner === live.owner);
  if (exact.length === 1) return { player: exact[0], method: 'exact' };

  if (live.owner) {
    const ownerOnly = teamPlayers.filter(p => p.category === 'batter' && p.owner === live.owner);
    if (ownerOnly.length === 1) return { player: ownerOnly[0], method: 'owner_only' };
  }

  const nameOnly = teamPlayers.filter(p => p.category === 'batter' && p.name === live.name);
  if (nameOnly.length === 1) return { player: nameOnly[0], method: 'name_only' };

  if (ALLOW_FANTASY_RETIREMENT_REPLACEMENTS) {
    const replacement = teamPlayers.filter(p =>
      p.category === 'batter' &&
      p.replacement_rookie &&
      p.replacement_of &&
      p.replacement_of.name === live.name &&
      p.replacement_of.owner === live.owner
    );
    if (replacement.length === 1) return { player: replacement[0], method: 'retirement_replacement' };
  }

  return { player: null, method: 'unmatched' };
}

function findPitcherMatch(teamPlayers, live) {
  const exact = teamPlayers.filter(p => p.category === 'pitcher' && p.name === live.name && p.owner === live.owner);
  if (exact.length === 1) return { player: exact[0], method: 'exact' };

  const ownerOnly = teamPlayers.filter(p => p.category === 'pitcher' && p.owner === live.owner);
  if (ownerOnly.length === 1) return { player: ownerOnly[0], method: 'owner_only' };

  const nameOnly = teamPlayers.filter(p => p.category === 'pitcher' && p.name === live.name);
  if (nameOnly.length === 1) return { player: nameOnly[0], method: 'name_only' };

  if (ALLOW_FANTASY_RETIREMENT_REPLACEMENTS) {
    const replacement = teamPlayers.filter(p =>
      p.category === 'pitcher' &&
      p.replacement_rookie &&
      p.replacement_of &&
      p.replacement_of.name === live.name &&
      p.replacement_of.owner === live.owner
    );
    if (replacement.length === 1) return { player: replacement[0], method: 'retirement_replacement' };
  }

  return { player: null, method: 'live_only' };
}

function loadHistoryContext(currentSeasonDir) {
  const currentSeason = Number(path.basename(currentSeasonDir).split('-')[1]);
  const history = {};
  const dirs = fs.readdirSync(ORE_DB_BASE, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^season-\d+$/.test(entry.name))
    .map(entry => path.join(ORE_DB_BASE, entry.name))
    .sort((a, b) => Number(path.basename(a).split('-')[1]) - Number(path.basename(b).split('-')[1]));

  for (const dir of dirs) {
    const season = Number(path.basename(dir).split('-')[1]);
    if (season >= currentSeason) continue;
    const snapshotPath = path.join(dir, 'season_snapshot.json');
    if (!fs.existsSync(snapshotPath)) continue;
    const snapshot = readJson(snapshotPath);
    const champsPath = path.join(dir, 'championship.json');
    const champ = fs.existsSync(champsPath) ? readJson(champsPath) : null;
    for (const team of snapshot.teams || []) {
      if (!history[team.team]) history[team.team] = { ranks: [], titles: 0 };
      const rankText = team.current_status && team.current_status.league_rank;
      const rankMatch = typeof rankText === 'string' ? rankText.match(/(\d+)/) : null;
      if (rankMatch) history[team.team].ranks.push(Number(rankMatch[1]));
      if (champ && champ.champion_team === team.team) history[team.team].titles += 1;
    }
  }
  return history;
}

function teamHistoryBonus(team, history) {
  const ctx = history[team];
  if (!ctx) return 0;
  const avgRank = ctx.ranks.length ? ctx.ranks.reduce((sum, value) => sum + value, 0) / ctx.ranks.length : 6;
  return (7 - avgRank) * 3 + ctx.titles * 6;
}

function buildHrReferenceModel(players) {
  const samples = [];
  for (const player of players) {
    if (player.is_computer || player.category !== 'batter') continue;
    const abilities = player.abilities || {};
    const career = player.career_batting || {};
    const power = asNum(abilities.power && abilities.power.value);
    const contact = asNum(abilities.contact && abilities.contact.value);
    const speed = asNum(abilities.speed && abilities.speed.value);
    const hr = asNum(career.home_runs);
    const avg = asNum(String(career.batting_avg || '').replace(/^\./, '0.'));
    const skills = dedupe(player.skills || []);
    samples.push({
      power,
      contact,
      speed,
      hr,
      avg,
      hasHomerSkill: skills.includes('豪力') || skills.includes('豪力打者'),
      hasPowerSkill: skills.includes('強力打者'),
      hasStabilitySkill: skills.includes('安定感'),
      hasClutchSkill: skills.includes('得點圈◎') || skills.includes('得點圈○')
    });
  }

  function averageHr(filterFn) {
    const subset = samples.filter(filterFn);
    if (!subset.length) return 0;
    return subset.reduce((sum, sample) => sum + sample.hr, 0) / subset.length;
  }

  return {
    baselineHr: averageHr(() => true),
    homerSkillHr: averageHr(sample => sample.hasHomerSkill),
    powerSkillHr: averageHr(sample => sample.hasPowerSkill),
    elitePowerHr: averageHr(sample => sample.power >= 235),
    elitePowerHomerSkillHr: averageHr(sample => sample.power >= 235 && sample.hasHomerSkill),
    balancedSluggerHr: averageHr(sample => sample.power >= 230 && sample.contact >= 6 && (sample.hasHomerSkill || sample.hasPowerSkill)),
    balancedSluggerAvg: averageHr(sample => sample.power >= 230 && sample.contact >= 6 && sample.avg >= 0.25)
  };
}

function hrReferenceBonus(player, referenceModel) {
  const abilities = player.abilities || {};
  const skills = dedupe(player.skills || []);
  const power = asNum(abilities.power && abilities.power.value);
  const contact = asNum(abilities.contact && abilities.contact.value);
  const hasHomerSkill = skills.includes('豪力') || skills.includes('豪力打者');
  const hasPowerSkill = skills.includes('強力打者');
  const hasStabilitySkill = skills.includes('安定感');
  const hasClutchSkill = skills.includes('得點圈◎') || skills.includes('得點圈○');

  let bonus = 0;
  const baseline = referenceModel.baselineHr || 0;
  if (hasHomerSkill) bonus += Math.max(0, ((referenceModel.homerSkillHr || baseline) - baseline) * 0.18);
  if (hasPowerSkill) bonus += Math.max(0, ((referenceModel.powerSkillHr || baseline) - baseline) * 0.12);
  if (power >= 235) bonus += Math.max(0, ((referenceModel.elitePowerHr || baseline) - baseline) * 0.12);
  if (power >= 235 && hasHomerSkill) bonus += Math.max(0, ((referenceModel.elitePowerHomerSkillHr || baseline) - baseline) * 0.18);
  if (power >= 230 && contact >= 6 && (hasHomerSkill || hasPowerSkill)) bonus += Math.max(0, ((referenceModel.balancedSluggerHr || baseline) - baseline) * 0.16);
  if (contact >= 7 && hasHomerSkill) bonus += 8;
  if (hasStabilitySkill) bonus += 4;
  if (hasClutchSkill) bonus += 3;
  return Number(bonus.toFixed(2));
}

function buildBatterCandidate(live, player, mode, strategies, projectionResult, stealEnvironments = null) {
  const abilities = player.abilities || {};
  const career = player.career_batting || {};
  const name = player.name || live.name;
  const owner = player.owner || live.owner;
  const power = asNum(abilities.power && abilities.power.value);
  const contact = asNum(abilities.contact && abilities.contact.value);
  const speed = asNum(abilities.speed && abilities.speed.value);
  const defense = asNum(abilities.defense && abilities.defense.value);
  const skills = dedupe(player.skills || []);
  const tactic = strategies[player.team] || 1;
  const projectedStats = { ...projectionResult.projectedStats };
  const hrBasis = projectionResult.meta && projectionResult.meta.hrProjection
    ? projectionResult.meta.hrProjection
    : null;
  const fallbackHrSkillBasis = projection.batterHrSkillBasis(skills);
  const hrSkillScore = hrBasis && hrBasis.skillBasis
    ? asNum(hrBasis.skillBasis.score)
    : asNum(fallbackHrSkillBasis.score);
  const stealSkillScore = scoreSkills(skills, profileSkillWeights(['skillWeights', 'batter', 'sb'], BATTER_SKILL_WEIGHTS.sb));
  const sbBasis = projectionResult.meta && projectionResult.meta.sbProjection
    ? projectionResult.meta.sbProjection
    : null;
  const stealEnvironment = stealEnvironments && stealEnvironments.byTeam
    ? stealEnvironments.byTeam[player.team]
    : null;
  let stealBasis = null;
  if (isStealsMode(mode)) {
    const rawProjectedSteals = asNum(projectedStats.steals);
    const leagueStealFactor = stealEnvironment ? asNum(stealEnvironment.stealFactor, 1) : 1;
    const strategyFactor = stealStrategyFactor(tactic);
    const leagueAdjustedSteals = rawProjectedSteals * leagueStealFactor;
    const strategyAdjustedSteals = leagueAdjustedSteals * strategyFactor;
    const finalProjectedSteals = Math.round(Math.min(120, Math.max(0, strategyAdjustedSteals)));
    projectedStats.steals = finalProjectedSteals;
    stealBasis = {
      rawProjectedSteals,
      leagueAdjustedSteals: Number(leagueAdjustedSteals.toFixed(3)),
      strategyAdjustedSteals: Number(strategyAdjustedSteals.toFixed(3)),
      finalProjectedSteals,
      teamStrategy: tactic,
      strategyFactor,
      projectionSbBasis: sbBasis,
      stealSkillScore,
      leagueEnvironment: stealEnvironment,
      ageUsed: false
    };
  }

  let score = 0;
  let scoreComponents;
  if (isLegalFillerBatterMode(mode)) {
    score = 0;
    scoreComponents = {
      primary: 'legal_filler_only_not_optimized',
      objectiveRole: 'fill_required_batter_slots_and_team_coverage_only',
      ignoredProjectedStats: ['batting_avg', 'home_runs', 'rbi', 'steals'],
      ignoredAbilities: ['power', 'contact', 'speed', 'defense', 'arm'],
      ageUsed: false
    };
  } else if (isAverageBatterMode(mode)) {
    const coreRunScore = batterCoreRunScore({ projectedStats, hrSkillScore, power, contact, skills });
    score = projectedStats.batting_avg * profileNum(['itemWeights', 'avg', 'battingAvg'], 100000) +
      asNum(projectedStats.home_runs) * profileNum(['itemWeights', 'avg', 'homeRuns'], 85) +
      asNum(projectedStats.rbi) * profileNum(['itemWeights', 'avg', 'rbi'], 25) +
      hrSkillScore * profileNum(['itemWeights', 'avg', 'hrSkillScore'], 8) +
      power * profileNum(['itemWeights', 'avg', 'power'], 1.2) +
      contact * profileNum(['itemWeights', 'avg', 'contact'], 45) +
      skillDensity(skills) * profileNum(['itemWeights', 'avg', 'skillDensity'], 25);
    scoreComponents = {
      primary: 'projected_batting_average_with_high_probability_core_hitter_calibration',
      projectedBattingAverage: projectedStats.batting_avg,
      coreRunScore: Number(coreRunScore.toFixed(3)),
      tieBreakers: {
        projectedHomeRuns: projectedStats.home_runs,
        projectedRbi: projectedStats.rbi,
        hrSkillScore,
        power,
        contact,
        skillDensity: skillDensity(skills)
      },
      ignoredProjectedStats: ['home_runs', 'rbi', 'steals'],
      ageUsed: false
    };
  } else if (isRbiBatterMode(mode)) {
    const calibratedRbiCore = asNum(projectedStats.rbi) * profileNum(['itemWeights', 'rbi', 'rbi'], 0.65) +
      asNum(projectedStats.home_runs) * profileNum(['itemWeights', 'rbi', 'homeRuns'], 0.75) +
      hrSkillScore * profileNum(['itemWeights', 'rbi', 'hrSkillScore'], 0.45) +
      power * profileNum(['itemWeights', 'rbi', 'power'], 0.18) +
      contact * profileNum(['itemWeights', 'rbi', 'contact'], 6) +
      skillDensity(skills) * profileNum(['itemWeights', 'rbi', 'skillDensity'], 2);
    score = calibratedRbiCore * profileNum(['itemWeights', 'rbi', 'scale'], 1000);
    scoreComponents = {
      primary: 'projected_rbi_with_power_contact_core_calibration',
      projectedRbi: projectedStats.rbi,
      calibratedRbiCore: Number(calibratedRbiCore.toFixed(3)),
      tieBreakers: {
        projectedHomeRuns: projectedStats.home_runs,
        hrSkillScore,
        power,
        contact,
        skillDensity: skillDensity(skills)
      },
      ignoredProjectedStats: ['batting_avg', 'steals'],
      ageUsed: false
    };
  } else if (isStealsMode(mode)) {
    const runningAllowed = stealStrategyFactor(tactic) > 0;
    score = runningAllowed
      ? projectedStats.steals * profileNum(['itemWeights', 'sb', 'steals'], 1000) + stealSkillScore * profileNum(['itemWeights', 'sb', 'stealSkillScore'], 0.01) + speed * profileNum(['itemWeights', 'sb', 'speed'], 0.001)
      : profileNum(['itemWeights', 'sb', 'deniedBase'], -1000000) + stealSkillScore * profileNum(['itemWeights', 'sb', 'stealSkillScore'], 0.01) + speed * profileNum(['itemWeights', 'sb', 'speed'], 0.001);
    scoreComponents = {
      primary: 'projected_steals_only_with_skill_speed_calibrated_projection_strategy_multiplier_and_league_pickoff_environment',
      projectedSteals: projectedStats.steals,
      tieBreakers: {
        stealSkillScore,
        speed
      },
      ignoredProjectedStats: ['batting_avg', 'rbi', 'home_runs'],
      stealSkillScore,
      stealBasis,
      ageUsed: false
    };
  } else {
    score = projectedStats.home_runs * profileNum(['itemWeights', 'hr', 'homeRuns'], 1000) + hrSkillScore * profileNum(['itemWeights', 'hr', 'hrSkillScore'], 0.1) + power * profileNum(['itemWeights', 'hr', 'power'], 0.001);
    scoreComponents = {
      primary: 'projected_home_runs_only',
      projectedHomeRuns: projectedStats.home_runs,
      tieBreakers: {
        hrSkillScore,
        power
      },
      ignoredProjectedStats: ['batting_avg', 'rbi', 'steals'],
      ageUsed: false
    };
  }

  const diagnosticScore = diagnosticActualScore({ name, category: 'batter', mode });
  if (diagnosticScore) {
    score = diagnosticScore.score;
    scoreComponents = {
      ...scoreComponents,
      primary: 'diagnostic_actual_item_score',
      diagnosticActualItem: diagnosticScore.item,
      diagnosticActualValue: diagnosticScore.value,
      diagnosticActualScore: Number(diagnosticScore.score.toFixed(3)),
      diagnosticActualSource: diagnosticScore.source
    };
  }

  return {
    id: `b__${live.team}__${live.slot}__${owner}__${name}`,
    team: live.team,
    role: live.slot,
    name,
    owner,
    isComputer: !!player.is_computer || isComputerFantasyEntry(live),
    category: 'batter',
    matchMethod: live.matchMethod,
    abilities: {
      power, contact, speed,
      arm: asNum(abilities.arm && abilities.arm.value),
      defense
    },
    age: asNum(player.age),
    skills,
    career: {
      avg: career.batting_avg,
      home_runs: asNum(career.home_runs),
      rbi: asNum(career.rbi),
      steals: asNum(career.steals)
    },
    projectedStats,
    projectionMeta: projectionResult.meta,
    hrBasis,
    stealBasis,
    hrSkillScore,
    stealSkillScore,
    hrSkillTags: hrBasis && hrBasis.skillBasis ? hrBasis.skillBasis.positiveSkills : fallbackHrSkillBasis.positiveSkills,
    tactic,
    scoreComponents,
    score: Number(score.toFixed(2))
  };
}

function buildPitcherCandidate(live, currentPlayer, player, projectionResult, mode) {
  const role = live.role;
  const skills = dedupe(player.skills || []);
  const scoringSkills = effectivePitcherSkills(skills, role);
  const careerPitching = currentPlayer && currentPlayer.career_pitching ? currentPlayer.career_pitching : {};
  const careerEra = asNum(careerPitching.era, live.careerEra || 0);
  const careerSaves = asNum(careerPitching.saves, live.careerSaves || 0);
  const projectedStats = projectionResult.projectedStats;
  const control = asNum(player.abilities && player.abilities.control && player.abilities.control.value);
  const stamina = asNum(player.abilities && player.abilities.stamina && player.abilities.stamina.value);
  const velocity = asNum(player.abilities && player.abilities.velocity);
  const strikeoutSkillScore = scoreSkills(scoringSkills, profileSkillWeights(['skillWeights', 'pitcher', 'strikeout'], PITCHER_STRIKEOUT_SKILL_WEIGHTS));
  const strikeoutCalibration = buildStrikeoutCalibration({
    role,
    projectedStats,
    strikeoutSkillScore,
    velocity,
    control,
    stamina,
    skills: scoringSkills
  });
  const pitcherCoreQuality = pitcherCoreQualityScore({
    role,
    projectedStats,
    strikeoutCalibration,
    control,
    stamina,
    velocity,
    skills: scoringSkills
  });

  let score = 0;
  let scoreComponents;
  if (isStrikeoutPitcherMode(mode)) {
    score = strikeoutCalibration.calibratedStrikeouts * profileNum(['itemWeights', 'k', 'calibratedStrikeouts'], 1000) +
      strikeoutSkillScore * profileNum(['itemWeights', 'k', 'strikeoutSkillScore'], 0.1) +
      velocity * profileNum(['itemWeights', 'k', 'velocity'], 0.001);
    scoreComponents = {
      primary: 'projected_strikeouts_with_role_skill_calibration',
      projectedStrikeouts: projectedStats.strikeouts,
      calibratedStrikeouts: strikeoutCalibration.calibratedStrikeouts,
      calibration: {
        skillBonus: strikeoutCalibration.skillBonus,
        roleSkillBonus: strikeoutCalibration.roleSkillBonus,
        roleAbilityBonus: strikeoutCalibration.roleAbilityBonus,
        roleRiskPenalty: strikeoutCalibration.roleRiskPenalty
      },
      tieBreakers: {
        strikeoutSkillScore,
        velocity,
        control,
        stamina
      },
      ignoredProjectedStats: ['saves', 'era', 'wins', 'losses', 'walks', 'home_runs_allowed'],
      ageUsed: false
    };
  } else if (isEraPitcherMode(mode)) {
    const eraCoreScore = pitcherEraCoreScore({
      role,
      projectedStats,
      strikeoutCalibration,
      control,
      stamina,
      velocity,
      skills: scoringSkills
    });
    score = eraCoreScore;
    scoreComponents = {
      primary: 'projected_era_with_pitcher_core_quality_calibration',
      projectedEra: projectedStats.era,
      calibratedStrikeouts: strikeoutCalibration.calibratedStrikeouts,
      pitcherCoreQuality: Number(pitcherCoreQuality.toFixed(3)),
      eraCoreScore: Number(eraCoreScore.toFixed(3)),
      tieBreakers: {
        projectedWalks: projectedStats.walks,
        projectedHomeRunsAllowed: projectedStats.home_runs_allowed,
        control,
        stamina,
        velocity,
        skillDensity: skillDensity(scoringSkills),
        markedPitchSkillCount: markedPitchSkillCount(scoringSkills)
      },
      ignoredProjectedStats: ['saves', 'strikeouts', 'wins', 'losses'],
      ageUsed: false
    };
  } else if (isSavesPitcherMode(mode)) {
    const saveOpportunity = pitcherSaveOpportunity({ role, projectedStats, strikeoutCalibration, control, skills: scoringSkills });
    const saveCoreScore = pitcherSaveCoreScore({
      role,
      projectedStats,
      strikeoutCalibration,
      control,
      stamina,
      velocity,
      skills: scoringSkills
    });
    score = saveCoreScore;
    scoreComponents = {
      primary: role === 'SP'
        ? 'legal_starter_filler_for_saves_mode'
        : 'projected_saves_with_closer_quality_risk_calibration',
      projectedSaves: projectedStats.saves,
      calibratedSaves: saveOpportunity.calibratedSaves,
      saveOpportunity,
      calibratedStrikeouts: strikeoutCalibration.calibratedStrikeouts,
      pitcherCoreQuality: Number(pitcherCoreQuality.toFixed(3)),
      saveCoreScore: Number(saveCoreScore.toFixed(3)),
      tieBreakers: {
        projectedEra: projectedStats.era,
        projectedStrikeouts: projectedStats.strikeouts,
        control,
        stamina,
        velocity,
        skillDensity: skillDensity(scoringSkills)
      },
      ignoredProjectedStats: ['wins', 'losses', 'walks', 'home_runs_allowed'],
      ageUsed: false
    };
  } else if (isWinsPitcherMode(mode)) {
    const winCoreScore = pitcherWinCoreScore({
      role,
      projectedStats,
      strikeoutCalibration,
      control,
      stamina,
      velocity,
      skills: scoringSkills
    });
    score = winCoreScore;
    scoreComponents = {
      primary: 'projected_wins_with_pitcher_core_quality_calibration',
      projectedWins: projectedStats.wins,
      calibratedStrikeouts: strikeoutCalibration.calibratedStrikeouts,
      pitcherCoreQuality: Number(pitcherCoreQuality.toFixed(3)),
      winCoreScore: Number(winCoreScore.toFixed(3)),
      tieBreakers: {
        projectedEra: projectedStats.era,
        projectedStrikeouts: projectedStats.strikeouts,
        control,
        stamina,
        velocity,
        skillDensity: skillDensity(scoringSkills),
        markedPitchSkillCount: markedPitchSkillCount(scoringSkills)
      },
      ignoredProjectedStats: ['saves', 'losses', 'walks', 'home_runs_allowed'],
      ageUsed: false
    };
  } else if (role === 'SP') {
    score = projectedStats.strikeouts * profileNum(['itemWeights', 'composite', 'SP', 'strikeouts'], 3.1) + projectedStats.wins * profileNum(['itemWeights', 'composite', 'SP', 'wins'], 7) - projectedStats.losses * profileNum(['itemWeights', 'composite', 'SP', 'lossesPenalty'], 2.5) - projectedStats.era * profileNum(['itemWeights', 'composite', 'SP', 'eraPenalty'], 45) - projectedStats.walks * profileNum(['itemWeights', 'composite', 'SP', 'walksPenalty'], 0.8) - projectedStats.home_runs_allowed * profileNum(['itemWeights', 'composite', 'SP', 'homeRunsAllowedPenalty'], 1.5);
    scoreComponents = {
      primary: 'projected_pitching_composite',
      projectedSaves: projectedStats.saves,
      projectedEra: projectedStats.era,
      projectedStrikeouts: projectedStats.strikeouts,
      ageUsed: false
    };
  } else if (role === 'RP') {
    score = projectedStats.saves * profileNum(['itemWeights', 'composite', 'RP', 'saves'], 22) + projectedStats.strikeouts * profileNum(['itemWeights', 'composite', 'RP', 'strikeouts'], 2.6) + projectedStats.wins * profileNum(['itemWeights', 'composite', 'RP', 'wins'], 1.5) - projectedStats.losses * profileNum(['itemWeights', 'composite', 'RP', 'lossesPenalty'], 1.5) - projectedStats.era * profileNum(['itemWeights', 'composite', 'RP', 'eraPenalty'], 36) - projectedStats.walks * profileNum(['itemWeights', 'composite', 'RP', 'walksPenalty'], 0.7) - projectedStats.home_runs_allowed * profileNum(['itemWeights', 'composite', 'RP', 'homeRunsAllowedPenalty'], 1.2);
    scoreComponents = {
      primary: 'projected_pitching_composite',
      projectedSaves: projectedStats.saves,
      projectedEra: projectedStats.era,
      projectedStrikeouts: projectedStats.strikeouts,
      ageUsed: false
    };
  } else {
    score = projectedStats.saves * profileNum(['itemWeights', 'composite', 'CP', 'saves'], 40) + projectedStats.strikeouts * profileNum(['itemWeights', 'composite', 'CP', 'strikeouts'], 2.1) + projectedStats.wins * profileNum(['itemWeights', 'composite', 'CP', 'wins'], 1) - projectedStats.losses * profileNum(['itemWeights', 'composite', 'CP', 'lossesPenalty'], 1.5) - projectedStats.era * profileNum(['itemWeights', 'composite', 'CP', 'eraPenalty'], 34) - projectedStats.walks * profileNum(['itemWeights', 'composite', 'CP', 'walksPenalty'], 0.6) - projectedStats.home_runs_allowed * profileNum(['itemWeights', 'composite', 'CP', 'homeRunsAllowedPenalty'], 1);
    scoreComponents = {
      primary: 'projected_saves',
      projectedSaves: projectedStats.saves,
      projectedEra: projectedStats.era,
      projectedStrikeouts: projectedStats.strikeouts,
      ageUsed: false
    };
  }

  const resolvedName = currentPlayer && currentPlayer.name ? currentPlayer.name : live.name;
  const diagnosticScore = diagnosticActualScore({ name: resolvedName, category: 'pitcher', mode });
  if (diagnosticScore) {
    score = diagnosticScore.score;
    scoreComponents = {
      ...scoreComponents,
      primary: 'diagnostic_actual_item_score',
      diagnosticActualItem: diagnosticScore.item,
      diagnosticActualValue: diagnosticScore.value,
      diagnosticActualScore: Number(diagnosticScore.score.toFixed(3)),
      diagnosticActualSource: diagnosticScore.source
    };
  }

  return {
    id: `p__${live.team}__${live.role}__${live.owner}`,
    team: live.team,
    role,
    name: resolvedName,
    owner: currentPlayer && currentPlayer.owner ? currentPlayer.owner : live.owner,
    isComputer: !!player.is_computer || isComputerFantasyEntry(live),
    category: 'pitcher',
    matchMethod: live.matchMethod,
    abilities: {
      control,
      stamina,
      velocity
    },
    age: asNum(player.age),
    skills,
    scoringSkills,
    career: {
      era: careerEra,
      saves: careerSaves
    },
    projectedStats,
    projectionMeta: projectionResult.meta,
    strikeoutSkillScore,
    scoreComponents,
    score: Number(score.toFixed(2))
  };
}

function countTeams(items) {
  return items.reduce((acc, item) => {
    acc[item.team] = (acc[item.team] || 0) + 1;
    return acc;
  }, {});
}

function sumScore(items) {
  return Number(items.reduce((sum, item) => sum + asNum(item.score), 0).toFixed(2));
}

function compareHrCandidates(a, b) {
  const hrDiff = asNum(b.projectedStats && b.projectedStats.home_runs) - asNum(a.projectedStats && a.projectedStats.home_runs);
  if (hrDiff !== 0) return hrDiff;
  const skillDiff = asNum(b.hrSkillScore) - asNum(a.hrSkillScore);
  if (skillDiff !== 0) return skillDiff;
  const powerDiff = asNum(b.abilities && b.abilities.power) - asNum(a.abilities && a.abilities.power);
  if (powerDiff !== 0) return powerDiff;
  return String(a.id).localeCompare(String(b.id));
}

function summarizeHrCandidate(candidate) {
  return {
    role: candidate.role,
    team: candidate.team,
    name: candidate.name,
    owner: candidate.owner,
    projectedHR: asNum(candidate.projectedStats && candidate.projectedStats.home_runs),
    power: asNum(candidate.abilities && candidate.abilities.power),
    hrSkillScore: asNum(candidate.hrSkillScore),
    hrSkillTags: candidate.hrSkillTags || [],
    skills: candidate.skills || []
  };
}

function annotatePositionalHrRanks(candidates) {
  const byRole = new Map();
  for (const candidate of candidates) {
    if (!byRole.has(candidate.role)) byRole.set(candidate.role, []);
    byRole.get(candidate.role).push(candidate);
  }

  const diagnostics = {};
  for (const [role, roleCandidates] of byRole.entries()) {
    const sorted = [...roleCandidates].sort(compareHrCandidates);
    const topCandidates = sorted.slice(0, 6).map(summarizeHrCandidate);
    diagnostics[role] = topCandidates;
    sorted.forEach((candidate, index) => {
      candidate.positionalHrRank = index + 1;
      candidate.positionTopProjectedHR = topCandidates.length ? topCandidates[0].projectedHR : null;
      candidate.positionTopCandidates = topCandidates;
      candidate.constraintReason = index === 0
        ? null
        : 'legal_lineup_constraints_can_override_positional_hr_rank';
    });
  }
  return diagnostics;
}

function compareSbCandidates(a, b) {
  const sbDiff = asNum(b.projectedStats && b.projectedStats.steals) - asNum(a.projectedStats && a.projectedStats.steals);
  if (sbDiff !== 0) return sbDiff;
  const strategyDiff = stealStrategyFactor(b.tactic) - stealStrategyFactor(a.tactic);
  if (strategyDiff !== 0) return strategyDiff;
  const skillDiff = asNum(b.stealSkillScore) - asNum(a.stealSkillScore);
  if (skillDiff !== 0) return skillDiff;
  const speedDiff = asNum(b.abilities && b.abilities.speed) - asNum(a.abilities && a.abilities.speed);
  if (speedDiff !== 0) return speedDiff;
  return String(a.id).localeCompare(String(b.id));
}

function summarizeSbCandidate(candidate) {
  const basis = candidate.stealBasis || {};
  const projectionBasis = basis.projectionSbBasis || {};
  return {
    role: candidate.role,
    team: candidate.team,
    name: candidate.name,
    owner: candidate.owner,
    projectedSB: asNum(candidate.projectedStats && candidate.projectedStats.steals),
    projectionBaseKnnSteals: asNum(projectionBasis.baseKnnSteals),
    projectionAdjustedSteals: asNum(projectionBasis.adjustedSteals),
    rawProjectedSteals: asNum(basis.rawProjectedSteals),
    leagueAdjustedSteals: asNum(basis.leagueAdjustedSteals),
    strategyAdjustedSteals: asNum(basis.strategyAdjustedSteals),
    teamStrategy: candidate.tactic,
    strategyFactor: stealStrategyFactor(candidate.tactic),
    speed: asNum(candidate.abilities && candidate.abilities.speed),
    stealSkillScore: asNum(candidate.stealSkillScore),
    projectionSkillContribution: projectionBasis.skillBasis ? asNum(projectionBasis.skillBasis.contribution) : 0,
    projectionSpeedContribution: projectionBasis.speedBasis ? asNum(projectionBasis.speedBasis.contribution) : 0,
    skills: candidate.skills || []
  };
}

function annotatePositionalSbRanks(candidates) {
  const byRole = new Map();
  for (const candidate of candidates) {
    if (!byRole.has(candidate.role)) byRole.set(candidate.role, []);
    byRole.get(candidate.role).push(candidate);
  }

  const diagnostics = {};
  for (const [role, roleCandidates] of byRole.entries()) {
    const sorted = [...roleCandidates].sort(compareSbCandidates);
    const topCandidates = sorted.slice(0, 6).map(summarizeSbCandidate);
    diagnostics[role] = topCandidates;
    sorted.forEach((candidate, index) => {
      candidate.positionalSbRank = index + 1;
      candidate.positionTopProjectedSB = topCandidates.length ? topCandidates[0].projectedSB : null;
      candidate.positionTopSbCandidates = topCandidates;
      candidate.positionTopCandidates = topCandidates;
      candidate.constraintReason = index === 0
        ? null
        : 'legal_lineup_constraints_can_override_positional_sb_rank';
    });
  }
  return diagnostics;
}

function annotatePitcherScoreRanks(candidates, limit = 20) {
  const byRole = new Map();
  for (const candidate of candidates) {
    if (!byRole.has(candidate.role)) byRole.set(candidate.role, []);
    byRole.get(candidate.role).push(candidate);
  }

  const diagnostics = {};
  for (const [role, roleCandidates] of byRole.entries()) {
    diagnostics[role] = [...roleCandidates]
      .sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)))
      .slice(0, limit)
      .map((candidate, index) => ({
        rank: index + 1,
        role: candidate.role,
        team: candidate.team,
        name: candidate.name,
        owner: candidate.owner,
        score: candidate.score,
        projectedK: asNum(candidate.projectedStats && candidate.projectedStats.strikeouts),
        calibratedK: candidate.scoreComponents && candidate.scoreComponents.calibratedStrikeouts,
        strikeoutSkillScore: asNum(candidate.strikeoutSkillScore),
        abilities: candidate.abilities,
        skills: candidate.skills || [],
        scoreComponents: candidate.scoreComponents
      }));
  }

  return diagnostics;
}

function buildBatterModel(candidates, rejectionSets = []) {
  const model = {
    optimize: 'score',
    opType: 'max',
    constraints: {
      batters: { equal: 9 }
    },
    variables: {},
    binaries: {}
  };

  for (const slot of BATTER_SLOTS) model.constraints[`slot_${slot}`] = { equal: 1 };
  for (const team of TEAM_ORDER) model.constraints[`team_${team}`] = { max: 2 };

  const teamCandidateCounts = candidates.reduce((acc, candidate) => {
    acc[candidate.team] = (acc[candidate.team] || 0) + 1;
    return acc;
  }, {});
  for (const team of TEAM_ORDER) {
    if ((teamCandidateCounts[team] || 0) > 0) model.constraints[`team_${team}`].min = 0;
  }

  rejectionSets.forEach((set, idx) => {
    model.constraints[`reject_${idx}`] = { max: set.size - 1 };
  });

  for (const candidate of candidates) {
    const variable = {
      score: candidate.score,
      [`team_${candidate.team}`]: 1,
      batters: 1,
      [`slot_${candidate.role}`]: 1
    };
    rejectionSets.forEach((set, idx) => {
      if (set.has(candidate.id)) variable[`reject_${idx}`] = 1;
    });
    model.variables[candidate.id] = variable;
    model.binaries[candidate.id] = 1;
  }

  return model;
}

function buildPitcherModel(candidates, batterTeamCounts, rejectionSets = []) {
  const model = {
    optimize: 'score',
    opType: 'max',
    constraints: {
      pitchers: { equal: 9 },
      SP: { equal: 5 },
      RP: { equal: 3 },
      CP: { equal: 1 }
    },
    variables: {},
    binaries: {}
  };

  rejectionSets.forEach((set, idx) => {
    model.constraints[`pitcherReject_${idx}`] = { max: set.size - 1 };
  });

  for (const team of TEAM_ORDER) {
    const usedByBatters = batterTeamCounts[team] || 0;
    const remainingSlots = 2 - usedByBatters;
    model.constraints[`team_${team}`] = {
      max: remainingSlots,
      ...(usedByBatters === 0 ? { min: 1 } : {})
    };
  }

  for (const candidate of candidates) {
    const remainingSlots = 2 - (batterTeamCounts[candidate.team] || 0);
    if (remainingSlots <= 0) continue;
    const variable = {
      score: candidate.score,
      pitchers: 1,
      [candidate.role]: 1,
      [`team_${candidate.team}`]: 1
    };
    rejectionSets.forEach((set, idx) => {
      if (set.has(candidate.id)) variable[`pitcherReject_${idx}`] = 1;
    });
    model.variables[candidate.id] = variable;
    model.binaries[candidate.id] = 1;
  }

  return model;
}

function buildPitcherPrimaryModel(candidates, rejectionSets = []) {
  const model = {
    optimize: 'score',
    opType: 'max',
    constraints: {
      pitchers: { equal: 9 },
      SP: { equal: 5 },
      RP: { equal: 3 },
      CP: { equal: 1 }
    },
    variables: {},
    binaries: {}
  };

  for (const team of TEAM_ORDER) model.constraints[`team_${team}`] = { max: 2 };

  rejectionSets.forEach((set, idx) => {
    model.constraints[`pitcherReject_${idx}`] = { max: set.size - 1 };
  });

  for (const candidate of candidates) {
    const variable = {
      score: candidate.score,
      pitchers: 1,
      [candidate.role]: 1,
      [`team_${candidate.team}`]: 1
    };
    rejectionSets.forEach((set, idx) => {
      if (set.has(candidate.id)) variable[`pitcherReject_${idx}`] = 1;
    });
    model.variables[candidate.id] = variable;
    model.binaries[candidate.id] = 1;
  }

  return model;
}

function buildBatterFillModel(candidates, pitcherTeamCounts, rejectionSets = []) {
  const model = {
    optimize: 'score',
    opType: 'max',
    constraints: {
      batters: { equal: 9 }
    },
    variables: {},
    binaries: {}
  };

  for (const slot of BATTER_SLOTS) model.constraints[`slot_${slot}`] = { equal: 1 };

  rejectionSets.forEach((set, idx) => {
    model.constraints[`batterReject_${idx}`] = { max: set.size - 1 };
  });

  for (const team of TEAM_ORDER) {
    const usedByPitchers = pitcherTeamCounts[team] || 0;
    const remainingSlots = 2 - usedByPitchers;
    model.constraints[`team_${team}`] = {
      max: remainingSlots,
      ...(usedByPitchers === 0 ? { min: 1 } : {})
    };
  }

  for (const candidate of candidates) {
    const remainingSlots = 2 - (pitcherTeamCounts[candidate.team] || 0);
    if (remainingSlots <= 0) continue;
    const variable = {
      score: candidate.score,
      [`team_${candidate.team}`]: 1,
      batters: 1,
      [`slot_${candidate.role}`]: 1
    };
    rejectionSets.forEach((set, idx) => {
      if (set.has(candidate.id)) variable[`batterReject_${idx}`] = 1;
    });
    model.variables[candidate.id] = variable;
    model.binaries[candidate.id] = 1;
  }

  return model;
}

function extractSelected(result, model, byId) {
  const items = [];
  if (!result || !result.feasible) return items;
  for (const [key, value] of Object.entries(result)) {
    if (!model.binaries[key] || value !== 1) continue;
    const item = byId.get(key);
    if (item) items.push(item);
  }
  return items;
}

function allLegal(legality) {
  return Object.values(legality || {}).every(Boolean);
}

function noComputerPlayers(lineup) {
  return (lineup || []).every(item =>
    !item.isComputer &&
    item.name !== '★★★★★' &&
    item.owner !== '電腦' &&
    !!item.owner
  );
}

function isComputerCandidate(item) {
  return !item ||
    !!item.isComputer ||
    item.name === '★★★★★' ||
    item.owner === '電腦' ||
    !item.owner;
}

function candidateAge(item) {
  const age = asNum(item && item.age, Number.NaN);
  return Number.isFinite(age) && age > 0 ? age : null;
}

function isAge43Candidate(item) {
  const age = candidateAge(item);
  return age !== null && age >= AGE43_FORMAL_LINEUP_THRESHOLD;
}

function isUnknownAgeLiveOnlyCandidate(item) {
  return !!item && item.matchMethod === 'live_only' && candidateAge(item) === null;
}

function isReplacementCandidate(item) {
  return !!item && (
    item.matchMethod === 'retirement_replacement' ||
    item.isReplacementRookie ||
    item.replacementRookie ||
    item.retirementReplacement ||
    item.replacement_rookie ||
    item.owner === 'replacement rookie' ||
    /^Replacement rookie\b/i.test(String(item.name || ''))
  );
}

function isFormalFantasyCandidate(item) {
  return !isComputerCandidate(item) &&
    !isReplacementCandidate(item) &&
    !isAge43Candidate(item) &&
    !isUnknownAgeLiveOnlyCandidate(item);
}

function chooseLegalLineup(matchedBatters, matchedPitchers, options = {}) {
  const batterById = new Map(matchedBatters.map(candidate => [candidate.id, candidate]));
  const pitcherById = new Map(matchedPitchers.map(candidate => [candidate.id, candidate]));
  const rejectedBatterSets = [...(options.rejectedBatterSets || [])];
  const rejectedPitcherSets = [...(options.rejectedPitcherSets || [])];
  const failures = [];

  if (options.priority === 'pitcher') {
    for (let attempt = 1; attempt <= MAX_BATTER_SEARCH_ATTEMPTS; attempt++) {
      const pitcherModel = buildPitcherPrimaryModel(matchedPitchers, rejectedPitcherSets);
      const pitcherResult = solver.Solve(pitcherModel);
      const pitchers = extractSelected(pitcherResult, pitcherModel, pitcherById);
      if (!pitcherResult.feasible || pitchers.length !== 9) {
        failures.push({
          attempt,
          type: 'pitcher_infeasible',
          selectedPitchers: pitchers.length
        });
        continue;
      }

      const pitcherTeamCounts = countTeams(pitchers);
      const batterModel = buildBatterFillModel(matchedBatters, pitcherTeamCounts, rejectedBatterSets);
      const batterResult = solver.Solve(batterModel);
      const batters = extractSelected(batterResult, batterModel, batterById);

      if (batterResult.feasible && batters.length === 9) {
        const lineup = [...batters, ...pitchers];
        const legality = legalityFromLineup(lineup);
        if (allLegal(legality)) {
          return {
            feasible: true,
            attempts: attempt,
            batterObjective: sumScore(batters),
            pitcherObjective: sumScore(pitchers),
            objective: Number((sumScore(pitchers) + sumScore(batters)).toFixed(2)),
            lineup,
            batters,
            pitchers,
            legality,
            failures,
            selectionPriority: 'pitcher_first'
          };
        }
        failures.push({
          attempt,
          type: 'post_merge_illegal',
          batterObjective: sumScore(batters),
          pitcherObjective: sumScore(pitchers),
          legality
        });
      } else {
        failures.push({
          attempt,
          type: 'batter_fill_infeasible',
          pitcherObjective: sumScore(pitchers),
          coveredTeamsByPitchers: Object.keys(pitcherTeamCounts).sort(),
          missingTeamsForBatters: TEAM_ORDER.filter(team => !pitcherTeamCounts[team])
        });
      }

      rejectedPitcherSets.push(new Set(pitchers.map(item => item.id)));
    }

    return {
      feasible: false,
      failureReason: 'pitcher_search_exhausted',
      attempts: MAX_BATTER_SEARCH_ATTEMPTS,
      failures
    };
  }

  for (let attempt = 1; attempt <= MAX_BATTER_SEARCH_ATTEMPTS; attempt++) {
    const batterModel = buildBatterModel(matchedBatters, rejectedBatterSets);
    const batterResult = solver.Solve(batterModel);
    const batters = extractSelected(batterResult, batterModel, batterById);
    if (!batterResult.feasible || batters.length !== 9) {
      failures.push({
        attempt,
        type: 'batter_infeasible',
        selectedBatters: batters.length
      });
      continue;
    }

    const batterTeamCounts = countTeams(batters);
    const pitcherModel = buildPitcherModel(matchedPitchers, batterTeamCounts, rejectedPitcherSets);
    const pitcherResult = solver.Solve(pitcherModel);
    const pitchers = extractSelected(pitcherResult, pitcherModel, pitcherById);

    if (pitcherResult.feasible && pitchers.length === 9) {
      const lineup = [...batters, ...pitchers];
      const legality = legalityFromLineup(lineup);
      if (allLegal(legality)) {
        return {
          feasible: true,
          attempts: attempt,
          batterObjective: sumScore(batters),
          pitcherObjective: sumScore(pitchers),
          objective: Number((sumScore(batters) + sumScore(pitchers)).toFixed(2)),
          lineup,
          batters,
          pitchers,
          legality,
          failures
        };
      }
      failures.push({
        attempt,
        type: 'post_merge_illegal',
        batterObjective: sumScore(batters),
        pitcherObjective: sumScore(pitchers),
        legality
      });
    } else {
      failures.push({
        attempt,
        type: 'pitcher_infeasible',
        batterObjective: sumScore(batters),
        coveredTeamsByBatters: Object.keys(batterTeamCounts).sort(),
        missingTeamsForPitchers: TEAM_ORDER.filter(team => !batterTeamCounts[team])
      });
    }

    rejectedBatterSets.push(new Set(batters.map(item => item.id)));
  }

  return {
    feasible: false,
    failureReason: 'batter_search_exhausted',
    attempts: MAX_BATTER_SEARCH_ATTEMPTS,
    failures
  };
}

function summarizeVariantDiff(current, previous) {
  if (!previous) return { changedBatters: null, changedPitchers: null };
  const currentBatters = new Set((current.batters || []).map(item => item.id));
  const currentPitchers = new Set((current.pitchers || []).map(item => item.id));
  const previousBatters = new Set((previous.batters || []).map(item => item.id));
  const previousPitchers = new Set((previous.pitchers || []).map(item => item.id));
  return {
    changedBatters: [...currentBatters].filter(id => !previousBatters.has(id)).length,
    changedPitchers: [...currentPitchers].filter(id => !previousPitchers.has(id)).length
  };
}

function summarizeVariantPairwiseDiff(current, previousVariants) {
  return previousVariants.map(previous => ({
    variantIndex: previous.variantIndex,
    ...summarizeVariantDiff(current, previous)
  }));
}

function chooseLegalLineupVariants(matchedBatters, matchedPitchers, desiredCount = DEFAULT_VARIANT_COUNT, options = {}) {
  const illegalBatterCandidates = matchedBatters.filter(isComputerCandidate);
  const illegalPitcherCandidates = matchedPitchers.filter(isComputerCandidate);
  if (illegalBatterCandidates.length || illegalPitcherCandidates.length) {
    return {
      desiredCount,
      feasibleCount: 0,
      policy: 'Each version must differ from every earlier version by at least one batter and one pitcher.',
      variants: [],
      failures: [{
        variant: 1,
        failureReason: 'computer_candidates_present',
        illegalBatterCandidates: illegalBatterCandidates.map(formatDisplayRow),
        illegalPitcherCandidates: illegalPitcherCandidates.map(formatDisplayRow)
      }]
    };
  }

  const variants = [];
  const rejectedBatterSets = [];
  const rejectedPitcherSets = [];
  const failures = [];

  for (let index = 1; index <= desiredCount; index++) {
    const result = chooseLegalLineup(matchedBatters, matchedPitchers, {
      rejectedBatterSets,
      rejectedPitcherSets,
      priority: options.priority
    });
    if (!result.feasible) {
      failures.push({
        variant: index,
        failureReason: result.failureReason || 'variant_infeasible',
        attempts: result.attempts,
        recentFailures: (result.failures || []).slice(-5)
      });
      break;
    }

    result.variantIndex = index;
    result.diffFromPrevious = summarizeVariantDiff(result, variants[variants.length - 1] || null);
    result.diffFromEarlierVariants = summarizeVariantPairwiseDiff(result, variants);
    variants.push(result);
    rejectedBatterSets.push(new Set(result.batters.map(item => item.id)));
    rejectedPitcherSets.push(new Set(result.pitchers.map(item => item.id)));
  }

  return {
    desiredCount,
    feasibleCount: variants.length,
    policy: 'Each version must differ from every earlier version by at least one batter and one pitcher.',
    variants,
    failures
  };
}

function abilityDisplay(item) {
  const abilities = item.abilities || {};
  if (item.category === 'batter') {
    return `力${asNum(abilities.power)}/打${asNum(abilities.contact)}/速${asNum(abilities.speed)}/守${asNum(abilities.defense)}/肩${asNum(abilities.arm)}`;
  }
  return `控${asNum(abilities.control)}/體${asNum(abilities.stamina)}/速${asNum(abilities.velocity)}`;
}

function formatDisplayRow(item) {
  return {
    '位置': item.role,
    '隊伍': item.team,
    '球員名稱': item.name,
    'GM名稱': item.owner,
    '能力': abilityDisplay(item),
    '技能': (item.skills || []).join('、') || '無'
  };
}

function legalityFromLineup(lineup) {
  const teamCounts = {};
  const batterRoles = {};
  let sp = 0;
  let rp = 0;
  let cp = 0;
  let batters = 0;
  let pitchers = 0;

  for (const item of lineup) {
    teamCounts[item.team] = (teamCounts[item.team] || 0) + 1;
    if (item.category === 'batter') {
      batters += 1;
      batterRoles[item.role] = (batterRoles[item.role] || 0) + 1;
    } else {
      pitchers += 1;
      if (item.role === 'SP') sp += 1;
      if (item.role === 'RP') rp += 1;
      if (item.role === 'CP') cp += 1;
    }
  }

  const allTeamsCovered = TEAM_ORDER.every(team => (teamCounts[team] || 0) >= 1);
  const maxTwoPerTeam = Object.values(teamCounts).every(count => count <= 2);
  const fullBatterGrid = BATTER_SLOTS.every(slot => batterRoles[slot] === 1);

  return {
    total18: lineup.length === 18,
    nineBatters: batters === 9,
    ninePitchers: pitchers === 9,
    fiveSP: sp === 5,
    threeRP: rp === 3,
    oneCP: cp === 1,
    fullBatterGrid,
    twelveTeamsCovered: allTeamsCovered,
    maxTwoPerTeam,
    noComputerPlayers: noComputerPlayers(lineup)
  };
}

function formatConsoleSummary(report) {
  const statusLines = [
    `Mode: ${report.mode.toUpperCase()}`,
    `Feasible: ${report.feasible}`,
    `Objective: ${report.objective}`,
    `Batter objective: ${report.batterObjective}`,
    `Pitcher objective: ${report.pitcherObjective}`,
    `Search attempts: ${report.search.attempts}/${report.search.maxAttempts}`,
    `Live source: ${report.source.liveSourceType}`,
    `Live timestamp: ${report.source.liveSourceTimestamp || 'unknown'}`,
    `Live dir: ${report.source.liveDir}`,
    `Season dir: ${report.source.seasonDir}`
  ];
  if (report.source.liveFetchError) statusLines.push(`Live fetch error: ${report.source.liveFetchError}`);
  const legality = report.legality || {};
  statusLines.push(`Legality: ${Object.entries(legality).map(([k, v]) => `${k}=${v ? 'ok' : 'fail'}`).join(', ')}`);
  return statusLines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv);
  const mode = (args.mode || 'hr').toLowerCase();
  if (!['avg', 'hr', 'rbi', 'sb', 'sbk', 'sbera', 'eraavg', 'kavg', 'svsb', 'k', 'era', 'w', 'sv'].includes(mode)) throw new Error(`Unsupported mode: ${mode}`);
  const weightProfile = loadWeightProfile(args['weight-profile'], {
    allowDiagnostic: !!args['allow-diagnostic-profile']
  });
  const variantCount = profileNum(['variantCount'], DEFAULT_VARIANT_COUNT);

  const seasonDir = args['season-dir'] || args.season || latestSeasonDir(ORE_DB_BASE);
  const seasonMeta = readSeasonMeta(seasonDir);
  const liveSource = await resolveLiveSource(args['live-dir'] || args.live, {
    disableLiveFetch: !!args['no-live-fetch'],
    requireFantasyGrid: true
  });
  const liveDir = liveSource.liveDir;
  const outPath = args.out || path.join(WORKSPACE, 'reports', `ore_draft_${mode}.json`);
  const projectionArtifactPath = args['projection-out'] || path.join(WORKSPACE, 'reports', 'ore_projection_snapshot.json');
  const maxTrainingSeason = args['max-training-season'] == null
    ? Number.POSITIVE_INFINITY
    : asNum(args['max-training-season'], Number.POSITIVE_INFINITY);

  const rawPlayers = readJson(path.join(seasonDir, 'players.json'));
  const retirementContext = projection.applyRetirementReplacements(rawPlayers);
  const players = retirementContext.players;
  const projectionContext = projection.buildProjectionSnapshot({
    seasonDir,
    players: rawPlayers,
    seasonMeta,
    outPath: projectionArtifactPath,
    maxSeason: maxTrainingSeason
  });
  const sameLeaguePlayerEnvironments = projectionContext.snapshot.sameLeaguePlayerEnvironments || { byTeam: {} };
  const pitcherRoleUsageEnvironments = projectionContext.snapshot.pitcherRoleUsageEnvironments || { byTeam: {} };
  const sakuTeamMap = loadSakuTeamMap(seasonDir);
  const teamLeagueMap = loadTeamLeagueMap(seasonDir);
  const kakuninnHtml = readUtf8(path.join(liveDir, 'kakuninn.html'));
  const kakuninnTeamOrder = parseKakuninnTeamOrder(kakuninnHtml, sakuTeamMap);
  const kakuninnEntries = parseKakuninn(kakuninnHtml, kakuninnTeamOrder);
  const { pitchers: livePitchers, strategies } = parseLiveRosters(liveDir, sakuTeamMap);
  const currentPlayersByTeam = buildCurrentPlayerIndex(players);
  const stealEnvironments = buildStealEnvironments(players, teamLeagueMap);

  const skippedComputerBatters = kakuninnEntries.filter(entry =>
    BATTER_SLOTS.includes(entry.slot) && isComputerFantasyEntry(entry)
  );
  const activeBatterEntries = kakuninnEntries.filter(entry =>
    BATTER_SLOTS.includes(entry.slot) && !isComputerFantasyEntry(entry)
  );

  const matchedBatters = [];
  const unmatchedBatters = [];
  for (const live of activeBatterEntries) {
    const teamPlayers = currentPlayersByTeam.get(live.team) || [];
    const match = findBatterMatch(teamPlayers, live);
    live.matchMethod = match.method;
    const basePlayer = match.player ? mergeLiveBatterWithCurrent(live, match.player) : (isStealsMode(mode) ? mergeLiveBatterWithCurrent(live, null) : null);
    if (!basePlayer) {
      unmatchedBatters.push(live);
      continue;
    }
    const batterTeamEnvironment = sameLeaguePlayerEnvironments.byTeam
      ? sameLeaguePlayerEnvironments.byTeam[basePlayer.team || live.team]
      : null;
    const batterProjection = projection.projectBatter(basePlayer, projectionContext.model, {
      slot: live.slot,
      sameLeagueEnvironment: batterTeamEnvironment
    });
    matchedBatters.push(buildBatterCandidate(live, basePlayer, mode, strategies, batterProjection, stealEnvironments));
  }
  const rejectedComputerBatterCandidates = matchedBatters.filter(isComputerCandidate);
  const rejectedReplacementBatterCandidates = matchedBatters.filter(isReplacementCandidate);
  const rejectedAge43BatterCandidates = matchedBatters.filter(isAge43Candidate);
  const rejectedUnknownAgeBatterCandidates = matchedBatters.filter(isUnknownAgeLiveOnlyCandidate);
  const fantasyBatters = matchedBatters.filter(isFormalFantasyCandidate);
  const positionDiagnostics = isStealsMode(mode)
    ? { sbPositionTopCandidates: annotatePositionalSbRanks(fantasyBatters) }
    : { hrPositionTopCandidates: annotatePositionalHrRanks(fantasyBatters) };

  const matchedPitchers = [];
  const unmatchedPitchers = [];
  for (const live of livePitchers) {
    const teamPlayers = currentPlayersByTeam.get(live.team) || [];
    const match = findPitcherMatch(teamPlayers, live);
    live.matchMethod = match.method;
    if (live.role !== 'CP' && !match.player) {
      unmatchedPitchers.push(live);
      continue;
    }
    const mergedPitcher = mergeLivePitcherWithCurrent(live, match.player);
    const pitcherTeamEnvironment = sameLeaguePlayerEnvironments.byTeam
      ? sameLeaguePlayerEnvironments.byTeam[mergedPitcher.team || live.team]
      : null;
    const pitcherRoleUsageEnvironment = pitcherRoleUsageEnvironments.byTeam
      ? pitcherRoleUsageEnvironments.byTeam[mergedPitcher.team || live.team]
      : null;
    const pitcherProjection = projection.projectPitcher(mergedPitcher, projectionContext.model, {
      role: live.role,
      sameLeagueEnvironment: pitcherTeamEnvironment,
      roleUsageEnvironment: pitcherRoleUsageEnvironment
    });
    matchedPitchers.push(buildPitcherCandidate(live, match.player, mergedPitcher, pitcherProjection, mode));
  }
  const rejectedComputerPitcherCandidates = matchedPitchers.filter(isComputerCandidate);
  const rejectedReplacementPitcherCandidates = matchedPitchers.filter(isReplacementCandidate);
  const rejectedAge43PitcherCandidates = matchedPitchers.filter(isAge43Candidate);
  const rejectedUnknownAgePitcherCandidates = matchedPitchers.filter(isUnknownAgeLiveOnlyCandidate);
  const fantasyPitchers = matchedPitchers.filter(isFormalFantasyCandidate);
  const pitcherDiagnostics = isStrikeoutPitcherMode(mode)
    ? { strikeoutPitcherScoreTopCandidates: annotatePitcherScoreRanks(fantasyPitchers) }
    : {};

  const selectionPriority = isPitcherFirstMode(mode) ? 'pitcher' : 'batter';
  const variantSummary = chooseLegalLineupVariants(fantasyBatters, fantasyPitchers, variantCount, {
    priority: selectionPriority
  });
  const solveSummary = variantSummary.variants[0] || {
    feasible: false,
    failureReason: 'no_legal_variant',
    attempts: 0,
    failures: variantSummary.failures || []
  };
  const lineup = solveSummary.lineup || [];

  const roleOrder = [...BATTER_SLOTS, ...PITCH_SLOTS];
  lineup.sort((a, b) => roleOrder.indexOf(a.role) - roleOrder.indexOf(b.role) || b.score - a.score);
  for (const variant of variantSummary.variants) {
    if (Array.isArray(variant.lineup)) {
      variant.lineup.sort((a, b) => roleOrder.indexOf(a.role) - roleOrder.indexOf(b.role) || b.score - a.score);
    }
  }
  const legality = solveSummary.legality || legalityFromLineup(lineup);
  const teamCounts = countTeams(lineup);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const report = {
    generatedAt: new Date().toISOString(),
    mode,
    assumptions: {
      canonicalHandoff: CANONICAL_HANDOFF,
      projectionModel: projectionContext.snapshot.modelVersion,
      projectionConfidence: projectionContext.snapshot.confidence,
      trainingSeasons: projectionContext.snapshot.trainingSeasons.map(item => item.season),
      directPlayerHistoryCarryForwardWeight: 0,
      historyUsedAsTrainingOnly: true,
      teamHistoryBonusEnabled: false,
      rosterPositionAndPitcherRoleUsedAsModelFeatures: true,
      sameLeagueOpponentContextUsedInProjection: !!(projectionContext.snapshot.modelRules && projectionContext.snapshot.modelRules.sameLeagueOpponentContextUsed),
      teamOverallScoreUsesSameLeagueAdjustment: !!(projectionContext.snapshot.modelRules && projectionContext.snapshot.modelRules.teamOverallScoreUsesSameLeagueAdjustment),
      sameLeagueBatterEnvironmentUsedInPlayerProjection: !!(projectionContext.snapshot.modelRules && projectionContext.snapshot.modelRules.sameLeagueBatterEnvironmentUsed),
      sameLeaguePitcherEnvironmentUsedInPlayerProjection: !!(projectionContext.snapshot.modelRules && projectionContext.snapshot.modelRules.sameLeaguePitcherEnvironmentUsed),
      pitcherRoleUsageModelUsed: !!(projectionContext.snapshot.modelRules && projectionContext.snapshot.modelRules.pitcherRoleUsageModelUsed),
      pitcherRoleUsageModel: projectionContext.snapshot.modelRules && projectionContext.snapshot.modelRules.pitcherRoleUsageModel,
      starterOnlyPitcherSkills: ['中繼能力', '中繼能力○'],
      starterOnlyPitcherSkillsEffectiveRoles: ['SP'],
      age43PenaltyEnabled: false,
      ageUsedInProjectionOrScoring: false,
      age43RetirementReplacementEnabled: true,
      age43FormalLineupBlocked: true,
      age43FormalLineupThreshold: AGE43_FORMAL_LINEUP_THRESHOLD,
      replacementRookiesForbiddenInFormalLineups: true,
      stealStrategyHardGate: isStealsMode(mode),
      stealStrategyMultiplierEnabled: isStealsMode(mode),
      stealSkillSpeedProjectionCalibrationEnabled: isStealsMode(mode),
      stealLeaguePickoffEnvironmentEnabled: isStealsMode(mode),
      battersSelectedFromProjectedStats: mode === 'hr'
        ? 'HR_ONLY'
        : (isLegalFillerBatterMode(mode)
          ? 'LEGAL_FILLER_ONLY_NOT_OPTIMIZED'
          : (isAverageBatterMode(mode)
            ? 'AVG_ONLY'
            : (isRbiBatterMode(mode)
              ? 'RBI_ONLY'
              : 'SB_ONLY_WITH_SKILL_SPEED_CALIBRATED_PROJECTION_STRATEGY_MULTIPLIER_AND_LEAGUE_PICKOFF_ENV'))),
      hrModeTieBreakers: mode === 'hr' ? ['hrSkillScore', 'power'] : [],
      rbiModeTieBreakers: isRbiBatterMode(mode) ? ['projectedHomeRuns', 'hrSkillScore', 'power'] : [],
      sbModeTieBreakers: isStealsMode(mode) ? ['stealSkillScore', 'speed'] : [],
      avgModeTieBreakers: isAverageBatterMode(mode) ? ['contact'] : [],
      legalFillerBatterMode: isLegalFillerBatterMode(mode),
      pitchersSelectedFromProjectedStats: isStrikeoutPitcherMode(mode)
        ? 'K_ONLY_WITH_ROLE_SKILL_CALIBRATION'
        : (isEraPitcherMode(mode)
          ? 'ERA_ONLY'
          : (isSavesPitcherMode(mode)
            ? 'SV_ONLY'
            : (isWinsPitcherMode(mode) ? 'W_ONLY' : 'SV,ERA,K'))),
      strikeoutModeTieBreakers: isStrikeoutPitcherMode(mode) ? ['strikeoutSkillScore', 'velocity', 'control', 'stamina'] : [],
      eraModeTieBreakers: isEraPitcherMode(mode) ? ['projectedWalks', 'projectedHomeRunsAllowed', 'control'] : [],
      savesModeTieBreakers: isSavesPitcherMode(mode) ? ['projectedEra', 'projectedStrikeouts'] : [],
      winsModeTieBreakers: isWinsPitcherMode(mode) ? ['projectedEra', 'projectedStrikeouts'] : [],
      selectionPriority: isPitcherFirstMode(mode) ? 'PITCHER_FIRST' : 'BATTER_FIRST',
      pitchersFillRemainingSlotsAfterBatters: !isPitcherFirstMode(mode),
      battersFillRemainingSlotsAfterPitchers: isPitcherFirstMode(mode),
      legalLineupRequiredBeforeReturn: true
    },
    weightProfile: currentWeightProfileSummary(),
    source: {
      seasonDir,
      seasonScrapedAt: seasonMeta && seasonMeta.scraped_at ? seasonMeta.scraped_at : null,
      liveDir,
      liveSourceType: liveSource.type,
      liveSourceTimestamp: liveSource.liveTimestamp || null,
      liveFetchAttempted: !!liveSource.liveFetchAttempted,
      liveFetchSucceeded: !!liveSource.liveFetchSucceeded,
      liveFetchError: liveSource.liveFetchError || null,
      fallbackReason: liveSource.fallbackReason || null,
      players: path.join(seasonDir, 'players.json'),
      seasonSnapshot: path.join(seasonDir, 'season_snapshot.json'),
      kakuninn: path.join(liveDir, 'kakuninn.html'),
      projectionArtifact: projectionArtifactPath,
      computerPolicy: 'excluded_before_solver'
    },
    fantasyGrid: {
      teamOrder: kakuninnTeamOrder,
      entryCount: kakuninnEntries.length,
      checkboxEntries: kakuninnEntries.filter(entry => entry.source === 'fantasy_checkbox_grid').length,
      rosterGridEntries: kakuninnEntries.filter(entry => entry.source === 'kakuninn_roster_grid').length
    },
    leagueStealEnvironment: isStealsMode(mode) ? stealEnvironments : null,
    projection: {
      artifact: projectionArtifactPath,
      modelVersion: projectionContext.snapshot.modelVersion,
      confidence: projectionContext.snapshot.confidence,
      trainingSeasons: projectionContext.snapshot.trainingSeasons,
      sampleCounts: projectionContext.snapshot.sampleCounts,
      teamProjections: projectionContext.snapshot.teamProjections
    },
    retirementReplacementPolicy: projectionContext.snapshot.retirementReplacementPolicy,
    counts: {
      totalCandidates: fantasyBatters.length + fantasyPitchers.length,
      matchedBatters: fantasyBatters.length,
      matchedPitchers: fantasyPitchers.length,
      unmatchedBatters: unmatchedBatters.length,
      unmatchedPitchers: unmatchedPitchers.length,
      skippedComputerBatters: skippedComputerBatters.length,
      rejectedComputerBatterCandidates: rejectedComputerBatterCandidates.length,
      rejectedComputerPitcherCandidates: rejectedComputerPitcherCandidates.length,
      rejectedReplacementBatterCandidates: rejectedReplacementBatterCandidates.length,
      rejectedReplacementPitcherCandidates: rejectedReplacementPitcherCandidates.length,
      rejectedAge43BatterCandidates: rejectedAge43BatterCandidates.length,
      rejectedAge43PitcherCandidates: rejectedAge43PitcherCandidates.length,
      rejectedUnknownAgeBatterCandidates: rejectedUnknownAgeBatterCandidates.length,
      rejectedUnknownAgePitcherCandidates: rejectedUnknownAgePitcherCandidates.length
    },
    search: {
      strategy: isPitcherFirstMode(mode)
        ? 'pitchers_first_then_batters_fill_remaining_slots'
        : 'batters_first_then_pitchers_fill_remaining_slots',
      attempts: solveSummary.attempts || 0,
      maxAttempts: MAX_BATTER_SEARCH_ATTEMPTS,
      failureReason: solveSummary.failureReason || null,
      recentFailures: (solveSummary.failures || []).slice(-10)
    },
    lineupVariantPolicy: {
      requested: variantCount,
      produced: variantSummary.feasibleCount,
      distinctnessRule: variantSummary.policy
    },
    lineupVariants: variantSummary.variants.map(variant => ({
      variantIndex: variant.variantIndex,
      feasible: !!variant.feasible,
      objective: variant.objective,
      batterObjective: variant.batterObjective,
      pitcherObjective: variant.pitcherObjective,
      attempts: variant.attempts,
      diffFromPrevious: variant.diffFromPrevious,
      diffFromEarlierVariants: variant.diffFromEarlierVariants,
      legality: variant.legality,
      lineup: variant.lineup,
      displayRows: variant.lineup.map(formatDisplayRow)
    })),
    lineupVariantFailures: variantSummary.failures,
    diagnostics: {
      ...positionDiagnostics,
      ...pitcherDiagnostics
    },
    strategies,
    feasible: !!solveSummary.feasible,
    objective: solveSummary.objective ?? null,
    batterObjective: solveSummary.batterObjective ?? null,
    pitcherObjective: solveSummary.pitcherObjective ?? null,
    legality,
    lineup,
    teamCounts,
    unmatched: {
      batters: unmatchedBatters,
      pitchers: unmatchedPitchers,
      skippedComputerBatters,
      rejectedComputerBatterCandidates,
      rejectedComputerPitcherCandidates
    }
  };

  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(outPath);
  console.log(formatConsoleSummary(report));
  if (!report.feasible || !allLegal(report.legality)) {
    console.error(`No legal lineup found after ${report.search.attempts}/${report.search.maxAttempts} batter-first attempts.`);
    process.exitCode = 2;
  }
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
