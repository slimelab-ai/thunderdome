import test from 'node:test';
import assert from 'node:assert/strict';
import { controlIdentity, controllerHint, directionalCandidate, MenuNavigator } from '../src/ui-nav.js';

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

test('controller hints advertise context-sensitive market shortcuts', () => {
  const shop = controllerHint('screen-shop');
  assert.match(shop, /X END TURN \/ NEXT FIGHT/);
  assert.match(shop, /Y PATCH/);
  assert.match(shop, /LB \/ RB SQUAD/);
  assert.match(controllerHint('screen-intro'), /X START FIGHT/);
  assert.match(controllerHint('screen-intro'), /B BLACK MARKET/);
  assert.match(controllerHint('screen-shop', { carrying: true }), /B CANCEL/);
  assert.doesNotMatch(controllerHint('screen-menu'), /B BACK/);
});

test('market shortcuts advance, patch, and cycle the selected squad member', () => {
  const calls = [];
  const control = (id, attributes = {}, selected = false) => ({
    id,
    classList: { contains: (name) => name === 'char-tab-sel' && selected },
    getAttribute: (name) => attributes[name] ?? null,
    hasAttribute: (name) => Object.hasOwn(attributes, name),
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
  navigator.doc = { querySelector: () => root };
  navigator._visible = (el) => el !== nextFight || advance.length === 1;
  navigator._activate = (el) => el.click();
  navigator._focus = (el) => calls.push(`focus:${el.getAttribute('data-char')}`);

  assert.equal(navigator._advance(root), true);
  advance = [nextFight];
  assert.equal(navigator._advance(root), true);
  assert.equal(navigator._patch(root), true);
  assert.equal(navigator._cycleSquad(root, 1), true);
  assert.deepEqual(calls, [
    'btn-end-turn', 'btn-next-fight', 'patch:player', '0', 'focus:0',
  ]);
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
