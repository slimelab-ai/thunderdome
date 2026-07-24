const FOCUSABLE = 'button:not(:disabled), input[type="range"]:not(:disabled), [data-controller-item]';
const CARRY_TARGETS = '[data-controller-target]';
const NAV_SCOPE_SELECTOR = '[data-shop-panel], [data-controller-panel]';
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
  if (carrying) return 'A PLACE / SELL  ·  B CANCEL  ·  LT / RT CHANGE PANEL';
  if (adjusting) return 'LEFT / RIGHT ADJUST  ·  UP / DOWN MOVE  ·  A SELECT';
  if (screenId === 'screen-shop') {
    return 'LT / RT PANEL  ·  LB / RB FIGHTER  ·  X END TURN / NEXT FIGHT  ·  Y PATCH  ·  A SELECT';
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
    this.panelMemory = new Map();
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

  activate() {
    this.doc.body.classList.add('controller-mode');
    this._updateHint();
  }

  handle(action) {
    const root = this.doc.querySelector('.screen:not(.hidden)');
    if (!root) return false;
    this.activate();

    if (action === 'back' && this.doc.body.classList.contains('controller-carrying')) {
      this.doc.dispatchEvent(new CustomEvent('controllercancel'));
      this._updateHint();
      return true;
    }

    const carrying = this.doc.body.classList.contains('controller-carrying');
    const dialog = root.querySelector('#hire-overlay:not(.hidden)');
    if (!carrying && action === 'back') {
      const handled = this._back(root);
      this._updateHint();
      return handled;
    }
    if (dialog && ['advance', 'patch', 'previousTab', 'nextTab', 'previousPanel', 'nextPanel'].includes(action)) {
      this._updateHint();
      return false;
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
    if (root.id === 'screen-shop' && (action === 'previousPanel' || action === 'nextPanel')) {
      const handled = this._jumpPanel(root, action === 'nextPanel' ? 1 : -1);
      this._updateHint();
      return handled;
    }
    if (action === 'previousPanel' || action === 'nextPanel') {
      this._updateHint();
      return false;
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
    if (action === 'previousTab' || action === 'nextTab') action = action === 'nextTab' ? 'right' : 'left';

    let navItems = items;
    let navIndex = index;
    if (root.id === 'screen-shop') {
      const scope = active.closest?.(NAV_SCOPE_SELECTOR);
      if (scope) {
        const scoped = this._items(scope);
        const scopedIndex = scoped.indexOf(active);
        if (scopedIndex >= 0) {
          navItems = scoped;
          navIndex = scopedIndex;
        }
      }
    }
    const next = directionalCandidate(navItems.map(el => el.getBoundingClientRect()), navIndex, action);
    if (next >= 0) this._focus(navItems[next], root);
    this._updateHint();
    return next >= 0;
  }

  _back(root) {
    const target = root.querySelector('#btn-hire-close:not(.hidden), #btn-intro-back, #btn-resume');
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
    const beforeItems = this._items(root);
    const before = beforeItems.includes(this.current)
      ? this.current
      : beforeItems.includes(this.doc.activeElement) ? this.doc.activeElement : null;
    const beforeIdentity = controlIdentity(before);
    const beforePosition = before ? center(before.getBoundingClientRect()) : null;
    const selected = tabs.findIndex(el => el.classList.contains('char-tab-sel'));
    const current = selected >= 0 ? selected : 0;
    const target = tabs[(current + direction + tabs.length) % tabs.length];
    target.click();
    const nextRoot = this.doc.querySelector('.screen:not(.hidden)');
    if (!nextRoot || nextRoot.id !== root.id) return true;
    if (!before) return true;
    const nextItems = this._items(nextRoot);
    const replacement = (beforeIdentity && nextItems.find(el => controlIdentity(el) === beforeIdentity))
      || this._nearest(nextItems, beforePosition);
    if (replacement) this._focus(replacement, nextRoot);
    return true;
  }

  _jumpPanel(root, direction) {
    const panels = [...root.querySelectorAll('[data-shop-panel]')].filter(el => this._visible(el));
    if (!panels.length) return false;
    const items = this._items(root);
    const active = items.includes(this.current)
      ? this.current
      : items.includes(this.doc.activeElement) ? this.doc.activeElement : null;
    const currentPanel = active?.closest?.('[data-shop-panel]');
    const currentIndex = panels.indexOf(currentPanel);
    const targetIndex = currentIndex < 0
      ? (direction > 0 ? 0 : panels.length - 1)
      : (currentIndex + direction + panels.length) % panels.length;
    const targetPanel = panels[targetIndex];
    const targetItems = this._items(targetPanel);
    if (!targetItems.length) return false;
    const key = targetPanel.getAttribute('data-shop-panel');
    const rememberedIdentity = this.panelMemory.get(key);
    const remembered = rememberedIdentity
      ? targetItems.find(el => controlIdentity(el) === rememberedIdentity)
      : null;
    const targetRect = targetPanel.getBoundingClientRect();
    const sameHeight = this.lastCenter
      ? { x: targetRect.left + targetRect.width / 2, y: this.lastCenter.y }
      : null;
    this._focus(remembered || this._nearest(targetItems, sameHeight) || targetItems[0], root);
    return true;
  }

  _items(root) {
    const selector = this.doc.body.classList.contains('controller-carrying')
      ? `${FOCUSABLE}, ${CARRY_TARGETS}`
      : FOCUSABLE;
    const dialog = root.id === 'screen-shop' ? root.querySelector('#hire-overlay:not(.hidden)') : null;
    return [...(dialog || root).querySelectorAll(selector)].filter(el => this._visible(el));
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
    const panel = el.closest?.('[data-shop-panel]');
    const panelKey = panel?.getAttribute('data-shop-panel');
    const identity = controlIdentity(el);
    if (panelKey && identity) this.panelMemory.set(panelKey, identity);
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
