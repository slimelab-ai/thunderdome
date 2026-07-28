// Mobile touch controls: a floating virtual thumbstick on the left half moves,
// the broad, unobstructed middle/right surface aims, and actions sit on the
// screen edges. The InputHub reads
// moveX/moveY (running them through the exponential stick curve) and drains
// look deltas via consumeLook(); button edges call straight into the player.

const STICK_R = 52;   // px travel of the virtual stick

export function isTouchDevice() {
  // A mouse/trackpad can become the "primary" pointer on hybrid devices, so
  // requiring `(pointer: coarse)` incorrectly hides touch controls there.
  // `?touch=1` is also useful for validating the mobile HUD from desktop.
  const override = new URLSearchParams(window.location.search).get('touch');
  if (override === '1') return true;
  if (override === '0') return false;
  const touchCapable = navigator.maxTouchPoints > 0 || 'ontouchstart' in window;
  const hasCoarsePointer = matchMedia('(any-pointer: coarse)').matches
    || matchMedia('(pointer: coarse)').matches;
  return touchCapable || hasCoarsePointer;
}

export class TouchControls {
  constructor(player, { onPause, onCycleSpectator } = {}) {
    this.player = player;
    this.onPause = onPause || (() => {});
    this.onCycleSpectator = onCycleSpectator || (() => {});
    this.enabled = false;
    this.spectating = false;
    this.moveX = 0;             // raw virtual-stick deflection, -1..1
    this.moveY = 0;
    this.sprint = false;        // slam the stick forward to sprint
    this._dx = 0;               // banked aim-drag pixels since last consume
    this._dy = 0;
    this._move = null;          // {id, x, y} — the touch owning the stick
    this._looks = new Map();    // touch id → last {x, y} for drag aiming
    this._btnTouches = new Map();
    this._firing = false;
    this._lookHintShown = false;
    this._build();
  }

  consumeLook() {
    const out = { dx: this._dx, dy: this._dy };
    this._dx = 0;
    this._dy = 0;
    return out;
  }

  setVisible(v) {
    if (v === this.enabled) return;
    this.enabled = v;
    this.root.classList.toggle('hidden', !v);
    if (v && !this._lookHintShown) {
      this._lookHintShown = true;
      this.root.classList.add('show-look-hint');
    }
    if (!v) this._resetAll();
  }

  // dead-but-spectating: collapse to just the pause button; taps switch fighters
  setSpectating(v) {
    if (v === this.spectating) return;
    this.spectating = v;
    this.root.classList.toggle('spectating', v);
    if (v) this._resetAll();
  }

  // toggle-button highlights follow the player's real state
  sync() {
    const p = this.player;
    this.root.querySelector('#t-ads').classList.toggle('on', !!p.adsHeld);
    this.root.querySelector('#t-crouch').classList.toggle('on', !!p.crouchToggled);
    this.root.querySelector('#t-lean-left').classList.toggle('on', p.leanToggle === -1);
    this.root.querySelector('#t-lean-right').classList.toggle('on', p.leanToggle === 1);
  }

