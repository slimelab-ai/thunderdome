// VULTURE — the tournament master. All flavor text lives here.
//
// Spoken lines are pre-rendered during development and shipped as ordinary Opus
// assets. That gives every browser the same voice and timing, without
// asking the OS speech service to synthesize audio during a match.

import { versioned } from './asset-version.js';

const pick = (arr) => arr[(Math.random() * arr.length) | 0];

export const announcerClipUrl = (category, index) =>
  versioned(`/assets/voice/vulture/${category}/${String(index + 1).padStart(2, '0')}.opus`);

export class AnnouncerVoiceBank {
  constructor({
    AudioCtor = globalThis.Audio,
    AudioContextCtor = globalThis.AudioContext || globalThis.webkitAudioContext,
    fetchImpl = globalThis.fetch?.bind(globalThis),
  } = {}) {
    this.AudioCtor = AudioCtor;
    this.AudioContextCtor = AudioContextCtor;
    this.fetchImpl = fetchImpl;
    this.context = null;
    this.buffers = new Map();
    this.pending = new Map();
    this.current = null;
    this._finishTimer = null;
  }

  _key(category, index) { return `${category}:${index}`; }

  _context() {
    if (!this.AudioContextCtor) return null;
    if (!this.context) this.context = new this.AudioContextCtor();
    return this.context;
  }

  unlock() {
    try { this._context()?.resume?.(); } catch { /* unsupported or already running */ }
  }

  async preload(category, index) {
    const key = this._key(category, index);
    if (this.buffers.has(key)) return true;
    if (this.pending.has(key)) return this.pending.get(key);
    const context = this._context();
    if (!context || !this.fetchImpl) return false;
    const pending = this.fetchImpl(announcerClipUrl(category, index), { cache: 'force-cache' })
      .then(response => {
        if (!response.ok) throw new Error(`voice clip HTTP ${response.status}`);
        return response.arrayBuffer();
      })
      // decodeAudioData is asynchronous and keeps codec initialization off the
      // animation callback. The measured 5.4-second Chrome stall landed when a
      // headshot line was due; this removes synchronous first-use media setup from
      // that path entirely.
      .then(encoded => context.decodeAudioData(encoded.slice(0)))
      .then(buffer => {
        this.buffers.set(key, buffer);
        return true;
      })
      .catch(() => false)
      .finally(() => this.pending.delete(key));
    this.pending.set(key, pending);
    return pending;
  }

  readyIndices(category) {
    const prefix = `${category}:`;
    return [...this.buffers.keys()]
      .filter(key => key.startsWith(prefix))
      .map(key => Number(key.slice(prefix.length)));
  }

  async prepare(catalog, { yieldTurn = () => new Promise(resolve => setTimeout(resolve, 0)) } = {}) {
    // One randomly selected line per category makes every first event cheap without
    // decoding the entire 6.5 MB / 294-line catalog into tens of MB of PCM. Any
    // other selected variation is decoded asynchronously on demand by play().
    for (const [category, lines] of Object.entries(catalog)) {
      await this.preload(category, (Math.random() * lines.length) | 0);
      await yieldTurn();
    }
  }

  _playBuffer(buffer, done) {
    const context = this._context();
    if (!context || this.current) return false;
    const source = context.createBufferSource();
    const gain = context.createGain();
    source.buffer = buffer;
    gain.gain.value = 0.9;
    source.connect(gain);
    gain.connect(context.destination);
    const active = { source, gain };
    this.current = active;
    source.onended = () => {
      if (this.current === active) this.current = null;
      done?.();
    };
    source.start();
    return true;
  }

