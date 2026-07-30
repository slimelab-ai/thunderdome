import { AMMO_TYPES, ITEM_TYPES, ammoInPack } from './items.js';
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
    purchases.push({ ...purchase, cost: itemCost });
    cost += itemCost;
    return true;
  };

  return {
    add,
    get stopped() { return stopped; },
    finish: () => ({ cost, purchases, quantities: Object.fromEntries(quantities) }),
  };
}

export function planSquadAmmo(fighters, budget, quoteSeries, stacksPerWeapon = AUTO_AMMO_STACKS) {
  const planner = purchasePlanner(Math.max(0, budget), quoteSeries);

  for (const fighter of fighters) {
    if (planner.stopped) break;
    const weaponCounts = new Map();
    for (const slot of ['gun1', 'gun2']) {
      const gun = fighter.ch.gear[slot];
      const ammoType = gun && ITEM_TYPES[gun.type]?.ammo;
      if (ammoType) weaponCounts.set(ammoType, (weaponCounts.get(ammoType) || 0) + 1);
    }
    let freeCells = Math.max(0, fighter.ch.pack.cols * fighter.ch.pack.rows - fighter.ch.pack.items.length);
    for (const [ammoType, weaponCount] of weaponCounts) {
      const roundsPerStack = AMMO_TYPES[ammoType].box;
      const targetRounds = roundsPerStack * stacksPerWeapon * weaponCount;
      const missing = Math.max(0, Math.ceil((targetRounds - ammoInPack(fighter.ch, ammoType)) / roundsPerStack));
      for (let i = 0; i < missing && freeCells > 0; i++) {
        if (!planner.add({ who: fighter.who, type: `ammo_${ammoType}` })) break;
        freeCells--;
      }
      if (planner.stopped) break;
    }
  }

  return planner.finish();
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
