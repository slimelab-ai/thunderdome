import { WEAPONS, WEAPON_ORDER } from './weapons.js';
import { audio } from './audio.js';
import {
  ITEM_TYPES, AMMO_TYPES, countInPack, characterWeight, weightSpeedMult, gridRows,
} from './items.js';

const $ = (id) => document.getElementById(id);

function healthColor(f) {
  // f: 1 = healthy → green; 0 = dead → red
  const r = f > 0.5 ? Math.round(255 * (1 - f) * 2) : 255;
  const g = f > 0.5 ? 218 : Math.round(218 * f * 2);
  return `rgb(${r},${g},60)`;
}

// icon sheet is 6×4 cells
function iconStyle(icon) {
  const col = icon % 6, row = (icon / 6) | 0;
  return `background-image:url(/assets/icons/items_sheet.png);background-size:600% 400%;` +
    `background-position:${(col / 5) * 100}% ${(row / 3) * 100}%;`;
}

// Recruits are PERMANENT: they come with nothing but a pistol and their base stats.
// You arm and armor them from the stash; when they go down mid-match they're back
// (bruised, free of charge) for the next bout with everything you gave them.
export const CREW_TIERS = {
  rookie: { name: 'Rookie', price: 400, hp: 85, spreadMult: 1.7, reaction: 0.75, speedMult: 1, desc: 'Some kid with a pistol and a dream. Cheap to sign, slow to aim.' },
  veteran: { name: 'Veteran', price: 1000, hp: 110, spreadMult: 1.15, reaction: 0.5, speedMult: 1.05, desc: 'Ex-military. Steady hands, moderate trauma. Bring your own gun.' },
  elite: { name: 'Elite', price: 2000, hp: 140, spreadMult: 0.85, reaction: 0.35, speedMult: 1.1, desc: 'Cartel-trained killer. Give this one the good rifle.' },
};

export const TRAINING = {
  aim: { name: 'MARKSMANSHIP', max: 2, prices: [700, 1500], desc: 'Tighter spread, tamer recoil.' },
  cardio: { name: 'CARDIO', max: 2, prices: [600, 1300], desc: 'Move faster, snap to sights quicker.' },
  tough: { name: 'PAIN TOLERANCE', max: 2, prices: [800, 1700], desc: '+25 max HP per level.' },
};

const MUT_NAMES = {
  blood_money: 'RICH CROWD', dim: 'BROWNOUT', pricey_docs: 'MEDICAL RACKET',
  hair_trigger: 'HAIR TRIGGERS', hard_rounds: 'HOT LOADS', swarm: 'FULL CARD',
};

const CREW_NAMES = ['Moose', 'Wren', 'Sledge', 'Ivy', 'Tarmac', 'Nadia', 'Brick', 'Kestrel', 'Yusuf', 'Dora', 'Flint', 'Marrow'];
let crewNameIdx = 0;
export function nextCrewName() { return CREW_NAMES[crewNameIdx++ % CREW_NAMES.length]; }

export class UI {
  constructor() {
    this.el = {
      hud: $('hud'), crosshair: $('crosshair'), hitmarker: $('hitmarker'),
      hpNum: $('hp-num'), hpFill: $('hp-fill'), statusTags: $('status-tags'),
      ammoMag: $('ammo-mag'), weaponName: $('weapon-name'), reloadHint: $('reload-hint'),
      weaponSlots: $('weapon-slots'), rank: $('hud-rank'), money: $('hud-money'),
      frenzy: $('frenzy-chip'), killfeed: $('killfeed'), squadPanel: $('squad-panel'),
      damageFlash: $('damage-flash'), lowhp: $('lowhp-overlay'),
      eventBanner: $('event-banner'), eventTitle: $('event-title'), eventSub: $('event-sub'),
      objective: $('objective-line'), interact: $('interact-hint'),
      consRow: $('consumables'), channelWrap: $('channel-wrap'), channelFill: $('channel-fill'), channelLabel: $('channel-label'),
      bp: { head: $('bp-head'), torso: $('bp-torso'), armL: $('bp-armL'), armR: $('bp-armR'), legL: $('bp-legL'), legR: $('bp-legR') },
    };
    this.screens = {
      menu: $('screen-menu'), intro: $('screen-intro'), shop: $('screen-shop'),
      death: $('screen-death'), champion: $('screen-champion'), executed: $('screen-executed'),
      pause: $('screen-pause'),
    };
    this._eventTimer = null;
    this.selChar = 'player';
    this.hireOpen = false;
  }

