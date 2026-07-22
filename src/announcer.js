// VULTURE — the tournament master. All flavor text lives here.

const pick = (arr) => arr[(Math.random() * arr.length) | 0];

export const LINES = {
  matchStart: [
    "Ladies and gentlemen and assorted degenerates... it's KILLING TIME!",
    "The book is open, the blood is fresh — FIGHT!",
    "Two crews walk in. One crew gets carried out. You know the rules!",
    "The pit is hungry tonight, folks. FEED IT!",
    "Cameras rolling, bets locked. Let's see some VIOLENCE!",
    "Welcome back to the only show where the refunds go to your next of kin!",
    "Tonight's forecast: lead, with a chance of screaming!",
    "The janitor just mopped, so somebody make a MESS!",
    "Doors are locked, exits are decorative — LET'S GO!",
    "If you're squeamish, folks, the concession stand sells blindfolds!",
  ],
  firstBlood: [
    "FIRST BLOOD! The crowd tastes copper and they LOVE it!",
    "And we're on the board! Somebody's mother is crying already!",
    "FIRST KILL of the bout — the pit claims its opening tribute!",
    "There's the opener! The night is officially RUINED for someone!",
    "First one down! The mop budget just went UP!",
    "The seal is BROKEN, folks! It only gets wetter from here!",
  ],
  playerKill: [
    "{victim} is DOWN! Our challenger has teeth, folks!",
    "OH! {victim} just got deleted from the payroll!",
    "{victim} won't be making it to the afterparty!",
    "The challenger drops {victim} like a bad habit!",
    "{victim} — DOWN! Somebody check their pulse. Actually, don't bother.",
    "{victim} has left the building! Feet first!",
    "Scratch {victim} off the fight card, PERMANENTLY!",
    "{victim} just discovered the exit nobody wants to take!",
    "The challenger sends {victim} to the big locker room in the sky!",
    "{victim}'s bookie just tore up the ticket!",
    "And {victim} goes down like the price of their stock!",
    "Someone tell {victim}'s crew to set one less place at dinner!",
  ],
  playerHeadshot: [
    "HEADSHOT! {victim}'s helmet fund was WASTED money!",
    "RIGHT BETWEEN THE EYES! {victim} never saw the bill coming!",
    "SKULL SHOT on {victim}! That's a crowd-pleaser, folks!",
    "One tap! {victim}'s brain just clocked out early!",
    "CRANIAL DELIVERY for {victim}! Sign here... oh, never mind!",
    "{victim} just had a thought — and it EXITED!",
    "DOME SHOT! {victim}'s hat size is now irrelevant!",
    "Right in the thinker! {victim} is DONE deliberating!",
    "The challenger reads {victim} a bedtime story — THE END!",
  ],
  allyKill: [
    "{killer} puts {victim} in the dirt! That's what money buys!",
    "{killer} earns the paycheck — {victim} is DONE!",
    "Hired muscle {killer} takes out {victim}! Professional work!",
    "{killer} with the assist... no wait, that's a FINISH! {victim} is out!",
    "That's why you pay {killer} the big bucks — {victim}, meet floor!",
    "{killer} clocks in and {victim} clocks OUT!",
    "Payroll well spent! {killer} just retired {victim}!",
  ],
  enemyKillsAlly: [
    "{killer} just SCRAPPED {victim}! The challenger's crew is thinning!",
    "{victim} is down! That's coming out of somebody's cut!",
    "OH NO — {killer} just retired {victim} PERMANENTLY!",
    "{victim}'s contract has been TERMINATED by {killer}!",
    "The challenger's payroll just got lighter — {victim} is gone!",
    "{killer} sends condolences to {victim}'s loved ones. And a bill!",
    "There goes {victim}! Good help is SO hard to keep alive!",
  ],
  playerHurt: [
    "The challenger takes a hit! The odds board is twitching!",
    "Blood on the challenger! The sharks smell it!",
    "OOF! That one's going in the highlight reel!",
    "The challenger springs a leak! Plug it, kid!",
    "That's gonna leave a mark! Several, actually!",
  ],
  playerArmHit: [
    "Challenger's shooting arm is CHEWED UP — watch that aim wobble, folks!",
    "That's a wing shot! Try aiming with a busted arm, kid!",
    "Right in the arm! The challenger's crosshair just grew a mind of its own!",
    "ARM SHOT! Someone's about to shoot like they're stirring soup!",
  ],
  playerLegHit: [
    "LEG SHOT! The challenger is LIMPING! No running from the pit!",
    "There goes the footwork! The challenger's dragging a dead leg!",
    "Kneecapped! The challenger's dancing days are OVER!",
    "That leg's just decoration now, folks!",
  ],
  playerLow: [
    "The challenger is one good sneeze away from the morgue!",
    "Somebody call the cleanup crew — the challenger's on FUMES!",
    "The challenger's health bar is more of a health SLIVER, folks!",
    "I've seen corpses with better vitals! Keep those bets coming!",
    "The morgue drawer is OPEN and WAITING, challenger!",
  ],
  lastEnemy: [
    "ONE LEFT! Finish it and get PAID!",
    "Last man standing on the away team! The crowd wants a FINISHER!",
    "Down to ONE! Somebody's about to be very lonely, then very dead!",
    "One straggler left, folks — this is the sad part. I LOVE the sad part!",
  ],
  win: [
    "IT'S OVER! The challenger takes the bout! PAY THE MAN!",
    "CLEAN SWEEP! The pit has a new favorite, ladies and gentlemen!",
    "The bell rings and the challenger STANDS! What a show!",
    "VICTORY! Cue the confetti — it's red, we buy in bulk!",
    "The away team is now a CLEANUP ITEM! Challenger wins!",
    "The odds board weeps, the crowd ROARS — what a bout!",
    "Winner winner — someone else's dinner! The challenger advances!",
  ],
  lose: [
    "Annnnd the challenger is DOWN. Scrape 'em up, boys.",
    "The house wins again, folks. It always does.",
    "That's a wrap on the challenger. Cleanup on aisle EVERYWHERE.",
    "The challenger has decided to become part of the floor. Respect.",
    "Ohh, and the crowd goes... home! Show's over, folks!",
    "Someone fetch the stretcher. And a sponge!",
    "The challenger's comeback tour has been POSTPONED. Indefinitely-ish!",
  ],
  event_lightsout: [
    "Whoops — did somebody forget to pay the power bill? LIGHTS OUT!",
    "Let's make it interesting — KILL THE LIGHTS!",
    "Total darkness, folks! The screaming really carries in the dark!",
    "Lights out! Muzzle flashes only — it's ROMANTIC!",
  ],
  event_gas: [
    "We've got a little GAS LEAK, folks! Purely accidental, I'm sure!",
    "The management apologizes for the toxic fumes. The management is LYING!",
    "Green cloud on the floor! That's not fog-machine juice, people!",
    "Breathe deep, contestants! Just kidding — DON'T!",
  ],
  event_frenzy: [
    "The high rollers just showed up — DOUBLE PAYOUT ON EVERYTHING!",
    "CROWD FRENZY! Blood money is trading at DOUBLE, people!",
    "The whales are betting! Every kill pays DOUBLE, make it messy!",
    "Money's raining, folks! Somebody go EARN it!",
  ],
  event_airdrop: [
    "A generous sponsor sends their regards — CARE PACKAGE INBOUND!",
    "Supply drop! First come, first SERVED, as in dinner!",
    "Presents from above, folks! No returns, no refunds!",
    "Someone up there likes you! Or wants a better show!",
  ],
  event_molotov: [
    "The cheap seats are throwing MOLOTOVS again! Security, do nothing!",
    "FIRE IN THE PIT! Someone's insurance premium just tripled!",
    "It's raining cocktails, folks! The FLAMMABLE kind!",
    "Fire on the floor! Marshmallows available at concessions!",
  ],
  bounty: [
    "The house wants {victim} GONE — TRIPLE money on that head!",
    "BOUNTY on {victim}! Somebody upstairs is settling a score!",
    "{victim} just became the most valuable target in the building!",
  ],
  bloodrules: [
    "BLOOD RULES, people! Everything hits HARDER for the next fifteen!",
    "The commission has waived the safety margins! Enjoy!",
    "Thin skin time, folks! EVERYONE bleeds double!",
  ],
  teamkill: [
    "THE CHALLENGER SHOT HIS OWN MAN! The bookies are LOSING it!",
    "Friendly fire! {victim} would like a word. From the floor!",
    "Oh no. Oh no no no. That was YOUR GUY, genius!",
    "Somebody explain trigger discipline to our challenger! {victim} paid the tuition!",
  ],
  nade: [
    "FRAG OUT! Somebody's about to have a very loud problem!",
    "Live grenade on the floor, folks! Place your bets on the shrapnel!",
    "Oh-ho, the pineapple express has DEPARTED!",
    "Grenade in play! Fun fact: it does not care who you are!",
    "Somebody dropped a party favor! RSVP: everyone nearby!",
    "That ticking sound? That's the sound of POOR DECISIONS incoming!",
  ],
  bored: [
    "The crowd paid for BLOOD, not a stakeout, challenger!",
    "Our challenger appears to have taken ROOT, folks! Management is preparing... motivation!",
    "BO-RING! Somebody light a fire under this one. That can be arranged, actually!",
    "Folks, I've seen furniture with more footwork. MOVE!",
    "Is the challenger NAPPING? Wake-up call is being arranged!",
    "This isn't hide and seek, kid! The crowd found you HOURS ago!",
  ],
  bossIntro: [
    "And now... undefeated in THIRTY-ONE bouts... the man, the monster... GOLIATH!",
    "Hide the children, cancel the ambulance — it's too late for all that. GOLIATH IS HERE!",
    "Thirty-one bouts. Thirty-one caskets. Ladies and gentlemen... GOLIATH!",
  ],
  champWin: [
    "I don't believe it. I DO NOT believe it. GOLIATH IS DOWN! WE HAVE A NEW CHAMPION!",
    "STOP THE PRESSES! GOLIATH HAS FALLEN! Bow to your NEW CHAMPION!",
  ],
};

