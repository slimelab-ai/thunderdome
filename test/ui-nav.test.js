import test from 'node:test';
import assert from 'node:assert/strict';
import {
  controlIdentity, controllerHint, cursorMagnetCandidate, directionalCandidate, MenuNavigator,
} from '../src/ui-nav.js';

const rect = (left, top, width = 80, height = 40) => ({ left, top, width, height });

test('directional UI navigation prefers aligned controls in the requested direction', () => {
  const controls = [
    rect(100, 100),
    rect(100, 170),
    rect(260, 105),
    rect(20, 105),
    rect(260, 260),
  ];
  assert.equal(directionalCandidate(controls, 0, 'down'), 1);
  assert.equal(directionalCandidate(controls, 0, 'right'), 2);
  assert.equal(directionalCandidate(controls, 0, 'left'), 3);
  assert.equal(directionalCandidate(controls, 1, 'up'), 0);
});

test('directional UI navigation reports no candidate beyond an edge', () => {
  const controls = [rect(0, 0), rect(100, 0)];
  assert.equal(directionalCandidate(controls, 0, 'left'), -1);
  assert.equal(directionalCandidate(controls, 1, 'right'), -1);
  assert.equal(directionalCandidate([], -1, 'down'), -1);
});

test('controller activation only performs the expensive menu handoff once', () => {
  const classes = new Set();
  const navigator = Object.create(MenuNavigator.prototype);
  navigator.doc = {
    body: {
      classList: {
        contains: name => classes.has(name),
        add: name => classes.add(name),
      },
    },
  };
  let hintUpdates = 0;
  navigator._updateHint = () => hintUpdates++;

  navigator.activate();
  navigator.activate();

  assert.equal(hintUpdates, 1);
  assert.equal(classes.has('controller-mode'), true);
});

test('analog cursor magnetism captures nearby controls without ordering them', () => {
  const controls = [
    rect(100, 100, 60, 60),
    rect(240, 100, 60, 60),
    rect(100, 240, 60, 60),
  ];
  assert.equal(cursorMagnetCandidate(controls, 128, 132), 0);
  assert.equal(cursorMagnetCandidate(controls, 268, 128), 1);
  assert.equal(cursorMagnetCandidate(controls, 180, 180), -1, 'free space remains free');
});

test('snapped analog cursor is sticky but breaks away under sustained input', () => {
  const target = {
    isConnected: true,
    getBoundingClientRect: () => rect(100, 100, 60, 60),
  };
  const navigator = Object.create(MenuNavigator.prototype);
  navigator.doc = { defaultView: { innerWidth: 1280, innerHeight: 720 } };
  navigator.cursorEl = {
    style: {},
    classList: { toggle: () => {} },
  };
  navigator.cursorX = 130;
  navigator.cursorY = 130;
  navigator.cursorSnapped = target;
  navigator.cursorSnapPush = { x: 0, y: 0 };
  navigator.cursorSnapCooldown = 0;
  navigator.cursorSnapIgnore = null;
  navigator.cursorTarget = target;
  navigator._setCursorTarget = () => {};
  navigator._edgeScroll = () => {};
  navigator._magneticTarget = () => null;
  navigator._hitTarget = () => null;

  navigator._moveCursor({ x: 1, y: 0, magnitude: 1, dt: 0.01 }, {});
  assert.equal(navigator.cursorX, 130, 'small movement remains captured');
  assert.equal(navigator.cursorSnapped, target);

  navigator._moveCursor({ x: 1, y: 0, magnitude: 1, dt: 0.01 }, {});
  assert.ok(navigator.cursorX > 130, 'continued movement breaks the capture');
  assert.equal(navigator.cursorSnapped, null);
  assert.equal(navigator.cursorSnapIgnore, target);
  assert.deepEqual(navigator.cursorMagnetLockoutPoint, {
    x: navigator.cursorX,
    y: navigator.cursorY,
  });
});