  play(category, index, done) {
    if (this.current) return false;
    const key = this._key(category, index);
    const ready = this.buffers.get(key);
    if (ready) return this._playBuffer(ready, done);

    // Reserve the channel while the chosen variation is fetched and decoded. The
    // subtitle appears immediately; audio follows as soon as the async decoder is
    // ready, with no synchronous codec startup on the game frame.
    if (this._context() && this.fetchImpl) {
      const pending = { pending: true };
      this.current = pending;
      this.preload(category, index).then(ok => {
        if (this.current !== pending) return;
        this.current = null;
        if (!ok || !this._playBuffer(this.buffers.get(key), done)) done?.();
      });
      return true;
    }

    if (!this.AudioCtor) return false;
    const clip = new this.AudioCtor(announcerClipUrl(category, index));
    clip.preload = 'auto';
    clip.volume = 0.9;
    this.current = clip;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(this._finishTimer);
      this._finishTimer = null;
      if (this.current === clip) this.current = null;
      done?.();
    };
    clip.addEventListener?.('ended', finish, { once: true });
    clip.addEventListener?.('error', finish, { once: true });
    try {
      const started = clip.play();
      started?.catch?.(finish);
      // HTML media has dependable `ended` events in normal operation, but a device
      // sleep or decoder reset must not leave all later announcer lines muted.
      this._finishTimer = setTimeout(finish, 20000);
    } catch {
      finish();
      return false;
    }
    return true;
  }

  stop() {
    const clip = this.current;
    this.current = null;
    clearTimeout(this._finishTimer);
    this._finishTimer = null;
    if (!clip) return;
    if (clip.source) {
      try { clip.source.stop(); } catch { /* already stopped */ }
      try { clip.source.disconnect(); } catch { /* already disconnected */ }
      try { clip.gain.disconnect(); } catch { /* already disconnected */ }
      return;
    }
    if (clip.pending) return;
    try { clip.pause(); } catch { /* already stopped */ }
    try { clip.currentTime = 0; } catch { /* not seekable yet */ }
  }
}

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
    "The locks are thrown and the medics are already disappointed. FIGHT!",
    "Every bad decision in this building led to this moment. Make it count!",
    "The crowd came hungry, the fighters came armed — perfect combination!",
    "No speeches, no mercy, no refunds. Ring the bell!",
    "The cameras are live and the exits are sealed. Give them a show!",
    "Fresh magazines, fresh grudges, same filthy pit. FIGHT!",
    "Settle in, folks. Somebody's evening is about to become paperwork!",
    "The odds are posted and common sense has left the building!",
    "Welcome to the pit, where every argument ends conclusively!",
    "Medical is standing by. Optimistic bunch, aren't they?",
    "One bell, two crews, and absolutely no appeals process!",
    "The house lights are hot and so are the chambers. Let's begin!",
    "Keep your ticket. It may be the last evidence this happened!",
    "All debts come due under these lights. FIGHT!",
    "The crowd is loud, the floor is clean, and neither will last!",
  ],
  firstBlood: [
    "FIRST BLOOD! The crowd tastes copper and they LOVE it!",
    "And we're on the board! Somebody's mother is crying already!",
    "FIRST KILL of the bout — the pit claims its opening tribute!",
    "There's the opener! The night is officially RUINED for someone!",
    "First one down! That got the crowd's attention!",
    "The seal is BROKEN, folks! It only gets wetter from here!",
    "Opening casualty! The pit has officially begun collecting!",
    "First one off the board! Everybody else just learned the stakes!",
    "There is the first drop! The crowd is awake now!",
    "First blood belongs to the house, as it always does!",
    "The first body hits the floor and the betting line starts running!",
    "Bout's barely started and somebody is already finished!",
    "First elimination! That is one locker nobody needs to reopen!",
    "The silence breaks with the first hard fall of the night!",
    "First one down! Now the survivors know exactly what this costs!",
    "And there is our opener — quick, ugly, and completely official!",
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
    "{victim} folds under pressure — and several incoming rounds!",
    "The challenger closes {victim}'s account with extreme prejudice!",
    "{victim} is finished! That résumé just got considerably shorter!",
    "Down goes {victim}! The floor wins another unanimous decision!",
    "The challenger found the switch and turned {victim} OFF!",
    "{victim} is out of the bout and into the incident report!",
    "That is the end of {victim}'s shift, career, and immediate plans!",
    "The challenger punches {victim}'s final time card!",
    "{victim} loses the angle, the fight, and most future appointments!",
    "Another clean removal! {victim} is no longer on the active roster!",
    "{victim} goes quiet and this crowd gets LOUD!",
    "The challenger just made {victim} a historical footnote!",
    "Put a line through {victim}. That contract is complete!",
    "{victim} gets the worst possible answer to a tactical question!",
    "The challenger sends {victim} straight to final accounting!",
    "There goes {victim}! Fast hands, hard landing!",
    "{victim} picked the wrong lane and paid the full price!",
    "The pit takes {victim}; the challenger keeps moving!",
    "A sharp burst, a short career — {victim} is done!",
    "{victim} just ran out of cover and good fortune at the same time!",
    "That exchange belongs to the challenger. {victim} belongs to cleanup!",
    "The challenger cashes another one in — {victim} is down!",
    "{victim} misses the lesson and becomes the example!",
    "No debate on that one! {victim} is comprehensively finished!",
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
    "Perfect placement! {victim} drops before the echo gets back!",
    "A precise little period at the end of {victim}'s sentence!",
    "Head shot on {victim}! Clinical work in a very dirty room!",
    "The challenger finds the smallest target and makes the biggest statement!",
    "{victim} catches one upstairs! No second opinion required!",
    "That round had an address and {victim} answered the door!",
    "Clean hit above the collar! {victim} is instantly off the board!",
    "The sights settle, the trigger breaks, and {victim} disappears!",
    "A surgeon's shot from somebody who definitely is not a surgeon!",
    "{victim}'s headgear has failed its final inspection!",
    "Top shelf! The challenger puts {victim} down with punctuation!",
    "One measured shot and {victim}'s whole plan evaporates!",
  ],
  allyKill: [
    "{killer} puts {victim} in the dirt! That's what money buys!",
    "{killer} earns the paycheck — {victim} is DONE!",
    "Hired muscle {killer} takes out {victim}! Professional work!",
    "{killer} with the assist... no wait, that's a FINISH! {victim} is out!",
    "That's why you pay {killer} the big bucks — {victim}, meet floor!",
    "{killer} clocks in and {victim} clocks OUT!",
    "Payroll well spent! {killer} just retired {victim}!",
    "{killer} handles the problem! {victim} is off the schedule!",
    "That contract is earning interest — {killer} drops {victim}!",
    "{killer} clears the lane and {victim} clears the mortal coil!",
    "Professional timing from {killer}! {victim} never had the angle!",
    "{killer} makes the hire look smart and {victim} look horizontal!",
    "The crew contributes! {killer} has removed {victim}!",
    "{killer} catches {victim} exposed and collects the receipt!",
    "Excellent work from {killer}; catastrophic work from {victim}!",
    "{killer} earns another line on the invoice! {victim} is done!",
    "The hired gun delivers! {victim} is no longer a concern!",
  ],
  enemyKillsAlly: [
    "{killer} just SCRAPPED {victim}! The challenger's crew is thinning!",
    "{victim} is down! That's coming out of somebody's cut!",
    "OH NO — {killer} just retired {victim} PERMANENTLY!",
    "{victim}'s contract has been TERMINATED by {killer}!",
    "The challenger's payroll just got lighter — {victim} is gone!",
    "{killer} sends condolences to {victim}'s loved ones. And a bill!",
    "There goes {victim}! Good help is SO hard to keep alive!",
    "{killer} catches {victim} cold! The challenger loses another gun!",
    "The crew is down one — {victim} just got erased by {killer}!",
    "Bad trade for the challenger! {killer} closes out {victim}!",
    "{victim} is finished! {killer} just opened a hole in the line!",
    "The hired help is getting expensive — {victim} is down!",
    "{killer} removes {victim} and the numbers get uglier!",
    "One less friendly muzzle! {victim} is out of this fight!",
    "{victim} loses the duel! {killer} owns that piece of floor now!",
    "The challenger's formation just lost {victim} the hard way!",
    "{killer} breaks the crew apart! {victim} will not be regrouping!",
  ],
  playerHurt: [
    "The challenger takes a hit! The odds board is twitching!",
    "Blood on the challenger! The sharks smell it!",
    "OOF! That one's going in the highlight reel!",
    "The challenger springs a leak! Plug it, kid!",
    "That's gonna leave a mark! Several, actually!",
    "Solid hit on the challenger! That armor cannot negotiate forever!",
    "The challenger gets tagged and the crowd changes its mind again!",
    "That one landed clean! Check the breathing, check the angle!",
    "Incoming fire finds the challenger! Movement, kid, movement!",
    "The challenger just paid for that peek in blood!",
    "A hard connection! The house can smell a momentum swing!",
    "The return fire is real and it just found its address!",
    "The challenger takes another receipt from the ammunition counter!",
    "That was not cover, kid. That was optimism with edges!",
    "A round gets through! The crowd loves a close account!",
    "The challenger is hit and every open bet just twitched!",
    "That angle bites back! Get small or get carried!",
  ],
  playerArmHit: [
    "Challenger's shooting arm is CHEWED UP — watch that aim wobble, folks!",
    "That's a wing shot! Try aiming with a busted arm, kid!",
    "Right in the arm! The challenger's crosshair just grew a mind of its own!",
    "ARM SHOT! Someone's about to shoot like they're stirring soup!",
    "The challenger's arm takes a round! Fine control just left the building!",
    "A hard hit to the shooting side! That trigger suddenly weighs a ton!",
    "Winged! The challenger will have to earn every follow-up shot now!",
    "That arm is compromised! Watch the muzzle start wandering!",
    "The return fire catches an arm! Grip strength is now a luxury!",
    "Direct hit on the arm! The next reload is going to be educational!",
  ],
  playerLegHit: [
    "LEG SHOT! The challenger is LIMPING! No running from the pit!",
    "There goes the footwork! The challenger's dragging a dead leg!",
    "Kneecapped! The challenger's dancing days are OVER!",
    "That leg's just decoration now, folks!",
    "The challenger takes one low! Speed just became a memory!",
    "Leg hit! Every piece of cover is suddenly much farther away!",
    "A round finds the leg and steals the challenger's exit plan!",
    "That knee will not be filing a favorable report!",
    "Mobility is compromised! The pit just got twice as large!",
    "The challenger is dragging one leg and a rapidly changing betting line!",
  ],
  playerLow: [
    "The challenger is one good sneeze away from the morgue!",
    "Somebody call the cleanup crew — the challenger's on FUMES!",
    "The challenger's health bar is more of a health SLIVER, folks!",
    "I've seen corpses with better vitals! Keep those bets coming!",
    "The morgue drawer is OPEN and WAITING, challenger!",
    "The challenger is held together by adrenaline and bad accounting!",
    "One more clean hit and this becomes a memorial broadcast!",
    "Very little blood left inside the challenger, folks!",
    "The margin is gone! Every corner is now a life decision!",
    "The challenger is operating on fumes, spite, and borrowed time!",
    "That pulse is becoming a limited-time offer!",
  ],
  lastEnemy: [
    "ONE LEFT! Finish it and get PAID!",
    "Last man standing on the away team! The crowd wants a FINISHER!",
    "Down to ONE! Somebody's about to be very lonely, then very dead!",
    "One straggler left, folks — this is the sad part. I LOVE the sad part!",
    "The whole crew is gone except one very nervous volunteer!",
    "Final target! No reinforcements, no excuses, nowhere to hide!",
    "One opponent remains between the challenger and the payout!",
    "Last gun on the other side! Close the account!",
    "The numbers say one. The crowd says FINISH IT!",
    "Everybody else is down. One fighter gets the full attention now!",
  ],
  win: [
    "IT'S OVER! The challenger takes the bout! PAY THE MAN!",
    "CLEAN SWEEP! The pit has a new favorite, ladies and gentlemen!",
    "The bell rings and the challenger STANDS! What a show!",
    "VICTORY! Cue the confetti — it's red, we buy in bulk!",
    "The away team is now a CLEANUP ITEM! Challenger wins!",
    "The odds board weeps, the crowd ROARS — what a bout!",
    "Winner winner — someone else's dinner! The challenger advances!",
    "BELL! The challenger owns the floor and the house owes a payout!",
    "That is the bout! One crew standing, one crew becoming inventory!",
    "The challenger survives the card and climbs another rung!",
    "Close the book on this one! The challenger takes it clean!",
    "The pit asked a question and the challenger answered with gunfire!",
    "Victory confirmed! Count the living, count the money, move along!",
    "The challenger gets the win and the cleanup crew gets overtime!",
    "Another rank falls! The view from the top just got a little clearer!",
  ],
  lose: [
    "Annnnd the challenger is DOWN. Scrape 'em up, boys.",
    "The house wins again, folks. It always does.",
    "That's a wrap on the challenger. Cleanup on aisle EVERYWHERE.",
    "The challenger has decided to become part of the floor. Respect.",
    "Ohh, and the crowd goes... home! Show's over, folks!",
    "Someone fetch the stretcher. And a sponge!",
    "The challenger's comeback tour has been POSTPONED. Indefinitely-ish!",
    "That is all, folks. The pit keeps another promising career!",
    "The challenger is finished and the house keeps the lights on!",
    "No miracle tonight. Just a body, a bill, and a losing ticket!",
    "The last chance is gone! Somebody unlock the cleanup cabinet!",
    "A hard stop for the challenger. The ladder does not forgive!",
    "The bout ends exactly where the house expected: on the floor!",
  ],
  event_lightsout: [
    "Whoops — did somebody forget to pay the power bill? LIGHTS OUT!",
    "Let's make it interesting — KILL THE LIGHTS!",
    "Total darkness, folks! The screaming really carries in the dark!",
    "Lights out! Muzzle flashes only — it's ROMANTIC!",
    "Blackout in the pit! Aim for the noise and apologize later!",
    "The house kills the lamps! Every shadow just picked up a weapon!",
    "Darkness, folks! Suddenly every muzzle flash is a confession!",
    "Visibility is cancelled until further notice! Good luck in there!",
  ],
  event_gas: [
    "We've got a little GAS LEAK, folks! Purely accidental, I'm sure!",
    "The management apologizes for the toxic fumes. The management is LYING!",
    "Green cloud on the floor! That's not fog-machine juice, people!",
    "Breathe deep, contestants! Just kidding — DON'T!",
    "Toxic cloud rolling in! The air has joined the opposing team!",
    "Gas on the floor! Breathing is now a tactical error!",
    "The vents are coughing green and nobody signed a waiver!",
    "Fresh poison from management! Find clean air or become floor dressing!",
  ],
  event_frenzy: [
    "The high rollers just showed up — DOUBLE PAYOUT ON EVERYTHING!",
    "CROWD FRENZY! Blood money is trading at DOUBLE, people!",
    "The whales are betting! Every kill pays DOUBLE, make it messy!",
    "Money's raining, folks! Somebody go EARN it!",
    "The crowd doubles the purse! Every target just got more interesting!",
    "Double money is live! Violence has entered a bull market!",
    "The big spenders want action and the house is paying twice!",
    "Every takedown pays double! This is no time for restraint!",
  ],
  event_airdrop: [
    "A generous sponsor sends their regards — CARE PACKAGE INBOUND!",
    "Supply drop! First come, first SERVED, as in dinner!",
    "Presents from above, folks! No returns, no refunds!",
    "Someone up there likes you! Or wants a better show!",
    "Cargo over the pit! Free equipment, expensive consequences!",
    "The house sends supplies! Fight over them like professionals!",
    "A package is dropping and every eye in the room just moved!",
    "New hardware inbound! Possession is nine tenths of the firefight!",
  ],
  event_molotov: [
    "The cheap seats are throwing MOLOTOVS again! Security, do nothing!",
    "THE FLOOR IS BURNING! Pick a lane and MOVE!",
    "It's raining cocktails, folks! The FLAMMABLE kind!",
    "Fire on the floor! Marshmallows available at concessions!",
    "The pit is burning! Choose your footing with unusual care!",
    "Open flame in the arena! Management calls this audience participation!",
    "The floor catches fire and the evacuation plan remains fictional!",
    "Heat rising in the pit! That route is closed unless you enjoy cooking!",
  ],
  bounty: [
    "The house wants {victim} GONE — TRIPLE money on that head!",
    "BOUNTY on {victim}! Somebody upstairs is settling a score!",
    "{victim} just became the most valuable target in the building!",
    "The price just went up on {victim}! Triple return for a clean removal!",
    "House bounty declared! {victim} is now everybody's favorite investment!",
    "Three times the money for {victim}! Try not to look too popular!",
    "The board lights up around {victim}! That head is worth a fortune!",
  ],
  bloodrules: [
    "BLOOD RULES, people! Everything hits HARDER for the next fifteen!",
    "The commission has waived the safety margins! Enjoy!",
    "Thin skin time, folks! EVERYONE bleeds double!",
    "Damage limits are off! Every mistake now arrives twice as hard!",
    "The gloves are off and the ammunition has teeth! BLOOD RULES!",
    "House safety is suspended! Expect shorter arguments from here!",
    "Blood rules active! Cover matters twice and courage matters half!",
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
  constructor({ voiceBank = new AnnouncerVoiceBank(), onVoiceStart = null } = {}) {
    this.wrap = document.getElementById('announcer-wrap');
    this.line = document.getElementById('announcer-line');
    this.queue = [];
    this.showing = 0;
    this.cooldowns = {};
    this.lastLineAt = -99;
    this._used = {};   // per-category lines already played this session (no repeats until exhausted)
    this._speaking = false;
    this._voiceBank = voiceBank;
    this._onVoiceStart = onVoiceStart;
  }

  prepare({
    categories = [
      'matchStart', 'firstBlood', 'playerKill', 'playerHeadshot', 'enemyKillsAlly',
      'playerHurt', 'nade', 'win', 'lose',
    ],
    ...options
  } = {}) {
    const catalog = Object.fromEntries(categories
      .filter(category => LINES[category])
      .map(category => [category, LINES[category]]));
    return this._voiceBank.prepare?.(catalog, options) || Promise.resolve();
  }

  unlock() {
    this._voiceBank.unlock?.();
  }

  _pickFresh(category) {
    const pool = LINES[category] || ['...'];
    const used = this._used[category] = this._used[category] || new Set();
    let fresh = pool.map((text, index) => ({ text, index })).filter(line => !used.has(line.index));
    if (!fresh.length) {
      used.clear();
      fresh = pool.map((text, index) => ({ text, index }));
    }
    // Prefer the line decoded during the loading screen for the first occurrence of
    // a category. Later occurrences still range across the full authored catalog;
    // uncached choices are decoded asynchronously by the voice bank.
    const ready = new Set(this._voiceBank.readyIndices?.(category) || []);
    const readyFresh = fresh.filter(line => ready.has(line.index));
    const line = pick(used.size === 0 && readyFresh.length ? readyFresh : fresh);
    used.add(line.index);
    return line;
  }

  say(category, vars = {}, { force = false, minGap = 4 } = {}) {
    const now = performance.now() / 1000;
    if (!force) {
      // he's a commentator, not a firehose: drop color lines while busy or too soon
      if (this.showing > 0 || this.queue.length) return;
      if (now - this.lastLineAt < 6) return;
      if (this.cooldowns[category] && now - this.cooldowns[category] < minGap) return;
      if (this._speaking) return;
    }
    this.cooldowns[category] = now;
    const selected = this._pickFresh(category);
    let text = selected.text;
    for (const [k, v] of Object.entries(vars)) text = text.replaceAll(`{${k}}`, v);
    if (force) this.queue.length = 0;
    if (this.queue.length < 2) this.queue.push({ text, category, index: selected.index, force });
  }

  update(dt) {
    if (this.showing > 0) {
      this.showing -= dt;
      if (this.showing <= 0) this.wrap.classList.remove('show');
    } else if (this.queue.length) {
      const { text, category, index, force } = this.queue.shift();
      this.line.textContent = `“${text}”`;
      this.wrap.classList.add('show');
      this.showing = 2.2 + text.length * 0.03;
      this.lastLineAt = performance.now() / 1000;
      // Starting media stays off the frame path. The generation check keeps a line
      // queued just before clear() from speaking into the next screen.
      const gen = this._gen || 0;
      setTimeout(() => {
        if ((this._gen || 0) === gen) this._speak(category, index, force);
      }, 0);
    }
  }

  _speak(category, index, force) {
    if (this._speaking) {
      if (force) this._pendingSpeech = { category, index, gen: this._gen || 0 };
      return;
    }
    this._utter(category, index);
  }

  _utter(category, index) {
    const token = (this._utterToken = (this._utterToken || 0) + 1);
    const done = () => {
      if (this._utterToken !== token) return;
      this._speaking = false;
      const pending = this._pendingSpeech;
      this._pendingSpeech = null;
      if (pending && pending.gen === (this._gen || 0)) {
        setTimeout(() => this._utter(pending.category, pending.index), 0);
      }
    };
    this._speaking = true;
    const started = performance.now();
    const playing = this._voiceBank.play(category, index, done);
    this._lastVoiceStartMs = performance.now() - started;
    this._lastVoiceStartAt = started;
    this._onVoiceStart?.({ category, index, start_ms: this._lastVoiceStartMs, playing });
    if (!playing) done();
    else this._spokeCount = (this._spokeCount || 0) + 1;
  }

  clear() {
    this._gen = (this._gen || 0) + 1;   // invalidates any deferred _speak in flight
    this.queue.length = 0;
    this._pendingSpeech = null;
    this.showing = 0;
    this.wrap.classList.remove('show');
    this._utterToken = (this._utterToken || 0) + 1;
    this._voiceBank.stop();
    this._speaking = false;
  }
}
