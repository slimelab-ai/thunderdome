export const DEPLOYED_CREW_CAP = 5;
export const CREW_CONTRACT_CAP = 8;

export function deployedCrewCount(crew = []) {
  return crew.reduce((count, member) => count + (!member.benched ? 1 : 0), 0);
}

export function shouldBenchNewHire(crew = []) {
  return deployedCrewCount(crew) >= DEPLOYED_CREW_CAP;
}

// Older saves could contain more than five nominally deployed hires because
// hiring did not previously respect the deployment cap. Keep the first five
// active and migrate every overflow contract into the reserve locker.
export function normalizeCrewDeployment(crew = []) {
  let deployed = 0;
  for (const member of crew) {
    if (member.benched) continue;
    if (deployed < DEPLOYED_CREW_CAP) deployed++;
    else member.benched = true;
  }
  return crew;
}
