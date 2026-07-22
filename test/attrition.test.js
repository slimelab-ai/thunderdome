import test from 'node:test';
import assert from 'node:assert/strict';
import { AttritionMarket, CircuitMarket } from '../src/market.js';
import { makeItem } from '../src/items.js';
import {
  newAttritionState, advanceDraft, runAttritionAI, suggestedAttritionBankroll,
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

test('twenty alternating envelopes disburse equal full bankrolls', () => {
  const state = newAttritionState(suggestedAttritionBankroll(), () => 0);
  let playerMoney = 0;
  for (let guard = 0; guard < 30 && !state.draft.complete; guard++) {
    playerMoney = advanceDraft(state, playerMoney);
  }
  assert.equal(state.draft.turn, 20);
  assert.equal(playerMoney, state.bankroll);
  assert.equal(state.enemyMoney, state.bankroll);
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
