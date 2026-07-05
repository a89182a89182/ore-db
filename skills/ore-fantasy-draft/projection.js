const fs = require('fs');
const path = require('path');

const WORKSPACE = path.resolve(__dirname, '..', '..');
const USER_HOME = process.env.USERPROFILE || 'C:\\Users\\a8918';
const ORE_DB_BASE = path.join(USER_HOME, 'Documents', 'ore-db');
const MIN_TRAINING_SEASON = 767;
const MODEL_VERSION = 'ore-projection-v7-rp-workload-role-skill-filter-knn';
const DEFAULT_ARTIFACT_PATH = path.join(WORKSPACE, 'reports', 'ore_projection_snapshot.json');
const MIN_ROLE_NEIGHBORS = 6;
const MIN_POSITION_NEIGHBORS = 6;
const K_NEIGHBORS = 12;
const SAME_LEAGUE_EDGE_WEIGHT = 0.18;
const BATTER_OPPONENT_PITCHER_ENV_WEIGHT = 0.0012;
const PITCHER_OPPONENT_BATTER_ENV_WEIGHT = 0.0010;
const RP_WORKLOAD_STARTER_STAMINA_DEFICIT_WEIGHT = 0.0025;
const RP_WORKLOAD_STARTER_CAPACITY_DEFICIT_WEIGHT = 0.0015;
const RETIREMENT_AGE_THRESHOLD = 43;

const BATTER_SLOT_MAP = {
  '捕手': 'C',
  '一壘': '1B',
  '二壘': '2B',
  '三壘': '3B',
  '游擊': 'SS',
  '左外': 'LF',
  '中外': 'CF',
  '右外': 'RF',
  'ＤＨ': 'DH',
  'DH': 'DH'
};

const PITCHER_ROLE_MAP = {
  '先發': 'SP',
  '中繼': 'RP',
  '救援': 'CP',
  'SP': 'SP',
  'RP': 'RP',
  'CP': 'CP',
  'CL': 'CP'
};

const BATTER_TARGET_KEYS = ['batting_avg', 'home_runs', 'rbi', 'steals'];
const PITCHER_TARGET_KEYS = ['era', 'wins', 'losses', 'saves', 'strikeouts', 'walks', 'home_runs_allowed'];
const BATTER_INTERACTION_ABILITIES = ['power', 'contact', 'speed'];
const PITCHER_INTERACTION_ABILITIES = ['control', 'stamina', 'velocity'];
const STARTER_ONLY_PITCHER_SKILLS = new Set(['中繼能力', '中繼能力○']);
const PITCHER_CONTEXT_ONLY_SKILLS = new Set([
  '中繼能力',
  '中繼能力○',
  '人氣者',
  '牽制○',
  '牽制Ｘ',
  '投球反應○',
  '勝運',
  '負運'
]);
const HR_SKILL_WEIGHTS = {
  '豪力': 34,
  '豪力打者': 34,
  '強力打者': 24,
  '鬥氣打者': 10,
  '鬥氣': 8,
  '得點圈◎': 6,
  '得點圈○': 4,
  '滿壘男': 4,
  '再見男': 3,
  '安定感': 3,
  '固定打者': 2,
  '威壓感': 2,
  '逆境○': 2,
  '對左投Ｘ': -4,
  '對右投Ｘ': -4,
  '不安定感': -5
};
const SB_SKILL_WEIGHTS = {
  '\u795e\u901f': 20,
  '\u795e\u901f\u6253\u8005': 20,
  '\u76dc\u58d8\u25cb': 18,
  '\u958b\u8def\u5148\u92d2': 12,
  '\u5167\u91ce\u5b89\u6253': 8,
  '\u5de7\u6253\u6253\u8005': 6,
  '\u56fa\u5b9a\u6253\u8005': 4,
  '\u5b89\u5b9a\u611f': 4,
  '\u76dc\u58d8\uff38': -25,
  '\u4e0d\u5b89\u5b9a\u611f': -5,
  '\u5c0d\u5de6\u6295\uff38': -4,
  '\u5c0d\u53f3\u6295\uff38': -4
};
const MAJOR_HR_SKILLS = new Set(['豪力', '豪力打者', '強力打者']);

function asNum(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'string') {
    const cleaned = value.replace(/,/g, '').trim();
    if (!cleaned) return fallback;
    const num = Number(cleaned);
    return Number.isFinite(num) ? num : fallback;
  }
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function parseAvg(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  const text = String(value).trim();
  if (!text) return fallback;
  if (text.startsWith('.')) return asNum(`0${text}`, fallback);
  return asNum(text, fallback);
}

