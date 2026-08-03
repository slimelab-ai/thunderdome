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
  const stashRounds = new Map(Object.keys(AMMO_TYPES).map(ammoType => [
    ammoType,
    stash ? ammoInGrid(stash, ammoType) : 0,
  ]));

  // Pool incompatible ammo before planning any refill, so somebody else's dead
  // weight can supply an equipped weapon earlier in the roster on the same click.
  for (const fighter of fighters) {
    const usableAmmo = new Set(['gun1', 'gun2']
      .map(slot => fighter.ch.gear[slot])
      .filter(Boolean)
      .map(gun => ITEM_TYPES[gun.type]?.ammo)
      .filter(Boolean));
    for (const entry of fighter.ch.pack.items) {
      const def = ITEM_TYPES[entry.it.type];
      if (def?.kind !== 'ammo' || usableAmmo.has(def.ammoType)) continue;
      const step = {
        source: 'pack', who: fighter.who, uid: entry.it.uid,
        type: entry.it.type, rounds: entry.it.rounds,
      };
      returns.push(step);
      returnedUids.add(entry.it.uid);
      stashRounds.set(def.ammoType, (stashRounds.get(def.ammoType) || 0) + entry.it.rounds);
    }
  }

  const steps = [...returns];

  for (const fighter of fighters) {
    if (planner.stopped) break;
    const weaponCounts = new Map();
    for (const slot of ['gun1', 'gun2']) {
      const gun = fighter.ch.gear[slot];
      const ammoType = gun && ITEM_TYPES[gun.type]?.ammo;
      if (ammoType) weaponCounts.set(ammoType, (weaponCounts.get(ammoType) || 0) + 1);
    }
    const usedCells = fighter.ch.pack.items.reduce((total, entry) => {
      if (returnedUids.has(entry.it.uid)) return total;
      const def = ITEM_TYPES[entry.it.type];
      return total + (def?.w || 1) * (def?.h || 1);
    }, 0);
    let freeCells = Math.max(0, fighter.ch.pack.cols * fighter.ch.pack.rows - usedCells);
    for (const [ammoType, weaponCount] of weaponCounts) {
      const roundsPerStack = AMMO_TYPES[ammoType].box;
      const targetRounds = roundsPerStack * stacksPerWeapon * weaponCount;
      let carriedRounds = ammoInPack(fighter.ch, ammoType);
      let carriedStacks = fighter.ch.pack.items.filter(entry => {
        const def = ITEM_TYPES[entry.it.type];
        return def?.kind === 'ammo' && def.ammoType === ammoType;
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

  return { ...planner.finish(), returns, transfers, steps };
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