  _build() {
    const root = document.createElement('div');
    root.id = 'touch-ui';
    root.className = 'hidden';
    root.innerHTML = `
      <div id="t-look-hint" aria-hidden="true"><span>DRAG TO LOOK</span></div>
      <div id="t-stick"><div id="t-stick-nub"></div></div>
      <button id="t-pause" class="t-btn t-square" aria-label="Pause">❚❚</button>
      <button id="t-fire" class="t-btn" aria-label="Fire">FIRE</button>
      <button id="t-ads" class="t-btn" aria-label="Aim down sights">ADS</button>
      <button id="t-jump" class="t-btn" aria-label="Jump">JUMP</button>
      <button id="t-reload" class="t-btn" aria-label="Reload">RLD</button>
      <button id="t-crouch" class="t-btn" aria-label="Toggle crouch">CRCH</button>
      <button id="t-swap" class="t-btn t-square" aria-label="Swap weapon">SWAP</button>
      <button id="t-knife" class="t-btn t-square" aria-label="Toggle knife">🔪</button>
      <button id="t-nade" class="t-btn t-square" aria-label="Throw grenade">💣</button>
      <button id="t-med" class="t-btn t-square" aria-label="Use medkit">✚</button>
      <button id="t-splint" class="t-btn t-square" aria-label="Use splint">🩹</button>
      <button id="t-lean-left" class="t-btn t-lean" aria-label="Toggle lean left"><b>‹</b><span>LEAN</span></button>
      <button id="t-lean-right" class="t-btn t-lean" aria-label="Toggle lean right"><span>LEAN</span><b>›</b></button>`;
    document.body.appendChild(root);
    this.root = root;
    this.stick = root.querySelector('#t-stick');
    this.nub = root.querySelector('#t-stick-nub');

    const p = this.player;
    // aims: keep dragging on the fire button to track while shooting
    this._actions = {
      't-fire': { down: () => { p.onMouseDown(0); this._firing = true; }, up: () => { p.onMouseUp(0); this._firing = false; }, aims: true },
      't-ads': { down: () => { p.adsHeld = !p.adsHeld; } },
      't-jump': { down: () => p.onKey('Space', true), up: () => p.onKey('Space', false) },
      't-reload': { down: () => p.startReload() },
      't-crouch': { down: () => { p.crouchToggled = !p.crouchToggled; } },
      't-swap': { down: () => p.onWheel(1) },
      't-knife': { down: () => (p.knifeOut ? p.onWheel(1) : p.drawKnife()) },
      't-nade': { down: () => p.throwGrenade() },
      't-med': { down: () => p.startHeal('medkit') },
      't-splint': { down: () => p.startHeal('splint') },
      't-lean-left': { down: () => { p.leanToggle = p.leanToggle === -1 ? 0 : -1; } },
      't-lean-right': { down: () => { p.leanToggle = p.leanToggle === 1 ? 0 : 1; } },
      't-pause': { down: () => this.onPause() },
    };

    root.addEventListener('touchstart', (e) => { e.preventDefault(); for (const t of e.changedTouches) this._start(t); }, { passive: false });
    root.addEventListener('touchmove', (e) => { e.preventDefault(); for (const t of e.changedTouches) this._moveTouch(t); }, { passive: false });
    root.addEventListener('touchend', (e) => { e.preventDefault(); for (const t of e.changedTouches) this._end(t); }, { passive: false });
    root.addEventListener('touchcancel', (e) => { for (const t of e.changedTouches) this._end(t); });
  }

  _start(t) {
    const btn = t.target.closest?.('.t-btn');
    if (this.spectating) {
      if (btn?.id === 't-pause') this.onPause();
      else this.onCycleSpectator(t.clientX < window.innerWidth / 2 ? -1 : 1);
      return;
    }
    if (btn) {
      const act = this._actions[btn.id];
      act?.down?.();
      this._btnTouches.set(t.identifier, btn.id);
      btn.classList.add('press');
      if (act?.aims) this._looks.set(t.identifier, { x: t.clientX, y: t.clientY });
      return;
    }
    if (t.clientX < window.innerWidth * 0.42 && !this._move) {
      this._move = { id: t.identifier, x: t.clientX, y: t.clientY };
      this.stick.style.display = 'block';
      this.stick.style.left = `${t.clientX}px`;
      this.stick.style.top = `${t.clientY}px`;
      this._setStick(0, 0);
    } else {
      this._looks.set(t.identifier, { x: t.clientX, y: t.clientY });
    }
  }

  _moveTouch(t) {
    if (this._move && t.identifier === this._move.id) {
      let dx = (t.clientX - this._move.x) / STICK_R;
      let dy = (t.clientY - this._move.y) / STICK_R;
      const m = Math.hypot(dx, dy);
      if (m > 1) { dx /= m; dy /= m; }
      this._setStick(dx, dy);
      // slam forward → sprint; ease off → walk (hysteresis so it doesn't flicker)
      if (m > 0.92 && dy < -0.35) this.sprint = true;
      else if (m < 0.7) this.sprint = false;
      return;
    }
    const look = this._looks.get(t.identifier);
    if (look) {
      this._dx += t.clientX - look.x;
      this._dy += t.clientY - look.y;
      look.x = t.clientX;
      look.y = t.clientY;
    }
  }

  _end(t) {
    const btnId = this._btnTouches.get(t.identifier);
    if (btnId) {
      this._actions[btnId]?.up?.();
      this.root.querySelector(`#${btnId}`)?.classList.remove('press');
      this._btnTouches.delete(t.identifier);
    }
    if (this._move && t.identifier === this._move.id) {
      this._move = null;
      this.sprint = false;
      this._setStick(0, 0);
      this.stick.style.display = 'none';
    }
    this._looks.delete(t.identifier);
  }

  _setStick(dx, dy) {
    this.moveX = dx;
    this.moveY = dy;
    this.nub.style.transform = `translate(${dx * STICK_R}px, ${dy * STICK_R}px)`;
  }

  _resetAll() {
    if (this._firing) { this.player.onMouseUp(0); this._firing = false; }
    this.player.onKey('Space', false);
    for (const id of this._btnTouches.values()) this.root.querySelector(`#${id}`)?.classList.remove('press');
    this._btnTouches.clear();
    this._looks.clear();
    this._move = null;
    this.moveX = 0;
    this.moveY = 0;
    this.sprint = false;
    this._dx = 0;
    this._dy = 0;
    this.stick.style.display = 'none';
  }
}
