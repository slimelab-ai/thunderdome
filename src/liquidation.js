import { ITEM_TYPES, AMMO_TYPES } from './items.js';
import { HIRE_TYPES } from './progression.js';

export const LIQUIDATION_DRAFT_TURNS = 10;

export function suggestedLiquidationBankroll() {
  const recruit = 400; // archetypes are equal-cost sidegrades; growth comes from earned XP
  const perElite = recruit + ITEM_TYPES.helm2.price + ITEM_TYPES.vest2.price + ITEM_TYPES.pads2.price +
    ITEM_TYPES.rifle.price + ITEM_TYPES.ammo_762.price * 3 + ITEM_TYPES.grenade.price * 3 +
    ITEM_TYPES.medkit.price * 3 + ITEM_TYPES.splint.price * 3;
  return Math.round(perElite * 3 / 500) * 500;
}

export function newLiquidationState(bankroll = suggestedLiquidationBankroll(), random = Math.random) {
  const starter = random() < 0.5 ? 'player' : 'enemy';
  return {
    bankroll, draft: {
      version: 3, fundedRounds: 0, starter, complete: false,
      pendingEnemyShop: false, playerFirst: false, playerTurnEnded: false, lastEnvelope: 0,
    },
    enemyMoney: 0, round: 1, playerWins: 0, enemyWins: 0, lastResupply: null,
    playerLossStreak: 0, enemyLossStreak: 0,
    complete: false, // the war is over: someone's bankroll died with no envelope left to save it
    enemy: { strategy: 'balanced', inventory: {}, recruits: ['enforcer'] },
    marketLog: [{ kind: 'round', round: 1 }],
    market: null,
  };
}

export function recordMarketRound(state, round = state.round) {
  state.marketLog ||= [];
  if (!state.marketLog.some(entry => entry.kind === 'round' && entry.round === round)) {
    state.marketLog.push({ kind: 'round', round });
  }
  return state.marketLog;
}

export function recordMarketTrade(state, side, action, type, amount, label = null) {
  recordMarketRound(state);
  const entry = { kind: 'trade', round: state.round, side, action, type, amount: Math.round(amount) };
  if (label) entry.label = label;
  state.marketLog.push(entry);
  return entry;
}

export function recordMarketEvent(state, text) {
  recordMarketRound(state);
  const entry = { kind: 'event', round: state.round, text };
  state.marketLog.push(entry);
  return entry;
}

export function liquidationOdds(state, playerMoney) {
  const rival = Math.max(1, state.enemyMoney);
  const player = Math.max(1, playerMoney);
  // Bankroll is a useful public proxy for squad strength. The poorer squad gets
  // comeback odds; favorites receive a smaller but still profitable return.
  return Math.max(1.25, Math.min(4, +(2 + (rival - player) / Math.max(rival, player)).toFixed(2)));
}

export function liquidationBetOptions(state, playerMoney) {
  const cash = Math.max(0, playerMoney);
  const envelope = draftShare(state);
  // Normal bets scale through an all-in. Two explicit blood markers let either
  // side borrow against up to two future envelopes, making a voluntary wager
  // large enough to end a war during the protected draft.
  const values = [
    250,
    ...[0.10, 0.25, 0.50, 1].map(f => Math.max(250, Math.floor(cash * f / 50) * 50)),
    envelope,
    envelope * 2,
  ];
  return [...new Set(values)].filter(value => value <= liquidationCreditLimit(state, playerMoney));
}

export function liquidationCreditLimit(state, money) {
  const draftCredit = state.draft.complete ? 0 : draftShare(state) * 2;
  return Math.max(250, Math.max(0, money) + draftCredit);
}

export function canPlaceLiquidationBet(state, money, amount) {
  return liquidationBetOptions(state, money).includes(amount);
}

export function recordLiquidationOutcome(state, playerWon) {
  if (playerWon) {
    state.playerLossStreak = 0;
    state.enemyLossStreak = (state.enemyLossStreak || 0) + 1;
    return {
      loser: 'rival',
      streak: state.enemyLossStreak,
      penalty: liquidationStreakPenalty(state, state.enemyLossStreak),
    };
  }
  state.enemyLossStreak = 0;
  state.playerLossStreak = (state.playerLossStreak || 0) + 1;
  return {
    loser: 'player',
    streak: state.playerLossStreak,
    penalty: liquidationStreakPenalty(state, state.playerLossStreak),
  };
}

export function liquidationStreakPenalty(state, streak) {
  if (streak < 2) return 0;
  // A second straight loss burns half an envelope. A third burns a full one;
  // combined with the mandatory stake, a squad living envelope-to-envelope can
  // no longer be rescued indefinitely.
  return Math.round(draftShare(state) * (streak - 1) / 2);
}

