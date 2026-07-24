import test from 'node:test';
import assert from 'node:assert/strict';
import { LiquidationMarket, CircuitMarket } from '../src/market.js';
import { makeItem } from '../src/items.js';
import {
  newLiquidationState, fundDraftRound, runLiquidationAI, suggestedLiquidationBankroll,
  liquidationOdds, liquidationBetOptions, liquidationCreditLimit, canPlaceLiquidationBet,
  recordLiquidationOutcome, resupplyLiquidation, draftCanCoverDebt, allocateRivalSupply,
  recordMarketRound, recordMarketTrade, enemyRoster, commitPlayerDraftTurn,
} from '../src/liquidation.js';

test('shared AMM raises price under demand and returns sold stock', () => {
  const market = new LiquidationMarket(null, () => 0.5);
  const before = market.quoteBuy('ammo_9mm');
  const paid = market.buy('ammo_9mm');
  assert.ok(market.quoteBuy('ammo_9mm') > before);
  const refund = market.sell(makeItem('ammo_9mm'));
  assert.ok(Math.abs(refund - paid) <= 1, '100% live quote has no fixed-price haircut');
  assert.equal(market.info('ammo_9mm').units, market.info('ammo_9mm').initial);
});

test('each recruit archetype has an independent Liquidation AMM pool', () => {
  const market = new LiquidationMarket(null, () => 0.5);
  const medicBefore = market.quoteRecruit('medic');
  const marksmanBefore = market.quoteRecruit('marksman');
  const paid = market.buyRecruit('medic');
  assert.equal(paid, medicBefore);
  assert.ok(market.quoteRecruit('medic') > medicBefore);
  assert.equal(market.quoteRecruit('marksman'), marksmanBefore);
  assert.equal(market.recruitInfo('medic').units, market.recruitInfo('medic').initial - 1);
  const refund = market.releaseRecruit('medic');
  assert.ok(Math.abs(refund - paid) <= 1);
  assert.equal(market.recruitInfo('medic').units, market.recruitInfo('medic').initial);
});

test('circuits retains its 55% sale adapter', () => {
  const market = new CircuitMarket();
  assert.equal(market.quoteSell(makeItem('rifle')), 825);
});

test('ten fight-linked envelopes disburse equal full bankrolls', () => {
  const state = newLiquidationState(suggestedLiquidationBankroll(), () => 0);
  let playerMoney = 0;
  let enemyFirstTurns = 0;
  for (let round = 0; round < 10; round++) {
    playerMoney = fundDraftRound(state, playerMoney, () => enemyFirstTurns++);
  }
  assert.equal(state.draft.fundedRounds, 10);
  assert.equal(enemyFirstTurns, 5);
  assert.equal(playerMoney, state.bankroll);
  assert.equal(state.enemyMoney, state.bankroll);
});

test('each funded round records one envelope', () => {
  const state = newLiquidationState(25000, () => 0.9);
  const playerMoney = fundDraftRound(state, 0);
  assert.equal(playerMoney, 2500);
  // Main gates funding by round; the primitive tracks each funded bout explicitly.
  assert.equal(state.draft.fundedRounds, 1);
  assert.equal(state.draft.lastEnvelope, 2500);
});

test('player-first draft waits for an explicit commit and runs the rival shop once', () => {
  const state = newLiquidationState(20000, () => 0);
  let rivalTurns = 0;
  fundDraftRound(state, 0, () => rivalTurns++);
  assert.equal(state.draft.playerFirst, true);
  assert.equal(state.draft.playerTurnEnded, false);
  assert.equal(state.draft.pendingEnemyShop, true);
  assert.equal(rivalTurns, 0);

  assert.equal(commitPlayerDraftTurn(state, () => rivalTurns++), true);
  assert.equal(state.draft.playerTurnEnded, true);
  assert.equal(state.draft.pendingEnemyShop, false);
  assert.equal(rivalTurns, 1);
  assert.equal(commitPlayerDraftTurn(state, () => rivalTurns++), false);
  assert.equal(rivalTurns, 1);
});

test('enemy-first draft shops immediately and does not require a player commit', () => {
  const state = newLiquidationState(20000, () => 0.9);
  let rivalTurns = 0;
  fundDraftRound(state, 0, () => rivalTurns++);
  assert.equal(state.draft.playerFirst, false);
  assert.equal(state.draft.playerTurnEnded, false);
  assert.equal(state.draft.pendingEnemyShop, false);
  assert.equal(rivalTurns, 1);
  assert.equal(commitPlayerDraftTurn(state, () => rivalTurns++), false);
  assert.equal(rivalTurns, 1);
});

test('rival begins with one fighter and buys every additional contract from the AMM', () => {
  const market = new LiquidationMarket(null, () => 0.5);
  const state = newLiquidationState(20000, () => 0.5);
  assert.deepEqual(state.enemy.recruits, ['enforcer']);
  assert.equal(enemyRoster(state).length, 1);
  fundDraftRound(state, 0);
  for (let i = 0; i < 8; i++) runLiquidationAI(state, market);
  assert.equal(state.enemy.recruits.length, 3);
  assert.equal(enemyRoster(state).length, 3);
  const hires = state.marketLog.filter(entry => entry.kind === 'trade' && entry.side === 'rival' && entry.action === 'hire');
  assert.equal(hires.length, 2);
  assert.deepEqual(hires.map(entry => entry.label), ['MEDIC CONTRACT', 'RUSHER CONTRACT']);
  assert.equal(market.recruitInfo('medic').units, market.recruitInfo('medic').initial - 1);
  assert.equal(market.recruitInfo('rusher').units, market.recruitInfo('rusher').initial - 1);
});

