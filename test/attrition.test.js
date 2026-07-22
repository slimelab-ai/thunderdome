import test from 'node:test';
import assert from 'node:assert/strict';
import { AttritionMarket, CircuitMarket } from '../src/market.js';
import { makeItem } from '../src/items.js';
import {
  newAttritionState, fundDraftRound, runAttritionAI, suggestedAttritionBankroll,
  attritionOdds, attritionBetOptions, resupplyAttrition, draftCanCoverDebt,
} from '../src/attrition.js';

test('shared AMM raises price under demand and returns sold stock', () => {
  const market = new AttritionMarket(null, () => 0.5);
  const before = market.quoteBuy('ammo_9mm');
  const paid = market.buy('ammo_9mm');
  assert.ok(market.quoteBuy('ammo_9mm') > before);
  const refund = market.sell(makeItem('ammo_9mm'));
  assert.ok(Math.abs(refund - paid) <= 1, '100% live quote has no fixed-price haircut');
  assert.equal(market.info('ammo_9mm').units, market.info('ammo_9mm').initial);
});

test('circuits retains its 55% sale adapter', () => {
  const market = new CircuitMarket();
  assert.equal(market.quoteSell(makeItem('rifle')), 825);
});

test('ten fight-linked envelopes disburse equal full bankrolls', () => {
  const state = newAttritionState(suggestedAttritionBankroll(), () => 0);
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
  const state = newAttritionState(25000, () => 0.9);
  let playerMoney = fundDraftRound(state, 0);
  assert.equal(playerMoney, 2500);
  // Main gates funding by round; the primitive tracks each funded bout explicitly.
  assert.equal(state.draft.fundedRounds, 1);
  assert.equal(state.draft.lastEnvelope, 2500);
});

test('the next draft envelope protects only a recoverable deficit', () => {
  const state = newAttritionState(25000, () => 0.5);
  fundDraftRound(state, 0);
  assert.equal(draftCanCoverDebt(state, -2400), true);
  assert.equal(draftCanCoverDebt(state, -2600), false);
  state.draft.complete = true;
  assert.equal(draftCanCoverDebt(state, -1), false);
});

test('rival AI pivots away from a squeezed 9mm pool and explains the buy', () => {
  const market = new AttritionMarket(null, () => 0.5);
  for (let i = 0; i < 7; i++) market.buy('ammo_9mm');
  const state = newAttritionState(20000, () => 0.5);
  state.enemyMoney = 10000;
  const action = runAttritionAI(state, market, { hoarded9mm: true });
  assert.equal(state.enemy.strategy, 'rifle');
  assert.ok(action.action.includes('RIFLE'));
  assert.ok(state.enemy.log[0].includes('bought'));
});

test('underdog sees comeback odds and can raise the stake', () => {
  const state = newAttritionState(20000, () => 0.5);
  state.enemyMoney = 20000;
  assert.ok(attritionOdds(state, 5000) > 2);
  assert.deepEqual(attritionBetOptions(state, 5000), [250, 500, 1250, 2500]);
  assert.deepEqual(attritionBetOptions(state, 100), [250]);
});

test('every third completed round resupplies only shared consumables and ammo', () => {
  const market = new AttritionMarket(null, () => 0.5);
  const state = newAttritionState(20000, () => 0.5);
  state.round = 4;
  const ammoBefore = market.info('ammo_762').units;
  const rifleBefore = market.info('rifle').units;
  const drop = resupplyAttrition(state, market, () => 0);
  assert.equal(drop.round, 3);
  assert.equal(market.info('ammo_762').units, ammoBefore + 2);
  assert.equal(market.info('rifle').units, rifleBefore);
  assert.match(state.enemy.log[0], /HOUSE RESUPPLY/);
});
