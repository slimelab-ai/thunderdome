/**
 * Render layers.
 *
 * `NO_OCCLUDE` is for things that are drawn but are not *surfaces*: muzzle flashes,
 * particles, tracers, decals, and the name tags over your crew. The camera renders the
 * layer normally; the ambient occlusion pass drops it.
 *
 * It exists because GTAO rebuilds depth and normals by re-rendering the scene with an
 * override material, and an override material knows nothing about blending or
 * billboarding. Anything left on the default layer goes into that buffer as solid
 * geometry, so it occludes — including itself. The muzzle flash shipped as a black
 * rectangle boxing its own flare, and the crew name tags shipped with a dark panel
 * behind them at a different angle to the text, because the sprite billboards toward
 * the camera in the beauty pass and the override material draws the raw quad where it
 * actually sits.
 *
 * The rule is narrow on purpose. Chain-link and glass are transparent too, and they
 * stay on the default layer: they are real surfaces that should occlude and should
 * cast shadows. What belongs here is anything with no physical presence at all.
 *
 * This lives in its own module rather than in fx.js because it is not an fx concept —
 * name tags are UI, and combatant.js should not have to import the particle system to
 * find out which layer means "not a thing".
 */
export const NO_OCCLUDE_LAYER = 2;
