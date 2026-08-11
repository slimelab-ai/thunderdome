import { randomUUID } from 'node:crypto';
import { LiquidationMarket } from '../../src/market.js';
import {
  LIQUIDATION_DRAFT_TURNS,
  draftShare,
  enemyRoster,
  liquidationOdds,
  newLiquidationState,
  resupplyLiquidation,
  runLiquidationAI,
  suggestedLiquidationBankroll,
} from '../../src/liquidation.js';

const WEAPONS = {
  knife: { damage: 55, rpm: 95, accuracy: 0.72 },
  pistol: { damage: 34, rpm: 280, accuracy: 0.62 },
  smg: { damage: 15, rpm: 850, accuracy: 0.43 },
  shotgun: { damage: 17 * 4.5, rpm: 82, accuracy: 0.58 },
  rifle: { damage: 43, rpm: 600, accuracy: 0.68 },
  dmr: { damage: 82, rpm: 145, accuracy: 0.79 },
};

export function seededRandom(seed = Date.now()) {
  let value = Number(seed) >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let mixed = value;
    mixed = Math.imul(mixed ^ mixed >>> 15, mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ mixed >>> 7, mixed | 61);
    return ((mixed ^ mixed >>> 14) >>> 0) / 4294967296;
  };
}

function makeBot(id, bankroll, random) {
  const state = newLiquidationState(bankroll, random);
  state.enemyMoney = 0;
  state.enemy.strategy = ['balanced', 'rifle', 'swarm', 'heavy'][Math.floor(random() * 4)];
  state.marketLog = [];
  return { id, state, wins: 0, losses: 0 };
}

function power(bot) {
  return enemyRoster(bot.state).reduce((sum, fighter) => {
    const weapon = WEAPONS[fighter.w] || WEAPONS.pistol;
    return sum + fighter.hp * weapon.damage * weapon.accuracy * (1 + fighter.ar);
  }, 0);
}

function snapshot(bot) {
  return {
    bot: bot.id,
    cash: Math.round(bot.state.enemyMoney),
    strategy: bot.state.enemy.strategy,
    recruits: [...bot.state.enemy.recruits],
    inventory: { ...bot.state.enemy.inventory },
    power: Math.round(power(bot)),
    loss_streak: bot.state.enemyLossStreak || 0,
  };
}

function shop(bot, opponent, market, emit, options = {}) {
  let actions = 0;
  while (actions++ < 40) {
    const before = snapshot(bot);
    const decision = runLiquidationAI(bot.state, market, {
      opponentPower: power(opponent),
      expectedStake: 250,
      hoarded9mm: (opponent.state.enemy.inventory.ammo_9mm || 0) >= 4,
      liquidationOnly: options.liquidationOnly === true,
    });
    emit('liquidation_decision', {
      bot: bot.id, decision, before, after: snapshot(bot),
    });
    if (decision.kind === 'hold') break;
  }
}

function chooseStake(bot, opponent) {
  const cash = bot.state.enemyMoney;
  const odds = liquidationOdds({ enemyMoney: opponent.state.enemyMoney }, cash);
  const confidence = power(bot) / Math.max(1, power(bot) + power(opponent));
  const nextPenalty = bot.state.enemyLossStreak > 0
    ? draftShare(bot.state) * bot.state.enemyLossStreak / 2
    : 0;
  const runway = 250 + nextPenalty + Math.max(250, enemyRoster(bot.state).length * 100);
  const riskable = Math.max(0, cash - runway);
  const fraction = confidence > 0.66 ? 0.25 : confidence < 0.4 ? 0.05 : 0.1;
  return {
    amount: Math.max(250, Math.min(riskable,
      Math.floor(cash * fraction / 50) * 50)),
    odds,
    confidence: +confidence.toFixed(3),
    runway: Math.round(runway),
  };
}

function consume(bot, type, amount) {
  const current = bot.state.enemy.inventory[type] || 0;
  bot.state.enemy.inventory[type] = Math.max(0, +(current - amount).toFixed(3));
}

