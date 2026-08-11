// Diagnostic pose: same framing as `arena`, but reports what is actually in the
// frame — draw calls per pass, and every mesh bright enough to be a suspect.
document.querySelectorAll('.screen, #hud').forEach((n) => { n.style.display = 'none'; });
const g = window.__game;
g.freeCam([13, 4.6, 12.5], [-2, 1.2, -5]);

const bright = [];
g.scene.traverse((o) => {
  const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
  for (const m of mats) {
    const ei = m.emissiveIntensity ?? 0;
    const isEmissive = m.emissive && (m.emissive.r + m.emissive.g + m.emissive.b) > 0.01 && ei > 0.5;
    if (isEmissive || m.isMeshBasicMaterial) {
      const p = new (o.position.constructor)();
      o.getWorldPosition(p);
      bright.push(`${o.type} ${m.type} name=${m.name || '-'} ei=${ei} at ${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)}`);
    }
  }
});

// Count draw calls for the raw scene only, bypassing the post chain.
g.renderer.info.autoReset = false;
g.renderer.info.reset();
g.renderer.render(g.scene, g.camera);
const raw = { ...g.renderer.info.render };
g.renderer.info.autoReset = true;

console.log('DIAG rawScene ' + JSON.stringify(raw));
console.log('DIAG quality ' + g.pipeline.quality + ' envIntensity ' + g.scene.environmentIntensity);
console.log('DIAG bright ' + JSON.stringify([...new Set(bright)], null, 1));

// Identify whatever is under a screen point, given as NDC. Guessing from a
// screenshot is slower than asking the scene.
const probes = [[-0.597, 0.014], [0.48, -0.056], [-0.2, -0.55], [0.0, 0.62]];
{
  const rc = new g.THREE.Raycaster();
  for (const [nx, ny] of probes) {
    rc.setFromCamera({ x: nx, y: ny }, g.camera);
    const hit = rc.intersectObjects(g.scene.children, true).filter((h) => h.object.visible)[0];
    const o = hit?.object;
    console.log(`DIAG probe ${nx},${ny} -> ${o ? `${o.type} mat=${o.material?.type} ei=${o.material?.emissiveIntensity} geo=${o.geometry?.type} dist=${hit.distance.toFixed(1)} at ${hit.point.x.toFixed(1)},${hit.point.y.toFixed(1)},${hit.point.z.toFixed(1)}` : 'nothing'}`);
  }
}