test('magnetism cannot ping-pong between adjacent slots during breakaway', () => {
  const candidate = { getBoundingClientRect: () => rect(25, -10, 20, 20) };
  const navigator = Object.create(MenuNavigator.prototype);
  navigator.cursorX = 20;
  navigator.cursorY = 0;
  navigator.cursorMagnetLockoutPoint = { x: 0, y: 0 };
  navigator.cursorSnapCooldown = 0;
  navigator.cursorSnapIgnore = null;
  navigator._cursorItems = () => [candidate];

  assert.equal(navigator._magneticTarget({}), null, 'nearby slots cannot recapture immediately');
  navigator.cursorX = 31;
  assert.equal(navigator._magneticTarget({}), candidate, 'capture returns after clearing the slot boundary');
  assert.equal(navigator.cursorMagnetLockoutPoint, null);
});

test('right-stick scrolling targets the scroll region beneath the cursor', () => {
  let delta = null;
  const body = {};
  const scroller = {
    parentElement: body,
    scrollWidth: 300,
    clientWidth: 300,
    scrollLeft: 0,
    scrollHeight: 900,
    clientHeight: 300,
    scrollTop: 0,
    scrollBy: (value) => { delta = value; },
  };
  const child = { parentElement: scroller };
  const navigator = Object.create(MenuNavigator.prototype);
  navigator.doc = {
    body,
    defaultView: { getComputedStyle: () => ({ overflowX: 'hidden', overflowY: 'auto' }) },
    elementsFromPoint: () => [child],
  };
  navigator.cursorEl = {};
  navigator.cursorX = 200;
  navigator.cursorY = 180;
  navigator.cursorSnapped = { id: 'old-slot' };
  navigator.cursorSnapPoint = { x: 200, y: 180 };
  navigator.cursorSnapPush = { x: 4, y: 2 };
  navigator._syncCursorTarget = () => {};
  navigator._renderCursor = () => {};

  assert.equal(navigator._scrollCursorPanel({ y: 0.75, magnitude: 0.75, dt: 0.05 }, {}), true);
  assert.deepEqual(delta, { left: 0, top: 33.75, behavior: 'auto' });
  assert.equal(navigator.cursorSnapped, null);
});

test('mouse movement takes control of the active controller menu cursor', () => {
  const root = { id: 'screen-shop' };
  const navigator = Object.create(MenuNavigator.prototype);
  navigator.doc = {
    body: { classList: { contains: (name) => name === 'controller-menu-cursor' } },
    defaultView: { innerWidth: 800, innerHeight: 600 },
    querySelector: () => root,
  };
  navigator.cursorSnapped = { id: 'old-snap' };
  navigator.cursorSnapPoint = { x: 10, y: 10 };
  navigator.cursorSnapPush = { x: 5, y: 5 };
  navigator.cursorSnapIgnore = { id: 'old-ignore' };
  navigator.cursorSnapCooldown = 0.18;
  navigator.cursorMagnetLockoutPoint = { x: 10, y: 10 };
  let syncedRoot = null;
  navigator._renderCursor = () => {};
  navigator._syncCursorTarget = (value) => { syncedRoot = value; };

  assert.equal(navigator._adoptMouseCursor({ clientX: 345, clientY: 278 }), true);
  assert.equal(navigator.cursorX, 345);
  assert.equal(navigator.cursorY, 278);
  assert.equal(navigator.cursorInitialized, true);
  assert.equal(navigator.cursorSnapped, null);
  assert.equal(navigator.cursorSnapIgnore, null);
  assert.equal(navigator.cursorMagnetLockoutPoint, null);
  assert.equal(syncedRoot, root);
});

