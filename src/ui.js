import { WEAPONS, WEAPON_ORDER } from './weapons.js';
import { audio } from './audio.js';

const $ = (id) => document.getElementById(id);

function healthColor(f) {
  // f: 1 = healthy → green; 0 = dead → red
  const r = f > 0.5 ? Math.round(255 * (1 - f) * 2) : 255;
  const g = f > 0.5 ? 218 : Math.round(218 * f * 2);
  return `rgb(${r},${g},60)`;
}

// Modular armor: independent slots, sequential tiers within each.
export const ARMOR_SLOTS = {
  head: {
    label: 'HEAD', tiers: [
      { name: 'Bare Skull', price: 0, mit: 0 },
      { name: 'STEEL POT', price: 450, mit: 0.35, desc: 'Surplus helmet. −35% head damage.' },
      { name: 'OPS-CORE RIG', price: 1200, mit: 0.55, desc: 'High-cut composite. −55% head damage.' },
    ],
  },
  body: {
    label: 'BODY', tiers: [
      { name: 'T-Shirt', price: 0, mit: 0 },
      { name: 'STAB VEST', price: 500, mit: 0.3, desc: 'Cheap kevlar. −30% torso damage.' },
      { name: 'CERAMIC PLATES', price: 1300, mit: 0.55, desc: 'Military surplus. −55% torso damage.' },
    ],
  },
  limbs: {
    label: 'LIMBS', tiers: [
      { name: 'Bare Limbs', price: 0, mit: 0, accum: 0 },
      { name: 'COMBAT PADS', price: 400, mit: 0.25, accum: 0.45, desc: '−25% limb damage, injuries accumulate slower.' },
      { name: 'EXO BRACING', price: 950, mit: 0.4, accum: 0.65, desc: '−40% limb damage, aim/limp penalties heavily dampened.' },
    ],
  },
};