export class Announcer {
  constructor() {
    this.wrap = document.getElementById('announcer-wrap');
    this.line = document.getElementById('announcer-line');
    this.queue = [];
    this.showing = 0;
    this.cooldowns = {};
    this.lastLineAt = -99;
    this._used = {};   // per-category lines already played this session (no repeats until exhausted)
  }

  _pickFresh(category) {
    const pool = LINES[category] || ['...'];
    const used = this._used[category] = this._used[category] || new Set();
    let fresh = pool.filter(l => !used.has(l));
    if (!fresh.length) { used.clear(); fresh = pool; }
    const text = pick(fresh);
    used.add(text);
    return text;
  }

  say(category, vars = {}, { force = false, minGap = 4 } = {}) {
    const now = performance.now() / 1000;
    if (!force) {
      // he's a commentator, not a firehose: drop color lines while busy or too soon
      if (this.showing > 0 || this.queue.length) return;
      if (now - this.lastLineAt < 6) return;
      if (this.cooldowns[category] && now - this.cooldowns[category] < minGap) return;
      try { if (window.speechSynthesis?.speaking) return; } catch { /* fine */ }
    }
    this.cooldowns[category] = now;
    let text = this._pickFresh(category);
    for (const [k, v] of Object.entries(vars)) text = text.replaceAll(`{${k}}`, v);
    if (force) this.queue.length = 0;
    if (this.queue.length < 2) this.queue.push({ text, force });
  }

