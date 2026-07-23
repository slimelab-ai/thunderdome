export const PLAYER_TYPE = 'challenger';

export const HIRE_TYPES = {
  enforcer: {
    name: 'ENFORCER', archetype: null, price: 400,
    desc: 'A dependable gunhand with no gimmick. Flexible, steady, and yours to shape.',
    hp: 100, spreadMult: 1.35, reaction: 0.62, speedMult: 1,
  },
  rusher: {
    name: 'RUSHER', archetype: 'rusher', price: 400,
    desc: 'Fast, fearless point fighter. Ignores danger and closes distance hard.',
    hp: 95, spreadMult: 1.55, reaction: 0.56, speedMult: 1.1,
  },
  shield: {
    name: 'SHIELD', archetype: 'shield', price: 400,
    desc: 'Slow bodyguard carrying a ballistic shield. Built to own a firing lane.',
    hp: 110, spreadMult: 1.5, reaction: 0.7, speedMult: 0.9,
  },
  marksman: {
    name: 'MARKSMAN', archetype: 'marksman', price: 400,
    desc: 'Patient back-line shooter with a steadier first shot and longer sightline.',
    hp: 90, spreadMult: 1.0, reaction: 0.48, speedMult: 0.95,
  },
  medic: {
    name: 'MEDIC', archetype: 'medic', price: 400,
    desc: 'Combat support who moves to wounded teammates and patches them mid-bout.',
    hp: 95, spreadMult: 1.4, reaction: 0.64, speedMult: 1,
  },
};

export const TRAINING_NODES = {
  aim: {
    name: 'MARKSMANSHIP', costs: [100, 225, 400],
    desc: ['10% tighter spread', '20% tighter spread', '30% tighter spread'],
  },
  cardio: {
    name: 'CONDITIONING', costs: [100, 225, 400],
    desc: ['+6% movement speed', '+12% movement speed', '+18% movement speed'],
  },
  tough: {
    name: 'PAIN TOLERANCE', costs: [100, 225, 400],
    desc: ['+15 max HP', '+30 max HP', '+45 max HP'],
  },
  discipline: {
    name: 'FIRE DISCIPLINE', costs: [125, 275, 500],
    desc: ['8% faster reactions', '16% faster reactions', '24% faster reactions'],
  },
  firepower: {
    name: 'CONTROLLED VIOLENCE', costs: [125, 275, 500],
    desc: ['+5% damage', '+10% damage', '+15% damage'],
  },
  momentum: {
    name: 'MOMENTUM', costs: [125, 275, 500],
    desc: ['+5% rush speed', '+10% rush speed', '+15% rush speed'],
  },
  brutality: {
    name: 'BRUTALITY', costs: [125, 275, 500],
    desc: ['+10% damage', '+20% damage', '+30% damage'],
  },
  bulwark: {
    name: 'BULWARK', costs: [125, 275, 500],
    desc: ['5% less incoming damage', '10% less incoming damage', '15% less incoming damage'],
  },
  guardian: {
    name: 'GUARDIAN', costs: [125, 275, 500],
    desc: ['+10 additional HP', '+20 additional HP', '+30 additional HP'],
  },
  precision: {
    name: 'PRECISION', costs: [125, 275, 500],
    desc: ['8% tighter role spread', '16% tighter role spread', '24% tighter role spread'],
  },
  overwatch: {
    name: 'OVERWATCH', costs: [125, 275, 500],
    desc: ['10% faster reactions', '20% faster reactions', '30% faster reactions'],
  },
  trauma: {
    name: 'TRAUMA CARE', costs: [125, 275, 500],
    desc: ['+12% healing', '+24% healing', '+36% healing'],
  },
  response: {
    name: 'RAPID RESPONSE', costs: [125, 275, 500],
    desc: ['12% shorter medic cooldown', '24% shorter medic cooldown', '36% shorter medic cooldown'],
  },
  quickhands: {
    name: 'QUICK HANDS', costs: [125, 275, 500],
    desc: ['8% faster reloads', '16% faster reloads', '24% faster reloads'],
  },
  adrenaline: {
    name: 'ADRENALINE LOOP', costs: [125, 275, 500],
    desc: ['Heal 12 HP on a kill', 'Heal 16 HP on a kill', 'Heal 20 HP on a kill'],
  },
};

