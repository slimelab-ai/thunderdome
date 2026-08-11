// Wide establishing shot of the empty pit, HUD-free. The reference frame for
// every lighting/material change.
document.querySelectorAll('.screen, #hud').forEach((n) => { n.style.display = 'none'; });
window.__game.freeCam([13, 4.6, 12.5], [-2, 1.2, -5]);
console.log('DIAG', JSON.stringify({
  render: window.__game.renderer.info.render,
  memory: window.__game.renderer.info.memory,
  children: window.__game.scene.children.length,
}));