test('the next draft envelope protects only a recoverable deficit', () => {
  const state = newLiquidationState(25000, () => 0.5);
  fundDraftRound(state, 0);
  assert.equal(draftCanCoverDebt(state, -2400), true);
  assert.equal(draftCanCoverDebt(state, -2600), false);
  state.draft.complete = true;
  assert.equal(draftCanCoverDebt(state, -1), false);
});

test('rival AI pivots away from a squeezed 9mm pool and explains the buy', () => {
  const market = new LiquidationMarket(null, () => 0.5);
  for (let i = 0; i < 7; i++) market.buy('ammo_9mm');
  const state = newLiquidationState(20000, () => 0.5);
  state.enemyMoney = 10000;
  const action = runLiquidationAI(state, market, { hoarded9mm: true });
  assert.equal(state.enemy.strategy, 'rifle');
  assert.ok(action.action.includes('RIFLE'));
  assert.deepEqual(state.marketLog.at(-1), {
    kind: 'trade', round: 1, side: 'rival', action: 'buy', type: action.type, amount: action.cost,
  });
});

test('rival buyer deliberately stocks grenades, medkits, and splints', () => {
  const market = new LiquidationMarket(null, () => 0.5);
  const state = newLiquidationState(20000, () => 0.5);
  state.enemyMoney = 20000;
  for (let i = 0; i < 8; i++) runLiquidationAI(state, market);
  assert.equal(state.enemy.inventory.medkit, 2);
  assert.equal(state.enemy.inventory.grenade, 2);
  assert.equal(state.enemy.inventory.splint, 1);
  const rivalBuys = state.marketLog.filter(entry => entry.kind === 'trade' && entry.side === 'rival');
  assert.ok(rivalBuys.some(entry => entry.type === 'grenade'));
  assert.ok(rivalBuys.some(entry => entry.type === 'splint'));
});

test('public market tape records both sides and separates rounds', () => {
  const state = newLiquidationState(20000, () => 0.5);
  recordMarketTrade(state, 'player', 'buy', 'rifle', 1500);
  recordMarketTrade(state, 'player', 'hire', null, 400, 'MEDIC · WREN');
  state.round = 2;
  recordMarketRound(state);
  recordMarketTrade(state, 'player', 'sell', 'rifle', 1600);
  assert.deepEqual(state.marketLog.map(entry => entry.kind), ['round', 'trade', 'trade', 'round', 'trade']);
  assert.equal(state.marketLog[2].action, 'hire');
  assert.equal(state.marketLog[2].label, 'MEDIC · WREN');
  assert.deepEqual(state.marketLog[3], { kind: 'round', round: 2 });
  assert.equal(state.marketLog[4].action, 'sell');
  assert.equal(state.marketLog[4].amount, 1600);
});

test('rival supplies are divided across fighters without duplication', () => {
  const inventory = { grenade: 5 };
  const shares = Array.from({ length: 3 }, (_, i) => allocateRivalSupply(inventory, 'grenade', i, 3));
  assert.deepEqual(shares, [2, 2, 1]);
  assert.equal(shares.reduce((total, n) => total + n, 0), inventory.grenade);
});

test('underdog sees comeback odds and can raise the stake', () => {
  const state = newLiquidationState(20000, () => 0.5);
  state.enemyMoney = 20000;
  assert.ok(liquidationOdds(state, 5000) > 2);
  assert.deepEqual(liquidationBetOptions(state, 5000), [250, 500, 1250, 2500, 5000, 2000, 4000]);
  assert.deepEqual(liquidationBetOptions(state, 100), [250, 2000, 4000]);
  assert.equal(liquidationCreditLimit(state, 100), 4100);
  assert.equal(canPlaceLiquidationBet(state, 100, 4000), true);
  assert.equal(canPlaceLiquidationBet(state, 100, 5000), false);
  state.draft.complete = true;
  assert.equal(liquidationCreditLimit(state, 100), 250);
  assert.equal(canPlaceLiquidationBet(state, 100, 4000), false);
});

test('consecutive defeats escalate until the next envelope cannot rescue a broke squad', () => {
  const state = newLiquidationState(20000, () => 0.5);
  fundDraftRound(state, 0);
  assert.deepEqual(recordLiquidationOutcome(state, false), { loser: 'player', streak: 1, penalty: 0 });
  assert.deepEqual(recordLiquidationOutcome(state, false), { loser: 'player', streak: 2, penalty: 1000 });
  const third = recordLiquidationOutcome(state, false);
  assert.deepEqual(third, { loser: 'player', streak: 3, penalty: 2000 });
  assert.equal(draftCanCoverDebt(state, -250 - third.penalty), false);
  assert.deepEqual(recordLiquidationOutcome(state, true), { loser: 'rival', streak: 1, penalty: 0 });
  assert.equal(state.playerLossStreak, 0);
});

test('every third completed round resupplies only shared consumables and ammo', () => {
  const market = new LiquidationMarket(null, () => 0.5);
  const state = newLiquidationState(20000, () => 0.5);
  state.round = 4;
  const ammoBefore = market.info('ammo_762').units;
  const rifleBefore = market.info('rifle').units;
  const drop = resupplyLiquidation(state, market, () => 0);
  assert.equal(drop.round, 3);
  assert.equal(market.info('ammo_762').units, ammoBefore + 2);
  assert.equal(market.info('rifle').units, rifleBefore);
  assert.match(state.marketLog.at(-1).text, /HOUSE RESTOCK/);
});