test('controller hints advertise context-sensitive market shortcuts', () => {
  const shop = controllerHint('screen-shop');
  assert.match(shop, /X ALTERNATE/);
  assert.match(shop, /START ADVANCE/);
  assert.match(shop, /D-PAD ↑ PATCH/);
  assert.doesNotMatch(shop, /Y PATCH/);
  assert.match(shop, /LEFT STICK CURSOR/);
  assert.match(shop, /RIGHT STICK SCROLL/);
  assert.match(shop, /LT \/ RT PANEL/);
  assert.match(controllerHint('screen-intro'), /START FIGHT/);
  assert.match(controllerHint('screen-intro'), /B BLACK MARKET/);
  assert.match(controllerHint('screen-shop', { carrying: true }), /B CANCEL/);
  assert.match(controllerHint('screen-shop', { stashItem: true }), /X EQUIP TO SELECTED/);
  assert.match(controllerHint('screen-shop', { stashItem: true }), /HOLD Y SELL/);
  assert.match(controllerHint('screen-shop', { stashItem: true }), /D-PAD ↑ PATCH/);
  assert.match(controllerHint('screen-shop', { inventoryItem: true }), /HOLD Y SELL/);
  assert.match(controllerHint('screen-shop', { marketRow: true }), /A BUY TO STASH/);
  assert.match(controllerHint('screen-shop', { marketRow: true }), /X EQUIP TO SELECTED/);
  assert.doesNotMatch(controllerHint('screen-menu'), /D-PAD/);
  assert.doesNotMatch(controllerHint('screen-menu'), /B BACK/);
});

test('market shortcuts advance, patch, and cycle the selected squad member', () => {
  const calls = [];
  const control = (id, attributes = {}, selected = false) => ({
    id,
    classList: { contains: (name) => name === 'char-tab-sel' && selected },
    getAttribute: (name) => attributes[name] ?? null,
    hasAttribute: (name) => Object.hasOwn(attributes, name),
    getBoundingClientRect: () => rect(500, 200),
    click: () => calls.push(id || attributes['data-char'] || `patch:${attributes['data-patch']}`),
  });
  const endTurn = control('btn-end-turn');
  const nextFight = control('btn-next-fight');
  const patch = control('', { 'data-patch': 'player' });
  const playerTab = control('', { 'data-char': 'player' }, true);
  const crewTab = control('', { 'data-char': '0' });
  let advance = [endTurn, nextFight];
  const root = {
    id: 'screen-shop',
    querySelectorAll(selector) {
      if (selector === '#btn-end-turn, #btn-next-fight') return advance;
      if (selector === '[data-patch]') return [patch];
      if (selector === '[data-char]') return [playerTab, crewTab];
      return [];
    },
  };
  const navigator = Object.create(MenuNavigator.prototype);
  navigator.doc = { querySelector: () => root, activeElement: null };
  navigator._visible = (el) => el !== nextFight || advance.length === 1;
  navigator._activate = (el) => el.click();
  navigator._items = () => [patch, playerTab, crewTab];
  navigator.current = patch;
  navigator._focus = (el) => calls.push(`focus:${controlIdentity(el)}`);

  assert.equal(navigator._advance(root), true);
  advance = [nextFight];
  assert.equal(navigator._advance(root), true);
  assert.equal(navigator._patch(root), true);
  assert.equal(navigator._cycleSquad(root, 1), true);
  assert.deepEqual(calls, [
    'btn-end-turn', 'btn-next-fight', 'patch:player', '0', 'focus:data-patch:player',
  ]);
});

test('panel shortcuts jump directly between market regions', () => {
  const focusCalls = [];
  const panel = (name, left) => ({
    getAttribute: (attr) => attr === 'data-shop-panel' ? name : null,
    getBoundingClientRect: () => rect(left, 0, 280, 700),
    closest: () => null,
  });
  const market = panel('market', 0);
  const stash = panel('stash', 300);
  const marketControl = {
    id: 'market-buy',
    closest: () => market,
    getBoundingClientRect: () => rect(20, 200),
  };
  const stashControl = {
    id: 'stash-item',
    closest: () => stash,
    getBoundingClientRect: () => rect(320, 210),
  };
  const root = {
    querySelectorAll: (selector) => selector === '[data-shop-panel]' ? [market, stash] : [],
  };
  const navigator = Object.create(MenuNavigator.prototype);
  navigator.doc = {
    activeElement: marketControl,
    body: { classList: { contains: (name) => name === 'controller-menu-cursor' } },
  };
  navigator.current = marketControl;
  navigator.cursorTarget = marketControl;
  navigator.cursorX = 60;
  navigator.cursorY = 220;
  navigator.cursorSnapped = null;
  navigator.cursorSnapPoint = null;
  navigator.lastCenter = { x: 60, y: 220 };
  navigator.panelMemory = new Map();
  navigator._visible = () => true;
  navigator._items = (scope) => scope === stash ? [stashControl] : scope === market ? [marketControl] : [marketControl, stashControl];
  navigator._focus = (el) => focusCalls.push(el.id);
  navigator._setCursorTarget = (el) => { navigator.cursorTarget = el; };
  navigator._renderCursor = () => {};

  assert.equal(navigator._jumpPanel(root, 1), true);
  assert.deepEqual(focusCalls, ['stash-item']);
  assert.equal(navigator.cursorSnapped, stashControl);
  assert.deepEqual(navigator.cursorSnapPoint, { x: 360, y: 230 });
});

