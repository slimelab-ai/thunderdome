export const LAST_CREW_STABILIZATION_BANKROLL = 500;

/**
 * Keep a broke Circuits career from becoming a permanently solo save.
 *
 * This is deliberately not healing: it only revives one existing, deployed
 * teammate at 1 HP after the entire crew has gone down. The player still has
 * to earn enough in combat to patch the squad properly.
 */
export function stabilizeLastCrew(crew, money, bankrollLimit = LAST_CREW_STABILIZATION_BANKROLL) {
  if (!Array.isArray(crew) || money >= bankrollLimit) return null;
  if (crew.some(member => !member.benched && (member.hp == null || member.hp > 0))) return null;

  const target = crew
    .filter(member => !member.benched && member.hp != null && member.hp <= 0)
    .sort((a, b) =>
      ((b.progress?.totalXp || 0) - (a.progress?.totalXp || 0))
      || ((b.kills || 0) - (a.kills || 0)))[0];

  if (!target) return null;
  target.hp = 1;
  return target;
}
