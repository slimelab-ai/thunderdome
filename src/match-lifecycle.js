export const ACTIVE_MATCH_KEY = 'thunderdome_analytics_active_match_v1';

const finiteNumber = (value, fallback = null) => Number.isFinite(value) ? value : fallback;

function compactFighter(fighter) {
  if (!fighter || typeof fighter !== 'object') return null;
  return {
    name: String(fighter.name || 'UNKNOWN').slice(0, 80),
    team: fighter.team === 'player' || fighter.team === 'enemy' ? fighter.team : null,
    alive: typeof fighter.alive === 'boolean' ? fighter.alive : null,
    hp: finiteNumber(fighter.hp),
    max_hp: finiteNumber(fighter.maxHp ?? fighter.max_hp),
  };
}

function compactSquad(squad) {
  if (!squad || typeof squad !== 'object') return null;
  const fighters = value => Array.isArray(value)
    ? value.slice(0, 16).map(compactFighter).filter(Boolean)
    : [];
  return {
    player: compactFighter(squad.player),
    crew: fighters(squad.crew),
    enemies: fighters(squad.enemies),
  };
}

function compactEconomy(economy) {
  if (!economy || typeof economy !== 'object') return null;
  return {
    player_money: finiteNumber(economy.player_money),
    stake: finiteNumber(economy.stake),
    rival_money: finiteNumber(economy.rival_money),
    player_wins: finiteNumber(economy.player_wins),
    rival_wins: finiteNumber(economy.rival_wins),
    player_loss_streak: finiteNumber(economy.player_loss_streak),
    rival_loss_streak: finiteNumber(economy.rival_loss_streak),
  };
}

function terminalPayload(active, reason, details = {}) {
  const winner = details.winner === 'player' || details.winner === 'rival'
    ? details.winner
    : null;
  return {
    match_id: active.match_id,
    mode: active.mode,
    round: active.round,
    terminal_reason: reason,
    winner,
    duration: finiteNumber(details.duration),
    kills: finiteNumber(details.kills, 0),
    headshots: finiteNumber(details.headshots, 0),
    final_squad: compactSquad(details.final_squad),
    pre_settlement_economy: compactEconomy(details.pre_settlement_economy),
    lifecycle_sequence: 2,
  };
}

export function markKnownOutcome(match, { won, endDelay }, journal) {
  if (!match || match.ended) return false;
  match.ended = true;
  match.won = won;
  match.endTimer = endDelay;
  try {
    journal?.();
  } catch {
    // The outcome is gameplay state; telemetry is never allowed to roll it back.
  }
  return true;
}

export class MatchLifecycle {
  constructor({
    analytics,
    storage = globalThis.localStorage,
    now = () => new Date().toISOString(),
    randomUUID = () => globalThis.crypto.randomUUID(),
  }) {
    this.analytics = analytics;
    this.storage = storage;
    this.now = now;
    this.randomUUID = randomUUID;
    this.active = null;
  }

  context(active) {
    return {
      career_id: active.career_id,
      war_id: active.war_id,
      mode: active.mode,
      round: active.round,
      match_id: active.match_id,
    };
  }

  readActive() {
    if (this.active) return this.active;
    try {
      const parsed = JSON.parse(this.storage?.getItem(ACTIVE_MATCH_KEY) || 'null');
      if (parsed?.version === 1 && parsed.match_id && parsed.terminal_event_id) {
        this.active = parsed;
      }
    } catch {
      // Gameplay and recovery remain available when browser storage is disabled.
    }
    return this.active;
  }

  writeActive(active) {
    this.active = active;
    try {
      this.storage?.setItem(ACTIVE_MATCH_KEY, JSON.stringify(active));
      return true;
    } catch {
      return false;
    }
  }

  clearIfDurable(eventId) {
    let durable = false;
    try {
      durable = this.analytics?.isDurablyQueued?.(eventId) === true;
    } catch {
      durable = false;
    }
    if (!durable) return false;
    try {
      this.storage?.removeItem(ACTIVE_MATCH_KEY);
      this.active = null;
      return true;
    } catch {
      return false;
    }
  }

  begin({ matchId, careerId, warId = null, mode, round = null }, enterPayload = {}) {
    if (this.readActive()) this.recoverIncomplete();
    const active = {
      version: 1,
      match_id: matchId,
      career_id: careerId,
      war_id: warId,
      mode,
      round,
      started_at: this.now(),
      enter_event_id: this.randomUUID(),
      terminal_event_id: this.randomUUID(),
      lifecycle_sequence: 1,
    };
    this.writeActive(active);
    try {
      this.analytics?.emit('match_enter', {
        ...enterPayload,
        match_id: matchId,
        lifecycle_sequence: 1,
      }, {
        eventId: active.enter_event_id,
        context: this.context(active),
      });
    } catch {
      // Analytics is fail-open: starting combat must never depend on telemetry.
    }
    return active;
  }

  finalize(reason, detailsFactory = () => ({})) {
    const active = this.readActive();
    if (!active) return null;

    let payload = active.terminal_payload;
    if (!payload) {
      let details = {};
      try {
        details = detailsFactory?.() || {};
      } catch {
        details = {};
      }
      payload = terminalPayload(active, reason, details);
      this.writeActive({
        ...active,
        terminal_reason: reason,
        terminal_payload: payload,
        terminal_journaled_at: this.now(),
      });
    }

    try {
      this.analytics?.emit('match_terminal', payload, {
        eventId: active.terminal_event_id,
        context: this.context(active),
      });
    } catch {
      // The persisted marker lets the next startup retry the same terminal ID.
    }
    this.clearIfDurable(active.terminal_event_id);
    return { event_id: active.terminal_event_id, payload };
  }

  recoverIncomplete() {
    const active = this.readActive();
    if (!active) return null;
    if (active.terminal_payload) {
      return this.finalize(active.terminal_reason || 'recovered_incomplete');
    }
    return this.finalize('recovered_incomplete', () => ({
      winner: null,
      duration: null,
      kills: 0,
      headshots: 0,
      final_squad: null,
      pre_settlement_economy: null,
    }));
  }
}
