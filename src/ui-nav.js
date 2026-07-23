const FOCUSABLE = 'button:not(:disabled), input[type="range"]:not(:disabled), [data-controller-item]';
const CARRY_TARGETS = '[data-controller-target]';
const IDENTITY_ATTRIBUTES = [
  'data-char', 'data-buy-item', 'data-buy-to', 'data-hire-menu', 'data-patch',
  'data-bench', 'data-train', 'data-sell-crew', 'data-hire',
];

export function controlIdentity(el) {
  if (!el) return null;
  if (el.id) return `id:${el.id}`;
  if (el.hasAttribute?.('data-item')) return `data-item:${el.getAttribute('data-item')}`;
  if (el.hasAttribute?.('data-controller-target')) {
    return [
      'target', el.getAttribute('data-controller-target'),
      el.getAttribute('data-who') || '', el.getAttribute('data-slot') || '',
    ].join(':');
  }
  for (const attribute of IDENTITY_ATTRIBUTES) {
    if (el.hasAttribute?.(attribute)) return `${attribute}:${el.getAttribute(attribute)}`;
  }
  return null;
}

function center(rect) {
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

export function directionalCandidate(rects, currentIndex, direction) {
  if (currentIndex < 0 || currentIndex >= rects.length) return rects.length ? 0 : -1;
  const from = center(rects[currentIndex]);
  const vertical = direction === 'up' || direction === 'down';
  const sign = direction === 'up' || direction === 'left' ? -1 : 1;
  let best = -1;
  let bestScore = Infinity;

  rects.forEach((rect, index) => {
    if (index === currentIndex) return;
    const to = center(rect);
    const primary = vertical ? (to.y - from.y) * sign : (to.x - from.x) * sign;
    if (primary <= 2) return;
    const cross = Math.abs(vertical ? to.x - from.x : to.y - from.y);
    const score = primary + cross * 2.35;
    if (score < bestScore) {
      bestScore = score;
      best = index;
    }
  });
  return best;
}

export function controllerHint(screenId, { carrying = false, adjusting = false } = {}) {
  if (carrying) return 'A PLACE / SELL  ·  B CANCEL  ·  LB / RB JUMP COLUMN';
  if (adjusting) return 'LEFT / RIGHT ADJUST  ·  UP / DOWN MOVE  ·  B BACK';
  if (screenId === 'screen-shop') {
    return 'X END TURN / NEXT FIGHT  ·  Y PATCH  ·  LB / RB SQUAD  ·  A SELECT  ·  STICK / D-PAD MOVE';
  }
  if (screenId === 'screen-intro') {
    return 'X START FIGHT  ·  B BLACK MARKET  ·  A SELECT  ·  STICK / D-PAD MOVE';
  }
  if (screenId === 'screen-menu') return 'STICK / D-PAD MOVE  ·  A SELECT';
  return 'STICK / D-PAD MOVE  ·  A SELECT  ·  B BACK  ·  LB / RB JUMP COLUMN';
}

export class MenuNavigator {
  constructor(doc = document) {
    this.doc = doc;
    this.current = null;
    this.lastIdentity = null;
    this.lastCenter = null;
    this.lastScreen = null;
    const leaveControllerMode = () => {
      doc.body.classList.remove('controller-mode');
      this._updateHint();
    };
    doc.addEventListener('pointerdown', leaveControllerMode, { passive: true });
    doc.addEventListener('screenchange', () => {
      this.current = null;
      this.lastIdentity = null;
      this.lastCenter = null;
      this.lastScreen = null;
      this._updateHint();
    });
    doc.addEventListener('controllercarrychange', () => this._updateHint());
  }

  handle(action) {
    const root = this.doc.querySelector('.screen:not(.hidden)');
    if (!root) return false;
    this.doc.body.classList.add('controller-mode');

    if (action === 'back' && this.doc.body.classList.contains('controller-carrying')) {
      this.doc.dispatchEvent(new CustomEvent('controllercancel'));
      this._updateHint();
      return true;
    }

    const carrying = this.doc.body.classList.contains('controller-carrying');
    if (!carrying && action === 'back') {
      const handled = this._back(root);
      this._updateHint();
      return handled;
    }
    if (!carrying && action === 'advance') {
      const handled = this._advance(root);
      this._updateHint();
      return handled;
    }
    if (!carrying && action === 'patch') {
      const handled = this._patch(root);
      this._updateHint();
      return handled;
    }
    if (!carrying && root.id === 'screen-shop' && (action === 'previousTab' || action === 'nextTab')) {
      const handled = this._cycleSquad(root, action === 'nextTab' ? 1 : -1);
      this._updateHint();
      return handled;
    }

    const items = this._items(root);
    if (!items.length) return false;
    let index = items.indexOf(this.current);
    if (index < 0) index = items.indexOf(this.doc.activeElement);
    if (index < 0 && this.lastScreen === root.id) {
      const recovered = this._recover(items);
      if (recovered) {
        this._focus(recovered, root);
        index = items.indexOf(recovered);
      }
    }
    if (index < 0) {
      this._focus(items[0], root);
      index = 0;
      if (action !== 'activate') return true;
    }

    if (action === 'activate') {
      this._activate(items[index], root);
      this._updateHint();
      return true;
    }
    const active = items[index];
    if (active.matches('input[type="range"]') && (action === 'left' || action === 'right')) {
      action === 'right' ? active.stepUp() : active.stepDown();
      active.dispatchEvent(new Event('input', { bubbles: true }));
      this._updateHint();
      return true;
    }
    if (action === 'previousTab' || action === 'nextTab') {
      const tabs = [...root.querySelectorAll('[data-shop-view]')].filter(el => this._visible(el));
      if (tabs.length) {
        const selected = Math.max(0, tabs.findIndex(el => el.classList.contains('shop-mobile-tab-active')));
        tabs[(selected + (action === 'nextTab' ? 1 : tabs.length - 1)) % tabs.length].click();
        this.current = null;
        this._focus(this._items(root)[0], root);
        return true;
      }
      action = action === 'nextTab' ? 'right' : 'left';
    }

    const next = directionalCandidate(items.map(el => el.getBoundingClientRect()), index, action);
    if (next >= 0) this._focus(items[next], root);
    this._updateHint();
    return next >= 0;
  }

  _back(root) {
    const target = root.querySelector('#btn-intro-back, #btn-resume');
    if (!target || !this._visible(target)) return false;
    this._activate(target, root);
    return true;
  }

  _advance(root) {
    const selector = root.id === 'screen-shop'
      ? '#btn-end-turn, #btn-next-fight'
      : root.id === 'screen-intro' ? '#btn-fight' : null;
    if (!selector) return false;
    const target = [...root.querySelectorAll(selector)].find(el => this._visible(el));
    if (!target) return false;
    this._activate(target, root);
    return true;
  }

  _patch(root) {
    if (root.id !== 'screen-shop') return false;
    const target = [...root.querySelectorAll('[data-patch]')].find(el => this._visible(el));
    if (!target) return false;
    this._activate(target, root);
    return true;
  }

  _cycleSquad(root, direction) {
    const tabs = [...root.querySelectorAll('[data-char]')].filter(el => this._visible(el));
    if (!tabs.length) return false;
    const selected = tabs.findIndex(el => el.classList.contains('char-tab-sel'));
    const current = selected >= 0 ? selected : 0;
    const target = tabs[(current + direction + tabs.length) % tabs.length];
    const identity = controlIdentity(target);
    target.click();
    const nextRoot = this.doc.querySelector('.screen:not(.hidden)');
    if (!nextRoot || nextRoot.id !== root.id) return true;
    const replacement = [...nextRoot.querySelectorAll('[data-char]')]
      .filter(el => this._visible(el))
      .find(el => controlIdentity(el) === identity);
    if (replacement) this._focus(replacement, nextRoot);
    return true;
  }

  _items(root) {
    const selector = this.doc.body.classList.contains('controller-carrying')
      ? `${FOCUSABLE}, ${CARRY_TARGETS}`
      : FOCUSABLE;
    return [...root.querySelectorAll(selector)].filter(el => this._visible(el));
  }

  _visible(el) {
    if (el.disabled || el.closest('.hidden')) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 1 && rect.height > 1;
  }

  _activate(el, root) {
    const identity = controlIdentity(el);
    const rect = el.getBoundingClientRect();
    const position = center(rect);
    const screenId = root.id;
    el.click();
    const nextRoot = this.doc.querySelector('.screen:not(.hidden)');
    if (!nextRoot || nextRoot.id !== screenId) return;
    const items = this._items(nextRoot);
    const exact = identity && items.find(item => controlIdentity(item) === identity);
    const fallback = exact || this._nearest(items, position);
    if (fallback) this._focus(fallback, nextRoot);
  }

  _recover(items) {
    const exact = this.lastIdentity && items.find(item => controlIdentity(item) === this.lastIdentity);
    return exact || this._nearest(items, this.lastCenter);
  }

  _nearest(items, position) {
    if (!position || !items.length) return null;
    let nearest = null;
    let nearestDistance = Infinity;
    for (const item of items) {
      const point = center(item.getBoundingClientRect());
      const distance = Math.hypot(point.x - position.x, point.y - position.y);
      if (distance < nearestDistance) {
        nearest = item;
        nearestDistance = distance;
      }
    }
    return nearest;
  }

  _focus(el, root = this.doc.querySelector('.screen:not(.hidden)')) {
    this.current = el;
    this.lastIdentity = controlIdentity(el);
    this.lastCenter = center(el.getBoundingClientRect());
    this.lastScreen = root?.id || null;
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
  }

  _updateHint() {
    const hint = this.doc.getElementById('controller-hint');
    if (!hint) return;
    const activeScreen = this.doc.querySelector('.screen:not(.hidden)');
    const show = this.doc.body.classList.contains('controller-mode') && !!activeScreen;
    hint.classList.toggle('hidden', !show);
    hint.dataset.screen = activeScreen?.id || '';
    const adjusting = this.doc.activeElement?.matches?.('input[type="range"]');
    hint.textContent = controllerHint(activeScreen?.id, {
      carrying: this.doc.body.classList.contains('controller-carrying'),
      adjusting,
    });
  }
}
