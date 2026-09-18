/* ==========================================================================
   Orbital Puzzle — game logic
   Plain vanilla JS on one canvas. No build step, no external libraries.

   One probe, one launch, and gravity from every body on the field. The whole
   game is a two-body-plus integrator and twelve hand-placed levels; the skill
   is entirely in reading what the pull will do to your arc before you commit
   to it. Nothing is random, so a solution that works once works every time.
   ========================================================================== */
(() => {
  "use strict";

  /* ------------------------------------------------------------------ *
   *  Small helpers
   * ------------------------------------------------------------------ */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const rand = (lo, hi) => lo + Math.random() * (hi - lo);
  const TAU = Math.PI * 2;
  const DEG = 180 / Math.PI;

  // Some browsers (private-mode Safari, locked-down iframes) throw on any
  // localStorage access rather than just returning null — guard every call
  // so the game still runs, it just won't remember progress between visits.
  const Store = {
    get: (key) => { try { return localStorage.getItem(key); } catch (e) { return null; } },
    set: (key, val) => { try { localStorage.setItem(key, val); } catch (e) { /* ignore */ } },
  };

  /* ------------------------------------------------------------------ *
   *  Audio
   *  The synthesiser lives in assets/audio.js and is shared with the rest
   *  of the arcade. This layer is the vocabulary Orbital Puzzle uses, plus
   *  a stub so a failed script load costs the sound and nothing else.
   * ------------------------------------------------------------------ */
  const Audio_ = (() => {
    const noop = () => {};
    const A = window.ArcadeAudio || {
      sfx: noop, music: noop, thruster: noop, setSfxEnabled: noop,
      setMusicEnabled: noop, setSfxVolume: noop, setMusicVolume: noop,
      sfxEnabled: () => false, musicEnabled: () => false,
      sfxVolume: () => 0, musicVolume: () => 0,
    };
    return {
      click: () => A.sfx("click"),
      launch: () => A.sfx("launchpad"),
      burn: () => A.sfx("whoosh"),
      crystal: () => A.sfx("chime"),
      dock: () => A.sfx("success"),
      crash: () => A.sfx("crash"),
      lost: () => A.sfx("warp"),
      locked: () => A.sfx("error"),
      aim: () => A.sfx("tick"),
      thruster: (v) => A.thruster(v),
      music: (track) => A.music(track),

      sfxEnabled: () => A.sfxEnabled(),
      musicEnabled: () => A.musicEnabled(),
      setSfxEnabled: (v) => A.setSfxEnabled(v),
      setMusicEnabled: (v) => A.setMusicEnabled(v),
      musicVolume: () => A.musicVolume(),
      setMusicVolume: (v) => A.setMusicVolume(v),
    };
  })();

  /* ------------------------------------------------------------------ *
   *  Physics constants
   *  The canvas is a fixed 900x620 coordinate space that CSS scales to fit,
   *  so every number below is in those units and behaves identically on a
   *  phone and on a desktop.
   * ------------------------------------------------------------------ */
  const W = 900, H = 620;

  const GRAV = 24000;        // tuned so a mass of ~45 bends a shot, not breaks it
  const PROBE_R = 5;
  const MAX_LAUNCH = 330;    // px/s at full power
  const MIN_POWER = 0.1;
  const BURN_BOOST = 130;    // px/s added along the current heading
  const FLIGHT_LIMIT = 22;   // seconds before an attempt is written off
  const OUT_MARGIN = 140;    // how far off-field the probe may stray
  const CRYSTAL_R = 11;
  const SUBSTEPS = 4;        // integration steps per frame, for stability

  /* ------------------------------------------------------------------ *
   *  Scoring
   *  Completing a puzzle is most of the score; solving it in one attempt is
   *  worth nearly as much again. A player's campaign score is the sum of
   *  their best run at each puzzle, so going back to clean up a messy
   *  solution always pays — the same shape as Danes Rocket's campaign.
   * ------------------------------------------------------------------ */
  const SCORE = {
    base: 400,
    attemptBonus: (attempts) => Math.max(0, 300 - (attempts - 1) * 60),
    crystal: 120,
  };

  /* ------------------------------------------------------------------ *
   *  Levels
   *  Every body is lethal on contact; only the station is safe to touch.
   *  `mass` is the gravity strength, `r` the drawn and collided radius, and
   *  the two are deliberately independent — a void is small and vicious, a
   *  gas giant large and gentle.
   * ------------------------------------------------------------------ */
  const LEVELS = [
    {
      name: "First Light",
      hint: "Aim straight at the station and let it fly. Nothing out here is pulling on you yet.",
      start: { x: 120, y: 500 }, goal: { x: 770, y: 150, r: 28 },
      bodies: [], crystals: [], walls: [],
    },
    {
      name: "Gentle Pull",
      hint: "That planet is not in your way, but it will bend your path on the way past. Aim a little high.",
      start: { x: 110, y: 520 }, goal: { x: 800, y: 140, r: 28 },
      bodies: [{ x: 450, y: 430, r: 48, mass: 42, kind: "planet" }],
      crystals: [{ x: 300, y: 330 }], walls: [],
    },
    {
      name: "Around the Giant",
      hint: "Straight through is not an option. Go over the top and let its gravity walk you back down.",
      start: { x: 100, y: 310 }, goal: { x: 810, y: 310, r: 28 },
      bodies: [{ x: 455, y: 310, r: 78, mass: 75, kind: "planet" }],
      crystals: [{ x: 455, y: 150 }], walls: [],
    },
    {
      name: "Slingshot",
      hint: "Swing in close and it will throw you further than your engine ever could.",
      start: { x: 110, y: 545 }, goal: { x: 810, y: 95, r: 28 },
      bodies: [{ x: 420, y: 330, r: 52, mass: 58, kind: "planet" }],
      crystals: [{ x: 265, y: 386 }, { x: 615, y: 175 }], walls: [],
    },
    {
      name: "Twin Wells",
      hint: "Two equal pulls cancel each other out. Straight up the middle is the whole trick.",
      start: { x: 450, y: 570 }, goal: { x: 450, y: 70, r: 30 },
      bodies: [
        { x: 255, y: 320, r: 48, mass: 46, kind: "planet" },
        { x: 645, y: 320, r: 48, mass: 46, kind: "planet" },
      ],
      crystals: [{ x: 450, y: 460 }, { x: 450, y: 300 }, { x: 450, y: 165 }], walls: [],
    },
    {
      name: "Hot Core",
      hint: "The star burns anything it touches, and it pulls harder than any planet here.",
      start: { x: 95, y: 530 }, goal: { x: 825, y: 120, r: 28 },
      bodies: [
        { x: 430, y: 325, r: 38, mass: 85, kind: "star" },
        { x: 660, y: 470, r: 42, mass: 38, kind: "planet" },
      ],
      crystals: [{ x: 250, y: 330 }], walls: [],
    },
    {
      name: "The Gauntlet",
      hint: "Thread the gap on the low side, then let the planet beyond it lift you into the station.",
      start: { x: 95, y: 310 }, goal: { x: 815, y: 310, r: 28 },
      bodies: [{ x: 700, y: 175, r: 44, mass: 45, kind: "planet" }],
      crystals: [{ x: 455, y: 315 }],
      walls: [{ x: 430, y: 0, w: 22, h: 248 }, { x: 430, y: 372, w: 22, h: 248 }],
    },
    {
      name: "Into the Void",
      hint: "A void this hungry has to be given room. Go wide — the long way round is the only way through.",
      start: { x: 100, y: 545 }, goal: { x: 825, y: 100, r: 32 },
      bodies: [
        { x: 430, y: 325, r: 24, mass: 112, kind: "void" },
        { x: 695, y: 445, r: 42, mass: 40, kind: "planet" },
      ],
      crystals: [{ x: 300, y: 150 }], walls: [],
    },
    {
      name: "Crystal Run",
      hint: "A flat shot will reach the station easily enough. The crystals are up over the top, and that is a different launch entirely.",
      start: { x: 110, y: 545 }, goal: { x: 790, y: 545, r: 30 },
      bodies: [{ x: 450, y: 265, r: 54, mass: 62, kind: "planet" }],
      crystals: [{ x: 199, y: 371 }, { x: 505, y: 185 }, { x: 713, y: 374 }],
      walls: [],
    },
    {
      name: "Two Step",
      hint: "One planet to turn you, a second to catch you. Keep the burn for whichever one lets you down.",
      start: { x: 100, y: 545 }, goal: { x: 830, y: 105, r: 28 },
      bodies: [
        { x: 345, y: 390, r: 44, mass: 48, kind: "planet" },
        { x: 640, y: 215, r: 44, mass: 48, kind: "planet" },
      ],
      crystals: [{ x: 500, y: 300 }], walls: [],
    },
    {
      name: "Pick a Lane",
      hint: "Two gaps, one star, no second chances. Speed is your friend — the faster you pass, the less it can pull.",
      start: { x: 95, y: 310 }, goal: { x: 830, y: 310, r: 28 },
      bodies: [
        { x: 462, y: 310, r: 34, mass: 70, kind: "star" },
        { x: 462, y: 105, r: 40, mass: 40, kind: "planet" },
        { x: 462, y: 515, r: 40, mass: 40, kind: "planet" },
      ],
      crystals: [{ x: 462, y: 207 }], walls: [],
    },
    {
      name: "The Long Way",
      hint: "The station is directly above you and there is no straight line to it. Launch sideways, gently, and ride the planet round.",
      start: { x: 450, y: 555 }, goal: { x: 450, y: 75, r: 32 },
      bodies: [{ x: 450, y: 310, r: 66, mass: 90, kind: "planet" }],
      crystals: [{ x: 695, y: 310 }, { x: 623, y: 137 }], walls: [],
    },
  ];

  /* ------------------------------------------------------------------ *
   *  Progress persistence
   * ------------------------------------------------------------------ */
  const Progress = (() => {
    const KEY = "op_progress";
    const blank = () => ({ done: {}, best: {}, stars: {}, crystals: {} });
    let data = blank();
    try {
      const saved = JSON.parse(Store.get(KEY));
      if (saved) data = Object.assign(blank(), saved);
    } catch (e) { /* ignore malformed storage */ }

    const save = () => Store.set(KEY, JSON.stringify(data));

    return {
      isComplete: (i) => !!data.done[i],
      isUnlocked: (i) => i === 0 || !!data.done[i - 1],
      bestFor: (i) => data.best[i] || 0,
      starsFor: (i) => data.stars[i] || 0,
      crystalsFor: (i) => data.crystals[i] || 0,
      bests: () => ({ ...data.best }),
      total: () => Object.values(data.best).reduce((a, b) => a + b, 0),

      /** Records a solved puzzle, keeping the best of every measure so a
       *  sloppier replay can never take a star away. Returns true when the
       *  score itself improved. */
      record(i, score, stars, crystals) {
        data.done[i] = true;
        data.stars[i] = Math.max(data.stars[i] || 0, stars);
        data.crystals[i] = Math.max(data.crystals[i] || 0, crystals);
        const improved = score > (data.best[i] || 0);
        if (improved) data.best[i] = score;
        save();
        return improved;
      },

      reset() { data = blank(); save(); },
    };
  })();

  /* ------------------------------------------------------------------ *
   *  Run state
   *  P is the puzzle currently on screen. It is null whenever the play
   *  screen is not up, which is what every input handler checks first.
   * ------------------------------------------------------------------ */
  let P = null;
  let raf = null;
  let lastT = null;
  let ctx = null;

  const keys = { left: false, right: false, up: false, down: false };

  function newAttempt(level, attempts) {
    return {
      level,
      index: LEVELS.indexOf(level),
      attempts,
      phase: "aim",              // aim | flight | settled
      aim: { angle: aimDefault(level), power: 0.6, dragging: false },
      probe: null,
      trail: [],
      got: new Set(),            // crystal indexes taken this attempt
      burnUsed: false,
      flightT: 0,
      bits: [],
      time: 0,
    };
  }

  /** A first guess that points roughly at the station, so the very first
   *  drag is a refinement rather than a blind hunt. */
  function aimDefault(level) {
    return Math.atan2(level.goal.y - level.start.y, level.goal.x - level.start.x);
  }

  /* ------------------------------------------------------------------ *
   *  Integration
   *  One function serves both the live probe and the dotted preview, so
   *  what the preview promises is exactly what the flight delivers.
   * ------------------------------------------------------------------ */
  function accelAt(x, y, bodies) {
    let ax = 0, ay = 0;
    for (const b of bodies) {
      const dx = b.x - x, dy = b.y - y;
      const d2 = dx * dx + dy * dy;
      // Floor the distance at the body's surface. Inside a body the attempt is
      // already over, and an unbounded 1/r² would fling the probe to infinity
      // in the frame before the collision check notices.
      const floor = (b.r * 0.85) ** 2;
      const eff = Math.max(d2, floor);
      const d = Math.sqrt(d2) || 1;
      const a = (GRAV * b.mass) / eff;
      ax += (dx / d) * a;
      ay += (dy / d) * a;
    }
    return { ax, ay };
  }

  function advance(p, dt, bodies) {
    const { ax, ay } = accelAt(p.x, p.y, bodies);
    p.vx += ax * dt;
    p.vy += ay * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
  }

  const insideWall = (x, y, w) =>
    x > w.x - PROBE_R && x < w.x + w.w + PROBE_R &&
    y > w.y - PROBE_R && y < w.y + w.h + PROBE_R;

  /** What the probe just ran into, or null if it is still flying.
   *  Returns "goal", "body", "wall" or "out". */
  function collisionAt(x, y, level) {
    for (const b of level.bodies) {
      if (Math.hypot(b.x - x, b.y - y) < b.r + PROBE_R) return "body";
    }
    for (const w of level.walls) {
      if (insideWall(x, y, w)) return "wall";
    }
    if (Math.hypot(level.goal.x - x, level.goal.y - y) < level.goal.r) return "goal";
    if (x < -OUT_MARGIN || x > W + OUT_MARGIN || y < -OUT_MARGIN || y > H + OUT_MARGIN) return "out";
    return null;
  }

  /** The dotted line shown while aiming. Deliberately short: two seconds is
   *  enough to read the initial curve, and not enough to hand the player the
   *  whole answer — which is where the puzzle would otherwise go. */
  function previewPath() {
    const { level, aim } = P;
    const p = {
      x: level.start.x, y: level.start.y,
      vx: Math.cos(aim.angle) * aim.power * MAX_LAUNCH,
      vy: Math.sin(aim.angle) * aim.power * MAX_LAUNCH,
    };
    const dt = 1 / 120;
    const pts = [];
    for (let i = 0; i < 260; i++) {
      advance(p, dt, level.bodies);
      if (i % 5 === 0) pts.push({ x: p.x, y: p.y });
      if (collisionAt(p.x, p.y, level)) break;
    }
    return pts;
  }

  /* ------------------------------------------------------------------ *
   *  Launching and outcomes
   * ------------------------------------------------------------------ */
  function launch() {
    if (!P || P.phase !== "aim") return;
    const { level, aim } = P;
    P.probe = {
      x: level.start.x, y: level.start.y,
      vx: Math.cos(aim.angle) * aim.power * MAX_LAUNCH,
      vy: Math.sin(aim.angle) * aim.power * MAX_LAUNCH,
    };
    P.trail = [{ x: P.probe.x, y: P.probe.y }];
    P.phase = "flight";
    P.flightT = 0;
    Audio_.launch();
    paintPlayHud();
  }

  function burn() {
    if (!P || P.phase !== "flight" || P.burnUsed) return;
    const p = P.probe;
    const speed = Math.hypot(p.vx, p.vy) || 1;
    p.vx += (p.vx / speed) * BURN_BOOST;
    p.vy += (p.vy / speed) * BURN_BOOST;
    P.burnUsed = true;
    burst(p.x, p.y, 14, "#b78bff", 150);
    Audio_.burn();
    paintPlayHud();
  }

  function failAttempt(reason) {
    P.phase = "settled";
    Audio_.thruster(0);
    const p = P.probe;

    if (reason === "out") {
      Audio_.lost();
      flash("Lost in space", "warn");
    } else {
      burst(p.x, p.y, 24, "#ff9a5d", 240);
      Audio_.crash();
      flash(reason === "wall" ? "Struck the barrier" : "Burned up", "warn");
    }

    // Straight back to the pad — a puzzle that makes you click through a
    // failure dialogue on every attempt stops being a puzzle you want to
    // keep attempting.
    setTimeout(() => {
      if (!P || P.phase !== "settled") return;
      const attempts = P.attempts + 1;
      P = newAttempt(P.level, attempts);
      paintPlayHud();
    }, 950);
  }

  function succeed() {
    P.phase = "settled";
    Audio_.thruster(0);
    Audio_.dock();

    const i = P.index;
    const crystals = P.got.size;
    const attempts = P.attempts;
    const score = SCORE.base + SCORE.attemptBonus(attempts) + crystals * SCORE.crystal;
    const stars = attempts === 1 ? 3 : attempts <= 3 ? 2 : 1;

    const improved = Progress.record(i, score, stars, crystals);
    flash("Docked", "good");

    setTimeout(() => showResult({ i, score, stars, crystals, attempts, improved }), 850);
  }

  /* ------------------------------------------------------------------ *
   *  Effects
   * ------------------------------------------------------------------ */
  function burst(x, y, count, color, spread) {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * TAU;
      const sp = rand(30, spread);
      P.bits.push({
        x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        r: rand(1.2, 3.2), life: rand(0.3, 0.75), maxLife: 0.75, color,
      });
    }
  }

  /** Big centred callout. Several can overlap; each removes itself when its
   *  animation finishes, so nothing accumulates over a long session. */
  function flash(text, kind = "") {
    const host = $("#flash");
    const el = document.createElement("div");
    el.className = "flash__text" + (kind ? " flash__text--" + kind : "");
    el.textContent = text;
    host.appendChild(el);
    setTimeout(() => el.remove(), 1300);
  }

  /* ------------------------------------------------------------------ *
   *  Simulation
   * ------------------------------------------------------------------ */
  function step(dt) {
    P.time += dt;

    /* ---- aiming ---- */
    if (P.phase === "aim" && !P.aim.dragging) {
      // Keyboard aiming, for players not using a pointer. Holding a key
      // sweeps smoothly rather than stepping, which is much easier to land.
      let moved = false;
      if (keys.left) { P.aim.angle -= 1.1 * dt; moved = true; }
      if (keys.right) { P.aim.angle += 1.1 * dt; moved = true; }
      if (keys.up) { P.aim.power = clamp(P.aim.power + 0.5 * dt, MIN_POWER, 1); moved = true; }
      if (keys.down) { P.aim.power = clamp(P.aim.power - 0.5 * dt, MIN_POWER, 1); moved = true; }
      if (moved) paintPlayHud();
    }

    /* ---- flight ---- */
    if (P.phase === "flight") {
      P.flightT += dt;
      const p = P.probe;

      // Several small steps per frame: gravity changes fast near a body, and
      // one big step there would tunnel straight through it.
      const sub = dt / SUBSTEPS;
      for (let i = 0; i < SUBSTEPS; i++) {
        advance(p, sub, P.level.bodies);

        // Crystals are collected mid-step so a fast probe cannot skip one it
        // visibly flew through.
        P.level.crystals.forEach((c, ci) => {
          if (P.got.has(ci)) return;
          if (Math.hypot(c.x - p.x, c.y - p.y) < CRYSTAL_R + PROBE_R + 4) {
            P.got.add(ci);
            burst(c.x, c.y, 10, "#7cf5d0", 120);
            Audio_.crystal();
            paintPlayHud();
          }
        });

        const hit = collisionAt(p.x, p.y, P.level);
        if (hit === "goal") { succeed(); return; }
        if (hit) { failAttempt(hit); return; }
      }

      P.trail.push({ x: p.x, y: p.y });
      if (P.trail.length > 1400) P.trail.shift();

      // A quiet thrum while the probe is under way, louder the faster it goes.
      Audio_.thruster(clamp(Math.hypot(p.vx, p.vy) / 700, 0, 1) * 0.18);

      if (P.flightT >= FLIGHT_LIMIT) { failAttempt("out"); return; }
    }

    /* ---- particles ---- */
    for (let i = P.bits.length - 1; i >= 0; i--) {
      const b = P.bits[i];
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.vx -= b.vx * 2.1 * dt;
      b.vy -= b.vy * 2.1 * dt;
      b.life -= dt;
      if (b.life <= 0) P.bits.splice(i, 1);
    }
  }

  /* ------------------------------------------------------------------ *
   *  Rendering
   * ------------------------------------------------------------------ */
  function draw() {
    const L = P.level;
    ctx.fillStyle = "#05070f";
    ctx.fillRect(0, 0, W, H);

    /* Influence rings. Gravity is invisible and this game is about planning
       around it, so each body gets a faint halo showing where its pull starts
       to matter. It is a readability aid, not a hard boundary. */
    L.bodies.forEach((b) => {
      const reach = b.r + Math.sqrt(b.mass) * 14;
      const g = ctx.createRadialGradient(b.x, b.y, b.r, b.x, b.y, reach);
      g.addColorStop(0, b.kind === "void" ? "rgba(183,139,255,.16)" : "rgba(90,209,255,.11)");
      g.addColorStop(1, "rgba(90,209,255,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(b.x, b.y, reach, 0, TAU);
      ctx.fill();
    });

    drawWalls(L);
    drawGoal(L);
    drawCrystals(L);
    drawBodies(L);

    /* Preview while aiming, trail while flying */
    if (P.phase === "aim") {
      drawPreview();
      drawAimArrow();
    } else if (P.trail.length > 1) {
      ctx.beginPath();
      ctx.moveTo(P.trail[0].x, P.trail[0].y);
      for (let i = 1; i < P.trail.length; i++) ctx.lineTo(P.trail[i].x, P.trail[i].y);
      ctx.strokeStyle = "rgba(198,236,255,.55)";
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    drawPad(L);

    /* Particles */
    P.bits.forEach((b) => {
      ctx.globalAlpha = clamp(b.life / b.maxLife, 0, 1);
      ctx.fillStyle = b.color;
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r, 0, TAU);
      ctx.fill();
    });
    ctx.globalAlpha = 1;

    if (P.phase === "flight") drawProbe();
  }

  function drawBodies(L) {
    L.bodies.forEach((b) => {
      if (b.kind === "star") {
        // Corona first, so the disc sits inside its own glow.
        const g = ctx.createRadialGradient(b.x, b.y, b.r * 0.4, b.x, b.y, b.r * 2.6);
        g.addColorStop(0, "rgba(255,226,140,.5)");
        g.addColorStop(1, "rgba(255,180,60,0)");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.r * 2.6, 0, TAU);
        ctx.fill();

        const core = ctx.createRadialGradient(b.x - b.r * 0.2, b.y - b.r * 0.2, b.r * 0.1, b.x, b.y, b.r);
        core.addColorStop(0, "#fffbe8");
        core.addColorStop(0.5, "#ffd46b");
        core.addColorStop(1, "#e8802a");
        ctx.fillStyle = core;
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.r, 0, TAU);
        ctx.fill();
        return;
      }

      if (b.kind === "void") {
        // An accretion ring that turns, then a hole with no highlight at all —
        // the absence of shading is what makes it read as a void.
        ctx.save();
        ctx.translate(b.x, b.y);
        ctx.rotate(P.time * 0.7);
        for (let i = 0; i < 3; i++) {
          ctx.beginPath();
          ctx.ellipse(0, 0, b.r * (1.7 + i * 0.5), b.r * (0.55 + i * 0.18), i * 0.5, 0, TAU);
          ctx.strokeStyle = `rgba(183,139,255,${0.34 - i * 0.09})`;
          ctx.lineWidth = 2;
          ctx.stroke();
        }
        ctx.restore();

        ctx.beginPath();
        ctx.arc(b.x, b.y, b.r, 0, TAU);
        ctx.fillStyle = "#050308";
        ctx.fill();
        ctx.strokeStyle = "rgba(183,139,255,.8)";
        ctx.lineWidth = 2;
        ctx.stroke();
        return;
      }

      /* planet */
      const g = ctx.createRadialGradient(
        b.x - b.r * 0.32, b.y - b.r * 0.36, b.r * 0.12, b.x, b.y, b.r * 1.08
      );
      g.addColorStop(0, "#8fd0f0");
      g.addColorStop(0.45, "#3b81b8");
      g.addColorStop(1, "#122f4c");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,.4)";
      ctx.lineWidth = 2;
      ctx.stroke();

      // A couple of continents, placed from the body's own coordinates so
      // they are stable between frames without storing anything.
      ctx.fillStyle = "rgba(63,143,92,.5)";
      ctx.beginPath();
      ctx.arc(b.x - b.r * 0.25, b.y - b.r * 0.1, b.r * 0.3, 0, TAU);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(b.x + b.r * 0.3, b.y + b.r * 0.28, b.r * 0.22, 0, TAU);
      ctx.fill();
    });
  }

  function drawWalls(L) {
    L.walls.forEach((w) => {
      ctx.fillStyle = "#26313f";
      ctx.fillRect(w.x, w.y, w.w, w.h);
      // Hazard stripes, drawn as short diagonals clipped to the bar.
      ctx.save();
      ctx.beginPath();
      ctx.rect(w.x, w.y, w.w, w.h);
      ctx.clip();
      ctx.strokeStyle = "rgba(255,93,93,.45)";
      ctx.lineWidth = 6;
      for (let y = w.y - w.w; y < w.y + w.h + w.w; y += 22) {
        ctx.beginPath();
        ctx.moveTo(w.x - 4, y);
        ctx.lineTo(w.x + w.w + 4, y + w.w + 8);
        ctx.stroke();
      }
      ctx.restore();
      ctx.strokeStyle = "#5c6b7d";
      ctx.lineWidth = 2;
      ctx.strokeRect(w.x, w.y, w.w, w.h);
    });
  }

  function drawGoal(L) {
    const g = L.goal;
    const pulse = 1 + Math.sin(P.time * 3) * 0.06;

    ctx.save();
    ctx.translate(g.x, g.y);

    const halo = ctx.createRadialGradient(0, 0, g.r * 0.3, 0, 0, g.r * 2.4);
    halo.addColorStop(0, "rgba(73,242,172,.28)");
    halo.addColorStop(1, "rgba(73,242,172,0)");
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(0, 0, g.r * 2.4, 0, TAU);
    ctx.fill();

    ctx.rotate(P.time * 0.5);
    ctx.beginPath();
    ctx.arc(0, 0, g.r * pulse, 0, TAU);
    ctx.strokeStyle = "#49f2ac";
    ctx.lineWidth = 3;
    ctx.setLineDash([10, 7]);
    ctx.stroke();
    ctx.setLineDash([]);

    // Docking cross in the middle, so the target point is unambiguous.
    ctx.beginPath();
    ctx.moveTo(-7, 0); ctx.lineTo(7, 0);
    ctx.moveTo(0, -7); ctx.lineTo(0, 7);
    ctx.strokeStyle = "rgba(198,255,230,.9)";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }

  function drawCrystals(L) {
    L.crystals.forEach((c, i) => {
      const taken = P.got.has(i);
      ctx.save();
      ctx.translate(c.x, c.y);
      ctx.rotate(P.time * 1.4);
      ctx.globalAlpha = taken ? 0.18 : 1;
      ctx.beginPath();
      ctx.moveTo(0, -CRYSTAL_R);
      ctx.lineTo(CRYSTAL_R * 0.7, 0);
      ctx.lineTo(0, CRYSTAL_R);
      ctx.lineTo(-CRYSTAL_R * 0.7, 0);
      ctx.closePath();
      ctx.fillStyle = "rgba(124,245,208,.35)";
      ctx.fill();
      ctx.strokeStyle = "#7cf5d0";
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();
      ctx.globalAlpha = 1;
    });
  }

  function drawPad(L) {
    const s = L.start;
    ctx.save();
    ctx.translate(s.x, s.y);
    // The pad always points along the launch heading, so the ship on it is
    // a second read on where the shot is going.
    ctx.rotate(P.aim.angle + Math.PI / 2);
    ctx.fillStyle = "#3d4a5e";
    ctx.fillRect(-16, 4, 32, 7);
    ctx.fillStyle = "#26313f";
    ctx.fillRect(-11, 11, 22, 5);
    if (P.phase === "aim") {
      ctx.beginPath();
      ctx.moveTo(0, -13);
      ctx.lineTo(7, 5);
      ctx.lineTo(-7, 5);
      ctx.closePath();
      ctx.fillStyle = "#e6ecf2";
      ctx.fill();
      ctx.strokeStyle = "#5ad1ff";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawPreview() {
    const pts = previewPath();
    ctx.fillStyle = "rgba(198,236,255,.62)";
    pts.forEach((p, i) => {
      // Fade the dots out along the path: the preview is a hint about the
      // first moments, and looking less certain further out says so.
      ctx.globalAlpha = 0.72 * (1 - i / pts.length);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2.2, 0, TAU);
      ctx.fill();
    });
    ctx.globalAlpha = 1;
  }

  function drawAimArrow() {
    const { start } = P.level;
    const { angle, power } = P.aim;
    const len = 46 + power * 74;
    const ex = start.x + Math.cos(angle) * len;
    const ey = start.y + Math.sin(angle) * len;

    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(ex, ey);
    ctx.strokeStyle = "rgba(90,209,255,.85)";
    ctx.lineWidth = 3;
    ctx.stroke();

    ctx.save();
    ctx.translate(ex, ey);
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.moveTo(11, 0);
    ctx.lineTo(-6, 6);
    ctx.lineTo(-6, -6);
    ctx.closePath();
    ctx.fillStyle = "#5ad1ff";
    ctx.fill();
    ctx.restore();

    /* Power bar along the arrow's own direction */
    ctx.save();
    ctx.translate(start.x, start.y);
    ctx.rotate(angle);
    ctx.fillStyle = "rgba(255,255,255,.16)";
    ctx.fillRect(0, 16, 120, 5);
    ctx.fillStyle = "#5ad1ff";
    ctx.fillRect(0, 16, 120 * power, 5);
    ctx.restore();
  }

  function drawProbe() {
    const p = P.probe;
    const a = Math.atan2(p.vy, p.vx);
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(a);

    ctx.beginPath();
    ctx.moveTo(9, 0);
    ctx.lineTo(-6, 5);
    ctx.lineTo(-3, 0);
    ctx.lineTo(-6, -5);
    ctx.closePath();
    ctx.fillStyle = "#e6ecf2";
    ctx.fill();
    ctx.strokeStyle = "#5ad1ff";
    ctx.lineWidth = 1.4;
    ctx.stroke();
    ctx.restore();

    ctx.beginPath();
    ctx.arc(p.x, p.y, 10 + Math.sin(P.time * 9) * 1.6, 0, TAU);
    ctx.strokeStyle = "rgba(90,209,255,.35)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  /* ------------------------------------------------------------------ *
   *  HUD
   * ------------------------------------------------------------------ */
  function paintPlayHud() {
    if (!P) return;
    const L = P.level;
    // Screen angles run clockwise from east; showing the negated value means
    // "up" reads as a positive number, which is what a player expects.
    const deg = Math.round(-P.aim.angle * DEG);
    $("#hud-angle").textContent = ((deg % 360) + 360) % 360 + "°";
    $("#hud-power").textContent = Math.round(P.aim.power * 100) + "%";
    $("#hud-crystals").textContent = `${P.got.size} / ${L.crystals.length}`;
    $("#hud-burn").textContent = P.burnUsed ? "Spent" : P.phase === "flight" ? "Ready" : "Armed";
    $("#hud-burn").parentElement.classList.toggle("is-spent", P.burnUsed);
    $("#play-attempts").textContent = "Attempt " + P.attempts;
  }

  /* ------------------------------------------------------------------ *
   *  Loop
   * ------------------------------------------------------------------ */
  function frame(t) {
    if (!P) return;
    raf = requestAnimationFrame(frame);
    if (lastT === null) lastT = t;
    // Cap the step: a backgrounded tab returns with a huge delta, and without
    // this the probe would jump straight through a planet on the way back.
    const dt = Math.min((t - lastT) / 1000, 0.05);
    lastT = t;
    step(dt);
    if (P) draw();
  }

  function openLevel(index) {
    stopPlay();
    const level = LEVELS[index];
    ctx = $("#canvas").getContext("2d");
    P = newAttempt(level, 1);
    $("#play-title").textContent =
      String(index + 1).padStart(2, "0") + " — " + level.name;
    $("#play-hint").textContent = level.hint;
    $("#flash").innerHTML = "";
    paintPlayHud();
    lastT = null;
    raf = requestAnimationFrame(frame);
  }

  function stopPlay() {
    if (raf) cancelAnimationFrame(raf);
    raf = null;
    lastT = null;
    P = null;
    Audio_.thruster(0);
  }

  /* ------------------------------------------------------------------ *
   *  Result modal
   * ------------------------------------------------------------------ */
  function showResult({ i, score, stars, crystals, attempts, improved }) {
    const L = LEVELS[i];
    const modal = $("#modal-result .modal--result");
    modal.classList.remove("is-fail");
    $("#result-badge").textContent = "★";
    $("#result-title").textContent = "Docked";
    $("#result-body").textContent =
      attempts === 1
        ? `${L.name} solved on the first attempt. That is as clean as it gets.`
        : `${L.name} solved in ${attempts} attempts.`;

    $("#result-stars").innerHTML = [1, 2, 3]
      .map((n) => `<span${n > stars ? ' class="is-empty"' : ""}>★</span>`)
      .join("");

    $("#result-score").innerHTML =
      `<span class="result-score__num">${score.toLocaleString()}</span>` +
      `<span class="result-score__label">${improved ? "New puzzle best!" : "Puzzle score"}</span>` +
      `<span class="result-score__line">` +
      `Completion <b>${SCORE.base}</b> · ` +
      `Attempts <b>+${SCORE.attemptBonus(attempts)}</b> · ` +
      `Crystals <b>+${crystals * SCORE.crystal}</b></span>` +
      `<span class="result-score__line">Campaign total: <b>${Progress.total().toLocaleString()}</b></span>`;

    const actions = $("#result-actions");
    actions.innerHTML = "";

    const hasNext = i + 1 < LEVELS.length;
    if (hasNext) {
      const next = document.createElement("button");
      next.className = "menu-btn menu-btn--small";
      next.textContent = "Next Puzzle";
      next.onclick = () => { closeModal("modal-result"); Audio_.click(); openLevel(i + 1); };
      actions.appendChild(next);
    }

    const retry = document.createElement("button");
    retry.className = "menu-btn menu-btn--small menu-btn--ghost";
    retry.textContent = attempts === 1 ? "Replay" : "Try for 3 Stars";
    retry.onclick = () => { closeModal("modal-result"); Audio_.click(); openLevel(i); };
    actions.appendChild(retry);

    const list = document.createElement("button");
    list.className = "menu-btn menu-btn--small menu-btn--ghost";
    list.textContent = "All Puzzles";
    list.onclick = () => { closeModal("modal-result"); Audio_.click(); showScreen("screen-levels"); };
    actions.appendChild(list);

    $("#result-sync").innerHTML = "";
    $("#result-sync").hidden = true;
    openModal("modal-result");

    // Hand the run to the arcade layer (arcade.js), which decides whether it
    // goes to the leaderboard or stays in this browser. The game itself stays
    // completely unaware of accounts and networking.
    document.dispatchEvent(new CustomEvent("orbital-puzzle:run-complete", {
      detail: {
        total: Progress.total(),
        level: i + 1,
        levelScore: score,
        stars,
        bests: Progress.bests(),
      },
    }));
  }

  /* ------------------------------------------------------------------ *
   *  Level select
   * ------------------------------------------------------------------ */
  function buildLevelCards() {
    const grid = $("#level-grid");
    grid.innerHTML = LEVELS.map((L, i) => `
      <button class="level-card" data-level="${i}" type="button">
        <span class="level-card__num">Puzzle ${String(i + 1).padStart(2, "0")}</span>
        <span class="level-card__name">${L.name}</span>
        <span class="level-card__stars"></span>
        <span class="level-card__best"></span>
        <span class="level-card__lock" aria-hidden="true">&#128274;</span>
      </button>`).join("");

    grid.querySelectorAll(".level-card").forEach((card) => {
      card.addEventListener("click", () => {
        const i = Number(card.dataset.level);
        if (!Progress.isUnlocked(i)) { Audio_.locked(); return; }
        Audio_.click();
        showScreen("screen-play");
        openLevel(i);
      });
    });
  }

  function refreshLevelCards() {
    LEVELS.forEach((L, i) => {
      const card = $(`.level-card[data-level="${i}"]`);
      if (!card) return;
      const unlocked = Progress.isUnlocked(i);
      card.classList.toggle("is-locked", !unlocked);
      card.classList.toggle("is-complete", Progress.isComplete(i));
      card.disabled = false;   // still focusable, so the lock can be explained

      const stars = Progress.starsFor(i);
      card.querySelector(".level-card__stars").innerHTML = unlocked
        ? [1, 2, 3].map((n) => `<span${n > stars ? ' class="is-empty"' : ""}>★</span>`).join("")
        : "";

      const best = Progress.bestFor(i);
      card.querySelector(".level-card__best").innerHTML = !unlocked
        ? "Locked"
        : best
        ? `Best <b>${best.toLocaleString()}</b> · ${Progress.crystalsFor(i)}/${L.crystals.length} crystals`
        : "Not solved yet";
    });

    const total = Progress.total().toLocaleString();
    $("#campaign-total").textContent = total;
    $("#start-total").textContent = total;
  }

  /* ------------------------------------------------------------------ *
   *  Screens and modals
   * ------------------------------------------------------------------ */
  function showScreen(id) {
    $$(".screen").forEach((s) => s.classList.toggle("active", s.id === id));
    if (id !== "screen-play") stopPlay();
    if (id === "screen-levels" || id === "screen-start") refreshLevelCards();
    Audio_.music(id === "screen-play" ? "puzzle" : "menu");
  }

  const openModal = (id) => $("#" + id).classList.add("active");
  const closeModal = (id) => $("#" + id).classList.remove("active");
  const anyModalOpen = () => $$(".modal-overlay.active").length > 0;

  /* ------------------------------------------------------------------ *
   *  Input
   * ------------------------------------------------------------------ */
  const KEYMAP = {
    ArrowLeft: "left", a: "left", A: "left",
    ArrowRight: "right", d: "right", D: "right",
    ArrowUp: "up", w: "up", W: "up",
    ArrowDown: "down", s: "down", S: "down",
  };

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      const open = $$(".modal-overlay.active");
      if (open.length) open.forEach((m) => m.classList.remove("active"));
      return;
    }
    if (!P || anyModalOpen()) return;

    if (e.key === " ") {
      // One key for the whole flight: launch, then the single mid-course burn.
      if (P.phase === "aim") launch();
      else if (P.phase === "flight") burn();
      e.preventDefault();
      return;
    }
    if (e.key === "r" || e.key === "R") {
      resetLevel();
      return;
    }
    const k = KEYMAP[e.key];
    if (!k) return;
    keys[k] = true;
    e.preventDefault();
  });

  window.addEventListener("keyup", (e) => {
    const k = KEYMAP[e.key];
    if (k) keys[k] = false;
  });

  // A held key would stay held forever if the window lost focus mid-press.
  window.addEventListener("blur", () => {
    Object.keys(keys).forEach((k) => { keys[k] = false; });
  });

  /** Start the current puzzle over, keeping the attempt count — a reset is
   *  for a shot you have not taken yet, not a way to wipe the record. */
  function resetLevel() {
    if (!P) return;
    const attempts = P.phase === "aim" ? P.attempts : P.attempts + 1;
    const level = P.level;
    P = newAttempt(level, attempts);
    Audio_.click();
    paintPlayHud();
  }

  /* Pointer aiming: the canvas is scaled by CSS, so client coordinates have
     to be mapped back into the fixed 900x620 space the game thinks in. */
  const canvasEl = $("#canvas");

  function toField(e) {
    const rect = canvasEl.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * W,
      y: ((e.clientY - rect.top) / rect.height) * H,
    };
  }

  function setAimFrom(p) {
    const s = P.level.start;
    const dx = p.x - s.x, dy = p.y - s.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 6) return;                 // too close to read a direction from
    P.aim.angle = Math.atan2(dy, dx);
    // 230px of drag is full power, so the gesture stays inside the field even
    // when the pad sits near an edge.
    P.aim.power = clamp(dist / 230, MIN_POWER, 1);
    paintPlayHud();
  }

  canvasEl.addEventListener("pointerdown", (e) => {
    if (!P || anyModalOpen()) return;
    if (P.phase === "flight") { burn(); return; }
    if (P.phase !== "aim") return;
    P.aim.dragging = true;
    setAimFrom(toField(e));
    canvasEl.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  canvasEl.addEventListener("pointermove", (e) => {
    if (!P || !P.aim.dragging) return;
    setAimFrom(toField(e));
  });

  ["pointerup", "pointercancel"].forEach((evt) =>
    canvasEl.addEventListener(evt, () => {
      if (!P || !P.aim.dragging) return;
      P.aim.dragging = false;
      launch();
    })
  );

  /* ------------------------------------------------------------------ *
   *  Nav wiring
   * ------------------------------------------------------------------ */
  $("#btn-start").addEventListener("click", () => { Audio_.click(); showScreen("screen-levels"); });
  $("#btn-howto").addEventListener("click", () => { Audio_.click(); openModal("modal-howto"); });
  $("#btn-settings").addEventListener("click", () => { Audio_.click(); openModal("modal-settings"); });
  $("#btn-quit").addEventListener("click", () => { Audio_.click(); openModal("modal-quit"); });
  $("#btn-retry").addEventListener("click", resetLevel);

  $$("[data-goto]").forEach((btn) =>
    btn.addEventListener("click", () => { Audio_.click(); showScreen(btn.dataset.goto); })
  );
  $$("[data-close-modal]").forEach((btn) =>
    btn.addEventListener("click", () => { Audio_.click(); closeModal(btn.dataset.closeModal); })
  );

  /* ------------------------------------------------------------------ *
   *  Audio settings
   *  Effects and music switch separately, and both preferences are stored
   *  by the audio engine so they carry across every game in the arcade.
   * ------------------------------------------------------------------ */
  const soundToggle = $("#toggle-sound");
  soundToggle.setAttribute("aria-pressed", Audio_.sfxEnabled() ? "true" : "false");
  soundToggle.addEventListener("click", () => {
    const next = soundToggle.getAttribute("aria-pressed") !== "true";
    soundToggle.setAttribute("aria-pressed", next ? "true" : "false");
    Audio_.setSfxEnabled(next);
    if (next) Audio_.click();
  });

  const musicToggle = $("#toggle-music");
  musicToggle.setAttribute("aria-pressed", Audio_.musicEnabled() ? "true" : "false");
  musicToggle.addEventListener("click", () => {
    const next = musicToggle.getAttribute("aria-pressed") !== "true";
    musicToggle.setAttribute("aria-pressed", next ? "true" : "false");
    Audio_.setMusicEnabled(next);
  });

  const musicVol = $("#music-volume");
  musicVol.value = Math.round(Audio_.musicVolume() * 100);
  musicVol.addEventListener("input", (e) => Audio_.setMusicVolume(e.target.value / 100));

  $("#btn-reset-progress").addEventListener("click", () => {
    Progress.reset();
    refreshLevelCards();
    Audio_.click();
  });

  /* ------------------------------------------------------------------ *
   *  Boot
   * ------------------------------------------------------------------ */
  buildLevelCards();
  refreshLevelCards();

  /* The engine cannot legally make a sound until the player clicks something,
     so this only registers the intent — the menu theme starts on their first
     interaction with the page. */
  Audio_.music("menu");
})();
