import { WEAPONS, WEAPON_ORDER } from './weapons.js';
import { audio } from './audio.js';
import {
  ITEM_TYPES, AMMO_TYPES, countInPack, characterWeight, weightSpeedMult, gridRows,
} from './items.js';
import {
  PLAYER_TYPE, HIRE_TYPES, trainingTrees, trainingCost, combatProfile,
} from './progression.js';
import { CREW_CONTRACT_CAP, DEPLOYED_CREW_CAP } from './roster.js';
import { nextShopCharacter } from './squad-auto.js';

const $ = (id) => document.getElementById(id);

function healthColor(f) {
  // f: 1 = healthy → green; 0 = dead → red
  const r = f > 0.5 ? Math.round(255 * (1 - f) * 2) : 255;
  const g = f > 0.5 ? 218 : Math.round(218 * f * 2);
  return `rgb(${r},${g},60)`;
}

const FIGHTER_MARKS = {
  challenger: '◆', enforcer: '▰', rusher: '»', shield: '⬒', marksman: '⌖', medic: '✚',
};

// icon sheet is 6×4 cells
function iconStyle(icon) {
  const col = icon % 6, row = (icon / 6) | 0;
  return `background-image:url(/assets/icons/items_sheet.png);background-size:600% 400%;` +
    `background-position:${(col / 5) * 100}% ${(row / 3) * 100}%;`;
}

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
      spectator: $('spectator-banner'), spectatorName: $('spectator-name'), spectatorCount: $('spectator-count'),
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
    this.controllerCarry = null;
    document.addEventListener('controllercancel', () => this._cancelControllerCarry());
    let resizeTimer;
    window.addEventListener('resize', () => {
      if (!$('screen-shop').classList.contains('hidden') && this._shopArgs) {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => this.renderShop(...this._shopArgs), 120);
      }
    });
  }

  showScreen(name) {
    for (const [k, s] of Object.entries(this.screens)) s.classList.toggle('hidden', k !== name);
    this.el.hud.classList.toggle('hidden', !(name === null));
    if (name !== null) this.hideSpectator();
    if (name !== 'shop') this._cancelControllerCarry();
    document.dispatchEvent(new CustomEvent('screenchange', { detail: name }));
  }
  showHUDOnly() { this.showScreen(null); }
  showSpectator(name, index, total) {
    this.el.hud.classList.add('spectating');
    this.el.spectator.classList.remove('hidden');
    this.el.spectatorName.textContent = name;
    this.el.spectatorCount.textContent = `${index + 1}/${total}`;
  }
  hideSpectator() {
    this.el.hud.classList.remove('spectating');
    this.el.spectator.classList.add('hidden');
  }

  cycleShopCharacter(direction = 1) {
    if (this.screens.shop.classList.contains('hidden') || this.hireOpen) return false;
    const tabs = [...document.querySelectorAll('#char-tabs [data-char]')].filter(tab => !tab.disabled);
    const selection = tabs.map(tab => tab.getAttribute('data-char'));
    const next = nextShopCharacter(selection, this.selChar, direction);
    const target = tabs.find(tab => String(tab.getAttribute('data-char')) === String(next));
    if (!target) return false;
    target.click();
    return true;
  }

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
    // Fade the crosshair out as the weapon comes up.
    //
    // Every weapon has real sights now, and the point of aiming is to use them; a
    // painted dot sitting on top of the front post is two aiming references arguing.
    // Gone by the time the weapon is 60% up, so the handover happens while the sights
    // are still travelling and there is never a moment with both.
    this.el.crosshair.style.opacity = Math.max(0, 1 - player.ads * 1.7).toFixed(2);

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
    const draftTurn = draftBout
      ? (actions.draftShopState?.() || { mustEndTurn: false, locked: false })
      : { mustEndTurn: false, locked: false };
    const autoPlans = actions.autoPlans?.() || {
      heal: { cost: 0 }, upgrade: { cost: 0 }, ammo: { cost: 0 },
    };
    $('screen-shop').classList.toggle('turn-locked', draftTurn.locked);
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
        (earnings.xpAwards?.length ? `<span>★ XP → <b>${earnings.xpAwards.map(a => `${a.name} +${a.xp}`).join(' · ')}</b></span>` : '') +
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
        const canBuy = !draftTurn.locked && !soldOut && career.money >= cost;
        return `<div class="market-row" data-controller-market-row="${t}" tabindex="-1" role="group" aria-label="${def.name}">
          <span class="mk-icon" style="${iconStyle(def.icon)}"></span>
          <span class="mk-name">${def.name}${ammoChip(t)}<span class="mk-w">${def.weight}kg</span>${marketFlag}</span>
          <button class="btn" data-buy-item="${t}" ${canBuy ? '' : 'disabled'}><span class="pad-key pad-a controller-only" aria-hidden="true">A</span>${soldOut ? 'OUT' : '$' + cost}</button>
          <button class="btn" data-buy-to="${t}" data-controller-skip ${canBuy ? '' : 'disabled'} title="buy straight onto ${selName}"><span class="pad-key pad-x controller-only" aria-hidden="true">X</span>→${selName === 'YOU' ? 'YOU' : selName.slice(0, 5).toUpperCase()}</button>
        </div>`;
      }).join('')).join('');

    // ---- next bout ----
    if (liquidation) {
      const rival = career.liquidation.enemy;
      const rivalTeam = (rival.recruits || ['enforcer']).map(type => HIRE_TYPES[type]?.name || type.toUpperCase());
      $('next-bout').innerHTML =
        `<b>THE RIVAL SYNDICATE</b><br>${draftBout ? `DRAFT ROUND ${career.liquidation.draft.fundedRounds}/10` : 'THE STRANGLE — no more envelopes'} · Strategy: ${rival.strategy.toUpperCase()}<br>` +
        `<span class="dim">TEAM ${rivalTeam.length}/5 · ${rivalTeam.join(' / ')}<br>Their inventory is private. Their team, trades, and bankroll are not.</span>`;
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
        const item = entry.label || ITEM_TYPES[entry.type]?.name || entry.type;
        const playerSide = entry.side === 'player';
        const credit = entry.action === 'sell' || entry.action === 'release';
        const verb = { buy: 'BOUGHT', sell: 'SOLD', hire: 'HIRED', release: 'RELEASED' }[entry.action] || entry.action.toUpperCase();
        return `<div class="tape-row ${playerSide ? 'tape-player' : 'tape-rival'}">` +
          `<span class="tape-side">${playerSide ? 'YOU' : 'RIVAL'}</span>` +
          `<span class="tape-action">${verb} ${item}</span>` +
          `<b class="${credit ? 'tape-credit' : 'tape-debit'}">${credit ? '+' : '−'}$${entry.amount.toLocaleString()}</b></div>`;
      }).join('');
      tape.scrollTop = tape.scrollHeight;
    }

    const turnStatus = $('shop-turn-status');
    const endTurn = $('btn-end-turn');
    turnStatus.classList.toggle('hidden', !draftBout);
    turnStatus.className = !draftBout ? 'hidden' :
      `shop-turn-status ${draftTurn.locked ? 'turn-committed' : draftTurn.mustEndTurn ? 'turn-open' : 'turn-second'}`;
    turnStatus.textContent = draftTurn.locked
      ? 'TURN COMMITTED · RIVAL TRANSACTIONS COMPLETE'
      : draftTurn.mustEndTurn
        ? 'YOUR DRAFT TURN · COMMIT WHEN YOUR TRANSACTIONS ARE COMPLETE'
        : draftBout ? 'RIVAL MOVED FIRST · YOUR TURN' : '';
    endTurn.classList.toggle('hidden', !draftTurn.mustEndTurn);
    endTurn.disabled = !draftTurn.mustEndTurn;
    endTurn.onclick = draftTurn.mustEndTurn
      ? () => { audio.uiClick(); actions.endDraftTurn(); }
      : null;
    $('btn-next-fight').disabled = draftTurn.mustEndTurn;
    $('sell-bin').textContent = liquidation ? '💰 SELL — return to the shared pool at 100% market rate' : '💰 SELL — drop anything here to liquidate (55%)';
    const autoButton = (action, label, description, plan, unit = '$') => `
      <button class="btn squad-auto-btn" data-auto-squad="${action}" ${draftTurn.locked || plan.cost <= 0 ? 'disabled' : ''}>
        <span><b>${label}</b><small>${description}</small></span>
        <strong>${unit === '$' ? '$' : ''}${plan.cost.toLocaleString()}${unit === '$' ? '' : ` ${unit}`}</strong>
      </button>`;
    $('squad-auto-actions').innerHTML =
      autoButton('autoHeal', 'AUTO-HEAL', 'YOU → CREW · FULL PATCH', autoPlans.heal) +
      autoButton('autoUpgrade', 'AUTO-UPGRADE', 'SPEND EACH FIGHTER’S XP', autoPlans.upgrade, 'XP') +
      autoButton('autoAmmo', 'AUTO-AMMO', 'YOU → CREW · 2 STACKS / WEAPON', autoPlans.ammo);

    // ---- stash grid ----
    const compactLandscape = window.innerWidth <= 1050 && window.innerWidth > window.innerHeight;
    const CELL = compactLandscape
      ? Math.max(22, Math.min(32, Math.floor(((window.innerWidth - 48) * 0.29) / 10)))
      : window.innerWidth <= 820
        ? Math.max(28, Math.min(38, Math.floor((window.innerWidth - 32) / 10)))
      : window.innerWidth < 1450 ? 38 : 42;
    const stashRows = gridRows(career.stash);
    const gridHtml = (grid, dropName, who) => {
      const rows = grid.rows > 0 ? grid.rows : stashRows;
      let html = `<div class="inv-grid" data-drop="${dropName}" data-controller-target="${dropName}" tabindex="-1" ${who !== undefined ? `data-who="${who}"` : ''}
        style="--cell:${CELL}px;width:${grid.cols * CELL}px;height:${rows * CELL}px;">`;
      for (const e of grid.items) {
        const def = ITEM_TYPES[e.it.type];
        html += `<div class="inv-item" data-item="${e.it.uid}" data-controller-item data-inventory="${dropName}" tabindex="0" role="button" aria-label="Move ${def.name}" title="${def.name} · ${def.weight}kg — drag to move, drop on SELL to liquidate"
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
    const deployedCrew = career.crew.map((member, index) => ({ member, index })).filter(entry => !entry.member.benched);
    const reserveCrew = career.crew.map((member, index) => ({ member, index })).filter(entry => entry.member.benched);
    const deployed = deployedCrew.length;

    const fighterView = (who) => {
      const isPlayerView = who === 'player';
      const member = isPlayerView ? null : career.crew[who];
      const type = isPlayerView ? PLAYER_TYPE : member.type;
      const typeDef = isPlayerView ? { name: 'CHALLENGER', desc: 'The contender calling the shots.' } : HIRE_TYPES[type];
      const progress = isPlayerView ? career.playerProgress : member.progress;
      const profile = combatProfile(type, progress, isPlayerView);
      const hp = isPlayerView
        ? (career.playerHp == null ? profile.maxHp : career.playerHp)
        : (member.hp == null ? profile.maxHp : member.hp);
      const limbs = isPlayerView ? career.playerLimbs : (member.limbs || { arm: 0, leg: 0 });
      const character = isPlayerView ? career.playerCh : member.ch;
      const gear = ['gun1', 'gun2', 'head', 'body'].map(slot => character.gear[slot]).filter(Boolean);
      return {
        who, member, type, typeDef, progress, profile, hp, limbs, character, gear,
        name: isPlayerView ? 'YOU' : member.name,
        kills: isPlayerView ? career.totals.kills : (member.kills || 0),
        mark: FIGHTER_MARKS[type] || FIGHTER_MARKS.enforcer,
      };
    };

    const fighterPopover = (view, status) => {
      const hpFraction = Math.max(0, view.hp / view.profile.maxHp);
      const tierCount = Object.values(view.progress.skills || {}).reduce((sum, level) => sum + level, 0);
      const injury = view.limbs.arm > 0.05 || view.limbs.leg > 0.05;
      const gear = view.gear.length
        ? view.gear.map(item => {
          const def = ITEM_TYPES[item.type];
          return `<span class="fighter-tip-gear"><i style="${iconStyle(def.icon)}"></i>${def.name}</span>`;
        }).join('')
        : '<span class="fighter-tip-empty">SIDEARM ONLY</span>';
      return `<div id="fighter-tip-${view.who}" class="fighter-popover" role="tooltip">
        <div class="fighter-tip-banner">
          <span class="fighter-tip-mark">${view.mark}</span>
          <div><b>${view.name}</b><small>${view.typeDef.name} · ${status}</small></div>
          <strong>${Math.round(view.hp)}/${view.profile.maxHp}</strong>
        </div>
        <div class="fighter-tip-hp"><i style="width:${hpFraction * 100}%;background:${healthColor(hpFraction)}"></i></div>
        <p>${view.typeDef.desc}</p>
        <div class="fighter-tip-stats">
          <span><b>${view.kills}</b>KILLS</span><span><b>${view.progress.xp}</b>XP</span>
          <span><b>${tierCount}</b>TRAINING</span><span><b>${Math.round(view.profile.speedMult * 100)}%</b>SPEED</span>
        </div>
        ${injury ? `<div class="fighter-tip-warning">⚠ ${view.limbs.arm > 0.05 ? 'ARM ' : ''}${view.limbs.leg > 0.05 ? 'LEG ' : ''}TRAUMA</div>` : ''}
        <div class="fighter-tip-loadout">${gear}</div>
      </div>`;
    };

    const rosterSlot = (view, status, reserve = false) => {
      const hpFraction = Math.max(0, view.hp / view.profile.maxHp);
      const selected = String(this.selChar) === String(view.who);
      return `<div class="roster-slot-wrap ${reserve ? 'reserve-slot-wrap' : ''} ${selected ? 'roster-slot-selected' : ''}">
        <button class="roster-slot ${reserve ? 'reserve-slot' : ''} ${selected ? 'char-tab-sel' : ''}" data-char="${view.who}"
          aria-label="${view.name}, ${view.typeDef.name}, ${status}" aria-describedby="fighter-tip-${view.who}">
          <span class="roster-slot-mark">${view.mark}</span>
          <span class="roster-slot-copy"><b>${view.name}</b><small>${view.typeDef.name}</small></span>
          <span class="roster-slot-hp"><i style="width:${Math.max(2, hpFraction * 100)}%;background:${healthColor(hpFraction)}"></i></span>
        </button>
        ${fighterPopover(view, status)}
      </div>`;
    };

    const playerView = fighterView('player');
    const deployedSlots = Array.from({ length: DEPLOYED_CREW_CAP }, (_, slot) => {
      const entry = deployedCrew[slot];
      if (entry) return rosterSlot(fighterView(entry.index), `DEPLOYED ${slot + 1}`);
      const canHire = career.crew.length < CREW_CONTRACT_CAP;
      return `<div class="roster-slot-wrap">
        <button class="roster-slot roster-slot-empty" data-hire-menu="${slot}" ${canHire ? '' : 'disabled'}>
          <span class="roster-slot-mark">+</span>
          <span class="roster-slot-copy"><b>${canHire ? 'HIRE' : 'EMPTY'}</b><small>SLOT ${slot + 1}</small></span>
        </button>
      </div>`;
    }).join('');
    const reserveSlots = reserveCrew.length
      ? reserveCrew.map(({ index }) => rosterSlot(fighterView(index), 'RESERVE', true)).join('')
      : '<div class="reserve-empty">NO BENCHED FIGHTERS</div>';

    $('char-tabs').innerHTML = `
      <div class="roster-section-head"><span>ACTIVE SQUAD</span><b>${deployed + 1}/${DEPLOYED_CREW_CAP + 1}</b></div>
      <div class="squad-selector">
        <span class="roster-cycle-hint controller-only" aria-hidden="true"><span class="pad-key">LB</span><small>PREV</small></span>
        <div class="deployed-roster">${rosterSlot(playerView, 'CHALLENGER')}${deployedSlots}</div>
        <span class="roster-cycle-hint controller-only" aria-hidden="true"><span class="pad-key">RB</span><small>NEXT</small></span>
      </div>
      <div class="roster-section-head reserve-head"><span>RESERVE LOCKER</span><b>${reserveCrew.length} BENCHED · ${career.crew.length}/${CREW_CONTRACT_CAP} CONTRACTS</b></div>
      <div class="reserve-roster">${reserveSlots}</div>`;

    const who = this.selChar;
    const isPlayer = who === 'player';
    const m = isPlayer ? null : career.crew[who];
    const ch = isPlayer ? career.playerCh : m.ch;
    const type = isPlayer ? PLAYER_TYPE : m.type;
    const progress = isPlayer ? career.playerProgress : m.progress;
    const typeDef = isPlayer ? { name: 'CHALLENGER' } : HIRE_TYPES[type];
    const maxHp = combatProfile(type, progress, isPlayer).maxHp;
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
      return `<div class="doll-slot ${slot.startsWith('gun') ? 'doll-slot-gun' : ''}" data-slot="${slot}" data-who="${who}" data-controller-target="slot" tabindex="-1" title="${label}${def ? ' — ' + def.name : ''}">
        ${it ? `<div class="inv-item doll-it" data-item="${it.uid}" data-controller-item tabindex="0" role="button" aria-label="Move ${def.name}" style="width:100%;height:100%;">
          <span class="inv-ico" style="${iconStyle(def.icon)}"></span>${chip}</div>` : `<span class="doll-lbl">${label}</span>`}
      </div>`;
    };

    const limbFlag = (l) => (l.arm > 0.05 ? ' <span class="limb-flag">ARM</span>' : '') + (l.leg > 0.05 ? ' <span class="limb-flag">LEG</span>' : '');
    const trees = trainingTrees(type);
    const releaseValue = !isPlayer ? actions.releaseValue(m.type) : 0;
    const trainingRows = (label, nodes) => `<div class="training-tree"><div class="training-tree-title">${label}</div>` +
      nodes.map(node => {
        const level = progress.skills[node.id] || 0;
        const cost = trainingCost(progress, type, node.id);
        const maxed = level >= 3;
        const effect = node.desc[Math.min(level, 2)];
        return `<div class="training-node ${maxed ? 'owned' : ''}">
          <div class="si-info"><div class="si-name">${node.name} ${'★'.repeat(level)}${'☆'.repeat(3 - level)}</div><div class="si-desc">${effect}</div></div>
          ${maxed ? '<span class="si-owned">MAXED</span>' :
            `<button class="btn" data-train="${node.id}" ${progress.xp >= cost ? '' : 'disabled'}>${cost} XP</button>`}
        </div>`;
      }).join('') + '</div>';

    $('char-panel').innerHTML = `
      <div class="char-head">
        <div>
          <b>${isPlayer ? 'YOU' : m.name}</b>
          <span class="dim">${typeDef.name} · ${isPlayer ? career.totals.kills : (m.kills || 0)} kills · ${progress.xp} XP</span>
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
        ${patchCost > 0 ? `<button class="btn" data-patch="${who}" ${career.money > 0 ? '' : 'disabled'}><span class="pad-key pad-up controller-only" aria-hidden="true">↑</span> 🏥 PATCH $${Math.min(patchCost, career.money)}${career.money < patchCost ? ' ⚠' : ''}</button>` : '<span class="si-owned">FIGHTING FIT</span>'}
        ${!isPlayer ? `<button class="btn" data-bench="${who}">${m.benched ? '▶ DEPLOY' : '🪑 BENCH'}</button>` : ''}
        ${!isPlayer ? `<button class="btn btn-ghost" data-sell-crew="${who}">RELEASE +$${releaseValue}</button>` : ''}
      </div>
      <div class="training-head"><b>CHARACTER TRAINING</b><span>${progress.xp} XP AVAILABLE</span></div>
      ${trainingRows('COMMON TREE', trees.common)}
      ${trainingRows(`${typeDef.name} TREE`, trees.role)}`;

    if (draftTurn.locked) this.hireOpen = false;
    const hireOverlay = $('hire-overlay');
    hireOverlay.classList.toggle('hidden', !this.hireOpen);
    $('hire-options').innerHTML = !this.hireOpen ? '' : Object.entries(HIRE_TYPES).map(([id, t]) => {
        const cost = actions.recruitPrice(id);
        const soldOut = !Number.isFinite(cost);
        const mi = actions.recruitMarketInfo(id);
        const marketFlag = mi ? `<span class="market-pressure ${mi.scarce ? 'market-scarce' : mi.surplus ? 'market-surplus' : ''}">${soldOut ? 'DRAINED' : mi.scarce ? 'SHORTAGE' : mi.surplus ? 'SURPLUS' : 'LIQUID'} · ${mi.units.toFixed(1)} left</span>` : '';
        const accuracy = Math.max(15, Math.min(100, 135 / t.spreadMult));
        const speed = Math.max(15, Math.min(100, t.speedMult * 82));
        return `<article class="hire-card">
          <div class="hire-card-mark">${FIGHTER_MARKS[id]}</div>
          <div class="hire-card-title"><b>${t.name}</b><span>${marketFlag}</span></div>
          <p>${t.desc}</p>
          <div class="hire-stat"><span>TOUGHNESS</span><i><b style="width:${Math.min(100, t.hp / 1.2)}%"></b></i><em>${t.hp}</em></div>
          <div class="hire-stat"><span>ACCURACY</span><i><b style="width:${accuracy}%"></b></i><em>${Math.round(accuracy)}</em></div>
          <div class="hire-stat"><span>MOBILITY</span><i><b style="width:${speed}%"></b></i><em>${Math.round(t.speedMult * 100)}%</em></div>
          <button class="btn hire-sign" data-hire="${id}" ${!soldOut && career.money >= cost && career.crew.length < CREW_CONTRACT_CAP ? '' : 'disabled'}>
            <span class="pad-key pad-a controller-only" aria-hidden="true">A</span>${soldOut ? 'SOLD OUT' : `SIGN · $${cost}`}
          </button>
        </article>`;
      }).join('');

    // ---- wire buttons ----
    const wire = (sel, attr, fn) => {
      document.querySelectorAll(sel).forEach(b => b.onclick = () => { audio.uiClick(); fn(b.getAttribute(attr)); });
    };
    wire('[data-buy-item]', 'data-buy-item', actions.buyItem);
    wire('[data-buy-to]', 'data-buy-to', (t) => actions.buyItemTo(t, this.selChar));
    wire('[data-auto-squad]', 'data-auto-squad', (action) => actions[action]?.());
    wire('[data-bench]', 'data-bench', (i) => actions.toggleBench(parseInt(i)));
    wire('[data-train]', 'data-train', (id) => actions.train(this.selChar, id));
    wire('[data-patch]', 'data-patch', (v) => v === 'player' ? actions.patchPlayer() : actions.patchCrew(parseInt(v)));
    wire('[data-sell-crew]', 'data-sell-crew', (i) => { actions.sellCrew(parseInt(i)); this.selChar = 'player'; });
    wire('[data-hire]', 'data-hire', (id) => { this.hireOpen = false; actions.hire(id); });
    wire('[data-char]', 'data-char', (whoSel) => {
      this.selChar = whoSel === 'player' ? 'player' : parseInt(whoSel);
      this.hireOpen = false;
      this.renderShop(...this._shopArgs);
      requestAnimationFrame(() => {
        document.querySelector(`[data-char="${whoSel}"]`)?.focus({ preventScroll: true });
      });
    });
    wire('[data-hire-menu]', 'data-hire-menu', () => {
      this.hireOpen = true;
      this.renderShop(...this._shopArgs);
    });
    $('btn-hire-close').onclick = () => {
      audio.uiClick();
      this.hireOpen = false;
      this.renderShop(...this._shopArgs);
    };
    hireOverlay.onclick = (event) => {
      if (event.target !== hireOverlay) return;
      audio.uiClick();
      this.hireOpen = false;
      this.renderShop(...this._shopArgs);
    };

    $('sell-bin').setAttribute('data-controller-target', 'sell');
    $('sell-bin').setAttribute('tabindex', '-1');
    if (draftTurn.locked) {
      this._cancelControllerCarry();
      document.querySelectorAll('#screen-shop .shop-cols button').forEach(button => {
        button.disabled = true;
      });
    } else {
      this._bindControllerTransfers(actions);
      this._bindDrag(actions, CELL);
    }
  }

  _bindControllerTransfers(actions) {
    document.querySelectorAll('[data-controller-item]').forEach(el => {
      el.onclick = (event) => {
        event.stopPropagation();
        if (event.detail !== 0 || !document.body.classList.contains('controller-mode')) return;
        this.controllerCarry = el.getAttribute('data-item');
        document.body.classList.add('controller-carrying');
        document.querySelectorAll('[data-controller-item]').forEach(item => {
          item.classList.toggle('controller-held-item', item.getAttribute('data-item') === this.controllerCarry);
        });
        document.dispatchEvent(new CustomEvent('controllercarrychange'));
      };
      el.addEventListener('controllerequip', () => {
        if (el.getAttribute('data-inventory') !== 'stash') return;
        actions.equipStashItem(el.getAttribute('data-item'), this.selChar);
      });
      el.addEventListener('controllersell', () => {
        actions.moveItem(el.getAttribute('data-item'), { kind: 'sell' });
      });
    });
    document.querySelectorAll('[data-controller-target]').forEach(el => {
      el.onclick = (event) => {
        if (event.detail !== 0 || !this.controllerCarry || !document.body.classList.contains('controller-mode')) return;
        const uid = this.controllerCarry;
        const target = el.getAttribute('data-controller-target');
        let destination;
        if (target === 'sell') destination = { kind: 'sell' };
        else if (target === 'slot') {
          destination = { kind: 'slot', who: this._whoAttr(el), slot: el.getAttribute('data-slot') };
        } else if (target === 'stash') destination = { kind: 'stash' };
        else destination = { kind: 'pack', who: this._whoAttr(el) };
        this._cancelControllerCarry();
        actions.moveItem(uid, destination);
      };
    });
  }

  _cancelControllerCarry() {
    this.controllerCarry = null;
    document.body.classList.remove('controller-carrying');
    document.querySelectorAll('.controller-held-item').forEach(el => el.classList.remove('controller-held-item'));
    document.dispatchEvent(new CustomEvent('controllercarrychange'));
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
    const maxHp = combatProfile(PLAYER_TYPE, career.playerProgress, true).maxHp;
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
      ? `<span class="dim">SELF-BET · pays ${odds.toFixed(2)}× · selected $${career.bet.toLocaleString()} → $${Math.round(career.bet * odds).toLocaleString()} return<br>YOUR $${career.money.toLocaleString()} vs RIVAL $${career.liquidation.enemyMoney.toLocaleString()} · LOSS STREAK ${career.liquidation.playerLossStreak || 0}–${career.liquidation.enemyLossStreak || 0}<br>CREDIT STAKES OR REPEATED DEFEATS CAN END THE WAR DURING THE DRAFT</span> ` +
        bets.map(b => `<button class="btn bet-btn ${career.bet === b ? 'kit-cur' : ''}" data-bet="${b}">$${b.toLocaleString()}${b > career.money ? ' ⚠' : ''}</button>`).join('')
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