export const CONSUMABLES = {
  medkit: { name: 'MEDKIT', key: 'H', price: 160, max: 3, desc: 'Channel 2.2s, restore 65 HP. Firing cancels.' },
  splint: { name: 'SPLINT KIT', key: 'V', price: 110, max: 3, desc: 'Channel 1.8s, fixes busted arms and legs.' },
  grenade: { name: 'FRAG GRENADE', key: 'G', price: 90, max: 4, desc: 'The crowd-pleaser. 2.8s fuse, hurts everyone.' },
};

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
    this.kitOpen = -1;
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

    // ammo / weapon
    this.el.ammoMag.textContent = player.mag;
    this.el.weaponName.textContent = player.weapon.name;
    this.el.reloadHint.classList.toggle('hidden', player.reloading <= 0);

    // weapon slots
    const slotsKey = player.slots.join(',') + player.slotIdx;
    if (this.el.weaponSlots._last !== slotsKey) {
      this.el.weaponSlots._last = slotsKey;
      this.el.weaponSlots.innerHTML = player.slots.map((id, i) =>
        `<span class="wslot ${i === player.slotIdx ? 'active' : ''}">${i + 1}·${WEAPONS[id].name.split(' ')[0]}</span>`).join('');
    }

    this.el.rank.textContent = career.rank;
    this.el.money.textContent = career.money.toLocaleString();
    this.el.frenzy.classList.toggle('hidden', !match.frenzy);

    // consumables
    const cons = career.consumables;
    const consKey = `${cons.medkit}|${cons.splint}|${cons.grenade}`;
    if (this.el.consRow._last !== consKey) {
      this.el.consRow._last = consKey;
      this.el.consRow.innerHTML =
        `<span class="${cons.medkit ? '' : 'cons-empty'}"><b>H</b> 🩹${cons.medkit}</span>` +
        `<span class="${cons.splint ? '' : 'cons-empty'}"><b>V</b> 🩼${cons.splint}</span>` +
        `<span class="${cons.grenade ? '' : 'cons-empty'}"><b>G</b> 💣${cons.grenade}</span>`;
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

  // ---------- SHOP ----------
  renderShop(career, player, nextSquad, earnings, actions) {
    $('shop-money').textContent = career.money.toLocaleString();
    $('shop-sub').textContent = `Rank ${career.rank} contender · Next bout: Rank ${career.rank}`;

    const eb = $('earnings-box');
    if (earnings) {
      eb.classList.remove('hidden');
      eb.innerHTML = `<span>LAST BOUT:</span> <span>💀 ${earnings.kills} kills → <b>$${earnings.killMoney}</b></span>` +
        (earnings.headshots ? `<span>🎯 ${earnings.headshots} headshots → <b>$${earnings.hsMoney}</b></span>` : '') +
        `<span>🏆 win purse → <b>$${earnings.winBonus}</b></span>` +
        (earnings.frenzyMoney ? `<span>💰 frenzy bonus → <b>$${earnings.frenzyMoney}</b></span>` : '') +
        `<span>TOTAL: <b>$${earnings.total}</b></span>`;
    } else eb.classList.add('hidden');

    // weapons: your own copy (permanent loadout slot) + extra copies for the crew stash
    $('shop-weapons').innerHTML = WEAPON_ORDER.map(id => {
      const w = WEAPONS[id];
      if (id === 'pistol') return '';
      const owned = career.weapons.includes(id);
      const afford = career.money >= w.price;
      const stashN = career.stash.weapons[id] || 0;
      return `<div class="shop-item ${owned ? 'owned' : ''}">
        <div class="si-info"><div class="si-name">${w.name}${stashN ? ` <span class="dim">· stash ×${stashN}</span>` : ''}</div><div class="si-desc">${w.desc}</div></div>
        <div class="roster-btns">
        ${owned ? '<span class="si-owned">YOURS</span>'
          : `<button class="btn" data-buy-weapon="${id}" ${afford ? '' : 'disabled'}>$${w.price}</button>`}
        <button class="btn" data-stash-weapon="${id}" ${afford ? '' : 'disabled'} title="buy a copy for the crew stash">+CREW</button>
        </div>
      </div>`;
    }).join('');

    // armor slots: your own progression + crew copies into the stash
    $('shop-armor').innerHTML = Object.entries(ARMOR_SLOTS).map(([slot, def]) => {
      const cur = career.armor[slot];
      return `<div class="armor-slot-label">${def.label} — <span class="dim">${def.tiers[cur].name}</span></div>` +
        def.tiers.map((t, i) => {
          if (i === 0) return '';
          const worn = cur === i;
          const canBuy = !worn && career.money >= t.price;
          const stashN = career.stash.armor[slot][i] || 0;
          return `<div class="shop-item ${worn ? 'owned' : ''}">
            <div class="si-info"><div class="si-name">${t.name}${stashN ? ` <span class="dim">· stash ×${stashN}</span>` : ''}</div><div class="si-desc">${t.desc}</div></div>
            <div class="roster-btns">
            ${worn ? '<span class="si-owned">WORN</span>'
              : `<button class="btn" data-buy-armor="${slot}:${i}" ${canBuy ? '' : 'disabled'}>$${t.price}</button>`}
            <button class="btn" data-stash-armor="${slot}:${i}" ${career.money >= t.price ? '' : 'disabled'} title="buy a copy for the crew stash">+CREW</button>
            </div>
          </div>`;
        }).join('');
    }).join('');

    // consumables
    $('shop-consumables').innerHTML = Object.entries(CONSUMABLES).map(([id, c]) => {
      const held = career.consumables[id] || 0;
      const canBuy = held < c.max && career.money >= c.price;
      return `<div class="shop-item">
        <div class="si-info"><div class="si-name">${c.name} <span class="dim">[${c.key}] · holding ${held}/${c.max}</span></div><div class="si-desc">${c.desc}</div></div>
        <button class="btn" data-buy-consumable="${id}" ${canBuy ? '' : 'disabled'}>$${c.price}</button>
      </div>`;
    }).join('');

    // crew hire (permanent signings)
    const crewCount = career.crew.length;
    $('shop-crew').innerHTML = Object.entries(CREW_TIERS).map(([id, t]) => {
      const afford = career.money >= t.price && crewCount < 5;
      return `<div class="shop-item">
        <div class="si-info"><div class="si-name">${t.name.toUpperCase()}</div><div class="si-desc">${t.desc}</div></div>
        <button class="btn" data-hire="${id}" ${afford ? '' : 'disabled'}>$${t.price}</button>
      </div>`;
    }).join('') + (crewCount >= 5 ? '<div class="si-desc" style="padding:4px">Roster is full (5 max).</div>' : '');

    // ---- medical ----
    const playerMax = 100 + career.skills.tough * 25;
    const playerHp = career.playerHp == null ? playerMax : Math.min(playerMax, career.playerHp);
    const pCost = actions.playerPatchCost();
    const limbFlags = (l) => (l.arm > 0.05 ? ' <span class="limb-flag">ARM</span>' : '') + (l.leg > 0.05 ? ' <span class="limb-flag">LEG</span>' : '');
    const hpBar = (hp, max) => `<span class="mini-hp"><i style="width:${(hp / max) * 100}%; background:${hp / max > 0.6 ? 'var(--acid)' : hp / max > 0.3 ? 'var(--gold)' : 'var(--blood)'}"></i></span> ${Math.round(hp)}/${max}`;
    $('shop-medical').innerHTML = `<div class="shop-item">
      <div class="si-info"><div class="si-name">YOU ${limbFlags(career.playerLimbs)}</div>
      <div class="si-desc">${hpBar(playerHp, playerMax)}</div></div>
      ${pCost > 0 ? `<button class="btn" data-patch="player" ${career.money > 0 ? '' : 'disabled'}>PATCH $${Math.min(pCost, career.money)}${career.money < pCost ? ' ⚠' : ''}</button>` : '<span class="si-owned">FIGHTING FIT</span>'}
    </div>`;

    // ---- roster: permanent hires with a real kit editor ----
    const stashGuns = Object.entries(career.stash.weapons).filter(([, n]) => n > 0)
      .map(([id, n]) => `${WEAPONS[id].name}×${n}`);
    const stashArmorList = ['head', 'body', 'limbs'].flatMap(s =>
      Object.entries(career.stash.armor[s]).filter(([, n]) => n > 0)
        .map(([t, n]) => `${ARMOR_SLOTS[s].tiers[t].name}×${n}`));
    const stashDesc = [...stashGuns, ...stashArmorList].join(', ');

    const kitEditor = (c, i) => {
      const wOpts = ['pistol', ...Object.keys(career.stash.weapons).filter(id => (career.stash.weapons[id] || 0) > 0)];
      if (c.gear.weapon !== 'pistol' && !wOpts.includes(c.gear.weapon)) wOpts.push(c.gear.weapon);
      const wBtns = wOpts.map(id => {
        const cur = c.gear.weapon === id;
        const n = career.stash.weapons[id] || 0;
        return `<button class="btn kit-btn ${cur ? 'kit-cur' : ''}" data-assign-weapon="${i}:${id}" ${cur ? '' : ''}>${WEAPONS[id].name.split(' ')[0]}${id !== 'pistol' && !cur ? ` ×${n}` : ''}</button>`;
      }).join('');
      const slotBtns = (slot) => ARMOR_SLOTS[slot].tiers.map((t, tier) => {
        const cur = c.gear[slot] === tier;
        const n = career.stash.armor[slot][tier] || 0;
        const usable = cur || tier === 0 || n > 0;
        return `<button class="btn kit-btn ${cur ? 'kit-cur' : ''}" data-assign-armor="${i}:${slot}:${tier}" ${usable ? '' : 'disabled'}>${tier === 0 ? 'NONE' : `T${tier}${!cur && n ? ` ×${n}` : ''}`}</button>`;
      }).join('');
      return `<div class="kit-editor">
        <div class="kit-row"><span>GUN</span>${wBtns}</div>
        <div class="kit-row"><span>HEAD</span>${slotBtns('head')}</div>
        <div class="kit-row"><span>BODY</span>${slotBtns('body')}</div>
        <div class="kit-row"><span>LEGS</span>${slotBtns('limbs')}</div>
        <div class="kit-row"><span>🩹 ${c.gear.medkit || 0}</span>
          <button class="btn kit-btn" data-give="${i}:medkit:-1" ${(c.gear.medkit || 0) > 0 ? '' : 'disabled'}>−</button>
          <button class="btn kit-btn" data-give="${i}:medkit:1" ${career.consumables.medkit > 0 && (c.gear.medkit || 0) < 2 ? '' : 'disabled'}>+</button>
          <span style="margin-left:10px">💣 ${c.gear.grenade || 0}</span>
          <button class="btn kit-btn" data-give="${i}:grenade:-1" ${(c.gear.grenade || 0) > 0 ? '' : 'disabled'}>−</button>
          <button class="btn kit-btn" data-give="${i}:grenade:1" ${career.consumables.grenade > 0 && (c.gear.grenade || 0) < 2 ? '' : 'disabled'}>+</button>
        </div>
      </div>`;
    };

    $('shop-roster').innerHTML = (career.crew.length
      ? career.crew.map((c, i) => {
        const max = CREW_TIERS[c.tier].hp;
        const hp = c.hp == null ? max : Math.min(max, c.hp);
        const cost = actions.crewPatchCost(c);
        const next = c.tier === 'rookie' ? 'veteran' : c.tier === 'veteran' ? 'elite' : null;
        const upCost = next ? CREW_TIERS[next].price - CREW_TIERS[c.tier].price + 200 : 0;
        const g = c.gear || {};
        const kitSummary = `${WEAPONS[g.weapon || 'pistol'].name} · ⛑${g.head || '–'} 🦺${g.body || '–'} 🦵${g.limbs || '–'} · 🩹${g.medkit || 0} 💣${g.grenade || 0}`;
        return `<div class="shop-item roster-card">
          <div class="si-info">
            <div class="si-name">${c.name} <span class="dim">${CREW_TIERS[c.tier].name} · ${c.kills || 0} kills</span>${limbFlags(c.limbs || {})}</div>
            <div class="si-desc">${hpBar(hp, max)}<br>${kitSummary}</div>
          </div>
          <div class="roster-btns roster-btns-col">
            <div>
              <button class="btn" data-kit="${i}">${this.kitOpen === i ? 'KIT ▴' : 'KIT ▾'}</button>
              ${cost > 0 ? `<button class="btn" data-patch="${i}" ${career.money > 0 ? '' : 'disabled'}>🏥 $${Math.min(cost, career.money)}${career.money < cost ? ' ⚠' : ''}</button>` : ''}
            </div>
            <div>
              ${next ? `<button class="btn" data-upgrade="${i}" ${career.money >= upCost ? '' : 'disabled'}>⬆ $${upCost}</button>` : ''}
              <button class="btn btn-ghost" data-sell="${i}">SELL $${Math.round(CREW_TIERS[c.tier].price * 0.5)}</button>
            </div>
          </div>
          ${this.kitOpen === i ? kitEditor(c, i) : ''}
        </div>`;
      }).join('')
      : '<div class="si-desc" style="padding:4px">You fight alone. Brave. Stupid, but brave.</div>')
      + `<div class="si-desc" style="padding:6px 4px">STASH: ${stashDesc || 'empty — +CREW buttons buy gear copies for your squad'}</div>`;

    // training
    $('shop-training').innerHTML = Object.entries(TRAINING).map(([id, t]) => {
      const lvl = career.skills[id];
      const maxed = lvl >= t.max;
      const price = maxed ? 0 : t.prices[lvl];
      const afford = !maxed && career.money >= price;
      return `<div class="shop-item ${maxed ? 'owned' : ''}">
        <div class="si-info"><div class="si-name">${t.name} ${'★'.repeat(lvl)}${'☆'.repeat(t.max - lvl)}</div><div class="si-desc">${t.desc}</div></div>
        ${maxed ? '<span class="si-owned">MAXED</span>'
          : `<button class="btn" data-train="${id}" ${afford ? '' : 'disabled'}>$${price}</button>`}
      </div>`;
    }).join('');

    // next bout
    $('next-bout').innerHTML = `<b>${nextSquad.name}</b><br>${nextSquad.blurb}<br>
      <span class="dim">${nextSquad.roster.length} fighters · threat level ${'🔥'.repeat(Math.min(5, 11 - career.rank))}</span>`;

    // wire buttons
    const wire = (sel, attr, fn) => {
      document.querySelectorAll(sel).forEach(b => b.onclick = () => { audio.uiClick(); fn(b.getAttribute(attr)); });
    };
    wire('[data-buy-weapon]', 'data-buy-weapon', actions.buyWeapon);
    wire('[data-stash-weapon]', 'data-stash-weapon', actions.buyStashWeapon);
    wire('[data-buy-armor]', 'data-buy-armor', (v) => { const [slot, tier] = v.split(':'); actions.buyArmor(slot, parseInt(tier)); });
    wire('[data-stash-armor]', 'data-stash-armor', (v) => { const [slot, tier] = v.split(':'); actions.buyStashArmor(slot, parseInt(tier)); });
    wire('[data-buy-consumable]', 'data-buy-consumable', actions.buyConsumable);
    wire('[data-hire]', 'data-hire', actions.hire);
    wire('[data-train]', 'data-train', actions.train);
    wire('[data-assign-weapon]', 'data-assign-weapon', (v) => { const [i, id] = v.split(':'); actions.assignWeapon(parseInt(i), id); });
    wire('[data-assign-armor]', 'data-assign-armor', (v) => { const [i, slot, tier] = v.split(':'); actions.assignArmor(parseInt(i), slot, parseInt(tier)); });
    wire('[data-give]', 'data-give', (v) => { const [i, kind, dir] = v.split(':'); actions.giveItem(parseInt(i), kind, parseInt(dir)); });
    wire('[data-patch]', 'data-patch', (v) => v === 'player' ? actions.patchPlayer() : actions.patchCrew(parseInt(v)));
    wire('[data-upgrade]', 'data-upgrade', (i) => actions.upgradeCrew(parseInt(i)));
    wire('[data-sell]', 'data-sell', (i) => actions.sellCrew(parseInt(i)));
    wire('[data-kit]', 'data-kit', (i) => {
      this.kitOpen = this.kitOpen === parseInt(i) ? -1 : parseInt(i);
      this.renderShop(career, player, nextSquad, earnings, actions);
    });
  }

  renderIntro(rank, squad) {
    $('intro-rank').textContent = rank;
    $('intro-squad').textContent = squad.name;
    $('intro-flavor').textContent = squad.blurb;
  }

  renderDeath(line, stats) {
    $('death-line').textContent = line;
    $('death-stats').innerHTML = stats;
  }

  renderChampion(statsHtml) {
    $('champ-stats').innerHTML = statsHtml;
  }

  renderExecuted(statsHtml) {
    $('executed-stats').innerHTML = statsHtml;
  }
}
