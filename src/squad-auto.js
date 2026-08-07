import { AMMO_TYPES, ITEM_TYPES, ammoInGrid, ammoInPack } from './items.js';
import { trainingCost, trainingTrees } from './progression.js';

export const AUTO_AMMO_STACKS = 2;

export function orderedSquad(career) {
  const crew = career.crew.map((member, index) => ({
    who: index,
    ch: member.ch,
    member,
  }));
  return [
    { who: 'player', ch: career.playerCh, member: null },
    ...crew.filter(entry => !entry.member.benched),
    ...crew.filter(entry => entry.member.benched),
  ];
}

export function nextShopCharacter(selection, current, direction = 1) {
  if (!selection.length) return null;
  const currentIndex = selection.findIndex(value => String(value) === String(current));
  const start = currentIndex < 0 ? 0 : currentIndex;
  return selection[(start + direction + selection.length) % selection.length];
}

export function planSquadHealing(fighters, budget) {
  const steps = [];
  let cost = 0;
  let remaining = Math.max(0, budget);
  for (const fighter of fighters) {
    const needed = Math.max(0, Math.round(fighter.cost || 0));
    if (needed <= 0 || remaining <= 0) continue;
    const pay = Math.min(needed, remaining);
    steps.push({ ...fighter, pay, full: pay >= needed });
    cost += pay;
    remaining -= pay;
    if (pay < needed) break;
  }
  const totalNeeded = fighters.reduce((total, fighter) => total + Math.max(0, Math.round(fighter.cost || 0)), 0);
  return { cost, steps, complete: cost >= totalNeeded };
}

function purchasePlanner(budget, quoteSeries) {
  const quantities = new Map();
  const purchases = [];
  let cost = 0;
  let stopped = false;

  const add = (purchase) => {
    if (stopped) return false;
    const quantity = quantities.get(purchase.type) || 0;
    const before = quantity > 0 ? quoteSeries(purchase.type, quantity) : 0;
    const after = quoteSeries(purchase.type, quantity + 1);
    if (!Number.isFinite(after)) return false; // sold out: try the next useful item
    const itemCost = Math.max(0, after - before);
    if (cost + itemCost > budget) {
      stopped = true;
      return false;
    }
    quantities.set(purchase.type, quantity + 1);
    const planned = { ...purchase, cost: itemCost };
    purchases.push(planned);
    cost += itemCost;
    return planned;
  };

  return {
    add,
    get stopped() { return stopped; },
    finish: () => ({ cost, purchases, quantities: Object.fromEntries(quantities) }),
  };
}

