const pct = value => `${(value * 100).toFixed(1)}%`;
const mean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;

export function analyze(events, wars) {
  const decisions = events.filter(e => e.event === 'liquidation_decision');
  const rounds = events.filter(e => e.event === 'round_end');
  const hits = events.filter(e => e.event === 'combat_hit');
  const shots = events.filter(e => e.event === 'combat_shot');
  const kills = events.filter(e => e.event === 'combat_kill');
  const holds = decisions.filter(e => e.decision.kind === 'hold');
  const buys = decisions.filter(e => e.decision.kind === 'buy' || e.decision.kind === 'hire');
  const sales = decisions.filter(e => e.decision.kind === 'sell');
  const countBy = (values, key) => Object.fromEntries([...new Set(values.map(key))]
    .map(value => [value, values.filter(item => key(item) === value).length]));
  const byWeapon = {};
  for (const shot of shots) (byWeapon[shot.weapon] ||= { shots: 0, hits: 0, kills: 0 }).shots++;
  for (const hit of hits) (byWeapon[hit.weapon] ||= { shots: 0, hits: 0, kills: 0 }).hits++;
  for (const kill of kills) (byWeapon[kill.weapon] ||= { shots: 0, hits: 0, kills: 0 }).kills++;
  for (const value of Object.values(byWeapon)) value.accuracy = value.shots ? value.hits / value.shots : 0;
  const result = {
    wars: wars.length,
    war_wins: Object.fromEntries(['alpha', 'bravo'].map(id => [id, wars.filter(w => w.winner === id).length])),
    endings: Object.fromEntries(['insolvency', 'round_cap'].map(reason => [reason, wars.filter(w => w.reason === reason).length])),
    rounds: { total: rounds.length, mean_per_war: mean(wars.map(w => w.rounds)),
      mean_duration_seconds: mean(rounds.map(r => r.duration)) },
    economy: { decisions: decisions.length, transactions: buys.length, sales: sales.length,
      emergency_sales: sales.filter(e => e.decision.reason === 'avoid_insolvency').length, holds: holds.length,
      reserve_holds: holds.filter(e => e.decision.reason === 'cash_reserve').length,
      mean_reserve_target: mean(decisions.map(e => e.decision.risk?.reserveTarget || 0)),
      strategy_switches: decisions.filter(e => e.before.strategy !== e.after.strategy).length,
      transactions_by_type: countBy(buys, e => e.decision.kind === 'hire' ? `hire:${e.decision.type}` : e.decision.type),
      decisions_by_strategy: countBy(decisions, e => e.after.strategy),
      mean_stake: mean(rounds.flatMap(r => Object.values(r.bets).map(b => b.amount))),
      mean_final_cash: mean(wars.flatMap(w => w.bots.map(bot => bot.cash))) },
    combat: { shots: shots.length, hits: hits.length, kills: kills.length,
      accuracy: shots.length ? hits.length / shots.length : 0, by_weapon: byWeapon },
  };
  const weaponLines = Object.entries(byWeapon).sort((a, b) => b[1].shots - a[1].shots)
    .map(([weapon, v]) => `- ${weapon}: ${v.shots} shots, ${pct(v.accuracy)} hits, ${v.kills} kills`);
  const learnings = [
    `${result.endings.insolvency}/${wars.length} wars ended through insolvency; average length was ${result.rounds.mean_per_war.toFixed(1)} rounds.`,
    `The bots made ${result.economy.transactions} purchases/hires, liquidated ${result.economy.sales} assets (${result.economy.emergency_sales} emergency sales), and held ${result.economy.holds} times.`,
    `Mean stake was $${result.economy.mean_stake.toFixed(0)} and mean ending cash was $${result.economy.mean_final_cash.toFixed(0)}.`,
    `Strategies switched ${result.economy.strategy_switches} times; decision mix was ${Object.entries(result.economy.decisions_by_strategy).map(([k, v]) => `${k} ${v}`).join(', ')}.`,
    `Combat produced ${shots.length} shots at ${pct(result.combat.accuracy)} aggregate hit rate and ${kills.length} kills.`,
  ];
  const markdown = `# Synthetic Liquidation Wars — ${wars.length}-war report

## Learnings

${learnings.map(line => `- ${line}`).join('\n')}

## Combat by weapon

${weaponLines.join('\n')}

## Symmetry check

- Alpha wins: ${result.war_wins.alpha}
- Bravo wins: ${result.war_wins.bravo}
- Shop order alternates each round; persistent win skew over larger samples would indicate a simulator or strategy bias.
`;
  return { result, markdown, learnings };
}