  showScreen(name) {
    for (const [k, s] of Object.entries(this.screens)) s.classList.toggle('hidden', k !== name);
    this.el.hud.classList.toggle('hidden', !(name === null));
  }
  showHUDOnly() { this.showScreen(null); }

  // ---------- HUD ----------
  updateHUD(player, career, match) {
    const hpF = Math.max(0, player.hp / player.maxHp);
    this.el.hpNum.textContent = Math.ceil(player.hp);
    this.el.hpFill.style.width = `${hpF * 100}%`;
    this.el.hpFill.style.background = healthColor(hpF);
    this.el.lowhp.style.opacity = hpF < 0.35 ? String(0.5 + (0.35 - hpF)) : '0';

    // body diagram
    const bodyF = healthColor(hpF);
    this.el.bp.head.style.fill = bodyF;
    this.el.bp.torso.style.fill = bodyF;
    this.el.bp.armL.style.fill = healthColor(Math.min(hpF, 1 - player.armDmg));
    this.el.bp.armR.style.fill = healthColor(Math.min(hpF, 1 - player.armDmg));
    this.el.bp.legL.style.fill = healthColor(Math.min(hpF, 1 - player.legDmg));
    this.el.bp.legR.style.fill = healthColor(Math.min(hpF, 1 - player.legDmg));

    // status tags
    let tags = '';
    if (player.armDmg > 0.25) tags += '<span class="st-tag">AIM IMPAIRED</span>';
    if (player.legDmg > 0.25) tags += '<span class="st-tag">LIMPING</span>';
    if (this.el.statusTags._last !== tags) { this.el.statusTags.innerHTML = tags; this.el.statusTags._last = tags; }

    // ammo / weapon — reserve is real rounds in the backpack now
    const melee = !!player.weapon.melee;
    this.el.ammoMag.textContent = melee ? '—' : player.mag;
    const res = player.reserve();
    const resEl = $('ammo-reserve');
    const resTxt = melee ? '—' : String(res);
    if (resEl.textContent !== resTxt) {
      resEl.textContent = resTxt;
      resEl.style.color = !melee && res <= player.weapon.mag ? 'var(--blood)' : '';
    }
    this.el.weaponName.textContent = player.weapon.name;
    this.el.reloadHint.classList.toggle('hidden', player.reloading <= 0);

    // weapon slots: guns on 1/2, the knife pinned on 3
    const slotsKey = player.slots.join(',') + player.slotIdx + (player.knifeOut ? 'K' : '');
    if (this.el.weaponSlots._last !== slotsKey) {
      this.el.weaponSlots._last = slotsKey;
      this.el.weaponSlots.innerHTML = player.slots.map((id, i) =>
        `<span class="wslot ${!player.knifeOut && i === player.slotIdx ? 'active' : ''}">${i + 1}·${WEAPONS[id].name.split(' ')[0]}</span>`).join('') +
        `<span class="wslot ${player.knifeOut ? 'active' : ''}">3·SHANK</span>`;
    }

    this.el.rank.textContent = career.rank;
    this.el.money.textContent = career.money.toLocaleString();
    this.el.frenzy.classList.toggle('hidden', !match.frenzy);

    // consumables (straight out of the backpack)
    const nMed = countInPack(player.character, 'medkit');
    const nSpl = countInPack(player.character, 'splint');
    const nNade = countInPack(player.character, 'grenade');
    const consKey = `${nMed}|${nSpl}|${nNade}`;
    if (this.el.consRow._last !== consKey) {
      this.el.consRow._last = consKey;
      this.el.consRow.innerHTML =
        `<span class="${nMed ? '' : 'cons-empty'}"><b>H</b> 🩹${nMed}</span>` +
        `<span class="${nSpl ? '' : 'cons-empty'}"><b>V</b> 🩼${nSpl}</span>` +
        `<span class="${nNade ? '' : 'cons-empty'}"><b>G</b> 💣${nNade}</span>`;
    }

    // heal channel
    if (player.healing) {
      this.el.channelWrap.classList.remove('hidden');
      this.el.channelFill.style.width = `${(player.healing.t / player.healing.dur) * 100}%`;
      this.el.channelLabel.textContent = player.healing.label;
    } else {
      this.el.channelWrap.classList.add('hidden');
    }

    // crosshair spread
    const spreadPx = 6 + player.currentSpread() * 14;
    this.el.crosshair.style.setProperty('--sp', `${spreadPx.toFixed(1)}px`);
    this.el.crosshair.style.opacity = player.ads > 0.7 && player.weapon.id === 'dmr' ? '0.4' : '1';

    // objective
    const alive = match.enemiesAlive;
    this.el.objective.textContent = alive > 0 ? `${alive} HOSTILE${alive > 1 ? 'S' : ''} REMAINING` : '';

    // squad panel
    const key = match.crew.map(c => `${c.name}:${c.alive ? Math.ceil(c.hp) : 'X'}`).join('|');
    if (this.el.squadPanel._last !== key) {
      this.el.squadPanel._last = key;
      this.el.squadPanel.innerHTML = match.crew.map(c => c.alive
        ? `<div class="sq-card">${c.name}<span class="sq-hp"><i style="width:${(c.hp / c.maxHp) * 100}%"></i></span></div>`
        : `<div class="sq-card dead">${c.name}</div>`
      ).join('');
    }
  }