export function resupplyLiquidation(state, market, random = Math.random) {
  const completedRound = state.round - 1;
  if (completedRound <= 0 || completedRound % 3 !== 0) return null;
  const delivered = {};
  for (const type of ['ammo_9mm', 'ammo_buck', 'ammo_762', 'ammo_308']) {
    const quantity = 2 + Math.floor(random() * 3);
    market.restock(type, quantity); delivered[type] = quantity;
  }
  for (const type of ['medkit', 'splint', 'grenade']) {
    const quantity = 1 + Math.floor(random() * 2);
    market.restock(type, quantity); delivered[type] = quantity;
  }
  state.lastResupply = { round: completedRound, delivered };
  recordMarketEvent(state, `HOUSE RESTOCK · ammo and consumables added after round ${completedRound}`);
  return state.lastResupply;
}

export function draftShare(state) {
  // Ten fight-linked envelopes total exactly one starting bankroll per squad.
  const base = Math.floor(state.bankroll / LIQUIDATION_DRAFT_TURNS / 100) * 100;
  return state.draft.fundedRounds === LIQUIDATION_DRAFT_TURNS - 1
    ? state.bankroll - base * (LIQUIDATION_DRAFT_TURNS - 1)
    : base;
}

export function fundDraftRound(state, playerMoney, onEnemyFirst) {
  if (state.draft.complete || state.draft.fundedRounds >= LIQUIDATION_DRAFT_TURNS) return playerMoney;
  const amount = draftShare(state);
  playerMoney += amount;
  state.enemyMoney += amount;
  const enemyFirst = (state.draft.fundedRounds % 2 === 0) === (state.draft.starter === 'enemy');
  state.draft.fundedRounds++;
  state.draft.lastEnvelope = amount;
  state.draft.playerFirst = !enemyFirst;
  state.draft.playerTurnEnded = false;
  state.draft.pendingEnemyShop = !enemyFirst;
  if (enemyFirst) onEnemyFirst?.(amount);
  if (state.draft.fundedRounds >= LIQUIDATION_DRAFT_TURNS) state.draft.complete = true;
  return playerMoney;
}

export function commitPlayerDraftTurn(state, onEnemyShop) {
  const draft = state?.draft;
  if (!draft?.playerFirst || draft.playerTurnEnded || !draft.pendingEnemyShop) return false;
  draft.playerTurnEnded = true;
  onEnemyShop?.();
  draft.pendingEnemyShop = false;
  return true;
}

export function draftCanCoverDebt(state, money) {
  return money < 0 && !state.draft.complete && money + draftShare(state) >= 0;
}

export function allocateRivalSupply(inventory, type, fighterIndex, rosterSize, cap = 2) {
  if (rosterSize <= 0 || fighterIndex < 0 || fighterIndex >= rosterSize) return 0;
  const available = Math.max(0, Math.floor(inventory[type] || 0));
  const evenShare = Math.floor(available / rosterSize);
  const remainder = available % rosterSize;
  return Math.min(cap, evenShare + (fighterIndex < remainder ? 1 : 0));
}

export function liquidationReserveTarget(state) {
  const envelope = draftShare(state);
  const fundedRounds = state.draft?.fundedRounds || 0;
  // Begin hunkering down after round six, reaching one full untouched envelope
  // at the end of the draft. This is cash runway, not an accusation that reserve
  // inventory is wasteful.
  const lateDraftRamp = Math.max(0, Math.min(1, (fundedRounds - 6) / 4));
  const lateDraftReserve = Math.round(envelope * lateDraftRamp / 50) * 50;
  // Always retain the minimum stake. If another defeat would trigger a streak
  // margin call, retain enough cash for that known liability too.
  const nextLossStreak = (state.enemyLossStreak || 0) + 1;
  const lossRunway = 250 + liquidationStreakPenalty(state, nextLossStreak);
  return Math.max(250, lateDraftReserve, lossRunway);
}

const STRATEGIES = {
  swarm: {
    guns: ['smg', 'pistol'], ammo: ['ammo_9mm'], armor: ['vest1', 'pads1'],
    recruits: ['rusher', 'rusher', 'medic', 'enforcer'], desiredRoster: 5,
  },
  rifle: {
    guns: ['rifle'], ammo: ['ammo_762'], armor: ['vest2', 'helm1'],
    recruits: ['marksman', 'enforcer', 'medic', 'shield'], desiredRoster: 3,
  },
  heavy: {
    guns: ['rifle', 'shotgun'], ammo: ['ammo_762', 'ammo_buck'], armor: ['helm2', 'vest2', 'pads2'],
    recruits: ['shield', 'medic', 'enforcer', 'marksman'], desiredRoster: 2,
  },
  balanced: {
    guns: ['rifle', 'smg'], ammo: ['ammo_762', 'ammo_9mm'], armor: ['helm1', 'vest1', 'pads1'],
    recruits: ['medic', 'rusher', 'marksman', 'shield'], desiredRoster: 3,
  },
};