function roundTo(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function dedupe(list) {
  return [...new Set((list || []).filter(Boolean))];
}

function effectivePitcherSkills(skills, role) {
  const unique = dedupe(skills || []);
  if (role === 'SP') return unique;
  return unique.filter(skill => !STARTER_ONLY_PITCHER_SKILLS.has(skill));
}

function projectionPitcherSkills(skills, role) {
  return effectivePitcherSkills(skills, role)
    .filter(skill => !PITCHER_CONTEXT_ONLY_SKILLS.has(skill));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function latestSeasonDir(base = ORE_DB_BASE) {
  const dirs = fs.readdirSync(base, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^season-\d+$/.test(entry.name))
    .map(entry => entry.name)
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  if (!dirs.length) throw new Error(`No season-* directories found under ${base}`);
  return path.join(base, dirs[0]);
}

function seasonNumberFromDir(seasonDir) {
  return Number(path.basename(seasonDir).split('-')[1]);
}

function readSeasonSnapshot(seasonDir) {
  const filePath = path.join(seasonDir, 'season_snapshot.json');
  if (!fs.existsSync(filePath)) return null;
  try {
    return readJson(filePath);
  } catch (_error) {
    return null;
  }
}

function teamLeagueMapFromSnapshot(snapshot) {
  const map = {};
  for (const team of (snapshot && snapshot.teams) || []) {
    if (team && team.team) map[team.team] = team.league || null;
  }
  return map;
}

function trainingSeasonDirs({ base = ORE_DB_BASE, minSeason = MIN_TRAINING_SEASON } = {}) {
  return fs.readdirSync(base, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^season-\d+$/.test(entry.name))
    .map(entry => path.join(base, entry.name))
    .filter(dir => {
      const season = seasonNumberFromDir(dir);
      if (season < minSeason) return false;
      const metaPath = path.join(dir, 'meta.json');
      if (!fs.existsSync(metaPath)) return false;
      const meta = readJson(metaPath);
      return asNum(meta.summary_rows, 0) > 0;
    })
    .sort((a, b) => seasonNumberFromDir(a) - seasonNumberFromDir(b));
}

function latestSnapshotTrainingSource(dir) {
  const snapshotsDir = path.join(dir, 'snapshots');
  if (!fs.existsSync(snapshotsDir)) return null;
  const season = seasonNumberFromDir(dir);
  const candidates = fs.readdirSync(snapshotsDir)
    .filter(name => /^\d{4}-\d{2}-\d{2}_players\.json$/.test(name))
    .map(name => path.join(snapshotsDir, name))
    .sort((a, b) => path.basename(b).localeCompare(path.basename(a)));

  for (const filePath of candidates) {
    const payload = readJson(filePath);
    if (asNum(payload.summary_rows, 0) <= 0 || !Array.isArray(payload.players)) continue;
    return {
      season,
      seasonDir: dir,
      playersFile: filePath,
      day: asNum(payload.day),
      scrapedAt: payload.scraped_at || null,
      summaryRows: asNum(payload.summary_rows),
      playersWithSummary: asNum(payload.players_with_summary),
      players: payload.players
    };
  }
  return null;
}

function trainingSeasonSources({ base = ORE_DB_BASE, minSeason = MIN_TRAINING_SEASON, maxSeason = Number.POSITIVE_INFINITY } = {}) {
  return fs.readdirSync(base, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^season-\d+$/.test(entry.name))
    .map(entry => path.join(base, entry.name))
    .filter(dir => seasonNumberFromDir(dir) >= minSeason && seasonNumberFromDir(dir) <= maxSeason)
    .map(dir => {
      const season = seasonNumberFromDir(dir);
      const metaPath = path.join(dir, 'meta.json');
      const playersPath = path.join(dir, 'players.json');
      if (fs.existsSync(metaPath) && fs.existsSync(playersPath)) {
        const meta = readJson(metaPath);
        if (asNum(meta.summary_rows, 0) > 0) {
          return {
            season,
            seasonDir: dir,
            playersFile: playersPath,
            day: asNum(meta.day),
            scrapedAt: meta.scraped_at || null,
            summaryRows: asNum(meta.summary_rows),
            playersWithSummary: asNum(meta.players_with_summary),
            players: readJson(playersPath)
          };
        }
      }
      return latestSnapshotTrainingSource(dir);
    })
    .filter(Boolean)
    .sort((a, b) => a.season - b.season);
}

function batterSlotForPlayer(player) {
  return BATTER_SLOT_MAP[player.position_or_role] || player.slot || null;
}

function inferTrainingPitcherRole(player) {
  const role = PITCHER_ROLE_MAP[player.season_summary_role] || PITCHER_ROLE_MAP[player.position_or_role] || 'RP';
  if (role === 'RP' && asNum(player.season_summary && player.season_summary.saves) >= 5) return 'CP';
  return role;
}

function pitcherRoleForProjection(player, fallbackRole = null) {
  return PITCHER_ROLE_MAP[fallbackRole] || PITCHER_ROLE_MAP[player.season_summary_role] || PITCHER_ROLE_MAP[player.position_or_role] || 'RP';
}

function salaryNumber(player) {
  const salary = String((player && player.salary) || '').replace(/,/g, '');
  const match = salary.match(/(\d+)/);
  return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
}

function abilityNumber(player, key) {
  return asNum(player && player.abilities && player.abilities[key] && player.abilities[key].value);
}

function batterRookieScore(player) {
  return abilityNumber(player, 'power') +
    abilityNumber(player, 'contact') * 8 +
    abilityNumber(player, 'speed') * 6 +
    abilityNumber(player, 'arm') * 5 +
    abilityNumber(player, 'defense') * 5;
}

function pitcherRookieScore(player) {
  const abilities = player.abilities || {};
  return asNum(abilities.control && abilities.control.value) +
    asNum(abilities.stamina && abilities.stamina.value) +
    asNum(abilities.velocity) * 3;
}

function rookieSort(category) {
  const score = category === 'batter' ? batterRookieScore : pitcherRookieScore;
  return (left, right) =>
    score(left) - score(right) ||
    asNum(left.age, 99) - asNum(right.age, 99) ||
    salaryNumber(left) - salaryNumber(right) ||
    String(left.owner || '').localeCompare(String(right.owner || ''));
}

function isYoungOwnerRookie(player) {
  const age = asNum(player.age, 99);
  return !!player.owner && !player.is_computer && age > 0 && age <= 26;
}

function replacementBucket(player) {
  if (player.category === 'batter') return batterSlotForPlayer(player);
  if (player.category === 'pitcher') return pitcherRoleForProjection(player);
  return null;
}

function findRookieReference(retiredPlayer, players) {
  const category = retiredPlayer.category;
  const bucket = replacementBucket(retiredPlayer);
  const candidates = players.filter(player =>
    player.category === category &&
    isYoungOwnerRookie(player) &&
    asNum(player.age) < RETIREMENT_AGE_THRESHOLD
  );
  const sameBucket = candidates
    .filter(player => replacementBucket(player) === bucket)
    .sort(rookieSort(category));
  if (sameBucket.length) {
    return { player: sameBucket[0], scope: category === 'batter' ? 'same_slot' : 'same_role', roleFallback: null };
  }

  const anyCategory = candidates.sort(rookieSort(category));
  if (anyCategory.length) {
    return { player: anyCategory[0], scope: category === 'batter' ? 'all_young_batters' : 'all_young_pitchers', roleFallback: bucket };
  }

  return { player: null, scope: 'synthetic_minimum', roleFallback: bucket };
}

function zeroBatting() {
  return {
    batting_avg: '.000',
    at_bats: '0',
    hits: '0',
    home_runs: '0',
    rbi: '0',
    walk_hit_by_pitch: '0',
    sacrifice_bunts: '0',
    steals: '0',
    errors: '0'
  };
}

function zeroPitching() {
  return {
    era: '0.00',
    wins: '0',
    losses: '0',
    saves: '0',
    innings_pitched: '0',
    strikeouts: '0',
    walks: '0',
    home_runs_allowed: '0',
    k_per_9_like: '0.00'
  };
}

function syntheticReference(category, bucket) {
  if (category === 'batter') {
    return {
      category,
      name: 'replacement rookie reference',
      owner: 'replacement rookie',
      age: 22,
      handedness: 'R',
      style: '一般',
      position_or_role: bucket || 'DH',
      abilities: {
        power: { value: 183 },
        contact: { value: 5 },
        speed: { value: 5 },
        arm: { value: 6 },
        defense: { value: 5 }
      },
      skills: []
    };
  }

  return {
    category,
    name: 'replacement rookie reference',
    owner: 'replacement rookie',
    age: 22,
    handedness: 'L',
    style: '一般',
    position_or_role: bucket || 'RP',
    raw_position_or_role: bucket === 'CP' ? '救援' : bucket,
    abilities: {
      control: { value: 188 },
      stamina: { value: 191 },
      velocity: 145
    },
    skills: []
  };
}

function makeReplacementPlayer(retiredPlayer, referenceInfo, index) {
  const bucket = replacementBucket(retiredPlayer);
  const reference = referenceInfo.player || syntheticReference(retiredPlayer.category, bucket);
  const replacement = JSON.parse(JSON.stringify(reference));
  replacement.team = retiredPlayer.team;
  replacement.slot = retiredPlayer.slot;
  replacement.name = `Replacement rookie ${index}`;
  replacement.owner = 'replacement rookie';
  replacement.is_computer = false;
  replacement.age = asNum(reference.age, 22);
  replacement.contract = '1';
  replacement.cash = '0萬';
  replacement.salary = reference.salary || '2000萬/年';
  replacement.skills = dedupe(reference.skills || []);
  replacement.replacement_rookie = true;
  replacement.replacement_of = {
    team: retiredPlayer.team,
    category: retiredPlayer.category,
    name: retiredPlayer.name || '',
    owner: retiredPlayer.owner || null,
    age: asNum(retiredPlayer.age),
    position_or_role: retiredPlayer.position_or_role || null
  };
  replacement.rookie_reference = {
    team: reference.team || null,
    name: reference.name || '',
    owner: reference.owner || null,
    age: asNum(reference.age),
    position_or_role: replacementBucket(reference),
    scope: referenceInfo.scope,
    roleFallback: referenceInfo.roleFallback
  };

  if (retiredPlayer.category === 'batter') {
    replacement.category = 'batter';
    replacement.position_or_role = retiredPlayer.position_or_role;
    replacement.current_batting = zeroBatting();
    replacement.career_batting = zeroBatting();
    delete replacement.season_summary;
    return replacement;
  }

  replacement.category = 'pitcher';
  replacement.position_or_role = bucket;
  replacement.raw_position_or_role = retiredPlayer.raw_position_or_role || (bucket === 'CP' ? '救援' : retiredPlayer.position_or_role);
  replacement.current_pitching = zeroPitching();
  replacement.career_pitching = zeroPitching();
  delete replacement.season_summary;
  return replacement;
}

function applyRetirementReplacements(players) {
  const retiredPlayers = players.filter(player => asNum(player.age) >= RETIREMENT_AGE_THRESHOLD);
  const activePlayers = players.filter(player => asNum(player.age) < RETIREMENT_AGE_THRESHOLD);
  const replacementRookies = retiredPlayers.map((retiredPlayer, index) => {
    const referenceInfo = findRookieReference(retiredPlayer, activePlayers);
    return makeReplacementPlayer(retiredPlayer, referenceInfo, index + 1);
  });

  return {
    players: [...activePlayers, ...replacementRookies],
    retiredPlayers: retiredPlayers.map(player => ({
      team: player.team,
      category: player.category,
      name: player.name || '',
      owner: player.owner || null,
      age: asNum(player.age),
      position_or_role: player.position_or_role || null
    })),
    replacementRookies: replacementRookies.map(player => ({
      team: player.team,
      category: player.category,
      name: player.name,
      owner: player.owner,
      age: asNum(player.age),
      position_or_role: player.position_or_role,
      raw_position_or_role: player.raw_position_or_role || null,
      replacement_of: player.replacement_of,
      rookie_reference: player.rookie_reference
    }))
  };
}

function playerKey(player, slotOrRole) {
  if (player.owner) return `${player.category || 'unknown'}::${player.name || ''}::${player.owner}`;
  return `${player.category || 'unknown'}::${player.team || ''}::${player.name || ''}::${slotOrRole || ''}`;
}

function buildBatterTrainingRow(player, season) {
  if (player.category !== 'batter' || !player.season_summary) return null;
  const slot = batterSlotForPlayer(player);
  if (!slot) return null;

  const abilities = player.abilities || {};
  return {
    season,
    team: player.team,
    category: 'batter',
    name: player.name,
    owner: player.owner || null,
    age: asNum(player.age),
    slot,
    role: slot,
    playerKey: playerKey({ ...player, category: 'batter' }, slot),
    isComputer: !!player.is_computer,
    abilities: {
      power: asNum(abilities.power && abilities.power.value),
      contact: asNum(abilities.contact && abilities.contact.value),
      speed: asNum(abilities.speed && abilities.speed.value),
      arm: asNum(abilities.arm && abilities.arm.value),
      defense: asNum(abilities.defense && abilities.defense.value)
    },
    skills: dedupe(player.skills || []),
    targets: {
      batting_avg: parseAvg(player.season_summary.batting_avg),
      home_runs: asNum(player.season_summary.home_runs),
      rbi: asNum(player.season_summary.rbi),
      steals: asNum(player.season_summary.steals)
    }
  };
}

function buildPitcherTrainingRow(player, season) {
  if (player.category !== 'pitcher' || !player.season_summary) return null;
  const abilities = player.abilities || {};
  const currentPitching = player.current_pitching || {};
  const role = inferTrainingPitcherRole(player);

  return {
    season,
    team: player.team,
    category: 'pitcher',
    name: player.name,
    owner: player.owner || null,
    age: asNum(player.age),
    role,
    playerKey: playerKey({ ...player, category: 'pitcher' }, role),
    isComputer: !!player.is_computer,
    abilities: {
      control: asNum(abilities.control && abilities.control.value),
      stamina: asNum(abilities.stamina && abilities.stamina.value),
      velocity: asNum(abilities.velocity)
    },
    skills: projectionPitcherSkills(player.skills || [], role),
    targets: {
      era: asNum(player.season_summary.era),
      wins: asNum(player.season_summary.wins),
      losses: asNum(player.season_summary.losses),
      saves: asNum(player.season_summary.saves),
      strikeouts: asNum(player.season_summary.strikeouts),
      walks: asNum(currentPitching.walks),
      home_runs_allowed: asNum(currentPitching.home_runs_allowed)
    }
  };
}

function buildTrainingRows({ base = ORE_DB_BASE, minSeason = MIN_TRAINING_SEASON, maxSeason = Number.POSITIVE_INFINITY } = {}) {
  const sources = trainingSeasonSources({ base, minSeason, maxSeason });
  const trainingSeasons = [];
  const batters = [];
  const pitchers = [];

  for (const source of sources) {
    const season = source.season;
    const players = source.players;
    trainingSeasons.push({
      season,
      seasonDir: source.seasonDir,
      playersFile: source.playersFile,
      day: source.day,
      scrapedAt: source.scrapedAt,
      summaryRows: source.summaryRows,
      playersWithSummary: source.playersWithSummary
    });

    for (const player of players) {
      const batterRow = buildBatterTrainingRow(player, season);
      if (batterRow) batters.push(batterRow);
      const pitcherRow = buildPitcherTrainingRow(player, season);
      if (pitcherRow) pitchers.push(pitcherRow);
    }
  }

  return { trainingSeasons, batters, pitchers };
}

function collectSkills(rows) {
  return [...new Set(rows.flatMap(row => row.skills || []))].sort();
}

function featureValue(row, key) {
  if (key.startsWith('ability:')) {
    return asNum(row.abilities && row.abilities[key.slice('ability:'.length)]);
  }
  if (key.startsWith('slot:')) {
    return row.slot === key.slice('slot:'.length) ? 1 : 0;
  }
  if (key.startsWith('role:')) {
    return row.role === key.slice('role:'.length) ? 1 : 0;
  }
  if (key.startsWith('skill:')) {
    return (row.skills || []).includes(key.slice('skill:'.length)) ? 1 : 0;
  }
  if (key.startsWith('interaction:')) {
    const [, skill, abilityName] = key.split(':');
    const hasSkill = (row.skills || []).includes(skill) ? 1 : 0;
    return hasSkill * asNum(row.abilities && row.abilities[abilityName]);
  }
  return 0;
}

function featureDefinition(category, rows) {
  const skills = collectSkills(rows);
  const featureKeys = [];
  const numericKeys = category === 'batter'
    ? ['ability:power', 'ability:contact', 'ability:speed', 'ability:arm', 'ability:defense']
    : ['ability:control', 'ability:stamina', 'ability:velocity'];
  featureKeys.push(...numericKeys);

  if (category === 'batter') {
    const slots = [...new Set(rows.map(row => row.slot).filter(Boolean))].sort();
    featureKeys.push(...slots.map(slot => `slot:${slot}`));
    featureKeys.push(...skills.map(skill => `skill:${skill}`));
    for (const skill of skills) {
      for (const ability of BATTER_INTERACTION_ABILITIES) {
        featureKeys.push(`interaction:${skill}:${ability}`);
      }
    }
  } else {
    const roles = [...new Set(rows.map(row => row.role).filter(Boolean))].sort();
    featureKeys.push(...roles.map(role => `role:${role}`));
    featureKeys.push(...skills.map(skill => `skill:${skill}`));
    for (const skill of skills) {
      for (const ability of PITCHER_INTERACTION_ABILITIES) {
        featureKeys.push(`interaction:${skill}:${ability}`);
      }
    }
  }

  const standardizer = {};
  for (const key of featureKeys) {
    const values = rows.map(row => featureValue(row, key));
    const mean = values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
    const variance = values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / Math.max(values.length, 1);
    standardizer[key] = {
      mean,
      std: Math.sqrt(variance) || 1
    };
  }

  return { featureKeys, skills, standardizer };
}

function vectorize(row, featureKeys, standardizer) {
  return featureKeys.map(key => {
    const stats = standardizer[key] || { mean: 0, std: 1 };
    return (featureValue(row, key) - stats.mean) / stats.std;
  });
}

function euclideanDistance(left, right) {
  let sum = 0;
  for (let i = 0; i < left.length; i++) {
    const delta = left[i] - right[i];
    sum += delta * delta;
  }
  return Math.sqrt(sum);
}

function averageTargets(rows, targetKeys) {
  if (!rows.length) {
    return Object.fromEntries(targetKeys.map(key => [key, 0]));
  }
  return Object.fromEntries(targetKeys.map(key => [
    key,
    rows.reduce((sum, row) => sum + asNum(row.targets && row.targets[key]), 0) / rows.length
  ]));
}

function hasMajorHrSkill(skills) {
  return (skills || []).some(skill => MAJOR_HR_SKILLS.has(skill));
}

function batterHrSkillBasis(skills) {
  const weightedSkills = [];
  let score = 0;
  for (const skill of dedupe(skills || [])) {
    const weight = HR_SKILL_WEIGHTS[skill] || 0;
    if (weight === 0) continue;
    score += weight;
    weightedSkills.push({ skill, weight });
  }

  return {
    score,
    majorSkills: weightedSkills.filter(item => MAJOR_HR_SKILLS.has(item.skill)).map(item => item.skill),
    positiveSkills: weightedSkills.filter(item => item.weight > 0).map(item => item.skill),
    negativeSkills: weightedSkills.filter(item => item.weight < 0).map(item => item.skill),
    weightedSkills
  };
}

function batterSbSkillBasis(skills) {
  const weightedSkills = [];
  let score = 0;
  for (const skill of dedupe(skills || [])) {
    const weight = SB_SKILL_WEIGHTS[skill] || 0;
    if (weight === 0) continue;
    score += weight;
    weightedSkills.push({ skill, weight });
  }

  return {
    score,
    positiveSkills: weightedSkills.filter(item => item.weight > 0).map(item => item.skill),
    negativeSkills: weightedSkills.filter(item => item.weight < 0).map(item => item.skill),
    weightedSkills
  };
}

function averageHomeRuns(rows, filterFn, fallback = 0) {
  const subset = rows.filter(filterFn);
  if (!subset.length) return fallback;
  return subset.reduce((sum, row) => sum + asNum(row.targets && row.targets.home_runs), 0) / subset.length;
}

function buildHrCalibration(rows) {
  const samples = rows.filter(row => row && row.targets && Number.isFinite(asNum(row.abilities && row.abilities.power)));
  const fallback = {
    sampleCount: samples.length,
    baselineHr: averageHomeRuns(samples, () => true, 0),
    meanPower: 200,
    powerSlope: 0.12,
    skillPointValue: 0.18,
    noMajorSkillHr: 0,
    majorSkillHr: 0,
    highPowerHr: 0,
    highPowerMajorHr: 0,
    lowPowerNoMajorHr: 0
  };
  if (!samples.length) return fallback;

  const baselineHr = averageHomeRuns(samples, () => true, 0);
  const meanPower = samples.reduce((sum, row) => sum + asNum(row.abilities && row.abilities.power), 0) / samples.length;
  const meanHr = baselineHr;
  const variance = samples.reduce((sum, row) => {
    const delta = asNum(row.abilities && row.abilities.power) - meanPower;
    return sum + delta * delta;
  }, 0) / samples.length;
  const covariance = samples.reduce((sum, row) => {
    const powerDelta = asNum(row.abilities && row.abilities.power) - meanPower;
    const hrDelta = asNum(row.targets && row.targets.home_runs) - meanHr;
    return sum + powerDelta * hrDelta;
  }, 0) / samples.length;
  const powerSlope = variance > 0 ? clamp(covariance / variance, 0.05, 0.22) : fallback.powerSlope;
  const noMajorSkillHr = averageHomeRuns(samples, row => !hasMajorHrSkill(row.skills), baselineHr);
  const majorSkillHr = averageHomeRuns(samples, row => hasMajorHrSkill(row.skills), baselineHr);
  const highPowerHr = averageHomeRuns(samples, row => asNum(row.abilities && row.abilities.power) >= 230, baselineHr);
  const highPowerMajorHr = averageHomeRuns(
    samples,
    row => asNum(row.abilities && row.abilities.power) >= 230 && hasMajorHrSkill(row.skills),
    majorSkillHr
  );
  const lowPowerNoMajorHr = averageHomeRuns(
    samples,
    row => asNum(row.abilities && row.abilities.power) < 160 && !hasMajorHrSkill(row.skills),
    Math.min(noMajorSkillHr, baselineHr)
  );

  return {
    sampleCount: samples.length,
    baselineHr,
    meanPower,
    powerSlope,
    skillPointValue: clamp((majorSkillHr - noMajorSkillHr) / 80, 0.08, 0.28),
    noMajorSkillHr,
    majorSkillHr,
    highPowerHr,
    highPowerMajorHr,
    lowPowerNoMajorHr
  };
}

function calibrateBatterHomeRuns(candidate, rawTargets, calibration) {
  const power = asNum(candidate.abilities && candidate.abilities.power);
  const rawKnnHr = asNum(rawTargets && rawTargets.home_runs);
  const hrSkill = batterHrSkillBasis(candidate.skills);
  const powerContribution = (power - calibration.meanPower) * calibration.powerSlope;
  const skillContribution = hrSkill.score * calibration.skillPointValue;
  const profileHr = calibration.baselineHr + powerContribution + skillContribution;

  let cap = 80;
  let capReason = null;
  if (power < 160 && hrSkill.majorSkills.length === 0) {
    cap = Math.max(4, calibration.lowPowerNoMajorHr + 4);
    capReason = 'low_power_no_major_hr_skill';
  } else if (power < 190 && hrSkill.majorSkills.length === 0) {
    cap = Math.max(12, calibration.noMajorSkillHr + 4);
    capReason = 'medium_low_power_no_major_hr_skill';
  }

  let floor = 0;
  let floorReason = null;
  if (power >= 230 && hrSkill.majorSkills.length > 0) {
    floor = Math.max(22, calibration.highPowerMajorHr * 0.82);
    floorReason = 'high_power_major_hr_skill';
  } else if (power >= 220 && hrSkill.majorSkills.length > 0) {
    floor = Math.max(18, calibration.majorSkillHr * 0.72);
    floorReason = 'major_hr_skill';
  } else if (power >= 245) {
    floor = Math.max(16, calibration.highPowerHr * 0.75);
    floorReason = 'elite_power';
  }

  const blendedHr = rawKnnHr * 0.35 + profileHr * 0.65;
  const boundedHr = clamp(Math.max(blendedHr, floor), 0, cap);
  const finalProjectedHr = Math.round(clamp(boundedHr, 0, 80));

  return {
    baseKnnHr: roundTo(rawKnnHr, 2),
    profileHr: roundTo(profileHr, 2),
    blendedHr: roundTo(blendedHr, 2),
    finalProjectedHr,
    powerBasis: {
      power,
      meanPower: roundTo(calibration.meanPower, 2),
      slope: roundTo(calibration.powerSlope, 4),
      contribution: roundTo(powerContribution, 2)
    },
    skillBasis: {
      ...hrSkill,
      pointValue: roundTo(calibration.skillPointValue, 4),
      contribution: roundTo(skillContribution, 2)
    },
    bounds: {
      floor: roundTo(floor, 2),
      floorReason,
      cap: roundTo(cap, 2),
      capReason
    }
  };
}

function calibrateBatterSteals(candidate, rawTargets) {
  const speed = asNum(candidate.abilities && candidate.abilities.speed);
  const rawKnnSteals = asNum(rawTargets && rawTargets.steals);
  const sbSkill = batterSbSkillBasis(candidate.skills);
  const speedContribution = clamp((speed - 7) * 0.6, -4, 6);
  const skillContribution = clamp(sbSkill.score * 0.15, -8, 12);
  const rawAdjustedSteals = rawKnnSteals + speedContribution + skillContribution;
  const hasLeadoffSkill = sbSkill.positiveSkills.includes('\u958b\u8def\u5148\u92d2');
  const hasStealPenalty = sbSkill.negativeSkills.includes('\u76dc\u58d8\uff38');
  let profileFloor = 0;
  let profileFloorReason = null;
  if (hasLeadoffSkill && !hasStealPenalty && speed >= 12) {
    profileFloor = 17;
    profileFloorReason = 'speed_12_leadoff_profile';
  } else if (hasLeadoffSkill && !hasStealPenalty && speed >= 11) {
    profileFloor = 14;
    profileFloorReason = 'speed_11_leadoff_profile';
  }
  const adjustedSteals = Math.max(rawAdjustedSteals, profileFloor);
  const finalProjectedSteals = Math.round(clamp(adjustedSteals, 0, 120));

  return {
    baseKnnSteals: roundTo(rawKnnSteals, 2),
    rawAdjustedSteals: roundTo(rawAdjustedSteals, 2),
    adjustedSteals: roundTo(adjustedSteals, 2),
    finalProjectedSteals,
    speedBasis: {
      speed,
      baselineSpeed: 7,
      pointValue: 0.6,
      contribution: roundTo(speedContribution, 2)
    },
    skillBasis: {
      ...sbSkill,
      pointValue: 0.15,
      contribution: roundTo(skillContribution, 2)
    },
    bounds: {
      profileFloor,
      profileFloorReason
    }
  };
}

function buildModel({ base = ORE_DB_BASE, minSeason = MIN_TRAINING_SEASON, maxSeason = Number.POSITIVE_INFINITY } = {}) {
  const { trainingSeasons, batters, pitchers } = buildTrainingRows({ base, minSeason, maxSeason });
  const batterFeatures = featureDefinition('batter', batters);
  const pitcherFeatures = featureDefinition('pitcher', pitchers);
  const batterRows = batters.map(row => ({
    ...row,
    vector: vectorize(row, batterFeatures.featureKeys, batterFeatures.standardizer)
  }));
  const pitcherRows = pitchers.map(row => ({
    ...row,
    vector: vectorize(row, pitcherFeatures.featureKeys, pitcherFeatures.standardizer)
  }));

  return {
    modelVersion: MODEL_VERSION,
    minSeason,
    maxSeason,
    confidence: 'bootstrap / sparse-data',
    trainingSeasons,
    batter: {
      rows: batterRows,
      featureKeys: batterFeatures.featureKeys,
      skills: batterFeatures.skills,
      standardizer: batterFeatures.standardizer,
      targetAverages: averageTargets(batterRows, BATTER_TARGET_KEYS),
      hrCalibration: buildHrCalibration(batterRows)
    },
    pitcher: {
      rows: pitcherRows,
      featureKeys: pitcherFeatures.featureKeys,
      skills: pitcherFeatures.skills,
      standardizer: pitcherFeatures.standardizer,
      targetAverages: averageTargets(pitcherRows, PITCHER_TARGET_KEYS)
    }
  };
}

function normalizeBatterProjection(targets) {
  return {
    batting_avg: roundTo(clamp(asNum(targets.batting_avg), 0.150, 0.400), 3),
    home_runs: Math.round(clamp(asNum(targets.home_runs), 0, 80)),
    rbi: Math.round(clamp(asNum(targets.rbi), 0, 180)),
    steals: Math.round(clamp(asNum(targets.steals), 0, 120))
  };
}

function normalizePitcherProjection(targets) {
  return {
    era: roundTo(clamp(asNum(targets.era), 0.50, 12.00), 2),
    wins: Math.round(clamp(asNum(targets.wins), 0, 30)),
    losses: Math.round(clamp(asNum(targets.losses), 0, 30)),
    saves: Math.round(clamp(asNum(targets.saves), 0, 60)),
    strikeouts: Math.round(clamp(asNum(targets.strikeouts), 0, 300)),
    walks: Math.round(clamp(asNum(targets.walks), 0, 220)),
    home_runs_allowed: Math.round(clamp(asNum(targets.home_runs_allowed), 0, 80))
  };
}

function environmentBatterProfile(player) {
  const candidate = batterCandidateFromPlayer(player);
  const power = asNum(candidate.abilities.power);
  const contact = asNum(candidate.abilities.contact);
  const speed = asNum(candidate.abilities.speed);
  const hrSkill = batterHrSkillBasis(candidate.skills);
  const sbSkill = batterSbSkillBasis(candidate.skills);
  return {
    runScore: power * 0.9 +
      contact * 10 +
      speed * 6 +
      clamp(asNum(hrSkill.score), -20, 60) * 0.8 +
      clamp(asNum(sbSkill.score), -25, 50) * 0.4,
    contact,
    power
  };
}

function environmentPitcherProfile(player) {
  const role = pitcherRoleForProjection(player);
  const candidate = pitcherCandidateFromPlayer(player, role);
  const control = asNum(candidate.abilities.control);
  const stamina = asNum(candidate.abilities.stamina);
  const velocity = asNum(candidate.abilities.velocity);
  const roleFactor = candidate.role === 'CP' ? 1.05 : (candidate.role === 'SP' ? 1 : 0.95);
  const skillDensity = dedupe(candidate.skills || []).length;
  return {
    difficultyScore: (control * 0.95 + stamina * 0.45 + velocity * 12 + skillDensity * 2) * roleFactor,
    control,
    velocity
  };
}

function averageProfile(profiles, key) {
  return averageNumbers(profiles.map(profile => asNum(profile && profile[key], Number.NaN)));
}

function buildSameLeaguePlayerEnvironments(players, teamLeagueMap = {}) {
  const teams = dedupe((players || []).map(player => player.team));
  const teamProfiles = new Map();

  for (const team of teams) {
    const teamPlayers = players.filter(player => player.team === team);
    const batterProfiles = teamPlayers
      .filter(player => player.category === 'batter')
      .map(environmentBatterProfile);
    const pitcherProfiles = teamPlayers
      .filter(player => player.category === 'pitcher')
      .map(environmentPitcherProfile);

    teamProfiles.set(team, {
      team,
      league: teamLeagueMap[team] || null,
      batterRunScore: averageProfile(batterProfiles, 'runScore'),
      batterContact: averageProfile(batterProfiles, 'contact'),
      batterPower: averageProfile(batterProfiles, 'power'),
      pitcherDifficultyScore: averageProfile(pitcherProfiles, 'difficultyScore'),
      pitcherControl: averageProfile(pitcherProfiles, 'control'),
      pitcherVelocity: averageProfile(pitcherProfiles, 'velocity')
    });
  }

  const profiles = [...teamProfiles.values()];
  const global = {
    batterRunScore: averageProfile(profiles, 'batterRunScore'),
    batterContact: averageProfile(profiles, 'batterContact'),
    batterPower: averageProfile(profiles, 'batterPower'),
    pitcherDifficultyScore: averageProfile(profiles, 'pitcherDifficultyScore'),
    pitcherControl: averageProfile(profiles, 'pitcherControl'),
    pitcherVelocity: averageProfile(profiles, 'pitcherVelocity')
  };

  const byTeam = {};
  for (const team of teams) {
    const profile = teamProfiles.get(team);
    const leagueTeams = profiles.filter(candidate => {
      if (!profile.league) return true;
      return candidate.league === profile.league;
    });
    const opponents = leagueTeams.filter(candidate => candidate.team !== team);
    const opponentTeams = opponents.map(candidate => candidate.team);
    const opponentBatterRunScore = averageProfile(opponents, 'batterRunScore');
    const opponentBatterContact = averageProfile(opponents, 'batterContact');
    const opponentBatterPower = averageProfile(opponents, 'batterPower');
    const opponentPitcherDifficultyScore = averageProfile(opponents, 'pitcherDifficultyScore');
    const opponentPitcherControl = averageProfile(opponents, 'pitcherControl');
    const opponentPitcherVelocity = averageProfile(opponents, 'pitcherVelocity');
    const pitcherDifficultyEdge = opponentPitcherDifficultyScore - global.pitcherDifficultyScore;
    const batterRunEdge = opponentBatterRunScore - global.batterRunScore;
    const batterContactEdge = opponentBatterContact - global.batterContact;
    const batterPowerEdge = opponentBatterPower - global.batterPower;
    const batterOffenseFactor = clamp(1 - pitcherDifficultyEdge * BATTER_OPPONENT_PITCHER_ENV_WEIGHT, 0.92, 1.08);
    const batterAvgFactor = clamp(1 - pitcherDifficultyEdge * BATTER_OPPONENT_PITCHER_ENV_WEIGHT * 0.38, 0.96, 1.04);
    const pitcherRunFactor = clamp(1 + batterRunEdge * PITCHER_OPPONENT_BATTER_ENV_WEIGHT, 0.90, 1.10);
    const pitcherStrikeoutFactor = clamp(1 - batterContactEdge * 0.035, 0.90, 1.10);
    const pitcherHomeRunFactor = clamp(1 + batterPowerEdge * 0.0012, 0.90, 1.10);

    byTeam[team] = {
      enabled: opponents.length > 0,
      league: profile.league || null,
      opponentTeams,
      teamProfile: {
        batterRunScore: roundTo(profile.batterRunScore, 2),
        batterContact: roundTo(profile.batterContact, 2),
        batterPower: roundTo(profile.batterPower, 2),
        pitcherDifficultyScore: roundTo(profile.pitcherDifficultyScore, 2),
        pitcherControl: roundTo(profile.pitcherControl, 2),
        pitcherVelocity: roundTo(profile.pitcherVelocity, 2)
      },
      batterEnvironment: {
        target: 'batter_vs_same_league_opposing_pitchers',
        opponentPitcherDifficultyScore: roundTo(opponentPitcherDifficultyScore, 2),
        opponentPitcherControl: roundTo(opponentPitcherControl, 2),
        opponentPitcherVelocity: roundTo(opponentPitcherVelocity, 2),
        globalPitcherDifficultyScore: roundTo(global.pitcherDifficultyScore, 2),
        pitcherDifficultyEdge: roundTo(pitcherDifficultyEdge, 2),
        offenseFactor: roundTo(batterOffenseFactor, 4),
        avgFactor: roundTo(batterAvgFactor, 4),
        weight: BATTER_OPPONENT_PITCHER_ENV_WEIGHT
      },
      pitcherEnvironment: {
        target: 'pitcher_vs_same_league_opposing_batters',
        opponentBatterRunScore: roundTo(opponentBatterRunScore, 2),
        opponentBatterContact: roundTo(opponentBatterContact, 2),
        opponentBatterPower: roundTo(opponentBatterPower, 2),
        globalBatterRunScore: roundTo(global.batterRunScore, 2),
        globalBatterContact: roundTo(global.batterContact, 2),
        globalBatterPower: roundTo(global.batterPower, 2),
        batterRunEdge: roundTo(batterRunEdge, 2),
        batterContactEdge: roundTo(batterContactEdge, 2),
        batterPowerEdge: roundTo(batterPowerEdge, 2),
        runFactor: roundTo(pitcherRunFactor, 4),
        strikeoutFactor: roundTo(pitcherStrikeoutFactor, 4),
        homeRunFactor: roundTo(pitcherHomeRunFactor, 4),
        weight: PITCHER_OPPONENT_BATTER_ENV_WEIGHT
      }
    };
  }

  return {
    global: Object.fromEntries(Object.entries(global).map(([key, value]) => [key, roundTo(value, 2)])),
    byTeam
  };
}

function starterCapacityProfile(player) {
  const candidate = pitcherCandidateFromPlayer(player, 'SP');
  const control = asNum(candidate.abilities.control);
  const stamina = asNum(candidate.abilities.stamina);
  const velocity = asNum(candidate.abilities.velocity);
  const skills = dedupe(candidate.skills || []);
  const negativeSkillCount = skills.filter(skill => ['一發病', '不安定感', '危機Ｘ'].includes(skill)).length;
  const positiveSkillCount = skills.filter(skill => ['安定感', '威壓感', '逃球', '重球'].includes(skill)).length;
  return {
    stamina,
    capacityScore: stamina * 0.65 + control * 0.25 + velocity * 0.75 + positiveSkillCount * 3 - negativeSkillCount * 4
  };
}

function buildPitcherRoleUsageEnvironments(players) {
  const teams = dedupe((players || []).map(player => player.team));
  const teamProfiles = new Map();

  for (const team of teams) {
    const teamPitchers = players.filter(player => player.team === team && player.category === 'pitcher');
    const starterProfiles = teamPitchers
      .filter(player => pitcherRoleForProjection(player) === 'SP')
      .map(starterCapacityProfile);
    const reliefCount = teamPitchers.filter(player => pitcherRoleForProjection(player) === 'RP').length;
    const closerCount = teamPitchers.filter(player => pitcherRoleForProjection(player) === 'CP').length;
    teamProfiles.set(team, {
      team,
      starterCount: starterProfiles.length,
      reliefCount,
      closerCount,
      starterStaminaScore: averageProfile(starterProfiles, 'stamina'),
      starterCapacityScore: averageProfile(starterProfiles, 'capacityScore')
    });
  }

  const profiles = [...teamProfiles.values()].filter(profile => profile.starterCount > 0);
  const global = {
    starterStaminaScore: averageProfile(profiles, 'starterStaminaScore'),
    starterCapacityScore: averageProfile(profiles, 'starterCapacityScore')
  };

  const byTeam = {};
  for (const team of teams) {
    const profile = teamProfiles.get(team);
    const starterStaminaDeficit = global.starterStaminaScore - profile.starterStaminaScore;
    const starterCapacityDeficit = global.starterCapacityScore - profile.starterCapacityScore;
    const rpWorkloadFactor = profile.starterCount > 0
      ? clamp(
        1 +
          starterStaminaDeficit * RP_WORKLOAD_STARTER_STAMINA_DEFICIT_WEIGHT +
          starterCapacityDeficit * RP_WORKLOAD_STARTER_CAPACITY_DEFICIT_WEIGHT,
        0.85,
        1.22
      )
      : 1;
    const rpRunStressFactor = clamp(
      1 + Math.max(0, rpWorkloadFactor - 1) * 0.22 - Math.max(0, 1 - rpWorkloadFactor) * 0.08,
      0.97,
      1.05
    );
    byTeam[team] = {
      enabled: profile.starterCount > 0,
      team,
      starterWorkloadSource: 'same_team_sp_stamina_and_capacity',
      starterCount: profile.starterCount,
      reliefCount: profile.reliefCount,
      closerCount: profile.closerCount,
      starterStaminaScore: roundTo(profile.starterStaminaScore, 2),
      globalStarterStaminaScore: roundTo(global.starterStaminaScore, 2),
      starterStaminaDeficit: roundTo(starterStaminaDeficit, 2),
      starterCapacityScore: roundTo(profile.starterCapacityScore, 2),
      globalStarterCapacityScore: roundTo(global.starterCapacityScore, 2),
      starterCapacityDeficit: roundTo(starterCapacityDeficit, 2),
      rpWorkloadFactor: roundTo(rpWorkloadFactor, 4),
      rpRunStressFactor: roundTo(rpRunStressFactor, 4),
      appliesToRoles: ['RP'],
      excludesRoles: ['SP', 'CP']
    };
  }

  return {
    global: Object.fromEntries(Object.entries(global).map(([key, value]) => [key, roundTo(value, 2)])),
    byTeam
  };
}

function applyBatterSameLeagueEnvironment(projectedStats, sameLeagueEnvironment) {
  if (!sameLeagueEnvironment || !sameLeagueEnvironment.enabled) {
    return { projectedStats, meta: { enabled: false } };
  }
  const environment = sameLeagueEnvironment.batterEnvironment || {};
  const offenseFactor = asNum(environment.offenseFactor, 1);
  const avgFactor = asNum(environment.avgFactor, 1);
  return {
    projectedStats: normalizeBatterProjection({
      batting_avg: asNum(projectedStats.batting_avg) * avgFactor,
      home_runs: asNum(projectedStats.home_runs) * offenseFactor,
      rbi: asNum(projectedStats.rbi) * offenseFactor,
      steals: asNum(projectedStats.steals) * offenseFactor
    }),
    meta: {
      enabled: true,
      league: sameLeagueEnvironment.league || null,
      opponentTeams: sameLeagueEnvironment.opponentTeams || [],
      ...environment
    }
  };
}

function applyPitcherRoleUsageModel(projectedStats, candidate, roleUsageEnvironment) {
  if (!roleUsageEnvironment || !roleUsageEnvironment.enabled) {
    return { projectedStats, meta: { enabled: false } };
  }
  if (candidate.role === 'SP') {
    return {
      projectedStats,
      meta: {
        enabled: false,
        reason: 'starter_model_uses_own_stamina_not_rp_workload',
        team: roleUsageEnvironment.team || null
      }
    };
  }
  if (candidate.role === 'CP') {
    return {
      projectedStats,
      meta: {
        enabled: false,
        reason: 'closer_usage_is_save_opportunity_not_rp_workload',
        team: roleUsageEnvironment.team || null
      }
    };
  }
  if (candidate.role !== 'RP') {
    return {
      projectedStats,
      meta: {
        enabled: false,
        reason: 'role_not_relief_pitcher',
        team: roleUsageEnvironment.team || null,
        role: candidate.role
      }
    };
  }

  const workloadFactor = asNum(roleUsageEnvironment.rpWorkloadFactor, 1);
  const stamina = asNum(candidate.abilities && candidate.abilities.stamina);
  const durabilityFactor = clamp(0.90 + (stamina / 250) * 0.18, 0.90, 1.08);
  const effectiveWorkloadFactor = clamp(1 + (workloadFactor - 1) * durabilityFactor, 0.86, 1.24);
  const decisionFactor = clamp(1 + (effectiveWorkloadFactor - 1) * 0.70, 0.90, 1.17);
  const runStressFactor = asNum(roleUsageEnvironment.rpRunStressFactor, 1);

  return {
    projectedStats: normalizePitcherProjection({
      era: asNum(projectedStats.era) * runStressFactor,
      wins: asNum(projectedStats.wins) * decisionFactor,
      losses: asNum(projectedStats.losses) * decisionFactor,
      saves: asNum(projectedStats.saves),
      strikeouts: asNum(projectedStats.strikeouts) * effectiveWorkloadFactor,
      walks: asNum(projectedStats.walks) * effectiveWorkloadFactor * runStressFactor,
      home_runs_allowed: asNum(projectedStats.home_runs_allowed) * effectiveWorkloadFactor * runStressFactor
    }),
    meta: {
      enabled: true,
      role: candidate.role,
      team: roleUsageEnvironment.team || null,
      starterWorkloadSource: roleUsageEnvironment.starterWorkloadSource || 'same_team_sp_stamina_and_capacity',
      starterCount: roleUsageEnvironment.starterCount,
      reliefCount: roleUsageEnvironment.reliefCount,
      closerCount: roleUsageEnvironment.closerCount,
      starterStaminaScore: roleUsageEnvironment.starterStaminaScore,
      globalStarterStaminaScore: roleUsageEnvironment.globalStarterStaminaScore,
      starterStaminaDeficit: roleUsageEnvironment.starterStaminaDeficit,
      starterCapacityScore: roleUsageEnvironment.starterCapacityScore,
      globalStarterCapacityScore: roleUsageEnvironment.globalStarterCapacityScore,
      starterCapacityDeficit: roleUsageEnvironment.starterCapacityDeficit,
      rpWorkloadFactor: roundTo(workloadFactor, 4),
      rpDurabilityFactor: roundTo(durabilityFactor, 4),
      effectiveWorkloadFactor: roundTo(effectiveWorkloadFactor, 4),
      decisionFactor: roundTo(decisionFactor, 4),
      rpRunStressFactor: roundTo(runStressFactor, 4),
      adjustedStats: ['strikeouts', 'wins', 'losses', 'walks', 'home_runs_allowed', 'era'],
      unchangedStats: ['saves']
    }
  };
}

function applyPitcherSameLeagueEnvironment(projectedStats, sameLeagueEnvironment) {
  if (!sameLeagueEnvironment || !sameLeagueEnvironment.enabled) {
    return { projectedStats, meta: { enabled: false } };
  }
  const environment = sameLeagueEnvironment.pitcherEnvironment || {};
  const runFactor = asNum(environment.runFactor, 1);
  const strikeoutFactor = asNum(environment.strikeoutFactor, 1);
  const homeRunFactor = asNum(environment.homeRunFactor, 1);
  return {
    projectedStats: normalizePitcherProjection({
      era: asNum(projectedStats.era) * runFactor,
      wins: asNum(projectedStats.wins),
      losses: asNum(projectedStats.losses) * runFactor,
      saves: asNum(projectedStats.saves),
      strikeouts: asNum(projectedStats.strikeouts) * strikeoutFactor,
      walks: asNum(projectedStats.walks) * runFactor,
      home_runs_allowed: asNum(projectedStats.home_runs_allowed) * homeRunFactor
    }),
    meta: {
      enabled: true,
      league: sameLeagueEnvironment.league || null,
      opponentTeams: sameLeagueEnvironment.opponentTeams || [],
      ...environment
    }
  };
}

function excludeSamePlayer(candidate, row) {
  if (!candidate.playerKey) return false;
  return candidate.playerKey === row.playerKey;
}

function pickNeighborPool(categoryModel, candidate, sameBucketValue) {
  const rows = categoryModel.rows;
  let sameBucketRows;
  if (candidate.category === 'batter') {
    sameBucketRows = rows.filter(row => row.slot === sameBucketValue);
    if (sameBucketRows.length >= MIN_POSITION_NEIGHBORS) return { rows: sameBucketRows, scope: 'same_slot' };
  } else {
    sameBucketRows = rows.filter(row => row.role === sameBucketValue);
    if (sameBucketRows.length >= MIN_ROLE_NEIGHBORS) return { rows: sameBucketRows, scope: 'same_role' };
  }
  return { rows, scope: candidate.category === 'batter' ? 'all_batters' : 'all_pitchers' };
}

function weightedProjection(candidate, categoryModel, targetKeys, bucketValue, normalizer) {
  const { rows: pool, scope } = pickNeighborPool(categoryModel, candidate, bucketValue);
  const candidateVector = vectorize(candidate, categoryModel.featureKeys, categoryModel.standardizer);
  const usableRows = pool.filter(row => !excludeSamePlayer(candidate, row));
  const neighbors = usableRows
    .map(row => ({
      row,
      distance: euclideanDistance(candidateVector, row.vector)
    }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, Math.min(K_NEIGHBORS, usableRows.length));

  const fallbackTargets = categoryModel.targetAverages;
  if (!neighbors.length) {
    return {
      projectedStats: normalizer(fallbackTargets),
      rawProjectedTargets: { ...fallbackTargets },
      meta: {
        scope,
        fallback: 'target_average',
        neighbors: [],
        neighborCount: 0
      }
    };
  }

  const rawTargets = Object.fromEntries(targetKeys.map(key => [key, 0]));
  let totalWeight = 0;
  for (const neighbor of neighbors) {
    const weight = 1 / Math.max(neighbor.distance, 0.35);
    totalWeight += weight;
    for (const key of targetKeys) {
      rawTargets[key] += asNum(neighbor.row.targets && neighbor.row.targets[key]) * weight;
    }
  }

  if (totalWeight <= 0) {
    return {
      projectedStats: normalizer(fallbackTargets),
      rawProjectedTargets: { ...fallbackTargets },
      meta: {
        scope,
        fallback: 'target_average',
        neighbors: [],
        neighborCount: 0
      }
    };
  }

  const projected = {};
  for (const key of targetKeys) projected[key] = rawTargets[key] / totalWeight;

  return {
    projectedStats: normalizer(projected),
    rawProjectedTargets: projected,
    meta: {
      scope,
      fallback: null,
      neighborCount: neighbors.length,
      averageDistance: roundTo(neighbors.reduce((sum, neighbor) => sum + neighbor.distance, 0) / neighbors.length, 3),
      neighbors: neighbors.slice(0, 5).map(neighbor => ({
        season: neighbor.row.season,
        team: neighbor.row.team,
        name: neighbor.row.name,
        owner: neighbor.row.owner,
        distance: roundTo(neighbor.distance, 3)
      }))
    }
  };
}

function batterCandidateFromPlayer(player, slot = null) {
  const abilities = player.abilities || {};
  const resolvedSlot = slot || batterSlotForPlayer(player) || 'DH';
  return {
    category: 'batter',
    team: player.team,
    name: player.name,
    owner: player.owner || null,
    age: asNum(player.age),
    slot: resolvedSlot,
    role: resolvedSlot,
    playerKey: playerKey({ ...player, category: 'batter' }, resolvedSlot),
    abilities: {
      power: asNum(abilities.power && abilities.power.value),
      contact: asNum(abilities.contact && abilities.contact.value),
      speed: asNum(abilities.speed && abilities.speed.value),
      arm: asNum(abilities.arm && abilities.arm.value),
      defense: asNum(abilities.defense && abilities.defense.value)
    },
    skills: dedupe(player.skills || [])
  };
}

function pitcherCandidateFromPlayer(player, role = null) {
  const abilities = player.abilities || {};
  const resolvedRole = pitcherRoleForProjection(player, role);
  return {
    category: 'pitcher',
    team: player.team,
    name: player.name,
    owner: player.owner || null,
    age: asNum(player.age),
    role: resolvedRole,
    playerKey: playerKey({ ...player, category: 'pitcher' }, resolvedRole),
    abilities: {
      control: asNum(abilities.control && abilities.control.value),
      stamina: asNum(abilities.stamina && abilities.stamina.value),
      velocity: asNum(abilities.velocity)
    },
    skills: projectionPitcherSkills(player.skills || [], resolvedRole)
  };
}

function projectBatter(player, model, { slot = null, sameLeagueEnvironment = null } = {}) {
  const candidate = batterCandidateFromPlayer(player, slot);
  const result = weightedProjection(candidate, model.batter, BATTER_TARGET_KEYS, candidate.slot, normalizeBatterProjection);
  const hrProjection = calibrateBatterHomeRuns(candidate, result.rawProjectedTargets, model.batter.hrCalibration);
  const sbProjection = calibrateBatterSteals(candidate, result.rawProjectedTargets);
  const baseProjectedStats = {
    ...result.projectedStats,
    home_runs: hrProjection.finalProjectedHr,
    steals: sbProjection.finalProjectedSteals
  };
  const environmentAdjustment = applyBatterSameLeagueEnvironment(baseProjectedStats, sameLeagueEnvironment);
  const projectedStats = environmentAdjustment.projectedStats;
  return {
    ...result,
    projectedStats,
    meta: {
      ...result.meta,
      baseProjectedStats,
      hrProjection,
      sbProjection,
      sameLeagueEnvironment: environmentAdjustment.meta
    },
    candidate
  };
}

function projectPitcher(player, model, { role = null, sameLeagueEnvironment = null, roleUsageEnvironment = null } = {}) {
  const candidate = pitcherCandidateFromPlayer(player, role);
  const result = weightedProjection(candidate, model.pitcher, PITCHER_TARGET_KEYS, candidate.role, normalizePitcherProjection);
  const roleUsageAdjustment = applyPitcherRoleUsageModel(result.projectedStats, candidate, roleUsageEnvironment);
  const environmentAdjustment = applyPitcherSameLeagueEnvironment(roleUsageAdjustment.projectedStats, sameLeagueEnvironment);
  return {
    ...result,
    projectedStats: environmentAdjustment.projectedStats,
    meta: {
      ...result.meta,
      baseProjectedStats: result.projectedStats,
      roleUsage: roleUsageAdjustment.meta,
      sameLeagueEnvironment: environmentAdjustment.meta
    },
    candidate
  };
}

function batterContribution(projectedStats) {
  return roundTo(
    projectedStats.home_runs * 3.2 +
    projectedStats.rbi * 1.1 +
    projectedStats.steals * 1.4 +
    projectedStats.batting_avg * 220,
    2
  );
}

function pitcherContribution(projectedStats) {
  return roundTo(
    projectedStats.strikeouts * 0.65 +
    projectedStats.wins * 3 +
    projectedStats.saves * 5 -
    projectedStats.losses * 1.8 -
    projectedStats.walks * 0.25 -
    projectedStats.home_runs_allowed * 1.2 -
    projectedStats.era * 16,
    2
  );
}

function averageNumbers(values) {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return 0;
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function buildTeamProjections(playerProjections, { teamLeagueMap = {} } = {}) {
  const byTeam = new Map();
  for (const projection of playerProjections) {
    if (!byTeam.has(projection.team)) byTeam.set(projection.team, []);
    byTeam.get(projection.team).push(projection);
  }

  const teams = [];
  for (const [team, players] of byTeam.entries()) {
    const batters = players
      .filter(player => player.category === 'batter')
      .sort((a, b) => b.compositeScore - a.compositeScore);
    const pitchers = players
      .filter(player => player.category === 'pitcher')
      .sort((a, b) => b.compositeScore - a.compositeScore);
    const starters = pitchers.filter(player => player.role === 'SP').slice(0, 5);
    const bullpenPool = pitchers.filter(player => player.role !== 'SP');
    const bullpen = bullpenPool.slice(0, 4);
    const pitcherPool = [...starters, ...bullpen];
    if (pitcherPool.length < 9) {
      const used = new Set(pitcherPool.map(player => player.id));
      const fillers = pitchers.filter(player => !used.has(player.id)).slice(0, 9 - pitcherPool.length);
      pitcherPool.push(...fillers);
    }

    const offenseScore = roundTo(batters.slice(0, 9).reduce((sum, player) => sum + player.compositeScore, 0), 2);
    const pitchingScore = roundTo(pitcherPool.reduce((sum, player) => sum + player.compositeScore, 0), 2);
    const rawOverallScore = roundTo(offenseScore + pitchingScore, 2);
    teams.push({
      team,
      league: teamLeagueMap[team] || null,
      offenseScore,
      pitchingScore,
      rawOverallScore,
      overallScore: rawOverallScore,
      projectedCore: {
        batters: batters.slice(0, 9).map(player => player.id),
        pitchers: pitcherPool.slice(0, 9).map(player => player.id)
      }
    });
  }

  const adjustedTeams = teams.map(team => {
    const leagueTeams = teams.filter(candidate => {
      if (!team.league) return true;
      return candidate.league === team.league;
    });
    const opponents = leagueTeams.filter(candidate => candidate.team !== team.team);
    const opponentAverageOverallScore = averageNumbers(opponents.map(candidate => candidate.rawOverallScore));
    const opponentAverageOffenseScore = averageNumbers(opponents.map(candidate => candidate.offenseScore));
    const opponentAveragePitchingScore = averageNumbers(opponents.map(candidate => candidate.pitchingScore));
    const leagueAverageOverallScore = averageNumbers(leagueTeams.map(candidate => candidate.rawOverallScore));
    const leagueAverageOffenseScore = averageNumbers(leagueTeams.map(candidate => candidate.offenseScore));
    const leagueAveragePitchingScore = averageNumbers(leagueTeams.map(candidate => candidate.pitchingScore));
    const sameLeagueOverallEdge = opponents.length
      ? roundTo(team.rawOverallScore - opponentAverageOverallScore, 2)
      : 0;
    const sameLeagueOffenseEdge = opponents.length
      ? roundTo(team.offenseScore - opponentAverageOffenseScore, 2)
      : 0;
    const sameLeaguePitchingEdge = opponents.length
      ? roundTo(team.pitchingScore - opponentAveragePitchingScore, 2)
      : 0;
    const sameLeagueAdjustment = roundTo(sameLeagueOverallEdge * SAME_LEAGUE_EDGE_WEIGHT, 2);
    return {
      ...team,
      sameLeagueAdjustment,
      overallScore: roundTo(team.rawOverallScore + sameLeagueAdjustment, 2),
      sameLeagueContext: {
        enabled: true,
        league: team.league || null,
        opponentTeams: opponents.map(candidate => candidate.team),
        opponentAverageOverallScore: roundTo(opponentAverageOverallScore, 2),
        opponentAverageOffenseScore: roundTo(opponentAverageOffenseScore, 2),
        opponentAveragePitchingScore: roundTo(opponentAveragePitchingScore, 2),
        leagueAverageOverallScore: roundTo(leagueAverageOverallScore, 2),
        leagueAverageOffenseScore: roundTo(leagueAverageOffenseScore, 2),
        leagueAveragePitchingScore: roundTo(leagueAveragePitchingScore, 2),
        sameLeagueOverallEdge,
        sameLeagueOffenseEdge,
        sameLeaguePitchingEdge,
        adjustmentWeight: SAME_LEAGUE_EDGE_WEIGHT,
        rule: 'overallScore = rawOverallScore + sameLeagueOverallEdge * adjustmentWeight'
      }
    };
  });

  return adjustedTeams.sort((a, b) => b.overallScore - a.overallScore || b.pitchingScore - a.pitchingScore || b.offenseScore - a.offenseScore);
}

function buildProjectionSnapshot({
  seasonDir = latestSeasonDir(ORE_DB_BASE),
  players = null,
  seasonMeta = null,
  outPath = DEFAULT_ARTIFACT_PATH,
  base = ORE_DB_BASE,
  minSeason = MIN_TRAINING_SEASON,
  maxSeason = Number.POSITIVE_INFINITY
} = {}) {
  const rawPlayers = players || readJson(path.join(seasonDir, 'players.json'));
  const retirementContext = applyRetirementReplacements(rawPlayers);
  const effectivePlayers = retirementContext.players;
  const effectiveMeta = seasonMeta || readJson(path.join(seasonDir, 'meta.json'));
  const seasonSnapshot = readSeasonSnapshot(seasonDir);
  const teamLeagueMap = teamLeagueMapFromSnapshot(seasonSnapshot);
  const model = buildModel({ base, minSeason, maxSeason });
  const sameLeaguePlayerEnvironments = buildSameLeaguePlayerEnvironments(effectivePlayers, teamLeagueMap);
  const pitcherRoleUsageEnvironments = buildPitcherRoleUsageEnvironments(effectivePlayers);
  const playerProjections = [];

  for (const player of effectivePlayers) {
    if (player.category === 'batter') {
      const result = projectBatter(player, model, {
        slot: batterSlotForPlayer(player),
        sameLeagueEnvironment: sameLeaguePlayerEnvironments.byTeam[player.team]
      });
      const projectedStats = result.projectedStats;
      playerProjections.push({
        id: `proj::${player.team}::batter::${player.name}::${player.owner || 'computer'}`,
        season: asNum(effectiveMeta.season, seasonNumberFromDir(seasonDir)),
        team: player.team,
        category: 'batter',
        slot: batterSlotForPlayer(player),
        role: batterSlotForPlayer(player),
        name: player.name,
        owner: player.owner || null,
        isComputer: !!player.is_computer,
        age: asNum(player.age),
        abilities: result.candidate.abilities,
        skills: result.candidate.skills,
        projectedStats,
        compositeScore: batterContribution(projectedStats),
        projectionMeta: result.meta
      });
      continue;
    }

    if (player.category === 'pitcher') {
      const role = pitcherRoleForProjection(player);
      const result = projectPitcher(player, model, {
        role,
        sameLeagueEnvironment: sameLeaguePlayerEnvironments.byTeam[player.team],
        roleUsageEnvironment: pitcherRoleUsageEnvironments.byTeam[player.team]
      });
      const projectedStats = result.projectedStats;
      playerProjections.push({
        id: `proj::${player.team}::pitcher::${player.name}::${player.owner || 'computer'}`,
        season: asNum(effectiveMeta.season, seasonNumberFromDir(seasonDir)),
        team: player.team,
        category: 'pitcher',
        role,
        name: player.name,
        owner: player.owner || null,
        isComputer: !!player.is_computer,
        age: asNum(player.age),
        abilities: result.candidate.abilities,
        skills: result.candidate.skills,
        projectedStats,
        compositeScore: pitcherContribution(projectedStats),
        projectionMeta: result.meta
      });
    }
  }

  const snapshot = {
    generatedAt: new Date().toISOString(),
    modelVersion: model.modelVersion,
    confidence: model.confidence,
    directPlayerHistoryCarryForwardWeight: 0,
    modelRules: {
      rosterPositionAndPitcherRoleUsedAsFeatures: true,
      pitcherNeighborScopePrefersSameRole: true,
      starterOnlyPitcherSkills: [...STARTER_ONLY_PITCHER_SKILLS],
      starterOnlyPitcherSkillsEffectiveRoles: ['SP'],
      pitcherProjectionIgnoredContextOnlySkills: [...PITCHER_CONTEXT_ONLY_SKILLS],
      sameLeagueOpponentContextUsed: true,
      sameLeagueAdjustmentWeight: SAME_LEAGUE_EDGE_WEIGHT,
      teamOverallScoreUsesSameLeagueAdjustment: true,
      sameLeagueBatterEnvironmentUsed: true,
      sameLeaguePitcherEnvironmentUsed: true,
      batterOpponentPitcherEnvironmentWeight: BATTER_OPPONENT_PITCHER_ENV_WEIGHT,
      pitcherOpponentBatterEnvironmentWeight: PITCHER_OPPONENT_BATTER_ENV_WEIGHT,
      pitcherRoleUsageModelUsed: true,
      pitcherRoleUsageModel: 'rp_workload_from_same_team_sp_stamina_and_capacity',
      rpWorkloadAppliesToRoles: ['RP'],
      rpWorkloadExcludesRoles: ['SP', 'CP'],
      rpWorkloadStarterStaminaDeficitWeight: RP_WORKLOAD_STARTER_STAMINA_DEFICIT_WEIGHT,
      rpWorkloadStarterCapacityDeficitWeight: RP_WORKLOAD_STARTER_CAPACITY_DEFICIT_WEIGHT
    },
    retirementReplacementPolicy: {
      enabled: true,
      retirementAge: RETIREMENT_AGE_THRESHOLD,
      sourceAgeReplacementThreshold: RETIREMENT_AGE_THRESHOLD,
      rookieSource: 'same fresh roster, owner-held non-computer age<=26',
      retiredPlayers: retirementContext.retiredPlayers,
      replacementRookies: retirementContext.replacementRookies
    },
    trainingSeasonBounds: {
      minSeason: model.minSeason,
      maxSeason: Number.isFinite(model.maxSeason) ? model.maxSeason : null
    },
    trainingSeasons: model.trainingSeasons,
    sourceSnapshot: {
      seasonDir,
      season: asNum(effectiveMeta.season, seasonNumberFromDir(seasonDir)),
      day: asNum(effectiveMeta.day),
      scrapedAt: effectiveMeta.scraped_at || null,
      sourceFreshnessStatus: effectiveMeta.sourceFreshness && effectiveMeta.sourceFreshness.status || null,
      sourceFreshnessSummaryStatus: effectiveMeta.sourceFreshness && effectiveMeta.sourceFreshness.summaryStatus || null,
      sourceFreshnessHistoryStatus: effectiveMeta.sourceFreshness && effectiveMeta.sourceFreshness.historyStatus || null,
      sourceFreshTeisatuCount: effectiveMeta.sourceFreshness && Array.isArray(effectiveMeta.sourceFreshness.teisatuFreshSakus) ? effectiveMeta.sourceFreshness.teisatuFreshSakus.length : null,
      sourceCacheTeisatuCount: effectiveMeta.sourceFreshness && Array.isArray(effectiveMeta.sourceFreshness.teisatuCacheSakus) ? effectiveMeta.sourceFreshness.teisatuCacheSakus.length : null,
      playersFile: path.join(seasonDir, 'players.json'),
      metaFile: path.join(seasonDir, 'meta.json'),
      seasonSnapshotFile: path.join(seasonDir, 'season_snapshot.json')
    },
    sampleCounts: {
      batterTrainingRows: model.batter.rows.length,
      pitcherTrainingRows: model.pitcher.rows.length,
      projectedPlayers: playerProjections.length
    },
    sameLeaguePlayerEnvironments,
    pitcherRoleUsageEnvironments,
    playerProjections,
    teamProjections: buildTeamProjections(playerProjections, { teamLeagueMap })
  };

  if (outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(snapshot, null, 2), 'utf8');
  }

  return {
    snapshot,
    model,
    outPath
  };
}

function parseArgs(argv) {
  const options = {};
  for (let i = 2; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const [key, inlineValue] = token.slice(2).split('=');
    if (inlineValue !== undefined) {
      options[key] = inlineValue;
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      options[key] = argv[++i];
    } else {
      options[key] = true;
    }
  }
  return options;
}

function formatSummary(snapshot, outPath) {
  const topTeam = snapshot.teamProjections[0];
  return [
    `Projection artifact: ${outPath}`,
    `Model: ${snapshot.modelVersion}`,
    `Confidence: ${snapshot.confidence}`,
    `Training seasons: ${snapshot.trainingSeasons.map(item => item.season).join(', ')}`,
    `Projected players: ${snapshot.sampleCounts.projectedPlayers}`,
    `Top projected team: ${topTeam ? `${topTeam.team} (${topTeam.overallScore})` : 'n/a'}`
  ].join('\n');
}

function main() {
  const args = parseArgs(process.argv);
  const seasonDir = args['season-dir'] || latestSeasonDir(ORE_DB_BASE);
  const outPath = args.out || DEFAULT_ARTIFACT_PATH;
  const maxSeason = args['max-training-season'] == null ? Number.POSITIVE_INFINITY : asNum(args['max-training-season'], Number.POSITIVE_INFINITY);
  const { snapshot } = buildProjectionSnapshot({ seasonDir, outPath, maxSeason });
  console.log(formatSummary(snapshot, outPath));
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error && error.stack ? error.stack : String(error));
    process.exit(1);
  }
}

module.exports = {
  MODEL_VERSION,
  MIN_TRAINING_SEASON,
  buildModel,
  buildProjectionSnapshot,
  batterSlotForPlayer,
  pitcherRoleForProjection,
  projectBatter,
  projectPitcher,
  batterContribution,
  pitcherContribution,
  batterHrSkillBasis,
  batterSbSkillBasis,
  buildPitcherRoleUsageEnvironments,
  applyRetirementReplacements
};
