import { ITEM_TYPES, AMMO_TYPES } from './items.js';

// One market API serves both modes. Circuits uses the fixed-price adapter;
// Liquidation persists shared constant-product pools in the career save.
export function createMarket(mode, state = null, random = Math.random) {
  return mode === 'liquidation' ? new LiquidationMarket(state, random) : new CircuitMarket();
}

export class CircuitMarket {
  quoteBuy(type, quantity = 1, multiplier = 1) {
    return Math.round(ITEM_TYPES[type].price * multiplier * quantity);
  }
  quoteSell(item, multiplier = 1) {
    const def = ITEM_TYPES[item.type];
    const fraction = def.kind === 'ammo' ? item.rounds / AMMO_TYPES[def.ammoType].box : 1;
    return Math.max(1, Math.round(def.price * multiplier * 0.55 * fraction));
  }
  buy() {}
  sell() {}
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
  }
  _buyRaw(type, quantity = 1) {
    const p = this.pools[type];
    if (!p || quantity <= 0 || p.units <= quantity) return Infinity;
    return p.cash * quantity / (p.units - quantity);
  }
  quoteBuy(type, quantity = 1) { return Math.max(1, Math.ceil(this._buyRaw(type, quantity))); }
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
