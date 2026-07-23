import { ITEM_TYPES, AMMO_TYPES } from './items.js';

export const LIQUIDATION_DRAFT_TURNS = 10;

export function suggestedLiquidationBankroll() {
  const elite = 2200; // kept here to avoid coupling the mode to UI presentation data
  const perElite = elite + ITEM_TYPES.helm2.price + ITEM_TYPES.vest2.price + ITEM_TYPES.pads2.price +
    ITEM_TYPES.rifle.price + ITEM_TYPES.ammo_762.price * 3 + ITEM_TYPES.grenade.price * 3 +
    ITEM_TYPES.medkit.price * 3 + ITEM_TYPES.splint.price * 3;
  return Math.round(perElite * 3 / 500) * 500;
}

export function newLiquidationState(bankroll = suggestedLiquidationBankroll(), random = Math.random) {
  const starter = random() < 0.5 ? 'player' : 'enemy';
  return {
    bankroll, draft: { version: 2, fundedRounds: 0, starter, complete: false, pendingEnemyShop: false, lastEnvelope: 0 },
    enemyMoney: 0, round: 1, playerWins: 0, enemyWins: 0, lastResupply: null,
    complete: false, // the war is over: someone's bankroll died with no envelope left to save it
    enemy: { strategy: 'balanced', inventory: {}, log: [] }, market: null,
  };
}

export function liquidationOdds(state, playerMoney) {
  const rival = Math.max(1, state.enemyMoney);
  const player = Math.max(1, playerMoney);
  // Bankroll is a useful public proxy for squad strength. The poorer squad gets
  // comeback odds; favorites receive a smaller but still profitable return.
  return Math.max(1.25, Math.min(4, +(2 + (rival - player) / Math.max(rival, player)).toFixed(2)));
}

export function liquidationBetOptions(state, playerMoney) {
  // The $250 floor can push a desperate squad below zero; that is the terminal
  // pressure Liquidation needs instead of allowing two broke squads to stalemate.
  const values = [250, ...[0.10, 0.25, 0.50].map(f => Math.max(250, Math.floor(playerMoney * f / 50) * 50))];
  return [...new Set(values)];
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
  state.enemy.log.unshift(`HOUSE RESUPPLY: ammo and consumables hit the shared market after round ${completedRound}`);
  state.enemy.log.length = Math.min(state.enemy.log.length, 8);
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
  state.draft.pendingEnemyShop = !enemyFirst;
  if (enemyFirst) onEnemyFirst?.(amount);
  if (state.draft.fundedRounds >= LIQUIDATION_DRAFT_TURNS) state.draft.complete = true;
  return playerMoney;
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

const STRATEGIES = {
  swarm: { guns: ['smg', 'pistol'], ammo: ['ammo_9mm'], armor: ['vest1', 'pads1'] },
  rifle: { guns: ['rifle'], ammo: ['ammo_762'], armor: ['vest2', 'helm1'] },
  heavy: { guns: ['rifle', 'shotgun'], ammo: ['ammo_762', 'ammo_buck'], armor: ['helm2', 'vest2', 'pads2'] },
  balanced: { guns: ['rifle', 'smg'], ammo: ['ammo_762', 'ammo_9mm'], armor: ['helm1', 'vest1', 'pads1'] },
};

export function runLiquidationAI(state, market, playerSignals = {}) {
  const inv = state.enemy.inventory;
  const price = t => market.quoteBuy(t);
  const pressure = t => market.info(t)?.pressure || 1;
  const affordable = t => Number.isFinite(price(t)) && price(t) <= state.enemyMoney;
  const alternatives = ['ammo_9mm', 'ammo_762', 'ammo_buck', 'ammo_308'].sort((a, b) => pressure(a) - pressure(b));

  if (playerSignals.hoarded9mm || pressure('ammo_9mm') > 1.5) state.enemy.strategy = 'rifle';
  else if (pressure('ammo_762') > 1.55) state.enemy.strategy = 'swarm';
  else if (state.enemyMoney > state.bankroll * 0.45) state.enemy.strategy = 'heavy';
  const plan = STRATEGIES[state.enemy.strategy];
  const owned = t => inv[t] || 0;
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
  if (!target) return null;
  const cost = market.buy(target);
  state.enemyMoney -= cost;
  inv[target] = owned(target) + 1;
  const action = `${state.enemy.strategy.toUpperCase()}: bought ${ITEM_TYPES[target].name} for $${cost}`;
  state.enemy.log.unshift(action); state.enemy.log.length = Math.min(state.enemy.log.length, 8);
  return { type: target, cost, action };
}

export function enemyRoster(state) {
  const inv = state.enemy.inventory;
  const strategy = state.enemy.strategy;
  const gun = strategy === 'swarm' ? 'smg' : (inv.rifle ? 'rifle' : inv.shotgun ? 'shotgun' : 'pistol');
  const ammoType = ITEM_TYPES[gun].ammo;
  const ammoItem = `ammo_${ammoType}`;
  const totalRounds = (inv[ammoItem] || 0) * AMMO_TYPES[ammoType].box;
  const count = strategy === 'swarm' ? 6 : 3;
  return Array.from({ length: count }, (_, i) => ({
    w: gun, hp: strategy === 'heavy' ? 130 : 105, sp: strategy === 'swarm' ? 1.25 : 0.9,
    re: strategy === 'swarm' ? 0.48 : 0.4, ar: strategy === 'heavy' ? 0.5 : (inv.vest1 ? 0.25 : 0),
    ammo: Math.floor(totalRounds / count), name: `RIVAL ${i + 1}`,
  }));
}
