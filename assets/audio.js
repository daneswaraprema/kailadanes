/* ==========================================================================
   Danes Arcade — audio engine
   --------------------------------------------------------------------------
   Every sound in the arcade is synthesised in the browser with WebAudio.
   There are no .mp3 or .ogg files to fetch, which keeps the games instant to
   load, keeps binaries out of the repo, and means a sound can be retuned by
   editing a number instead of re-exporting an asset.

   This is a classic script rather than an ES module because each game's
   game.js is a classic script too. It publishes one global:

     ArcadeAudio.sfx("explode")     one-shot effect
     ArcadeAudio.music("chase")     start or swap the background track
     ArcadeAudio.music(null)        stop the music
     ArcadeAudio.thruster(0.7)      continuous engine noise, 0 = off

   Browsers refuse to start audio before the player interacts with the page,
   so nothing is built until the first gesture. Calls made before then are
   remembered and take effect the moment the page unlocks, which is why a
   game can simply ask for its music in its start-up code.
   ========================================================================== */
(function () {
  "use strict";

  /* ------------------------------------------------------------------ *
   *  Preferences
   *  Sound and music are separate switches: plenty of players want the
   *  effects but not the soundtrack. Stored as one object so adding a
   *  setting later does not orphan an old key.
   * ------------------------------------------------------------------ */
  const PREF_KEY = "da_audio";

  const defaults = { sfx: true, music: true, sfxVol: 0.8, musicVol: 0.5 };
  let prefs = Object.assign({}, defaults);

  try {
    const raw = localStorage.getItem(PREF_KEY);
    if (raw) {
      prefs = Object.assign(prefs, JSON.parse(raw));
    } else if (localStorage.getItem("dr_sound") === "off") {
      // Danes Rocket shipped with its own boolean before this module existed;
      // honour it once so upgrading players keep the setting they chose.
      prefs.sfx = false;
    }
  } catch (e) { /* storage unavailable — run with defaults */ }

  function savePrefs() {
    try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch (e) { /* ignore */ }
  }

  const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));

  /* ------------------------------------------------------------------ *
   *  Graph
   *
   *    voice --+------------------------------> bus --> master --> out
   *            +--> send --> reverb --> bus       (compressor on master)
   *            +--> send --> delay  --> bus
   *
   *  Each bus owns its own reverb so that muting effects also silences
   *  their tails — a single shared reverb would keep ringing after a mute.
   *  The two convolvers share one impulse response buffer, so the duplicate
   *  costs a node, not memory for the audio.
   * ------------------------------------------------------------------ */
  let ctx = null;
  let master, sfxBus, musicBus;
  let sfxVerb, musicVerb, musicEcho;

  /** Noise with an exponential decay: flat (decay 0) for hiss and hits,
   *  decaying for a reverb impulse response. */
  function noiseBuffer(seconds, decay) {
    const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const fade = decay ? Math.pow(1 - i / len, decay) : 1;
        data[i] = (Math.random() * 2 - 1) * fade;
      }
    }
    return buf;
  }

  let hiss = null; // looped white noise, shared by every noise-based voice

  function build() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    ctx = new AC();

    // A gentle limiter. Several explosions at once would otherwise clip, and
    // clipping on a laptop speaker sounds like a bug rather than a big bang.
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -10;
    comp.knee.value = 24;
    comp.ratio.value = 4;
    comp.attack.value = 0.004;
    comp.release.value = 0.22;
    comp.connect(ctx.destination);

    master = ctx.createGain();
    master.gain.value = 0.85;
    master.connect(comp);

    sfxBus = ctx.createGain();
    sfxBus.gain.value = prefs.sfx ? prefs.sfxVol : 0;
    sfxBus.connect(master);

    musicBus = ctx.createGain();
    musicBus.gain.value = prefs.music ? prefs.musicVol : 0;
    musicBus.connect(master);

    const ir = noiseBuffer(2.4, 2.8);

    sfxVerb = ctx.createConvolver();
    sfxVerb.buffer = ir;
    const sfxVerbOut = ctx.createGain();
    sfxVerbOut.gain.value = 0.8;
    sfxVerb.connect(sfxVerbOut).connect(sfxBus);

    musicVerb = ctx.createConvolver();
    musicVerb.buffer = ir;
    const musicVerbOut = ctx.createGain();
    musicVerbOut.gain.value = 0.9;
    musicVerb.connect(musicVerbOut).connect(musicBus);

    // A filtered feedback echo. Space music lives on this.
    musicEcho = ctx.createDelay(1.2);
    musicEcho.delayTime.value = 0.3;
    const echoFb = ctx.createGain();
    echoFb.gain.value = 0.36;
    const echoTone = ctx.createBiquadFilter();
    echoTone.type = "lowpass";
    echoTone.frequency.value = 2200;
    musicEcho.connect(echoTone).connect(echoFb).connect(musicEcho);
    echoTone.connect(musicBus);

    hiss = noiseBuffer(2, 0);
    return true;
  }

  /** The context, creating it on first use. Returns null where WebAudio is
   *  missing, and every public call tolerates that by doing nothing. */
  function ensure() {
    if (!ctx && build() === false) return null;
    if (ctx && ctx.state === "suspended") ctx.resume();
    return ctx;
  }

  /* ------------------------------------------------------------------ *
   *  Unlocking
   *  The first pointer or key event is the only chance to start audio, so
   *  it is also where music requested during page load gets going.
   * ------------------------------------------------------------------ */
  let unlocked = false;

  function unlock() {
    if (unlocked) return;
    unlocked = true;
    if (!ensure()) return;
    if (wantedTrack) startMusic(wantedTrack);
  }

  ["pointerdown", "keydown", "touchstart"].forEach((evt) =>
    window.addEventListener(evt, unlock, { passive: true })
  );

  // Leaving the tab silences everything; coming back restores whatever the
  // game had playing. Without this the soundtrack follows you to other tabs.
  document.addEventListener("visibilitychange", () => {
    if (!ctx) return;
    if (document.hidden) ctx.suspend();
    else if (unlocked) ctx.resume();
  });

  /* ------------------------------------------------------------------ *
   *  Voices
   * ------------------------------------------------------------------ */

  /** A gain envelope. exponentialRamp cannot reach zero, hence the floor. */
  function env(param, t0, attack, dur, peak) {
    const a = Math.min(attack, dur * 0.6);
    param.setValueAtTime(0.0001, t0);
    param.exponentialRampToValueAtTime(Math.max(0.0002, peak), t0 + a);
    param.exponentialRampToValueAtTime(0.0001, t0 + dur);
  }

  function addSends(node, opts, bus) {
    if (opts.verb) {
      const s = ctx.createGain();
      s.gain.value = opts.verb;
      node.connect(s).connect(bus === musicBus ? musicVerb : sfxVerb);
    }
    if (opts.echo && bus === musicBus) {
      const s = ctx.createGain();
      s.gain.value = opts.echo;
      node.connect(s).connect(musicEcho);
    }
  }

  /** One oscillator note. `freqTo` sweeps the pitch across the note, which
   *  is what turns a beep into a laser, a rising launch or a falling siren. */
  function voice(opts) {
    const {
      freq, freqTo = 0, dur = 0.2, type = "triangle", gain = 0.1,
      attack = 0.008, detune = 0, cutoff = 0, when = ctx.currentTime,
      bus = sfxBus,
    } = opts;

    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(Math.max(20, freq), when);
    if (freqTo) osc.frequency.exponentialRampToValueAtTime(Math.max(20, freqTo), when + dur);
    if (detune) osc.detune.value = detune;

    let tail = osc;
    if (cutoff) {
      const f = ctx.createBiquadFilter();
      f.type = "lowpass";
      f.frequency.value = cutoff;
      tail = tail.connect(f);
    }

    const g = ctx.createGain();
    tail.connect(g);
    env(g.gain, when, attack, dur, gain);
    g.connect(bus);
    addSends(g, opts, bus);

    osc.start(when);
    osc.stop(when + dur + 0.05);
    return g;
  }

  /** Filtered noise: impacts, thruster bursts, hats, wind. */
  function noiseVoice(opts) {
    const {
      dur = 0.3, gain = 0.2, filter = "lowpass", freq = 1200, freqTo = 0,
      q = 1, attack = 0.004, when = ctx.currentTime, bus = sfxBus,
    } = opts;

    const src = ctx.createBufferSource();
    src.buffer = hiss;
    src.loop = true;

    const f = ctx.createBiquadFilter();
    f.type = filter;
    f.frequency.setValueAtTime(freq, when);
    if (freqTo) f.frequency.exponentialRampToValueAtTime(Math.max(30, freqTo), when + dur);
    f.Q.value = q;

    const g = ctx.createGain();
    src.connect(f).connect(g);
    env(g.gain, when, attack, dur, gain);
    g.connect(bus);
    addSends(g, opts, bus);

    src.start(when);
    src.stop(when + dur + 0.05);
    return g;
  }

  /* ------------------------------------------------------------------ *
   *  Effect library
   *  Shared by all three games so the arcade sounds like one place. Names
   *  describe the event, not the waveform, so calling code reads as a game.
   * ------------------------------------------------------------------ */
  const EFFECTS = {
    click:   () => voice({ freq: 520, dur: 0.06, type: "square", gain: 0.05 }),
    hover:   () => voice({ freq: 340, dur: 0.04, type: "sine", gain: 0.03 }),
    place:   () => voice({ freq: 640, freqTo: 880, dur: 0.09, type: "triangle", gain: 0.08 }),
    lock:    () => { voice({ freq: 300, dur: 0.05, type: "square", gain: 0.06 });
                     voice({ freq: 900, dur: 0.05, type: "sine", gain: 0.03, when: ctx.currentTime + 0.05 }); },
    error:   () => voice({ freq: 150, freqTo: 90, dur: 0.24, type: "sawtooth", gain: 0.07 }),

    success: () => [523, 659, 784, 1047].forEach((f, i) =>
      voice({ freq: f, dur: i === 3 ? 0.5 : 0.16, type: "triangle", gain: 0.085,
              when: ctx.currentTime + i * 0.1, verb: 0.5 })),

    fail:    () => { voice({ freq: 240, freqTo: 150, dur: 0.34, type: "sawtooth", gain: 0.08, cutoff: 900 });
                     voice({ freq: 160, freqTo: 80, dur: 0.6, type: "sawtooth", gain: 0.07, cutoff: 600,
                             when: ctx.currentTime + 0.2 }); },

    /* Flight */
    ignite:  () => { noiseVoice({ dur: 1.4, gain: 0.22, freq: 120, freqTo: 900, q: 0.8 });
                     voice({ freq: 40, freqTo: 90, dur: 1.4, type: "sawtooth", gain: 0.12, cutoff: 400 }); },
    stage:   () => { noiseVoice({ dur: 0.5, gain: 0.2, freq: 1800, freqTo: 200 });
                     voice({ freq: 110, freqTo: 55, dur: 0.5, type: "square", gain: 0.08, cutoff: 500 }); },
    thud:    () => { voice({ freq: 95, freqTo: 45, dur: 0.42, type: "sine", gain: 0.24 });
                     noiseVoice({ dur: 0.3, gain: 0.14, freq: 500, freqTo: 90 }); },
    crash:   () => { noiseVoice({ dur: 0.9, gain: 0.3, freq: 1600, freqTo: 70, q: 0.6, verb: 0.4 });
                     voice({ freq: 130, freqTo: 34, dur: 0.8, type: "sawtooth", gain: 0.2, cutoff: 700 }); },
    alarm:   () => [0, 0.26].forEach((d) =>
      voice({ freq: 880, dur: 0.14, type: "square", gain: 0.07, when: ctx.currentTime + d })),

    /* Shooting and impacts */
    shoot:   () => { voice({ freq: 1100, freqTo: 280, dur: 0.11, type: "square", gain: 0.055, cutoff: 2600 });
                     noiseVoice({ dur: 0.06, gain: 0.05, filter: "highpass", freq: 2000 }); },
    hit:     () => { noiseVoice({ dur: 0.1, gain: 0.13, freq: 2400, freqTo: 600 });
                     voice({ freq: 320, freqTo: 180, dur: 0.09, type: "square", gain: 0.05 }); },
    explode: () => { noiseVoice({ dur: 0.62, gain: 0.26, freq: 1400, freqTo: 80, q: 0.7, verb: 0.3 });
                     voice({ freq: 120, freqTo: 40, dur: 0.5, type: "sawtooth", gain: 0.16, cutoff: 600 }); },
    bigboom: () => { noiseVoice({ dur: 1.1, gain: 0.32, freq: 900, freqTo: 50, q: 0.5, verb: 0.5 });
                     voice({ freq: 90, freqTo: 28, dur: 1.0, type: "sawtooth", gain: 0.22, cutoff: 500 }); },

    /* Rewards */
    pickup:  () => [784, 1175].forEach((f, i) =>
      voice({ freq: f, dur: 0.12, type: "triangle", gain: 0.08, when: ctx.currentTime + i * 0.07 })),
    shield:  () => { voice({ freq: 330, freqTo: 990, dur: 0.4, type: "sine", gain: 0.09, verb: 0.3 });
                     voice({ freq: 334, freqTo: 996, dur: 0.4, type: "sine", gain: 0.06 }); },
    chime:   () => [1319, 1760].forEach((f, i) =>
      voice({ freq: f, dur: 0.9, type: "sine", gain: 0.07, when: ctx.currentTime + i * 0.08, verb: 0.7 })),
    extra:   () => [523, 784, 1047, 1568].forEach((f, i) =>
      voice({ freq: f, dur: 0.3, type: "square", gain: 0.06, when: ctx.currentTime + i * 0.07 })),

    /* Movement */
    whoosh:  () => noiseVoice({ dur: 0.45, gain: 0.13, filter: "bandpass", freq: 300, freqTo: 2600, q: 1.6 }),
    warp:    () => { voice({ freq: 1400, freqTo: 60, dur: 1.1, type: "sawtooth", gain: 0.1, cutoff: 1800, verb: 0.4 });
                     noiseVoice({ dur: 1.1, gain: 0.1, filter: "bandpass", freq: 2200, freqTo: 120, q: 2 }); },
    tick:    () => voice({ freq: 1600, dur: 0.03, type: "sine", gain: 0.035 }),
    launchpad: () => { voice({ freq: 180, freqTo: 720, dur: 0.3, type: "triangle", gain: 0.1 });
                       noiseVoice({ dur: 0.35, gain: 0.1, filter: "bandpass", freq: 400, freqTo: 2400, q: 1.4 }); },
  };

  function sfx(name) {
    if (!prefs.sfx) return;
    if (!ensure()) return;
    const fn = EFFECTS[name];
    if (!fn) { console.warn("[arcade audio] unknown effect:", name); return; }
    fn();
  }

  /* ------------------------------------------------------------------ *
   *  Continuous thruster
   *  One long-lived noise + rumble pair whose brightness and level follow
   *  the throttle. Built on first use and then kept, because starting and
   *  stopping sources sixty times a second would click.
   * ------------------------------------------------------------------ */
  let engine = null;

  function ramp(param, value, time = 0.05) {
    param.setTargetAtTime(value, ctx.currentTime, time);
  }

  function buildEngine() {
    const src = ctx.createBufferSource();
    src.buffer = hiss;
    src.loop = true;

    const band = ctx.createBiquadFilter();
    band.type = "lowpass";
    band.frequency.value = 400;
    band.Q.value = 1.2;

    const hissGain = ctx.createGain();
    hissGain.gain.value = 0;

    const rumble = ctx.createOscillator();
    rumble.type = "sawtooth";
    rumble.frequency.value = 46;
    const rumbleTone = ctx.createBiquadFilter();
    rumbleTone.type = "lowpass";
    rumbleTone.frequency.value = 220;
    const rumbleGain = ctx.createGain();
    rumbleGain.gain.value = 0;

    src.connect(band).connect(hissGain).connect(sfxBus);
    rumble.connect(rumbleTone).connect(rumbleGain).connect(sfxBus);
    src.start();
    rumble.start();

    engine = { band, hissGain, rumble, rumbleGain };
  }

  function thruster(level) {
    const v = clamp01(level);
    // Nothing is built for a game that never asks for thrust, and a game
    // sitting at zero does not pay for an oscillator it cannot hear.
    if (!engine && v <= 0) return;
    if (!ensure()) return;
    if (!prefs.sfx) {
      if (engine) { ramp(engine.hissGain.gain, 0); ramp(engine.rumbleGain.gain, 0); }
      return;
    }
    if (!engine) buildEngine();

    ramp(engine.hissGain.gain, v * 0.2);
    ramp(engine.rumbleGain.gain, v * 0.13);
    ramp(engine.band.frequency, 300 + v * 2200, 0.08);
    ramp(engine.rumble.frequency, 40 + v * 26, 0.12);
  }

  /* ------------------------------------------------------------------ *
   *  Music
   *
   *  Tracks are generated, not recorded. Each one is a chord progression
   *  plus a handful of layers — pad, bass, arpeggio, percussion — and a
   *  step sequencer walks it in sixteenths. Because the parts are data, a
   *  track is a dozen numbers rather than a three megabyte download, and it
   *  loops forever without a seam.
   *
   *  Offsets are semitones from the track's root; a step is one sixteenth
   *  of a bar, so `steps: [0, 8]` means beats one and three.
   * ------------------------------------------------------------------ */
  const TRACKS = {
    /* Title screens: slow, wide, unhurried. */
    menu: {
      bpm: 72, root: 55,
      chords: [[0, 7, 12, 15], [-4, 3, 8, 12], [-9, -2, 3, 7], [-2, 5, 10, 14]],
      pad:  { gain: 0.085, type: "triangle", cutoff: 1100, attack: 1.6, verb: 0.75 },
      bass: { gain: 0.1, type: "sine", steps: [0, 10], dur: 1.1 },
      arp:  { gain: 0.05, type: "triangle", steps: [0, 6, 10, 14], oct: 24, dur: 0.75, verb: 0.4, echo: 0.3 },
    },

    /* Mission 1, the assembly bay: workshop-calm, a little bit hopeful. */
    assembly: {
      bpm: 84, root: 62,
      chords: [[0, 7, 12, 16], [5, 12, 17, 21], [-3, 4, 9, 12], [-5, 2, 7, 11]],
      pad:  { gain: 0.06, type: "sine", cutoff: 1400, attack: 1.1, verb: 0.55 },
      bass: { gain: 0.09, type: "triangle", steps: [0, 6, 10], dur: 0.6 },
      arp:  { gain: 0.045, type: "sine", steps: [2, 6, 10, 14], oct: 24, dur: 0.5, verb: 0.4, echo: 0.35 },
      perc: { tick: [0, 4, 8, 12] },
    },

    /* Mission 2, the climb: a committed, forward-leaning pulse. */
    flight: {
      bpm: 126, root: 55,
      chords: [[0, 7, 12, 15], [-2, 5, 10, 14], [-4, 3, 8, 12], [-2, 5, 10, 14]],
      pad:  { gain: 0.05, type: "sawtooth", cutoff: 700, attack: 0.5, verb: 0.4 },
      bass: { gain: 0.11, type: "sawtooth", steps: [0, 4, 8, 12, 14], dur: 0.2, cutoff: 500 },
      arp:  { gain: 0.04, type: "square", steps: [0, 2, 4, 6, 8, 10, 12, 14], oct: 24, dur: 0.11, echo: 0.25 },
      perc: { kick: [0, 8], hat: [2, 6, 10, 14] },
    },

    /* Mission 3, the Mars descent: low, tense, watching the altimeter. */
    descent: {
      bpm: 90, root: 49,
      chords: [[0, 7, 15, 19], [-4, 3, 10, 15], [0, 6, 13, 18], [-2, 5, 12, 17]],
      pad:  { gain: 0.09, type: "sawtooth", cutoff: 520, attack: 1.2, verb: 0.6 },
      bass: { gain: 0.12, type: "sine", steps: [0, 8], dur: 0.9 },
      arp:  { gain: 0.035, type: "triangle", steps: [6, 13], oct: 24, dur: 0.6, verb: 0.65, echo: 0.4 },
      perc: { tick: [0, 8] },
    },

    /* Asteroid Run: the one track that is allowed to be loud. */
    chase: {
      bpm: 152, root: 55,
      chords: [[0, 7, 12, 15], [-4, 3, 8, 12], [-2, 5, 10, 14], [-5, 2, 7, 11]],
      pad:  { gain: 0.04, type: "sawtooth", cutoff: 900, attack: 0.3, verb: 0.3 },
      bass: { gain: 0.115, type: "sawtooth", steps: [0, 3, 6, 8, 11, 14], dur: 0.16, cutoff: 460 },
      arp:  { gain: 0.042, type: "square", steps: [0, 2, 4, 6, 8, 10, 12, 14], oct: 24, dur: 0.1, echo: 0.28 },
      perc: { kick: [0, 6, 8], snare: [4, 12], hat: [0, 2, 4, 6, 8, 10, 12, 14] },
    },

    /* Orbital Puzzle: room to think. Bells, air, no drums. */
    puzzle: {
      bpm: 64, root: 65,
      chords: [[0, 7, 11, 16], [-3, 4, 9, 14], [5, 12, 16, 21], [-5, 2, 9, 14]],
      pad:  { gain: 0.07, type: "sine", cutoff: 1300, attack: 2.0, verb: 0.8 },
      bass: { gain: 0.085, type: "sine", steps: [0], dur: 1.6 },
      arp:  { gain: 0.05, type: "sine", steps: [0, 7, 12], oct: 24, dur: 1.2, verb: 0.75, echo: 0.42 },
    },
  };

  const hz = (root, semi) => root * Math.pow(2, semi / 12);

  let seq = null;        // { name, track, step, nextTime, timer }
  let wantedTrack = null;
  let arpCursor = 0;

  function scheduleStep(track, step, when) {
    const bar = Math.floor(step / 16);
    const s = step % 16;
    const chord = track.chords[bar % track.chords.length];
    const stepDur = 60 / track.bpm / 4;
    const barDur = stepDur * 16;

    /* Pad — one sustained chord per bar, overlapping into the next so the
       progression breathes instead of restarting. */
    if (s === 0 && track.pad) {
      const p = track.pad;
      chord.forEach((semi) => {
        // Two slightly detuned voices per note: the beating between them is
        // what makes a synth pad sound wide rather than thin.
        [-6, 6].forEach((cents) =>
          voice({
            freq: hz(track.root, semi + 12), dur: barDur * 1.25, type: p.type,
            gain: p.gain / (chord.length * 0.8), attack: p.attack, detune: cents,
            cutoff: p.cutoff, verb: p.verb, when, bus: musicBus,
          })
        );
      });
    }

    /* Bass — the chord root, an octave below the pad. */
    if (track.bass && track.bass.steps.includes(s)) {
      const b = track.bass;
      voice({
        freq: hz(track.root, chord[0]), dur: b.dur, type: b.type, gain: b.gain,
        attack: 0.01, cutoff: b.cutoff || 0, when, bus: musicBus,
      });
    }

    /* Arpeggio — walks up the chord one tone per hit, so the figure keeps
       moving across bars instead of repeating a fixed shape. */
    if (track.arp && track.arp.steps.includes(s)) {
      const a = track.arp;
      const idx = arpCursor++ % chord.length;
      voice({
        freq: hz(track.root, chord[idx] + a.oct), dur: a.dur, type: a.type,
        gain: a.gain, attack: 0.005, verb: a.verb, echo: a.echo, when, bus: musicBus,
      });
    }

    /* Percussion */
    const perc = track.perc;
    if (perc) {
      if (perc.kick && perc.kick.includes(s)) {
        voice({ freq: 130, freqTo: 44, dur: 0.16, type: "sine", gain: 0.2, when, bus: musicBus });
      }
      if (perc.snare && perc.snare.includes(s)) {
        noiseVoice({ dur: 0.14, gain: 0.075, filter: "highpass", freq: 1400, when, bus: musicBus });
      }
      if (perc.hat && perc.hat.includes(s)) {
        noiseVoice({ dur: 0.035, gain: 0.035, filter: "highpass", freq: 8000, when, bus: musicBus });
      }
      if (perc.tick && perc.tick.includes(s)) {
        noiseVoice({ dur: 0.06, gain: 0.03, filter: "bandpass", freq: 3000, q: 3, when, bus: musicBus });
      }
    }
  }

  function startMusic(name) {
    const track = TRACKS[name];
    if (!track) { console.warn("[arcade audio] unknown track:", name); return; }
    if (!prefs.music) return;          // remembered in wantedTrack, not played
    if (!ensure()) return;
    if (seq && seq.name === name) return;

    stopSequencer();
    arpCursor = 0;
    seq = { name, track, step: 0, nextTime: ctx.currentTime + 0.12, timer: null };

    // Lookahead scheduling: the timer only has to be roughly on time, because
    // every note carries an exact WebAudio start time. A setInterval that
    // played notes directly would drift audibly.
    seq.timer = setInterval(() => {
      if (!seq) return;
      const stepDur = 60 / seq.track.bpm / 4;
      const horizon = ctx.currentTime + 0.3;
      while (seq.nextTime < horizon) {
        scheduleStep(seq.track, seq.step, seq.nextTime);
        seq.step = (seq.step + 1) % (16 * seq.track.chords.length);
        seq.nextTime += stepDur;
      }
    }, 40);
  }

  function stopSequencer() {
    if (seq && seq.timer) clearInterval(seq.timer);
    seq = null;
  }

  /** Start a track, swap to another, or stop with null. Asking for the track
   *  that is already playing is a no-op, so a screen can set its music on
   *  every entry without restarting the loop. */
  function music(name) {
    wantedTrack = name || null;

    if (!name) {
      // Fade the bus rather than cutting: an abrupt stop mid-chord reads as a
      // glitch. The sequencer stops once the tail is gone.
      if (ctx && seq) {
        musicBus.gain.setTargetAtTime(0, ctx.currentTime, 0.25);
        setTimeout(() => {
          stopSequencer();
          if (ctx) applyVolumes();
        }, 700);
      } else {
        stopSequencer();
      }
      return;
    }
    if (!unlocked) return;             // picked up by unlock()
    if (ctx && seq === null) applyVolumes();   // undo a fade left by a stop
    startMusic(name);
  }

  /* ------------------------------------------------------------------ *
   *  Settings
   * ------------------------------------------------------------------ */
  function applyVolumes() {
    if (!ctx) return;
    sfxBus.gain.setTargetAtTime(prefs.sfx ? prefs.sfxVol : 0, ctx.currentTime, 0.05);
    musicBus.gain.setTargetAtTime(prefs.music ? prefs.musicVol : 0, ctx.currentTime, 0.05);
  }

  window.ArcadeAudio = {
    sfx,
    music,
    thruster,
    unlock,

    tracks: () => Object.keys(TRACKS),
    effects: () => Object.keys(EFFECTS),

    sfxEnabled: () => prefs.sfx,
    musicEnabled: () => prefs.music,
    sfxVolume: () => prefs.sfxVol,
    musicVolume: () => prefs.musicVol,

    setSfxEnabled(on) {
      prefs.sfx = !!on;
      savePrefs();
      applyVolumes();
      if (!prefs.sfx) thruster(0);
    },

    setMusicEnabled(on) {
      prefs.music = !!on;
      savePrefs();
      applyVolumes();
      // Switching music back on picks up whichever track the screen wanted.
      if (prefs.music && wantedTrack) startMusic(wantedTrack);
      if (!prefs.music) stopSequencer();
    },

    setSfxVolume(v) { prefs.sfxVol = clamp01(v); savePrefs(); applyVolumes(); },
    setMusicVolume(v) { prefs.musicVol = clamp01(v); savePrefs(); applyVolumes(); },
  };
})();