export function planSquadAmmo(
  fighters, budget, quoteSeries, stacksPerWeapon = AUTO_AMMO_STACKS, stash = null,
) {
  const planner = purchasePlanner(Math.max(0, budget), quoteSeries);
  const returns = [];
  const transfers = [];
  const returnedUids = new Set();
  const returnedRoundsByFighter = new Map();
  const stashRounds = new Map(Object.keys(AMMO_TYPES).map(ammoType => [
    ammoType,
    stash ? ammoInGrid(stash, ammoType) : 0,
  ]));
  const weaponCountsByFighter = new Map(fighters.map(fighter => {
    const counts = new Map();
    for (const slot of ['gun1', 'gun2']) {
      const gun = fighter.ch.gear[slot];
      const ammoType = gun && ITEM_TYPES[gun.type]?.ammo;
      if (ammoType) counts.set(ammoType, (counts.get(ammoType) || 0) + 1);
    }
    return [fighter, counts];
  }));

  const planReturn = (fighter, entry, rounds, reason) => {
    const def = ITEM_TYPES[entry.it.type];
    const take = Math.min(Math.max(0, rounds), entry.it.rounds);
    if (!take || def?.kind !== 'ammo') return;
    returns.push({
      source: 'pack', reason, who: fighter.who, uid: entry.it.uid,
      type: entry.it.type, rounds: take,
    });
    if (take >= entry.it.rounds) returnedUids.add(entry.it.uid);
    const fighterReturns = returnedRoundsByFighter.get(fighter) || new Map();
    fighterReturns.set(def.ammoType, (fighterReturns.get(def.ammoType) || 0) + take);
    returnedRoundsByFighter.set(fighter, fighterReturns);
    stashRounds.set(def.ammoType, (stashRounds.get(def.ammoType) || 0) + take);
  };

  // Pool incompatible and surplus ammo before planning any refill, so somebody
  // else's dead weight can supply an equipped weapon earlier in the roster on
  // the same click. Keep exactly the configured target for compatible weapons.
  for (const fighter of fighters) {
    const weaponCounts = weaponCountsByFighter.get(fighter);
    const ammoEntries = fighter.ch.pack.items.filter(entry => ITEM_TYPES[entry.it.type]?.kind === 'ammo');
    for (const entry of ammoEntries) {
      const def = ITEM_TYPES[entry.it.type];
      if (!weaponCounts.has(def.ammoType)) planReturn(fighter, entry, entry.it.rounds, 'incompatible');
    }
    for (const [ammoType, weaponCount] of weaponCounts) {
      const targetRounds = AMMO_TYPES[ammoType].box * stacksPerWeapon * weaponCount;
      const entries = ammoEntries
        .filter(entry => ITEM_TYPES[entry.it.type].ammoType === ammoType)
        .sort((a, b) => a.it.rounds - b.it.rounds);
      let excessRounds = Math.max(0,
        entries.reduce((total, entry) => total + entry.it.rounds, 0) - targetRounds);
      for (const entry of entries) {
        if (excessRounds <= 0) break;
        const take = Math.min(excessRounds, entry.it.rounds);
        planReturn(fighter, entry, take, 'excess');
        excessRounds -= take;
      }
    }
  }

  const steps = [...returns];

  for (const fighter of fighters) {
    if (planner.stopped) break;
    const weaponCounts = weaponCountsByFighter.get(fighter);
    const usedCells = fighter.ch.pack.items.reduce((total, entry) => {
      if (returnedUids.has(entry.it.uid)) return total;
      const def = ITEM_TYPES[entry.it.type];
      return total + (def?.w || 1) * (def?.h || 1);
    }, 0);
    let freeCells = Math.max(0, fighter.ch.pack.cols * fighter.ch.pack.rows - usedCells);
    for (const [ammoType, weaponCount] of weaponCounts) {
      const roundsPerStack = AMMO_TYPES[ammoType].box;
      const targetRounds = roundsPerStack * stacksPerWeapon * weaponCount;
      let carriedRounds = ammoInPack(fighter.ch, ammoType) -
        (returnedRoundsByFighter.get(fighter)?.get(ammoType) || 0);
      let carriedStacks = fighter.ch.pack.items.filter(entry => {
        const def = ITEM_TYPES[entry.it.type];
        return !returnedUids.has(entry.it.uid) && def?.kind === 'ammo' && def.ammoType === ammoType;
      }).length;
      const carryCapacity = (carriedStacks + freeCells) * roundsPerStack;
      let missingRounds = Math.max(0, Math.min(targetRounds, carryCapacity) - carriedRounds);

      const reserveRounds = Math.min(missingRounds, stashRounds.get(ammoType) || 0);
      if (reserveRounds > 0) {
        const transfer = { source: 'stash', who: fighter.who, type: `ammo_${ammoType}`, rounds: reserveRounds };
        transfers.push(transfer);
        steps.push(transfer);
        stashRounds.set(ammoType, (stashRounds.get(ammoType) || 0) - reserveRounds);
        const partialCapacity = Math.max(0, carriedStacks * roundsPerStack - carriedRounds);
        const newStacks = Math.ceil(Math.max(0, reserveRounds - partialCapacity) / roundsPerStack);
        carriedStacks += newStacks;
        freeCells -= newStacks;
        carriedRounds += reserveRounds;
        missingRounds -= reserveRounds;
      }

      while (missingRounds > 0) {
        const rounds = Math.min(roundsPerStack, missingRounds);
        const purchase = planner.add({
          source: 'market', who: fighter.who, type: `ammo_${ammoType}`, rounds,
        });
        if (!purchase) break;
        steps.push(purchase);

        const partialCapacity = Math.max(0, carriedStacks * roundsPerStack - carriedRounds);
        const newStacks = Math.ceil(Math.max(0, rounds - partialCapacity) / roundsPerStack);
        carriedStacks += newStacks;
        freeCells -= newStacks;
        carriedRounds += rounds;
        missingRounds -= rounds;

        // A market unit is always a full box. Any rounds not needed by this fighter
        // go into the stash and become available to the next fighter in roster order.
        stashRounds.set(ammoType, (stashRounds.get(ammoType) || 0) + roundsPerStack - rounds);
      }
      if (planner.stopped) break;
    }
  }

  return { ...planner.finish(), returns, transfers, steps, actionable: steps.length > 0 };
}

export function planSquadTraining(fighters) {
  const upgrades = [];
  let cost = 0;
  for (const fighter of fighters) {
    const progress = {
      xp: fighter.progress.xp,
      skills: { ...fighter.progress.skills },
    };
    const nodes = [...trainingTrees(fighter.type).common, ...trainingTrees(fighter.type).role];
    while (true) {
      const next = nodes
        .map((node, order) => ({
          id: node.id,
          order,
          cost: trainingCost(progress, fighter.type, node.id),
        }))
        .filter(candidate => Number.isFinite(candidate.cost) && candidate.cost <= progress.xp)
        .sort((a, b) => a.cost - b.cost || a.order - b.order)[0];
      if (!next) break;
      progress.xp -= next.cost;
      progress.skills[next.id] = (progress.skills[next.id] || 0) + 1;
      upgrades.push({ who: fighter.who, type: fighter.type, skillId: next.id, cost: next.cost });
      cost += next.cost;
    }
  }
  return { cost, upgrades };
}