  update(dt) {
    if (this.showing > 0) {
      this.showing -= dt;
      if (this.showing <= 0) this.wrap.classList.remove('show');
    } else if (this.queue.length) {
      const { text, force } = this.queue.shift();
      this.line.textContent = `“${text}”`;
      this.wrap.classList.add('show');
      this.showing = 2.2 + text.length * 0.03;
      this.lastLineAt = performance.now() / 1000;
      this._speak(text, force);
    }
  }

  // VULTURE's voice: Web Speech API — zero assets, maximum carnival barker
  _speak(text, force) {
    try {
      if (!window.speechSynthesis) return;
      // never interrupt himself mid-sentence for color commentary
      if (speechSynthesis.speaking) {
        if (!force) return;
        speechSynthesis.cancel();
      }
      if (!this._voice) {
        const vs = speechSynthesis.getVoices();
        this._voice = vs.find(v => /^en/i.test(v.lang) && /male|david|mark|daniel|guy|george/i.test(v.name))
          || vs.find(v => /^en/i.test(v.lang)) || null;
      }
      const u = new SpeechSynthesisUtterance(text.replace(/[“”"]/g, ''));
      u.rate = 1.2;
      u.pitch = 0.55;
      u.volume = 0.9;
      if (this._voice) u.voice = this._voice;
      speechSynthesis.speak(u);
      this._spokeCount = (this._spokeCount || 0) + 1;
    } catch { /* no voice, no problem */ }
  }

  clear() {
    this.queue.length = 0;
    this.showing = 0;
    this.wrap.classList.remove('show');
    try { window.speechSynthesis?.cancel(); } catch { /* fine */ }
  }
}