const COMMON_TREE = ['aim', 'cardio', 'tough'];
const ROLE_TREES = {
  challenger: ['quickhands', 'adrenaline'],
  enforcer: ['discipline', 'firepower'],
  rusher: ['momentum', 'brutality'],
  shield: ['bulwark', 'guardian'],
  marksman: ['precision', 'overwatch'],
  medic: ['trauma', 'response'],
};

export function createProgression(skills = {}, xp = 0, totalXp = xp) {
  // Keep the common stats explicit. Player movement/recoil code reads these on
  // the first live frame, before the character has necessarily earned a tier.
  const cleanSkills = { aim: 0, cardio: 0, tough: 0 };
  for (const [id, level] of Object.entries(skills || {})) {
    if (TRAINING_NODES[id]) cleanSkills[id] = Math.max(0, Math.min(3, Math.floor(level || 0)));
  }
  return { xp: Math.max(0, Math.floor(xp || 0)), totalXp: Math.max(0, Math.floor(totalXp || 0)), skills: cleanSkills };
}

export function normalizeProgression(progress, legacySkills = null) {
  if (!progress) return createProgression(legacySkills || {});
  const normalized = createProgression(progress.skills || legacySkills || {}, progress.xp, progress.totalXp);
  Object.assign(progress, normalized);
  return progress;
}

export function trainingTrees(type) {
  return {
    common: COMMON_TREE.map(id => ({ id, ...TRAINING_NODES[id] })),
    role: (ROLE_TREES[type] || ROLE_TREES.enforcer).map(id => ({ id, ...TRAINING_NODES[id] })),
  };
}

export function trainingCost(progress, type, id) {
  const allowed = [...COMMON_TREE, ...(ROLE_TREES[type] || [])];
  if (!allowed.includes(id)) return Infinity;
  const level = progress.skills[id] || 0;
  return TRAINING_NODES[id]?.costs[level] ?? Infinity;
}

export function buyTraining(progress, type, id) {
  const cost = trainingCost(progress, type, id);
  if (!Number.isFinite(cost) || progress.xp < cost) return false;
  progress.xp -= cost;
  progress.skills[id] = (progress.skills[id] || 0) + 1;
  return true;
}

export function combatProfile(type, progress, isPlayer = false) {
  const p = normalizeProgression(progress);
  const level = id => p.skills[id] || 0;
  const base = isPlayer
    ? { hp: 100, spreadMult: 1, reaction: 0, speedMult: 1, archetype: null }
    : (HIRE_TYPES[type] || HIRE_TYPES.enforcer);
  return {
    maxHp: base.hp + level('tough') * 15 + level('guardian') * 10,
    spreadMult: base.spreadMult * (1 - level('aim') * 0.1) * (1 - level('precision') * 0.08),
    reaction: base.reaction * (1 - level('discipline') * 0.08) * (1 - level('overwatch') * 0.1),
    speedMult: base.speedMult * (1 + level('cardio') * 0.06 + level('momentum') * 0.05),
    damageMult: 1 + level('firepower') * 0.05 + level('brutality') * 0.1,
    damageTakenMult: 1 - level('bulwark') * 0.05,
    healingMult: 1 + level('trauma') * 0.12,
    medicCooldownMult: 1 - level('response') * 0.12,
    reloadMult: 1 - level('quickhands') * 0.08,
    killHeal: 8 + level('adrenaline') * 4,
    archetype: base.archetype || null,
  };
}

export function emptyXpStats() {
  return { damage: 0, kills: 0, headshots: 0, support: 0 };
}

export function calculateXp(stats, { won = false, survived = false } = {}) {
  const base = 10 + (stats.damage || 0) * 0.2 + (stats.kills || 0) * 35 +
    (stats.headshots || 0) * 10 + (stats.support || 0) * 0.4;
  const winMultiplier = won ? 1.35 : 1;
  const survivalMultiplier = survived ? 1.5 : 1;
  return {
    base: Math.round(base),
    winMultiplier,
    survivalMultiplier,
    total: Math.max(0, Math.round(base * winMultiplier * survivalMultiplier)),
  };
}

export function grantXp(progress, amount) {
  const xp = Math.max(0, Math.round(amount || 0));
  progress.xp += xp;
  progress.totalXp += xp;
  return xp;
}