export function runLiquidationAI(state, market, playerSignals = {}) {
  const inv = state.enemy.inventory;
  const reserveTarget = liquidationReserveTarget(state);
  const spendable = Math.max(0, state.enemyMoney - reserveTarget);
  const price = t => market.quoteBuy(t);
  const pressure = t => market.info(t)?.pressure || 1;
  const affordable = t => Number.isFinite(price(t)) && price(t) <= spendable;
  const alternatives = ['ammo_9mm', 'ammo_762', 'ammo_buck', 'ammo_308'].sort((a, b) => pressure(a) - pressure(b));

  if (playerSignals.hoarded9mm || pressure('ammo_9mm') > 1.5) state.enemy.strategy = 'rifle';
  else if (pressure('ammo_762') > 1.55) state.enemy.strategy = 'swarm';
  else if (state.enemyMoney > state.bankroll * 0.45) state.enemy.strategy = 'heavy';
  const plan = STRATEGIES[state.enemy.strategy];
  const owned = t => inv[t] || 0;
  const recruits = state.enemy.recruits ||= ['enforcer'];
  const fundedRounds = state.draft?.fundedRounds || 0;
  const desiredRoster = fundedRounds <= 0 ? 1 : Math.min(5, Math.max(
    plan.desiredRoster,
    1 + Math.floor(fundedRounds / 2),
  ));
  if (recruits.length < desiredRoster) {
    const candidates = plan.recruits
      .map((type, order) => ({ type, order, cost: market.quoteRecruit(type) }))
      .filter(candidate => Number.isFinite(candidate.cost) && candidate.cost <= spendable)
      .sort((a, b) => a.order - b.order || a.cost - b.cost);
    const recruit = candidates[recruits.length - 1] || candidates[0];
    if (recruit) {
      const cost = market.buyRecruit(recruit.type);
      state.enemyMoney -= cost;
      recruits.push(recruit.type);
      const label = `${HIRE_TYPES[recruit.type].name} CONTRACT`;
      recordMarketTrade(state, 'rival', 'hire', null, cost, label);
      return { kind: 'hire', type: recruit.type, cost, action: `${state.enemy.strategy.toUpperCase()}: hired ${label} for $${cost}` };
    }
  }
  // Establish a working weapon first, then deliberately stock combat supplies.
  // Without explicit goals these items never entered the old candidate list.
  const plannedAmmo = plan.ammo.reduce((total, type) => total + owned(type), 0);
  const plannedGuns = plan.guns.reduce((total, type) => total + owned(type), 0);
  const supplies = { medkit: 2, grenade: 2, splint: 1 };
  let target = plannedAmmo < 2
    ? [...plan.ammo].sort((a, b) => pressure(a) - pressure(b)).find(affordable)
    : null;
  if (!target && plannedGuns < 1) target = plan.guns.find(affordable);
  if (!target) target = Object.keys(supplies).find(t => owned(t) < supplies[t] && affordable(t));
  if (!target) target = plan.armor.find(t => owned(t) < 3 && affordable(t));
  if (!target) target = plan.guns.find(t => owned(t) < 3 && affordable(t));
  if (!target) target = plan.ammo.find(t => owned(t) < 4 && affordable(t));
  if (!target) target = alternatives.find(t => affordable(t));
  if (!target) {
    return {
      kind: 'hold',
      reason: spendable <= 0 ? 'cash_reserve' : 'no_purchase_inside_reserve',
      reserveTarget,
      cash: state.enemyMoney,
      spendable,
      action: `HOLD: keeping $${state.enemyMoney} cash (reserve target $${reserveTarget})`,
    };
  }
  const cost = market.buy(target);
  state.enemyMoney -= cost;
  inv[target] = owned(target) + 1;
  const action = `${state.enemy.strategy.toUpperCase()}: bought ${ITEM_TYPES[target].name} for $${cost}`;
  recordMarketTrade(state, 'rival', 'buy', target, cost);
  return { kind: 'buy', type: target, cost, reserveTarget, action };
}

export function enemyRoster(state) {
  const inv = state.enemy.inventory;
  const strategy = state.enemy.strategy;
  const gun = strategy === 'swarm' ? 'smg' : (inv.rifle ? 'rifle' : inv.shotgun ? 'shotgun' : 'pistol');
  const ammoType = ITEM_TYPES[gun].ammo;
  const ammoItem = `ammo_${ammoType}`;
  const totalRounds = (inv[ammoItem] || 0) * AMMO_TYPES[ammoType].box;
  let recruits = (state.enemy.recruits || ['enforcer'])
    .filter(type => HIRE_TYPES[type])
    .slice(0, 5);
  if (!recruits.length) recruits = ['enforcer'];
  const count = Math.max(1, recruits.length);
  return recruits.map((type, i) => {
    const fighter = HIRE_TYPES[type];
    return {
      w: gun, hp: fighter.hp, sp: fighter.spreadMult, re: fighter.reaction,
      ar: strategy === 'heavy' ? 0.5 : (inv.vest1 ? 0.25 : 0),
      arch: fighter.archetype, ammo: Math.floor(totalRounds / count),
      name: `RIVAL ${i + 1}`,
    };
  });
}