test('horizontal stick navigation moves across grid tiles before crossing panels', () => {
  const focused = [];
  const panel = (name, left) => ({
    getAttribute: (attr) => attr === 'data-shop-panel' ? name : null,
    getBoundingClientRect: () => rect(left, 0, 280, 700),
  });
  const stash = panel('stash', 300);
  const squad = panel('squad', 600);
  const gridItem = (id, left) => ({
    id,
    matches: (selector) => selector === '[data-controller-item]',
    closest: (selector) => selector === '[data-shop-panel], [data-controller-panel]'
      || selector === '[data-shop-panel]' ? stash : null,
    getBoundingClientRect: () => rect(left, 180, 60, 60),
  });
  const first = gridItem('stash-first', 320);
  const second = gridItem('stash-second', 410);
  const squadControl = {
    id: 'squad-control',
    matches: () => false,
    closest: (selector) => selector === '[data-shop-panel]' ? squad : null,
    getBoundingClientRect: () => rect(630, 180),
  };
  const root = {
    id: 'screen-shop',
    querySelectorAll: (selector) => selector === '[data-shop-panel]' ? [stash, squad] : [],
  };
  const navigator = Object.create(MenuNavigator.prototype);
  navigator.doc = {
    activeElement: first,
    body: { classList: { contains: () => false } },
    querySelector: () => root,
  };
  navigator.current = first;
  navigator.lastCenter = { x: 350, y: 210 };
  navigator.panelMemory = new Map();
  navigator.activate = () => {};
  navigator._dialog = () => null;
  navigator._visible = () => true;
  navigator._updateHint = () => {};
  navigator._items = (scope) => scope === stash
    ? [first, second]
    : scope === squad ? [squadControl] : [first, second, squadControl];
  navigator._focus = (el) => {
    navigator.current = el;
    navigator.doc.activeElement = el;
    const bounds = el.getBoundingClientRect();
    navigator.lastCenter = {
      x: bounds.left + bounds.width / 2,
      y: bounds.top + bounds.height / 2,
    };
    focused.push(el.id);
  };

  assert.equal(navigator.handle('right'), true);
  assert.equal(navigator.current, second, 'right moves to the next tile in the grid');
  assert.equal(navigator.handle('right'), true);
  assert.equal(navigator.current, squadControl, 'right crosses panels only at the grid edge');
  assert.deepEqual(focused, ['stash-second', 'squad-control']);
});

test('alternate market action buys the focused row directly to the selected fighter', () => {
  let clicks = 0;
  const buyTo = {
    disabled: false,
    closest: () => null,
    getBoundingClientRect: () => rect(140, 100),
    click: () => { clicks++; },
  };
  const row = { querySelector: () => buyTo };
  const primary = {
    closest: (selector) => selector === '.market-row' ? row : null,
  };
  const navigator = Object.create(MenuNavigator.prototype);
  navigator.doc = { activeElement: primary };
  navigator.current = primary;
  navigator._items = () => [primary];
  navigator._visible = () => true;
  navigator._activate = (el) => el.click();
  assert.equal(navigator._alternate({ id: 'screen-shop' }), true);
  assert.equal(clicks, 1);
});

