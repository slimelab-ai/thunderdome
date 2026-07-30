import { ITEM_TYPES, AMMO_TYPES } from './items.js';
import { HIRE_TYPES } from './progression.js';

export const recruitPoolKey = type => `recruit_${type}`;

// One market API serves both modes. Circuits uses the fixed-price adapter;
// Liquidation persists shared constant-product pools in the career save.
export function createMarket(mode, state = null, random = Math.random) {
  return mode === 'liquidation' ? new LiquidationMarket(state, random) : new CircuitMarket();
}

export class CircuitMarket {
  quoteBuy(type, quantity = 1, multiplier = 1) {
    return Math.round(ITEM_TYPES[type].price * multiplier * quantity);
  }
  quoteBuySeries(type, quantity = 1, multiplier = 1) {
    return this.quoteBuy(type, 1, multiplier) * quantity;
  }
  quoteSell(item, multiplier = 1) {
    const def = ITEM_TYPES[item.type];
    const fraction = def.kind === 'ammo' ? item.rounds / AMMO_TYPES[def.ammoType].box : 1;
    return Math.max(1, Math.round(def.price * multiplier * 0.55 * fraction));
  }
  buy() {}
  sell() {}
  quoteRecruit(type) { return HIRE_TYPES[type]?.price ?? Infinity; }
  buyRecruit(type) { return this.quoteRecruit(type); }
  quoteReleaseRecruit(type) { return Math.round((HIRE_TYPES[type]?.price || 0) * 0.5); }
  releaseRecruit(type) { return this.quoteReleaseRecruit(type); }
  recruitInfo() { return null; }
  snapshot() { return null; }
  info() { return null; }
}

export class LiquidationMarket {
  constructor(state = null, random = Math.random) {
    this.pools = state?.pools || {};
    for (const [type, def] of Object.entries(ITEM_TYPES)) {
      if (this.pools[type]) continue;
      const scarce = def.kind === 'ammo' || def.kind === 'consumable';
      const units = Math.max(4, Math.round((scarce ? 18 : 8) * (0.82 + random() * 0.36)));
      // x items * y dollars = k. Initial marginal price equals catalog price.
      this.pools[type] = { units, cash: units * def.price, initial: units };
    }
    for (const [type, def] of Object.entries(HIRE_TYPES)) {
      const key = recruitPoolKey(type);
      if (this.pools[key]) continue;
      const units = Math.max(5, Math.round(8 * (0.82 + random() * 0.36)));
      this.pools[key] = { units, cash: units * def.price, initial: units };
    }
  }
  _buyRaw(type, quantity = 1) {
    const p = this.pools[type];
    if (!p || quantity <= 0 || p.units <= quantity) return Infinity;
    return p.cash * quantity / (p.units - quantity);
  }
  quoteBuy(type, quantity = 1) { return Math.max(1, Math.ceil(this._buyRaw(type, quantity))); }
  quoteBuySeries(type, quantity = 1) {
    const pool = this.pools[type];
    if (!pool || quantity <= 0 || pool.units <= quantity) return quantity <= 0 ? 0 : Infinity;
    let units = pool.units;
    let cash = pool.cash;
    let total = 0;
    for (let i = 0; i < quantity; i++) {
      const cost = Math.max(1, Math.ceil(cash / (units - 1)));
      units--;
      cash += cost;
      total += cost;
    }
    return total;
  }
  buy(type, quantity = 1) {
    const cost = this.quoteBuy(type, quantity);
    if (!Number.isFinite(cost)) return Infinity;
    const p = this.pools[type];
    p.units -= quantity; p.cash += cost;
    return cost;
  }
  quoteSell(item) {
    const def = ITEM_TYPES[item.type];
    const q = def.kind === 'ammo' ? item.rounds / AMMO_TYPES[def.ammoType].box : 1;
    const p = this.pools[item.type];
    // Exact reverse AMM trade, rounded down: 100% market rate, no spread/tax.
    return Math.max(1, Math.floor(p.cash * q / (p.units + q)));
  }
  sell(item) {
    const def = ITEM_TYPES[item.type];
    const q = def.kind === 'ammo' ? item.rounds / AMMO_TYPES[def.ammoType].box : 1;
    const value = this.quoteSell(item);
    const p = this.pools[item.type];
    p.units += q; p.cash = Math.max(1, p.cash - value);
    return value;
  }
  quoteRecruit(type) { return this.quoteBuy(recruitPoolKey(type)); }
  buyRecruit(type) { return this.buy(recruitPoolKey(type)); }
  quoteReleaseRecruit(type) {
    const key = recruitPoolKey(type);
    const p = this.pools[key];
    return p ? Math.max(1, Math.floor(p.cash / (p.units + 1))) : 0;
  }
  releaseRecruit(type) {
    const key = recruitPoolKey(type);
    const p = this.pools[key];
    if (!p) return 0;
    const value = this.quoteReleaseRecruit(type);
    p.units += 1;
    p.cash = Math.max(1, p.cash - value);
    return value;
  }
  recruitInfo(type) { return this.info(recruitPoolKey(type)); }
  restock(type, quantity) {
    const p = this.pools[type];
    if (!p || quantity <= 0) return;
    // Supply drops add real units without adding quote currency, deliberately
    // easing shortages while leaving prior player trades in the pool.
    p.units += quantity;
  }
  snapshot() { return { pools: this.pools }; }
  info(type) {
    const p = this.pools[type];
    const pressure = p.initial / p.units;
    return { units: p.units, initial: p.initial, pressure, scarce: pressure > 1.28, surplus: pressure < 0.82 };
  }
}
