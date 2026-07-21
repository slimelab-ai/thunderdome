// VULTURE — the tournament master. All flavor text lives here.

const pick = (arr) => arr[(Math.random() * arr.length) | 0];

export const LINES = {
  matchStart: [
    "Ladies and gentlemen and assorted degenerates... it's KILLING TIME!",
    "The book is open, the blood is fresh — FIGHT!",
    "Two crews walk in. One crew gets carried out. You know the rules!",
    "The pit is hungry tonight, folks. FEED IT!",
    "Cameras rolling, bets locked. Let's see some VIOLENCE!",
  ],
  firstBlood: [
    "FIRST BLOOD! The crowd tastes copper and they LOVE it!",
    "And we're on the board! Somebody's mother is crying already!",
    "FIRST KILL of the bout — the pit claims its opening tribute!",
  ],
  playerKill: [
    "{victim} is DOWN! Our challenger has teeth, folks!",
    "OH! {victim} just got deleted from the payroll!",
    "{victim} won't be making it to the afterparty!",
    "The challenger drops {victim} like a bad habit!",
    "{victim} — DOWN! Somebody check their pulse. Actually, don't bother.",
  ],
  playerHeadshot: [
    "HEADSHOT! {victim}'s helmet fund was WASTED money!",
    "RIGHT BETWEEN THE EYES! {victim} never saw the bill coming!",
    "SKULL SHOT on {victim}! That's a crowd-pleaser, folks!",
    "One tap! {victim}'s brain just clocked out early!",
  ],
  allyKill: [
    "{killer} puts {victim} in the dirt! That's what money buys!",
    "{killer} earns the paycheck — {victim} is DONE!",
    "Hired muscle {killer} takes out {victim}! Professional work!",
  ],
  enemyKillsAlly: [
    "{killer} just SCRAPPED {victim}! The challenger's crew is thinning!",
    "{victim} is down! That's coming out of somebody's cut!",
    "OH NO — {victim} just got retired PERMANENTLY by {killer}!",
  ],
  playerHurt: [
    "The challenger takes a hit! The odds board is twitching!",
    "Blood on the challenger! The sharks smell it!",
  ],
  playerArmHit: [
    "Challenger's shooting arm is CHEWED UP — watch that aim wobble, folks!",
    "That's a wing shot! Try aiming with a busted arm, kid!",
  ],
  playerLegHit: [
    "LEG SHOT! The challenger is LIMPING! No running from the pit!",
    "There goes the footwork! The challenger's dragging a dead leg!",
  ],
  playerLow: [
    "The challenger is one good sneeze away from the morgue!",
    "Somebody call the cleanup crew — the challenger's on FUMES!",
  ],
  lastEnemy: [
    "ONE LEFT! Finish it and get PAID!",
    "Last man standing on the away team! The crowd wants a FINISHER!",
  ],
  win: [
    "IT'S OVER! The challenger takes the bout! PAY THE MAN!",
    "CLEAN SWEEP! The pit has a new favorite, ladies and gentlemen!",
    "The bell rings and the challenger STANDS! What a show!",
  ],
  lose: [
    "Annnnd the challenger is DOWN. Scrape 'em up, boys.",
    "The house wins again, folks. It always does.",
    "That's a wrap on the challenger. Cleanup on aisle EVERYWHERE.",
  ],
  event_lightsout: [
    "Whoops — did somebody forget to pay the power bill? LIGHTS OUT!",
    "Let's make it interesting — KILL THE LIGHTS!",
  ],
  event_gas: [
    "We've got a little GAS LEAK, folks! Purely accidental, I'm sure!",
    "The management apologizes for the toxic fumes. The management is LYING!",
  ],
  event_frenzy: [
    "The high rollers just showed up — DOUBLE PAYOUT ON EVERYTHING!",
    "CROWD FRENZY! Blood money is trading at DOUBLE, people!",
  ],
  event_airdrop: [
    "A generous sponsor sends their regards — CARE PACKAGE INBOUND!",
    "Supply drop! First come, first SERVED, as in dinner!",
  ],
  event_molotov: [
    "The cheap seats are throwing MOLOTOVS again! Security, do nothing!",
    "FIRE IN THE PIT! Someone's insurance premium just tripled!",
  ],
  bored: [
    "The crowd paid for BLOOD, not a stakeout, challenger!",
    "Our challenger appears to have taken ROOT, folks! Management is preparing... motivation!",
    "BO-RING! Somebody light a fire under this one. That can be arranged, actually!",
    "Folks, I've seen furniture with more footwork. MOVE!",
  ],
  bossIntro: [
    "And now... undefeated in THIRTY-ONE bouts... the man, the monster... GOLIATH!",
  ],
  champWin: [
    "I don't believe it. I DO NOT believe it. GOLIATH IS DOWN! WE HAVE A NEW CHAMPION!",
  ],
};

export class Announcer {
  constructor() {
    this.wrap = document.getElementById('announcer-wrap');
    this.line = document.getElementById('announcer-line');
    this.queue = [];
    this.showing = 0;
    this.cooldowns = {};
  }

  say(category, vars = {}, { force = false, minGap = 4 } = {}) {
    const now = performance.now() / 1000;
    if (!force && this.cooldowns[category] && now - this.cooldowns[category] < minGap) return;
    this.cooldowns[category] = now;
    let text = pick(LINES[category] || ['...']);
    for (const [k, v] of Object.entries(vars)) text = text.replaceAll(`{${k}}`, v);
    if (force) this.queue.length = 0;
    if (this.queue.length < 3) this.queue.push(text);
  }

  update(dt) {
    if (this.showing > 0) {
      this.showing -= dt;
      if (this.showing <= 0) this.wrap.classList.remove('show');
    } else if (this.queue.length) {
      const text = this.queue.shift();
      this.line.textContent = `“${text}”`;
      this.wrap.classList.add('show');
      this.showing = 2.2 + text.length * 0.03;
    }
  }

  clear() {
    this.queue.length = 0;
    this.showing = 0;
    this.wrap.classList.remove('show');
  }
}