  hitmarker(kill, headshot) {
    const hm = this.el.hitmarker;
    hm.classList.remove('hit', 'kill');
    void hm.offsetWidth;
    hm.classList.add('hit');
    if (kill) hm.classList.add('kill');
    if (kill) audio.hitmarker();
    if (headshot && kill) audio.headshotDing();
    else if (!kill) audio.hitmarker();
  }

  damageFlash() {
    this.el.damageFlash.style.transition = 'none';
    this.el.damageFlash.style.opacity = '1';
    requestAnimationFrame(() => {
      this.el.damageFlash.style.transition = 'opacity 0.5s';
      this.el.damageFlash.style.opacity = '0';
    });
  }

  killfeed(killerName, victimName, headshot, friendlyKiller) {
    const e = document.createElement('div');
    e.className = 'kf-entry' + (friendlyKiller ? ' friendly' : '');
    e.innerHTML = `<b>${killerName}</b> ${headshot ? '<span class="kf-head">☠ headshot</span>' : '🗡'} ${victimName}`;
    this.el.killfeed.prepend(e);
    while (this.el.killfeed.children.length > 5) this.el.killfeed.lastChild.remove();
    setTimeout(() => e.remove(), 6000);
  }

  eventBanner(title, sub, color = 'var(--blood)') {
    this.el.eventTitle.textContent = title;
    this.el.eventTitle.style.color = color;
    this.el.eventSub.textContent = sub;
    this.el.eventBanner.classList.remove('hidden');
    clearTimeout(this._eventTimer);
    this._eventTimer = setTimeout(() => this.el.eventBanner.classList.add('hidden'), 3500);
  }

  moneyPop(amount) {
    const e = document.createElement('div');
    e.className = 'money-pop';
    e.textContent = `+$${amount}`;
    e.style.left = `${48 + Math.random() * 8}%`;
    e.style.top = `${52 + Math.random() * 6}%`;
    document.body.appendChild(e);
    setTimeout(() => e.remove(), 1100);
  }

  interactHint(text) {
    this.el.interact.classList.toggle('hidden', !text);
    if (text) this.el.interact.textContent = text;
  }

