const FOCUSABLE = 'button:not(:disabled):not([data-controller-skip]), input[type="range"]:not(:disabled), [data-controller-item]';
const CURSOR_FOCUSABLE = 'button:not(:disabled), input[type="range"]:not(:disabled), [data-controller-item], [data-controller-market-row]';
const CARRY_TARGETS = '[data-controller-target]';
const NAV_SCOPE_SELECTOR = '[data-shop-panel], [data-controller-panel]';
const IDENTITY_ATTRIBUTES = [
  'data-char', 'data-buy-item', 'data-buy-to', 'data-hire-menu', 'data-patch',
  'data-bench', 'data-train', 'data-sell-crew', 'data-hire', 'data-controller-market-row',
  'data-auto-squad',
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

export function cursorMagnetCandidate(rects, x, y) {
  let best = -1;
  let bestScore = Infinity;
  rects.forEach((rect, index) => {
    const nearX = Math.max(rect.left, Math.min(rect.left + rect.width, x));
    const nearY = Math.max(rect.top, Math.min(rect.top + rect.height, y));
    const edgeDistance = Math.hypot(nearX - x, nearY - y);
    if (edgeDistance > 12) return;
    const point = center(rect);
    const score = edgeDistance + Math.hypot(point.x - x, point.y - y) * 0.001;
    if (score < bestScore) {
      best = index;
      bestScore = score;
    }
  });
  return best;
}

export function controllerHint(screenId, {
  carrying = false, adjusting = false, inventoryItem = false, stashItem = false, marketRow = false,
} = {}) {
  if (carrying) return 'LEFT STICK CURSOR  ·  RIGHT STICK SCROLL  ·  A PLACE / SELL  ·  B CANCEL  ·  LT / RT PANEL';
  if (adjusting) return 'LEFT STICK CURSOR  ·  RIGHT STICK SCROLL  ·  A SET VALUE  ·  B BACK';
  if (screenId === 'screen-shop' && stashItem) {
    return 'LEFT STICK CURSOR  ·  RIGHT STICK SCROLL  ·  A MOVE  ·  X EQUIP TO SELECTED  ·  HOLD Y SELL  ·  D-PAD ↑ PATCH';
  }
  if (screenId === 'screen-shop' && inventoryItem) {
    return 'LEFT STICK CURSOR  ·  RIGHT STICK SCROLL  ·  A MOVE  ·  HOLD Y SELL  ·  D-PAD ↑ PATCH';
  }
  if (screenId === 'screen-shop' && marketRow) {
    return 'LEFT STICK CURSOR  ·  RIGHT STICK SCROLL  ·  A BUY TO STASH  ·  X EQUIP TO SELECTED  ·  LT / RT PANEL';
  }
  if (screenId === 'screen-shop') {
    return 'LEFT STICK CURSOR  ·  RIGHT STICK SCROLL  ·  A SELECT  ·  X ALTERNATE  ·  LT / RT PANEL  ·  START ADVANCE  ·  D-PAD ↑ PATCH';
  }
  if (screenId === 'screen-intro') {
    return 'LEFT STICK CURSOR  ·  A SELECT  ·  START FIGHT  ·  B BLACK MARKET';
  }
  if (screenId === 'screen-menu') return 'LEFT STICK CURSOR  ·  A SELECT';
  return 'LEFT STICK CURSOR  ·  A SELECT  ·  B BACK';
}

export class MenuNavigator {
  constructor(doc = document) {
    this.doc = doc;
    this.current = null;
    this.lastIdentity = null;
    this.lastCenter = null;
    this.lastScreen = null;
    this.panelMemory = new Map();
    this.cursorEl = doc.getElementById?.('controller-cursor') || null;
    if (!this.cursorEl && doc.createElement) {
      this.cursorEl = doc.createElement('div');
      this.cursorEl.id = 'controller-cursor';
      this.cursorEl.setAttribute('aria-hidden', 'true');
      this.cursorEl.innerHTML = '<i></i><b></b>';
      doc.body.appendChild(this.cursorEl);
    }
    this.cursorX = 0;
    this.cursorY = 0;
    this.cursorInitialized = false;
    this.cursorTarget = null;
    this.cursorSnapped = null;
    this.cursorSnapPoint = null;
    this.cursorSnapPush = { x: 0, y: 0 };
    this.cursorSnapIgnore = null;
    this.cursorSnapCooldown = 0;
    this.cursorMagnetLockoutPoint = null;
    const leaveControllerMode = () => {
      doc.body.classList.remove('controller-mode', 'controller-menu-cursor');
      this._setCursorTarget(null);
      this._updateHint();
    };
    doc.addEventListener('mousemove', (event) => this._adoptMouseCursor(event), { passive: true });
    doc.addEventListener('pointerdown', leaveControllerMode, { passive: true });
    doc.addEventListener('screenchange', () => {
      doc.body.classList.remove('controller-menu-cursor');
      this._setCursorTarget(null);
      this.cursorInitialized = false;
      this.cursorSnapped = null;
      this.cursorSnapPoint = null;
      this.cursorSnapIgnore = null;
      this.cursorMagnetLockoutPoint = null;
      this.current = null;
      this.lastIdentity = null;
      this.lastCenter = null;
      this.lastScreen = null;
      this._updateHint();
    });
    doc.addEventListener('controllercarrychange', () => this._updateHint());
  }

  activate() {
    if (this.doc.body.classList.contains('controller-mode')) return;
    this.doc.body.classList.add('controller-mode');
    this._updateHint();
  }

  handle(action) {
    const root = this.doc.querySelector('.screen:not(.hidden)');
    if (!root) return false;
    this.activate();
    this._showCursor(root);
    if (action?.type === 'cursorMove') {
      const handled = this._moveCursor(action, root);
      this._updateHint();
      return handled;
    }
    if (action?.type === 'cursorScroll') {
      const handled = this._scrollCursorPanel(action, root);
      this._updateHint();
      return handled;
    }
    this._syncCursorTarget(root);

    if (action === 'back' && this.doc.body.classList.contains('controller-carrying')) {
      this.doc.dispatchEvent(new CustomEvent('controllercancel'));
      this._updateHint();
      return true;
    }

    const carrying = this.doc.body.classList.contains('controller-carrying');
    const dialog = this._dialog(root);
    if (!carrying && action === 'back') {
      const handled = this._back(root);
      this._updateHint();
      return handled;
    }
    if (dialog && ['advance', 'alternate', 'patch', 'sell', 'previousTab', 'nextTab', 'previousPanel', 'nextPanel'].includes(action)) {
      this._updateHint();
      return false;
    }
    if (carrying && ['advance', 'alternate', 'patch', 'sell', 'previousTab', 'nextTab'].includes(action)) {
      this._updateHint();
      return false;
    }
    if (!carrying && action === 'advance') {
      const handled = this._advance(root);
      this._updateHint();
      return handled;
    }
    if (!carrying && action === 'alternate') {
      const handled = this._alternate(root);
      this._updateHint();
      return handled;
    }
    if (!carrying && action === 'patch') {
      const handled = this._patch(root);
      this._updateHint();
      return handled;
    }
    if (!carrying && action === 'sell') {
      const handled = this._sell(root);
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
    if (action === 'activate' && this.doc.body.classList.contains('controller-menu-cursor')) {
      const handled = this._cursorActivate(root);
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
    const linearShopMove = root.id === 'screen-shop'
      && (action === 'up' || action === 'down')
      && !active.matches?.('[data-controller-item]');
    const next = linearShopMove
      ? navIndex + (action === 'down' ? 1 : -1)
      : directionalCandidate(navItems.map(el => el.getBoundingClientRect()), navIndex, action);
    if (next < 0 || next >= navItems.length) {
      if (root.id === 'screen-shop' && (action === 'left' || action === 'right')) {
        const handled = this._jumpPanel(root, action === 'right' ? 1 : -1, false);
        this._updateHint();
        return handled;
      }
      this._updateHint();
      return false;
    }
    if (next >= 0) this._focus(navItems[next], root);
    this._updateHint();
    return next >= 0;
  }

  _showCursor(root) {
    if (!this.cursorEl) return;
    this.doc.body.classList.add('controller-menu-cursor');
    if (!this.cursorInitialized) {
      const view = this.doc.defaultView;
      this.cursorX = (view?.innerWidth || 1280) / 2;
      this.cursorY = (view?.innerHeight || 720) / 2;
      this.cursorInitialized = true;
    }
    this._renderCursor();
    this._syncCursorTarget(root);
  }

  _adoptMouseCursor(event) {
    if (!this.doc.body.classList.contains('controller-menu-cursor')) return false;
    if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return false;
    const root = this.doc.querySelector('.screen:not(.hidden)');
    if (!root) return false;
    const view = this.doc.defaultView;
    const width = view?.innerWidth || 1280;
    const height = view?.innerHeight || 720;
    this.cursorX = Math.max(0, Math.min(width, event.clientX));
    this.cursorY = Math.max(0, Math.min(height, event.clientY));
    this.cursorInitialized = true;
    this.cursorSnapped = null;
    this.cursorSnapPoint = null;
    this.cursorSnapPush = { x: 0, y: 0 };
    this.cursorSnapIgnore = null;
    this.cursorSnapCooldown = 0;
    this.cursorMagnetLockoutPoint = null;
    this._renderCursor();
    this._syncCursorTarget(root);
    return true;
  }

  _moveCursor({ x = 0, y = 0, magnitude = 0, dt = 0 }, root) {
    if (!this.cursorEl) return false;
    const view = this.doc.defaultView;
    const width = view?.innerWidth || 1280;
    const height = view?.innerHeight || 720;
    const frame = Math.max(0, Math.min(0.05, dt));
    const speed = Math.max(640, Math.min(1400, Math.min(width, height) * 1.55));
    this.cursorSnapCooldown = Math.max(0, this.cursorSnapCooldown - frame);

    if (this.cursorSnapped?.isConnected) {
      const snapCenter = this.cursorSnapPoint || center(this.cursorSnapped.getBoundingClientRect());
      this.cursorSnapPush.x += x * speed * frame;
      this.cursorSnapPush.y += y * speed * frame;
      const pushDistance = Math.hypot(this.cursorSnapPush.x, this.cursorSnapPush.y);
      if (pushDistance < 14) {
        this.cursorX = snapCenter.x;
        this.cursorY = snapCenter.y;
        this._setCursorTarget(this.cursorSnapped);
        this._renderCursor();
        return magnitude > 0;
      }
      const overflow = (pushDistance - 14) / pushDistance;
      this.cursorX = snapCenter.x + this.cursorSnapPush.x * overflow;
      this.cursorY = snapCenter.y + this.cursorSnapPush.y * overflow;
      this.cursorSnapIgnore = this.cursorSnapped;
      this.cursorSnapCooldown = 0.18;
      this.cursorSnapped = null;
      this.cursorSnapPoint = null;
      this.cursorSnapPush = { x: 0, y: 0 };
      this.cursorMagnetLockoutPoint = { x: this.cursorX, y: this.cursorY };
    } else {
      this.cursorSnapped = null;
      this.cursorSnapPoint = null;
      this.cursorX += x * speed * frame;
      this.cursorY += y * speed * frame;
    }

    this.cursorX = Math.max(10, Math.min(width - 10, this.cursorX));
    this.cursorY = Math.max(10, Math.min(height - 10, this.cursorY));
    this._edgeScroll(x, y, frame);

    const magnet = this._magneticTarget(root);
    if (magnet) {
      const bounds = magnet.getBoundingClientRect();
      const point = {
        x: Math.max(bounds.left + 3, Math.min(bounds.left + bounds.width - 3, this.cursorX)),
        y: Math.max(bounds.top + 3, Math.min(bounds.top + bounds.height - 3, this.cursorY)),
      };
      this.cursorX = point.x;
      this.cursorY = point.y;
      this.cursorSnapped = magnet;
      this.cursorSnapPoint = point;
      this.cursorSnapPush = { x: 0, y: 0 };
      this.cursorMagnetLockoutPoint = null;
    }
    const hit = magnet || this._hitTarget(root);
    this._setCursorTarget(hit);
    this._renderCursor();
    return magnitude > 0;
  }

  _renderCursor() {
    if (!this.cursorEl) return;
    this.cursorEl.style.transform = `translate3d(${this.cursorX}px, ${this.cursorY}px, 0)`;
    this.cursorEl.classList.toggle('snapped', !!this.cursorSnapped);
    this.cursorEl.classList.toggle('over-target', !!this.cursorTarget);
  }

  _cursorItems(root) {
    const scope = this._dialog(root) || root;
    const selector = this.doc.body.classList.contains('controller-carrying')
      ? CARRY_TARGETS
      : CURSOR_FOCUSABLE;
    return [...scope.querySelectorAll(selector)].filter(el => {
      if (!this._visible(el)) return false;
      return !el.matches?.('button') || !el.closest?.('[data-controller-market-row]');
    });
  }

  /**
   * The cursor items and their rects, refreshed at most every 120 ms.
   *
   * `_magneticTarget` runs on every stick sample — once per frame while the stick is
   * held — and used to querySelectorAll the screen, visibility-check every control
   * and measure every rect each time: a forced layout per frame for controls that
   * almost never move. Menus are static between interactions; the moments they are
   * not are covered by the key (screen, dialog, carry mode change), the edge-scroll
   * invalidation, and the 120 ms ceiling. A control replaced mid-window self-heals:
   * every consumer already tolerates a detached element for a frame.
   */
  _cursorItemRects(root) {
    const dialog = this.doc ? this._dialog(root) : null;
    const carrying = !!this.doc?.body?.classList?.contains('controller-carrying');
    const key = `${root?.id || ''}|${dialog ? 'dlg' : ''}|${carrying}`;
    const now = performance.now();
    const cached = this._rectCache;
    if (cached && cached.key === key && now - cached.at < 120) return cached;
    const items = this._cursorItems(root);
    this._rectCache = {
      key, at: now, items,
      rects: items.map(item => item.getBoundingClientRect()),
    };
    return this._rectCache;
  }

  _magneticTarget(root) {
    if (this.cursorMagnetLockoutPoint) {
      const cleared = Math.hypot(
        this.cursorX - this.cursorMagnetLockoutPoint.x,
        this.cursorY - this.cursorMagnetLockoutPoint.y
      ) >= 30;
      if (!cleared) return null;
      this.cursorMagnetLockoutPoint = null;
    }
    const { items, rects } = this._cursorItemRects(root);
    let candidates = items;
    let candidateRects = rects;
    if (this.cursorSnapCooldown > 0 && this.cursorSnapIgnore) {
      candidates = [];
      candidateRects = [];
      for (let i = 0; i < items.length; i++) {
        if (items[i] === this.cursorSnapIgnore) continue;
        candidates.push(items[i]);
        candidateRects.push(rects[i]);
      }
    }
    const index = cursorMagnetCandidate(candidateRects, this.cursorX, this.cursorY);
    return index >= 0 ? candidates[index] : null;
  }

  _hitTarget(root) {
    const scope = this._dialog(root) || root;
    const selector = this.doc.body.classList.contains('controller-carrying')
      ? CARRY_TARGETS
      : CURSOR_FOCUSABLE;
    const stack = this.doc.elementsFromPoint?.(this.cursorX, this.cursorY) || [];
    for (const element of stack) {
      const hit = element.closest?.(selector);
      const target = hit?.closest?.('[data-controller-market-row]') || hit;
      if (target && scope.contains(target) && this._visible(target)) return target;
    }
    return null;
  }

  _syncCursorTarget(root) {
    if (!this.doc.body.classList.contains('controller-menu-cursor')) return this.current;
    const target = this.cursorSnapped?.isConnected ? this.cursorSnapped : this._hitTarget(root);
    this._setCursorTarget(target);
    return target;
  }

  _setCursorTarget(target) {
    if (this.cursorTarget === target) return;
    this.cursorTarget?.classList?.remove('controller-cursor-target');
    this.cursorTarget = target || null;
    if (!target) {
      this.current = null;
      return;
    }
    target.classList?.add('controller-cursor-target');
    this.current = target;
    this.lastIdentity = controlIdentity(target);
    this.lastCenter = center(target.getBoundingClientRect());
    const root = this.doc.querySelector?.('.screen:not(.hidden)');
    this.lastScreen = root?.id || null;
    target.focus?.({ preventScroll: true });
  }

  _cursorActivate(root) {
    const target = this._syncCursorTarget(root);
    if (!target) return false;
    if (target.matches?.('[data-controller-market-row]')) {
      const primary = target.querySelector?.('[data-buy-item]:not(:disabled)');
      if (!primary || !this._visible(primary)) return false;
      this._activate(primary, root);
      return true;
    }
    if (target.matches?.('input[type="range"]')) {
      const bounds = target.getBoundingClientRect();
      const min = Number(target.min);
      const max = Number(target.max);
      const step = Number(target.step) || 1;
      const ratio = Math.max(0, Math.min(1, (this.cursorX - bounds.left) / bounds.width));
      const raw = min + (max - min) * ratio;
      target.value = String(Math.round(raw / step) * step);
      const EventClass = this.doc.defaultView?.Event || Event;
      target.dispatchEvent(new EventClass('input', { bubbles: true }));
      target.dispatchEvent(new EventClass('change', { bubbles: true }));
      return true;
    }
    this._activate(target, root);
    return true;
  }

  _edgeScroll(dx, dy, dt) {
    const view = this.doc.defaultView;
    if (!view?.getComputedStyle || !this.doc.elementsFromPoint) return;
    const width = view.innerWidth;
    const height = view.innerHeight;
    const zone = 56;
    const edgeX = this.cursorX < zone && dx < 0 ? -1
      : this.cursorX > width - zone && dx > 0 ? 1 : 0;
    const edgeY = this.cursorY < zone && dy < 0 ? -1
      : this.cursorY > height - zone && dy > 0 ? 1 : 0;
    if (!edgeX && !edgeY) return;
    const scroller = this._scrollContainerAt(edgeX, edgeY);
    if (!scroller) return;
    scroller.scrollBy({
      left: edgeX * 720 * dt,
      top: edgeY * 720 * dt,
      behavior: 'auto',
    });
    // Everything on screen just moved relative to the cursor.
    this._rectCache = null;
  }

  _scrollCursorPanel({ x = 0, y = 0, magnitude = 0, dt = 0 }, root) {
    if (!this.cursorEl || magnitude <= 0) return false;
    const horizontal = Math.abs(x) > Math.abs(y);
    const scrollX = horizontal ? x : 0;
    const scrollY = horizontal ? 0 : y;
    const scroller = this._scrollContainerAt(scrollX, scrollY);
    if (!scroller) return false;
    const frame = Math.max(0, Math.min(0.05, dt));
    scroller.scrollBy({
      left: scrollX * 900 * frame,
      top: scrollY * 900 * frame,
      behavior: 'auto',
    });
    this.cursorSnapped = null;
    this.cursorSnapPoint = null;
    this.cursorSnapPush = { x: 0, y: 0 };
    this._syncCursorTarget(root);
    this._renderCursor();
    return true;
  }

  _scrollContainerAt(dx, dy) {
    const view = this.doc.defaultView;
    if (!view?.getComputedStyle || !this.doc.elementsFromPoint) return null;
    const stack = this.doc.elementsFromPoint(this.cursorX, this.cursorY);
    for (const element of stack) {
      let node = element;
      while (node && node !== this.doc.body) {
        const style = view.getComputedStyle(node);
        const canX = Math.abs(dx) > 0.01
          && node.scrollWidth > node.clientWidth
          && /(auto|scroll)/.test(style.overflowX)
          && (dx < 0 ? node.scrollLeft > 0 : node.scrollLeft + node.clientWidth < node.scrollWidth - 1);
        const canY = Math.abs(dy) > 0.01
          && node.scrollHeight > node.clientHeight
          && /(auto|scroll)/.test(style.overflowY)
          && (dy < 0 ? node.scrollTop > 0 : node.scrollTop + node.clientHeight < node.scrollHeight - 1);
        if (canX || canY) return node;
        node = node.parentElement;
      }
    }
    return null;
  }

  _back(root) {
    const settings = this.doc.querySelector('#settings-overlay:not(.hidden)');
    const target = settings?.querySelector('#btn-settings-close')
      || root.querySelector('#btn-hire-close:not(.hidden), #btn-intro-back, #btn-resume');
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

  _alternate(root) {
    if (root.id !== 'screen-shop') return false;
    const items = this._items(root);
    const active = this.doc.body?.classList?.contains('controller-menu-cursor')
      ? this.cursorTarget
      : items.includes(this.current)
        ? this.current
      : items.includes(this.doc.activeElement) ? this.doc.activeElement : null;
    if (active?.matches?.('[data-controller-item][data-inventory="stash"]')) {
      return this._inventoryAction(active, root, 'controllerequip');
    }
    const row = active?.closest?.('.market-row');
    const target = row?.querySelector?.('[data-buy-to]:not(:disabled)');
    if (!target || !this._visible(target)) return false;
    this._activate(target, root);
    return true;
  }

  _sell(root) {
    if (root.id !== 'screen-shop') return false;
    const items = this._items(root);
    const active = this.doc.body?.classList?.contains('controller-menu-cursor')
      ? this.cursorTarget
      : items.includes(this.current)
        ? this.current
      : items.includes(this.doc.activeElement) ? this.doc.activeElement : null;
    if (!active?.matches?.('[data-controller-item]')) return false;
    return this._inventoryAction(active, root, 'controllersell');
  }

  _inventoryAction(active, root, type) {
    const position = center(active.getBoundingClientRect());
    const EventClass = this.doc.defaultView?.Event || Event;
    active.dispatchEvent(new EventClass(type, { bubbles: true }));
    const nextRoot = this.doc.querySelector('.screen:not(.hidden)');
    if (!nextRoot || nextRoot.id !== root.id) return true;
    if (this.doc.body?.classList?.contains('controller-menu-cursor')) {
      this.cursorSnapped = null;
      this.cursorSnapPoint = null;
      this._syncCursorTarget(nextRoot);
      this._renderCursor();
      return true;
    }
    const replacement = this._nearest(this._items(nextRoot), position);
    if (replacement) this._focus(replacement, nextRoot);
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
    if (this.doc.body?.classList?.contains('controller-menu-cursor')) {
      this.cursorSnapped = null;
      this.cursorSnapPoint = null;
      this._syncCursorTarget(nextRoot);
      this._renderCursor();
      return true;
    }
    if (!before) return true;
    const nextItems = this._items(nextRoot);
    const replacement = (beforeIdentity && nextItems.find(el => controlIdentity(el) === beforeIdentity))
      || this._nearest(nextItems, beforePosition);
    if (replacement) this._focus(replacement, nextRoot);
    return true;
  }

  _jumpPanel(root, direction, wrap = true) {
    const panels = [...root.querySelectorAll('[data-shop-panel]')].filter(el => this._visible(el));
    if (!panels.length) return false;
    const items = this._items(root);
    const active = this.doc.body?.classList?.contains('controller-menu-cursor')
      ? this.cursorTarget
      : items.includes(this.current)
        ? this.current
        : items.includes(this.doc.activeElement) ? this.doc.activeElement : null;
    const currentPanel = active?.closest?.('[data-shop-panel]');
    const currentIndex = panels.indexOf(currentPanel);
    let targetIndex = currentIndex < 0 ? (direction > 0 ? 0 : panels.length - 1) : currentIndex + direction;
    if (!wrap && (targetIndex < 0 || targetIndex >= panels.length)) return false;
    targetIndex = (targetIndex + panels.length) % panels.length;
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
    const target = remembered || this._nearest(targetItems, sameHeight) || targetItems[0];
    this._focus(target, root);
    if (this.doc.body?.classList?.contains('controller-menu-cursor')) {
      const point = center(target.getBoundingClientRect());
      this.cursorX = point.x;
      this.cursorY = point.y;
      this.cursorSnapped = target;
      this.cursorSnapPoint = point;
      this.cursorSnapPush = { x: 0, y: 0 };
      this.cursorMagnetLockoutPoint = null;
      this._setCursorTarget(target);
      this._renderCursor();
    }
    return true;
  }

  _items(root) {
    const selector = this.doc.body.classList.contains('controller-carrying')
      ? `${FOCUSABLE}, ${CARRY_TARGETS}`
      : FOCUSABLE;
    const dialog = this._dialog(root);
    return [...(dialog || root).querySelectorAll(selector)].filter(el => this._visible(el));
  }

  _dialog(root) {
    return this.doc.querySelector('#settings-overlay:not(.hidden)')
      || (root.id === 'screen-shop' ? root.querySelector('#hire-overlay:not(.hidden)') : null);
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
    if (this.doc.body.classList.contains('controller-menu-cursor')) {
      this.cursorSnapped = null;
      this.cursorSnapPoint = null;
      this._syncCursorTarget(nextRoot);
      this._renderCursor();
      return;
    }
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
    const active = this.current?.isConnected ? this.current : this.doc.activeElement;
    const inventoryItem = active?.matches?.('[data-controller-item]');
    const stashItem = active?.matches?.('[data-controller-item][data-inventory="stash"]');
    const marketRow = active?.matches?.('[data-controller-market-row]');
    const text = controllerHint(activeScreen?.id, {
      carrying: this.doc.body.classList.contains('controller-carrying'),
      adjusting,
      inventoryItem,
      stashItem,
      marketRow,
    });
    hint.textContent = text;
    const shopGuide = this.doc.getElementById('shop-controller-guide');
    if (shopGuide && activeScreen?.id === 'screen-shop') shopGuide.textContent = text;
  }
}