function fight(botA, botB, random, emit) {
  const teams = new Map([[botA.id, botA], [botB.id, botB]]);
  const fighters = [botA, botB].flatMap(bot => enemyRoster(bot.state).map((fighter, index) => ({
    ...fighter, id: `${bot.id}-${index + 1}`, bot: bot.id, maxHp: fighter.hp,
    hp: fighter.hp, nextAction: fighter.re + random() * 0.4, shots: 0,
  })));
  let elapsed = 0;
  let sequence = 0;
  while (elapsed < 180 && new Set(fighters.filter(f => f.hp > 0).map(f => f.bot)).size > 1) {
    const living = fighters.filter(f => f.hp > 0);
    const actor = living.reduce((first, f) => f.nextAction < first.nextAction ? f : first);
    elapsed = actor.nextAction;
    const targets = living.filter(f => f.bot !== actor.bot);
    if (!targets.length) break;
    const target = targets[Math.floor(random() * targets.length)];
    const weapon = actor.ammo > actor.shots ? actor.w : 'knife';
    const stats = WEAPONS[weapon] || WEAPONS.pistol;
    actor.nextAction += 60 / stats.rpm + random() * 0.08;
    actor.shots++;
    emit('combat_shot', { sequence: sequence++, time: +elapsed.toFixed(3), actor: actor.id,
      bot: actor.bot, target: target.id, weapon });
    const hitChance = Math.max(0.08, stats.accuracy / actor.sp);
    if (random() > hitChance) continue;
    const partRoll = random();
    const part = partRoll < 0.08 ? 'head' : partRoll < 0.72 ? 'torso' : 'limb';
    const partMult = part === 'head' ? 2.5 : part === 'limb' ? 0.7 : 1;
    const mitigation = part === 'torso' ? target.ar : target.ar * 0.5;
    const damage = Math.max(1, Math.round(stats.damage * partMult * (1 - mitigation) * (0.88 + random() * 0.24)));
    target.hp = Math.max(0, target.hp - damage);
    emit('combat_hit', { sequence: sequence++, time: +elapsed.toFixed(3), actor: actor.id,
      bot: actor.bot, target: target.id, target_bot: target.bot, weapon, part, damage,
      target_hp: target.hp });
    if (target.hp <= 0) {
      emit('combat_kill', { sequence: sequence++, time: +elapsed.toFixed(3), actor: actor.id,
        bot: actor.bot, target: target.id, target_bot: target.bot, weapon, part });
    } else {
      const targetBot = teams.get(target.bot);
      if (target.hp < target.maxHp * 0.4 && (targetBot.state.enemy.inventory.medkit || 0) >= 1 && random() < 0.18) {
        target.hp = Math.min(target.maxHp, target.hp + 45);
        consume(targetBot, 'medkit', 1);
        emit('combat_heal', { sequence: sequence++, time: +elapsed.toFixed(3), actor: target.id,
          bot: target.bot, amount: 45, target_hp: target.hp });
      }
    }
  }
  for (const bot of [botA, botB]) {
    const roster = fighters.filter(f => f.bot === bot.id);
    const rounds = roster.reduce((sum, f) => sum + Math.min(f.shots, f.ammo), 0);
    const ammoTypes = new Set(roster.map(f => f.w === 'smg' || f.w === 'pistol' ? 'ammo_9mm'
      : f.w === 'rifle' ? 'ammo_762' : f.w === 'shotgun' ? 'ammo_buck' : 'ammo_308'));
    for (const type of ammoTypes) consume(bot, type, rounds / Math.max(1, roster.length) / 60);
  }
  const alive = id => fighters.filter(f => f.bot === id && f.hp > 0).length;
  const aAlive = alive(botA.id);
  const bAlive = alive(botB.id);
  const winner = aAlive === bAlive ? (random() < 0.5 ? botA : botB) : (aAlive > bAlive ? botA : botB);
  return { winner, duration: +elapsed.toFixed(3), survivors: { [botA.id]: aAlive, [botB.id]: bAlive } };
}

function insolvent(bot) {
  return bot.state.enemyMoney < 0 && (bot.state.draft.complete ||
    bot.state.enemyMoney + draftShare(bot.state) < 0);
}

export function simulateWar({ seed = Date.now(), maxRounds = 60, onEvent = () => {} } = {}) {
  const random = seededRandom(seed);
  const bankroll = suggestedLiquidationBankroll();
  const warId = randomUUID();
  const bots = [makeBot('alpha', bankroll, random), makeBot('bravo', bankroll, random)];
  const market = new LiquidationMarket(null, random);
  let eventIndex = 0;
  let round = 1;
  const emit = (event, data = {}) => onEvent({
    schema_version: 1, war_id: warId, seed, event_index: eventIndex++, round, event, ...data,
  });
  emit('war_start', { bankroll });
  while (round <= maxRounds && !bots.some(insolvent)) {
    for (const bot of bots) {
      bot.state.round = round;
      if (round <= LIQUIDATION_DRAFT_TURNS) {
        bot.state.draft.lastEnvelope = draftShare(bot.state);
        bot.state.enemyMoney += bot.state.draft.lastEnvelope;
        bot.state.draft.fundedRounds++;
        bot.state.draft.complete = bot.state.draft.fundedRounds >= LIQUIDATION_DRAFT_TURNS;
      }
    }
    emit('round_start', { bots: bots.map(snapshot), market: market.snapshot() });
    const order = round % 2 ? bots : [...bots].reverse();
    shop(order[0], order[1], market, emit);
    shop(order[1], order[0], market, emit);
    const bets = Object.fromEntries(bots.map(bot => [bot.id, chooseStake(bot, bots.find(x => x !== bot))]));
    emit('stakes_placed', { bets, bots: bots.map(snapshot) });
    const combat = fight(bots[0], bots[1], random, emit);
    const loser = bots.find(bot => bot !== combat.winner);
    const winnerBet = bets[combat.winner.id];
    const loserBet = bets[loser.id];
    combat.winner.state.enemyMoney += Math.round(winnerBet.amount * winnerBet.odds) - winnerBet.amount;
    loser.state.enemyMoney -= loserBet.amount;
    combat.winner.wins++; loser.losses++;
    combat.winner.state.enemyLossStreak = 0;
    loser.state.enemyLossStreak = (loser.state.enemyLossStreak || 0) + 1;
    const loserPenalty = loser.state.enemyLossStreak < 2 ? 0
      : Math.round(draftShare(loser.state) * (loser.state.enemyLossStreak - 1) / 2);
    loser.state.enemyMoney -= loserPenalty;
    shop(loser, combat.winner, market, emit, { liquidationOnly: true });
    emit('round_end', { winner: combat.winner.id, loser: loser.id, duration: combat.duration,
      survivors: combat.survivors, loser_penalty: loserPenalty, bets, bots: bots.map(snapshot) });
    round++;
    for (const bot of bots) bot.state.round = round;
    resupplyLiquidation(bots[0].state, market, random);
  }
  const sorted = [...bots].sort((a, b) => b.state.enemyMoney - a.state.enemyMoney || b.wins - a.wins);
  const reason = bots.some(insolvent) ? 'insolvency' : 'round_cap';
  emit('war_end', { winner: sorted[0].id, reason, rounds: round - 1, bots: bots.map(snapshot) });
  return { warId, seed, winner: sorted[0].id, reason, rounds: round - 1, bots: bots.map(snapshot) };
}