  // ---------- SHOP: market / stash grid / squad dolls with drag & drop ----------
  renderShop(career, player, nextSquad, earnings, actions) {
    this._shopArgs = [career, player, nextSquad, earnings, actions];
    $('shop-money').textContent = career.money.toLocaleString();
    const liquidation = career.mode === 'liquidation';
    const draftBout = liquidation && career.liquidation.round <= 10;
    $('shop-sub').textContent = liquidation
      ? `Liquidation · Round ${career.liquidation.round} · ${draftBout ? `draft envelope ${career.liquidation.draft.fundedRounds}/10 (+$${career.liquidation.draft.lastEnvelope.toLocaleString()})` : 'STRANGLE PHASE'} · rival $${career.liquidation.enemyMoney.toLocaleString()}`
      : `Circuit ${career.circuit} · Rank ${career.rank} contender` +
        (career.mutators.length ? ` · ${career.mutators.length} house conditions` : '');

    const eb = $('earnings-box');
    if (earnings) {
      eb.classList.remove('hidden');
      eb.innerHTML = `<span>LAST BOUT:</span> <span>💀 ${earnings.kills} kills → <b>$${earnings.killMoney}</b></span>` +
        (earnings.headshots ? `<span>🎯 ${earnings.headshots} headshots → <b>$${earnings.hsMoney}</b></span>` : '') +
        `<span>🏆 win purse → <b>$${earnings.winBonus}</b></span>` +
        (earnings.frenzyMoney ? `<span>💰 frenzy → <b>$${earnings.frenzyMoney}</b></span>` : '') +
        (earnings.betWinnings ? `<span>🎲 bet → <b>$${earnings.betWinnings}</b></span>` : '') +
        `<span>TOTAL: <b>$${earnings.total}</b></span>`;
    } else eb.classList.add('hidden');

    const pm = actions.priceMult();
    const priceOf = (type) => actions.priceOf ? actions.priceOf(type) : Math.round(ITEM_TYPES[type].price * pm);

    // ---- market ----
    const MARKET = [
      ['🔫 HARDWARE', ['smg', 'shotgun', 'rifle', 'dmr', 'pistol']],
      ['🦺 ARMOR', ['helm1', 'helm2', 'vest1', 'vest2', 'pads1', 'pads2']],
      ['📦 AMMUNITION', ['ammo_9mm', 'ammo_buck', 'ammo_762', 'ammo_308']],
      ['💊 MEDICAL & LOUD', ['medkit', 'splint', 'grenade']],
    ];
    const selName = this.selChar === 'player' ? 'YOU' : (career.crew[this.selChar]?.name || 'YOU');
    const ammoChip = (t) => {
      const def = ITEM_TYPES[t];
      if (def.kind === 'gun' && def.ammo) return `<span class="ammo-chip">${AMMO_TYPES[def.ammo].name}</span>`;
      if (def.kind === 'ammo') {
        const feeds = WEAPON_ORDER.filter(g => ITEM_TYPES[g].ammo === def.ammoType).map(g => ITEM_TYPES[g].name.split(' ')[0]);
        return `<span class="ammo-chip">feeds ${feeds.join('/')}</span>`;
      }
      return '';
    };
    $('market-list').innerHTML = MARKET.map(([label, types]) => `
      <div class="armor-slot-label">${label}</div>` +
      types.map(t => {
        const def = ITEM_TYPES[t];
        const cost = priceOf(t);
        const soldOut = !Number.isFinite(cost);
        const mi = actions.marketInfo?.(t);
        const marketFlag = mi ? `<span class="market-pressure ${mi.scarce ? 'market-scarce' : mi.surplus ? 'market-surplus' : ''}">${soldOut ? 'DRAINED' : mi.scarce ? 'SHORTAGE' : mi.surplus ? 'SURPLUS' : 'LIQUID'} · ${mi.units.toFixed(1)} left</span>` : '';
        const canBuy = !soldOut && career.money >= cost;
        return `<div class="market-row">
          <span class="mk-icon" style="${iconStyle(def.icon)}"></span>
          <span class="mk-name">${def.name}${ammoChip(t)}<span class="mk-w">${def.weight}kg</span>${marketFlag}</span>
          <button class="btn" data-buy-item="${t}" ${canBuy ? '' : 'disabled'}>${soldOut ? 'OUT' : '$' + cost}</button>
          <button class="btn" data-buy-to="${t}" ${canBuy ? '' : 'disabled'} title="buy straight onto ${selName}">→${selName === 'YOU' ? 'YOU' : selName.slice(0, 5).toUpperCase()}</button>
        </div>`;
      }).join('')).join('');

    // ---- training ----
    $('shop-training').innerHTML = Object.entries(TRAINING).map(([id, t]) => {
      const lvl = career.skills[id];
      const maxed = lvl >= t.max;
      const price = maxed ? 0 : Math.round(t.prices[lvl] * pm);
      return `<div class="shop-item ${maxed ? 'owned' : ''}">
        <div class="si-info"><div class="si-name">${t.name} ${'★'.repeat(lvl)}${'☆'.repeat(t.max - lvl)}</div><div class="si-desc">${t.desc}</div></div>
        ${maxed ? '<span class="si-owned">MAXED</span>'
          : `<button class="btn" data-train="${id}" ${career.money >= price ? '' : 'disabled'}>$${price}</button>`}
      </div>`;
    }).join('');

    // ---- next bout ----
    if (liquidation) {
      const rival = career.liquidation.enemy;
      $('next-bout').innerHTML =
        `<b>THE RIVAL SYNDICATE</b><br>${draftBout ? `DRAFT ROUND ${career.liquidation.draft.fundedRounds}/10` : 'THE STRANGLE — no more envelopes'} · Strategy: ${rival.strategy.toUpperCase()}<br>` +
        `<span class="dim">Their inventory is private. Their trades and bankroll are not.</span>`;
    } else {
      $('next-bout').innerHTML = `<b>${nextSquad.name}</b><br>${nextSquad.blurb}<br>
      <span class="dim">${nextSquad.roster.length} fighters · circuit ${career.circuit}` +
      (career.mutators.length ? `<br>house conditions: ${career.mutators.map(m => MUT_NAMES[m] || m).join(', ')}` : '') + `</span>`;
    }

    const tapeWrap = $('market-tape-wrap');
    tapeWrap.classList.toggle('hidden', !liquidation);
    if (liquidation) {
      const tape = $('market-tape');
      tape.innerHTML = (career.liquidation.marketLog || []).map(entry => {
        if (entry.kind === 'round') {
          return `<div class="tape-round"><span>ROUND ${entry.round}</span></div>`;
        }
        if (entry.kind === 'event') {
          return `<div class="tape-event">${entry.text}</div>`;
        }
        const item = ITEM_TYPES[entry.type]?.name || entry.type;
        const playerSide = entry.side === 'player';
        const sold = entry.action === 'sell';
        return `<div class="tape-row ${playerSide ? 'tape-player' : 'tape-rival'}">` +
          `<span class="tape-side">${playerSide ? 'YOU' : 'RIVAL'}</span>` +
          `<span class="tape-action">${sold ? 'SOLD' : 'BOUGHT'} ${item}</span>` +
          `<b class="${sold ? 'tape-credit' : 'tape-debit'}">${sold ? '+' : '−'}$${entry.amount.toLocaleString()}</b></div>`;
      }).join('');
      tape.scrollTop = tape.scrollHeight;
    }

    $('btn-next-fight').disabled = false;
    $('sell-bin').textContent = liquidation ? '💰 SELL — return to the shared pool at 100% market rate' : '💰 SELL — drop anything here to liquidate (55%)';

    // ---- stash grid ----
    const CELL = 42;
    const stashRows = gridRows(career.stash);
    const gridHtml = (grid, dropName, who) => {
      const rows = grid.rows > 0 ? grid.rows : stashRows;
      let html = `<div class="inv-grid" data-drop="${dropName}" ${who !== undefined ? `data-who="${who}"` : ''}
        style="width:${grid.cols * CELL}px;height:${rows * CELL}px;">`;
      for (const e of grid.items) {
        const def = ITEM_TYPES[e.it.type];
        html += `<div class="inv-item" data-item="${e.it.uid}" title="${def.name} · ${def.weight}kg — drag to move, drop on SELL to liquidate"
          style="left:${e.x * CELL}px;top:${e.y * CELL}px;width:${def.w * CELL}px;height:${def.h * CELL}px;">
          <span class="inv-ico" style="${iconStyle(def.icon)}"></span>
          ${e.it.rounds != null ? `<span class="inv-count">${e.it.rounds}</span>` : ''}
        </div>`;
      }
      return html + '</div>';
    };
    $('stash-wrap').innerHTML = gridHtml(career.stash, 'stash');

    // ---- squad panel ----
    if (this.selChar === undefined) this.selChar = 'player';
    if (this.selChar !== 'player' && !career.crew[this.selChar]) this.selChar = 'player';
    const deployed = career.crew.filter(c => !c.benched).length;
    const tabs = [['player', 'YOU'], ...career.crew.map((m, i) => [i, m.name])];
    $('char-tabs').innerHTML = tabs.map(([who, label]) => {
      const benched = who !== 'player' && career.crew[who].benched;
      const hp = who === 'player'
        ? (career.playerHp == null ? 1 : career.playerHp / (100 + career.skills.tough * 25))
        : (career.crew[who].hp == null ? 1 : career.crew[who].hp / CREW_TIERS[career.crew[who].tier].hp);
      return `<button class="btn char-tab ${String(this.selChar) === String(who) ? 'char-tab-sel' : ''} ${benched ? 'char-tab-benched' : ''}" data-char="${who}">
        ${label}${benched ? ' 🪑' : ''}<i class="tab-hp" style="width:${Math.max(2, hp * 100)}%;background:${healthColor(hp)}"></i></button>`;
    }).join('') + (career.crew.length < 8
      ? `<button class="btn btn-ghost char-tab" data-hire-menu="1">+ HIRE</button>` : '')
      + `<span class="dim" style="align-self:center;font-size:10px">${deployed}/5 deploy</span>`;

    const who = this.selChar;
    const isPlayer = who === 'player';
    const m = isPlayer ? null : career.crew[who];
    const ch = isPlayer ? career.playerCh : m.ch;
    const maxHp = isPlayer ? 100 + career.skills.tough * 25 : CREW_TIERS[m.tier].hp;
    const hp = isPlayer ? (career.playerHp == null ? maxHp : career.playerHp) : (m.hp == null ? maxHp : m.hp);
    const limbs = isPlayer ? career.playerLimbs : (m.limbs || { arm: 0, leg: 0 });
    const patchCost = isPlayer ? actions.playerPatchCost() : actions.crewPatchCost(m);
    const wt = characterWeight(ch).toFixed(1);
    const wMult = weightSpeedMult(ch);

    const slotHtml = (slot, label) => {
      const it = ch.gear[slot];
      const def = it ? ITEM_TYPES[it.type] : null;
      const chip = def?.kind === 'gun' && def.ammo
        ? `<span class="ammo-chip slot-chip">${AMMO_TYPES[def.ammo].name} ×${ch.pack.items.reduce((n, e) => n + (ITEM_TYPES[e.it.type].ammoType === def.ammo ? e.it.rounds : 0), 0)}</span>`
        : '';
      return `<div class="doll-slot ${slot.startsWith('gun') ? 'doll-slot-gun' : ''}" data-slot="${slot}" data-who="${who}" title="${label}${def ? ' — ' + def.name : ''}">
        ${it ? `<div class="inv-item doll-it" data-item="${it.uid}" style="width:100%;height:100%;">
          <span class="inv-ico" style="${iconStyle(def.icon)}"></span>${chip}</div>` : `<span class="doll-lbl">${label}</span>`}
      </div>`;
    };

    const limbFlag = (l) => (l.arm > 0.05 ? ' <span class="limb-flag">ARM</span>' : '') + (l.leg > 0.05 ? ' <span class="limb-flag">LEG</span>' : '');
    const next = !isPlayer && (m.tier === 'rookie' ? 'veteran' : m.tier === 'veteran' ? 'elite' : null);
    const upCost = next ? Math.round((CREW_TIERS[next].price - CREW_TIERS[m.tier].price + 200) * pm) : 0;

    $('char-panel').innerHTML = `
      <div class="char-head">
        <div>
          <b>${isPlayer ? 'YOU' : m.name}</b>
          <span class="dim">${isPlayer ? 'the challenger' : CREW_TIERS[m.tier].name + ' · ' + (m.kills || 0) + ' kills'}</span>
          ${limbFlag(limbs)}${hp <= 0 ? ' <span class="limb-flag">OUT — NEEDS MEDICAL</span>' : ''}
        </div>
        <div class="char-hp"><span class="mini-hp"><i style="width:${(hp / maxHp) * 100}%;background:${healthColor(hp / maxHp)}"></i></span>${Math.round(hp)}/${maxHp}</div>
      </div>
      <div class="char-body">
        <div class="doll">
          ${slotHtml('head', 'HEAD')}
          ${slotHtml('body', 'BODY')}
          ${slotHtml('limbs', 'LEGS')}
          <div class="doll-guns">${slotHtml('gun1', 'GUN 1')}${slotHtml('gun2', 'GUN 2')}</div>
        </div>
        <div class="pack-side">
          <div class="dim" style="margin-bottom:3px">BACKPACK · ${wt}kg${wMult < 0.995 ? ` <span class="limb-flag">−${Math.round((1 - wMult) * 100)}% SPEED</span>` : ''}</div>
          ${gridHtml(ch.pack, 'pack', who)}
        </div>
      </div>
      <div class="char-actions">
        ${patchCost > 0 ? `<button class="btn" data-patch="${who}" ${career.money > 0 ? '' : 'disabled'}>🏥 PATCH $${Math.min(patchCost, career.money)}${career.money < patchCost ? ' ⚠' : ''}</button>` : '<span class="si-owned">FIGHTING FIT</span>'}
        ${next ? `<button class="btn" data-upgrade="${who}" ${career.money >= upCost ? '' : 'disabled'}>⬆ ${next.toUpperCase()} $${upCost}</button>` : ''}
        ${!isPlayer ? `<button class="btn" data-bench="${who}">${m.benched ? '▶ DEPLOY' : '🪑 BENCH'}</button>` : ''}
        ${!isPlayer ? `<button class="btn btn-ghost" data-sell-crew="${who}">SELL $${Math.round(CREW_TIERS[m.tier].price * 0.5)}</button>` : ''}
      </div>
      ${this.hireOpen ? `<div class="hire-menu">${Object.entries(CREW_TIERS).map(([id, t]) => {
        const cost = Math.round(t.price * pm);
        return `<div class="shop-item"><div class="si-info"><div class="si-name">${t.name.toUpperCase()}</div><div class="si-desc">${t.desc}</div></div>
        <button class="btn" data-hire="${id}" ${career.money >= cost && career.crew.length < 5 ? '' : 'disabled'}>$${cost}</button></div>`;
      }).join('')}</div>` : ''}`;

    // ---- wire buttons ----
    const wire = (sel, attr, fn) => {
      document.querySelectorAll(sel).forEach(b => b.onclick = () => { audio.uiClick(); fn(b.getAttribute(attr)); });
    };
    wire('[data-buy-item]', 'data-buy-item', actions.buyItem);
    wire('[data-buy-to]', 'data-buy-to', (t) => actions.buyItemTo(t, this.selChar));
    wire('[data-bench]', 'data-bench', (i) => actions.toggleBench(parseInt(i)));
    wire('[data-train]', 'data-train', actions.train);
    wire('[data-patch]', 'data-patch', (v) => v === 'player' ? actions.patchPlayer() : actions.patchCrew(parseInt(v)));
    wire('[data-upgrade]', 'data-upgrade', (i) => actions.upgradeCrew(parseInt(i)));
    wire('[data-sell-crew]', 'data-sell-crew', (i) => { actions.sellCrew(parseInt(i)); this.selChar = 'player'; });
    wire('[data-hire]', 'data-hire', (id) => { this.hireOpen = false; actions.hire(id); });
    wire('[data-char]', 'data-char', (whoSel) => {
      this.selChar = whoSel === 'player' ? 'player' : parseInt(whoSel);
      this.hireOpen = false;
      this.renderShop(...this._shopArgs);
    });
    wire('[data-hire-menu]', 'data-hire-menu', () => {
      this.hireOpen = !this.hireOpen;
      this.renderShop(...this._shopArgs);
    });

    this._bindDrag(actions, CELL);
  }