test('controller cursor treats a market row as one A/X purchase target', () => {
  const calls = [];
  const primary = { disabled: false };
  const direct = { disabled: false };
  const row = {
    matches: (selector) => selector === '[data-controller-market-row]',
    closest: (selector) => selector === '.market-row' ? row : null,
    querySelector: (selector) => selector.includes('data-buy-item') ? primary : direct,
  };
  const navigator = Object.create(MenuNavigator.prototype);
  navigator.doc = {
    body: { classList: { contains: () => true } },
    activeElement: null,
  };
  navigator.cursorTarget = row;
  navigator._items = () => [];
  navigator._visible = () => true;
  navigator._syncCursorTarget = () => row;
  navigator._activate = (target) => calls.push(target === primary ? 'stash' : 'equip');

  assert.equal(navigator._cursorActivate({ id: 'screen-shop' }), true);
  assert.equal(navigator._alternate({ id: 'screen-shop' }), true);
  assert.deepEqual(calls, ['stash', 'equip']);
});

test('stash shortcuts equip with X and sell with held Y', () => {
  const events = [];
  const stashItem = {
    isConnected: true,
    matches: (selector) => [
      '[data-controller-item]',
      '[data-controller-item][data-inventory="stash"]',
    ].includes(selector),
    getBoundingClientRect: () => rect(320, 180),
    dispatchEvent: (event) => events.push(event.type),
  };
  const root = { id: 'screen-shop' };
  const navigator = Object.create(MenuNavigator.prototype);
  navigator.doc = {
    activeElement: stashItem,
    defaultView: { Event },
    querySelector: () => root,
  };
  navigator.current = stashItem;
  navigator._items = () => [stashItem];
  navigator._nearest = () => null;

  assert.equal(navigator._alternate(root), true);
  assert.equal(navigator._sell(root), true);
  assert.deepEqual(events, ['controllerequip', 'controllersell']);
});

test('held Y sells equipped and backpack inventory items too', () => {
  const events = [];
  const equippedItem = {
    matches: (selector) => selector === '[data-controller-item]',
    getBoundingClientRect: () => rect(780, 260),
    dispatchEvent: (event) => events.push(event.type),
  };
  const root = { id: 'screen-shop' };
  const navigator = Object.create(MenuNavigator.prototype);
  navigator.doc = {
    activeElement: equippedItem,
    defaultView: { Event },
    querySelector: () => root,
  };
  navigator.current = equippedItem;
  navigator._items = () => [equippedItem];
  navigator._nearest = () => null;

  assert.equal(navigator._sell(root), true);
  assert.deepEqual(events, ['controllersell']);
});

test('cursor activation sets range values from the visible pointer position', () => {
  const dispatched = [];
  const slider = {
    min: '0',
    max: '1',
    step: '0.05',
    value: '0',
    matches: (selector) => selector === 'input[type="range"]',
    getBoundingClientRect: () => rect(100, 100, 400, 20),
    dispatchEvent: (event) => dispatched.push(event.type),
  };
  const navigator = Object.create(MenuNavigator.prototype);
  navigator.doc = { defaultView: { Event } };
  navigator.cursorX = 400;
  navigator._syncCursorTarget = () => slider;

  assert.equal(navigator._cursorActivate({}), true);
  assert.equal(slider.value, '0.75');
  assert.deepEqual(dispatched, ['input', 'change']);
});

test('open hire dialog traps controller focus inside the contract cards', () => {
  const hireButton = { id: 'hire-enforcer' };
  const underlyingButton = { id: 'market-buy' };
  const dialog = { querySelectorAll: () => [hireButton] };
  const root = {
    id: 'screen-shop',
    querySelector: (selector) => selector === '#hire-overlay:not(.hidden)' ? dialog : null,
    querySelectorAll: () => [underlyingButton],
  };
  const navigator = Object.create(MenuNavigator.prototype);
  navigator.doc = { body: { classList: { contains: () => false } }, querySelector: () => null };
  navigator._visible = () => true;

  assert.deepEqual(navigator._items(root), [hireButton]);
});

test('back shortcut immediately returns from the fight intro without requiring focus first', () => {
  let clicks = 0;
  const back = {
    id: 'btn-intro-back',
    disabled: false,
    closest: () => null,
    getBoundingClientRect: () => rect(100, 100),
    click: () => { clicks++; },
  };
  const root = {
    id: 'screen-intro',
    querySelector: () => back,
    querySelectorAll: () => [],
  };
  const classes = new Set();
  const navigator = Object.create(MenuNavigator.prototype);
  navigator.doc = {
    body: {
      classList: {
        add: (...names) => names.forEach(name => classes.add(name)),
        contains: (name) => classes.has(name),
      },
    },
    querySelector: () => root,
    getElementById: () => null,
  };
  navigator._visible = () => true;
  navigator._activate = (el) => el.click();

  assert.equal(navigator.handle('back'), true);
  assert.equal(clicks, 1);
});

test('dynamic shop controls retain stable semantic focus identities', () => {
  const element = (id = '', attributes = {}) => ({
    id,
    hasAttribute: (name) => Object.hasOwn(attributes, name),
    getAttribute: (name) => attributes[name] ?? null,
  });
  assert.equal(controlIdentity(element('btn-next-fight')), 'id:btn-next-fight');
  assert.equal(controlIdentity(element('', { 'data-char': '2' })), 'data-char:2');
  assert.equal(controlIdentity(element('', { 'data-auto-squad': 'autoAmmo' })), 'data-auto-squad:autoAmmo');
  assert.equal(controlIdentity(element('', { 'data-patch': '2' })), 'data-patch:2');
  assert.equal(controlIdentity(element('', {
    'data-controller-item': '',
    'data-item': 'item-19',
  })), 'data-item:item-19');
  assert.equal(controlIdentity(element('', {
    'data-controller-target': 'slot',
    'data-who': '2',
    'data-slot': 'body',
  })), 'target:slot:2:body');
});

test('controller focus returns to the same crew control after the squad panel rerenders', () => {
  const previousGetComputedStyle = globalThis.getComputedStyle;
  globalThis.getComputedStyle = () => ({ display: 'block', visibility: 'visible' });
  const classes = new Set();
  const classList = {
    add: (...names) => names.forEach(name => classes.add(name)),
    remove: (...names) => names.forEach(name => classes.delete(name)),
    contains: (name) => classes.has(name),
    toggle: (name, force) => force ? classes.add(name) : classes.delete(name),
  };
  const doc = {
    activeElement: null,
    body: { classList },
    addEventListener: () => {},
    dispatchEvent: () => {},
    getElementById: () => null,
    querySelector: (selector) => selector === '.screen:not(.hidden)' ? root : null,
  };
  const makeControl = (attributes, left, onClick = () => {}) => ({
    id: '',
    disabled: false,
    hasAttribute: (name) => Object.hasOwn(attributes, name),
    getAttribute: (name) => attributes[name] ?? null,
    closest: () => null,
    matches: () => false,
    getBoundingClientRect: () => ({ left, top: 100, width: 80, height: 32 }),
    focus() { doc.activeElement = this; },
    scrollIntoView: () => {},
    click: onClick,
  });

  let controls;
  const replacementCrew = makeControl({ 'data-char': '2' }, 600);
  const patch = makeControl({ 'data-patch': '2' }, 600);
  const originalCrew = makeControl({ 'data-char': '2' }, 600, () => {
    controls = [replacementCrew, patch];
  });
  controls = [originalCrew];
  const root = {
    id: 'screen-shop',
    querySelectorAll: () => controls,
    querySelector: () => null,
  };

  try {
    const navigator = new MenuNavigator(doc);
    navigator._focus(originalCrew, root);
    navigator.handle('activate');
    assert.equal(navigator.current, replacementCrew);
    assert.equal(doc.activeElement, replacementCrew);
    assert.equal(navigator.lastIdentity, 'data-char:2');
  } finally {
    if (previousGetComputedStyle) globalThis.getComputedStyle = previousGetComputedStyle;
    else delete globalThis.getComputedStyle;
  }
});