  // pointer-based drag & drop between stash / packs / doll slots / the SELL bin
  _bindDrag(actions, CELL) {
    document.querySelectorAll('.inv-item').forEach(el => {
      el.onpointerdown = (e) => {
        e.preventDefault();
        const uid = el.getAttribute('data-item');
        const ghost = el.cloneNode(true);
        ghost.classList.add('inv-ghost');
        ghost.style.width = `${el.offsetWidth}px`;
        ghost.style.height = `${el.offsetHeight}px`;
        document.body.appendChild(ghost);
        const moveGhost = (ev) => {
          ghost.style.left = `${ev.clientX - el.offsetWidth / 2}px`;
          ghost.style.top = `${ev.clientY - el.offsetHeight / 2}px`;
        };
        moveGhost(e);
        el.classList.add('inv-dragging');
        document.body.classList.add('dragging');
        const onMove = (ev) => moveGhost(ev);
        const onUp = (ev) => {
          document.removeEventListener('pointermove', onMove);
          document.removeEventListener('pointerup', onUp);
          ghost.remove();
          el.classList.remove('inv-dragging');
          document.body.classList.remove('dragging');
          const at = document.elementFromPoint(ev.clientX, ev.clientY);
          if (!at) return;
          const sellBin = at.closest('#sell-bin');
          const slotEl = at.closest('[data-slot]');
          const gridEl = at.closest('[data-drop]');
          if (sellBin) return actions.moveItem(uid, { kind: 'sell' });
          if (slotEl) return actions.moveItem(uid, { kind: 'slot', who: this._whoAttr(slotEl), slot: slotEl.getAttribute('data-slot') });
          if (gridEl) {
            const kind = gridEl.getAttribute('data-drop');
            const r = gridEl.getBoundingClientRect();
            const x = Math.floor((ev.clientX - r.left) / CELL);
            const y = Math.floor((ev.clientY - r.top) / CELL);
            return actions.moveItem(uid, kind === 'stash'
              ? { kind: 'stash', x, y }
              : { kind: 'pack', who: this._whoAttr(gridEl), x, y });
          }
        };
        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onUp);
      };
    });
  }

  _whoAttr(el) {
    const w = el.getAttribute('data-who');
    return w === 'player' ? 'player' : parseInt(w);
  }


  renderIntro(career, squad, odds, onBet, liquidationBets = []) {
    const liquidation = career.mode === 'liquidation';
    $('intro-rank').parentElement.innerHTML = liquidation
      ? `LIQUIDATION ROUND <span id="intro-rank">${career.liquidation.round}</span>`
      : `RANK <span id="intro-rank">${career.rank}</span> BOUT`;
    $('intro-squad').textContent = squad.name;
    $('intro-flavor').textContent = squad.blurb;

    // don't let anyone stumble into the pit broke, bleeding, and surprised
    const maxHp = 100 + career.skills.tough * 25;
    const hp = career.playerHp == null ? maxHp : career.playerHp;
    const hurt = hp < maxHp * 0.6 || career.playerLimbs.arm > 0.05 || career.playerLimbs.leg > 0.05;
    const benchedOut = career.crew.filter(c => c.hp != null && c.hp <= 0 && !c.benched).length;
    $('intro-status').innerHTML =
      `<span class="intro-money">$${career.money.toLocaleString()}</span>` +
      `<span class="intro-hp" style="color:${healthColor(hp / maxHp)}">${Math.round(hp)}/${maxHp} HP</span>` +
      (hurt ? '<span class="limb-flag">⚠ PATCH UP AT THE MARKET</span>' : '') +
      (benchedOut ? `<span class="limb-flag">⚠ ${benchedOut} CREW OUT — NEED MEDICAL</span>` : '');
    const bets = liquidation ? liquidationBets : [0, 200, 500, 1000];
    $('bet-row').innerHTML = liquidation
      ? `<span class="dim">SELF-BET · pays ${odds.toFixed(2)}× · selected $${career.bet.toLocaleString()} → $${Math.round(career.bet * odds).toLocaleString()} return<br>YOUR $${career.money.toLocaleString()} vs RIVAL $${career.liquidation.enemyMoney.toLocaleString()}</span> ` +
        bets.map(b => `<button class="btn bet-btn ${career.bet === b ? 'kit-cur' : ''}" data-bet="${b}">$${b.toLocaleString()}</button>`).join('')
      : `<span class="dim">BET ON YOURSELF · pays ${odds.toFixed(2)}×</span> ` +
      bets.map(b => `<button class="btn bet-btn ${career.bet === b ? 'kit-cur' : ''}" data-bet="${b}"
        ${b <= career.money ? '' : 'disabled'}>${b === 0 ? 'NO BET' : '$' + b}</button>`).join('');
    if (onBet) {
      document.querySelectorAll('[data-bet]').forEach(btn =>
        btn.onclick = () => onBet(parseInt(btn.getAttribute('data-bet'))));
    }
  }

  renderDeath(line, stats) {
    $('death-line').textContent = line;
    $('death-stats').innerHTML = stats;
  }

  renderChampion(statsHtml, liquidationComplete = false) {
    const screen = this.screens.champion;
    screen.classList.toggle('liquidation-win', liquidationComplete);
    $('champ-pre').textContent = liquidationComplete ? 'RIVAL INSOLVENT · HOUSE LIQUIDATED' : 'THE HOUSE DECLARES';
    $('champ-title').textContent = 'VICTORY';
    $('champ-sub').textContent = liquidationComplete ? 'YOU BROKE THE SYNDICATE' : 'YOU OWN THE PIT';
    $('champ-stats').innerHTML = statsHtml;
    $('btn-newgame').textContent = liquidationComplete ? 'RETURN TO MAIN MENU' : 'NEXT CIRCUIT ➤';
    const confetti = $('champ-confetti');
    confetti.replaceChildren(...Array.from({ length: 64 }, (_, i) => {
      const piece = document.createElement('i');
      piece.style.setProperty('--x', (i * 37) % 101);
      piece.style.setProperty('--drift', ((i * 29) % 31) - 15);
      piece.style.setProperty('--fall', `${3.8 + (i % 9) * 0.31}s`);
      piece.style.setProperty('--delay', `${-((i * 17) % 50) / 10}s`);
      piece.style.setProperty('--spin', `${i % 2 ? 720 : -720}deg`);
      return piece;
    }));
    audio.victoryFanfare();
  }

  renderExecuted(statsHtml, liquidationComplete = false) {
    $('executed-stats').innerHTML = statsHtml;
    $('btn-executed-new').textContent = liquidationComplete ? 'RETURN TO MAIN MENU' : 'NEXT CONTESTANT — NEW CAREER';
  }
}
