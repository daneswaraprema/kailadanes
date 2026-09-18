/* ==========================================================================
   Asteroid Run — game logic
   Plain vanilla JS on one canvas. No build step, no external libraries.

   The run is endless: waves keep arriving and get faster, and the score is
   whatever you banked before the last hull went. Everything the player earns
   comes from two decisions — what to shoot and what to dodge — so the whole
   file is really just those two systems plus the feedback around them.
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

  // Some browsers (private-mode Safari, locked-down iframes) throw on any
  // localStorage access rather than just returning null — guard every call
  // so the game still runs, it just won't remember the best score.
  const Store = {
    get: (key) => { try { return localStorage.getItem(key); } catch (e) { return null; } },
    set: (key, val) => { try { localStorage.setItem(key, val); } catch (e) { /* ignore */ } },
  };

  /* ------------------------------------------------------------------ *
   *  Audio
   *  The synthesiser lives in assets/audio.js and is shared with the rest
   *  of the arcade. This layer is the vocabulary Asteroid Run uses, plus a
   *  stub so a failed script load costs the sound and nothing else.
   * ------------------------------------------------------------------ */
  const Audio_ = (() => {
    const noop = () => {};
    const A = window.ArcadeAudio || {
      sfx: noop, music: noop, thruster: noop, setSfxEnabled: noop,
      setMusicEnabled: noop, setSfxVolume: noop, setMusicVolume: noop,
      sfxEnabled: () => false, musicEnabled: () => false,
      sfxVolume: () => 0, musicVolume: () => 0,
    };

    // A hail of rocks can produce a dozen impacts in the same frame. Letting
    // every one through turns the mix to mush, so the noisy effects claim a
    // short window and the rest of that frame stays quiet.
    const gates = {};
    function gated(name, gap) {
      const now = performance.now() / 1000;
      if (now < (gates[name] || 0)) return;
      gates[name] = now + gap;
      A.sfx(name);
    }

    return {
      click: () => A.sfx("click"),
      shoot: () => gated("shoot", 0.045),
      tap: () => gated("hit", 0.05),
      explode: () => gated("explode", 0.06),
      bigboom: () => A.sfx("bigboom"),
      pickup: () => A.sfx("pickup"),
      shield: () => A.sfx("shield"),
      wave: () => A.sfx("chime"),
      levelUp: () => A.sfx("extra"),
      warn: () => A.sfx("alarm"),
      over: () => A.sfx("fail"),
      throttle: (v) => A.thruster(v),
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
   *  Best score
   *  Kept locally so the number shows up instantly and survives an offline
   *  session. The leaderboard copy is the arcade layer's job (arcade.js).
   * ------------------------------------------------------------------ */
  const Best = (() => {
    const KEY = "ar_best";
    let value = Math.max(0, Number(Store.get(KEY)) || 0);
    return {
      get: () => value,
      submit(score) {
        if (score <= value) return false;
        value = score;
        Store.set(KEY, String(value));
        return true;
      },
      reset() { value = 0; Store.set(KEY, "0"); },
    };
  })();

  /* ------------------------------------------------------------------ *
   *  Tuning
   *  The canvas is a fixed 900x620 coordinate space that CSS scales to fit,
   *  so every number below is in those units and behaves the same on a
   *  phone as on a desktop.
   * ------------------------------------------------------------------ */
  const W = 900, H = 620;

  const SHIP = {
    r: 13,            // collision radius; the drawn hull is a little larger
    accel: 1750,      // px/s² — the ship has weight instead of teleporting
    drag: 7,
    maxSpeed: 400,
    fireGap: 0.2,
    rapidGap: 0.07,
    invuln: 2.0,      // seconds of blinking mercy after a hit
    margin: 22,
  };

  const BULLET = { speed: 680, r: 3.2, life: 1.3 };

  /* Tier 0 is the smallest rock. Small ones pay the most because they are
     the hardest to hit, and a big one pays out over its whole break-up
     chain rather than all at once. */
  const TIERS = [
    { r: 15, hp: 1, score: 100, splits: 0 },
    { r: 25, hp: 2, score: 50,  splits: 2 },
    { r: 39, hp: 3, score: 20,  splits: 2 },
  ];

  const WAVE_SECONDS = 20;
  const SURVIVAL_POINTS = 3;   // per second, multiplied by the combo
  const COMBO_KILLS = 8;       // kills per multiplier step
  const COMBO_MAX = 5;
  const DROP_CHANCE = 0.09;

  const DROPS = {
    shield: { label: "Shield", glyph: "S", color: "#5ad1ff", seconds: 0 },
    rapid:  { label: "Rapid",  glyph: "R", color: "#ffd447", seconds: 8 },
    bomb:   { label: "Pulse",  glyph: "P", color: "#ff7ae0", seconds: 0 },
  };
  const DROP_KINDS = Object.keys(DROPS);

  /* ------------------------------------------------------------------ *
   *  Run state
   *  G is the whole run. It is null whenever the game screen is not up,
   *  which is what every input handler checks before touching anything.
   * ------------------------------------------------------------------ */
  let G = null;
  let raf = null;
  let lastT = null;
  let ctx = null;

  const keys = { left: false, right: false, up: false, down: false, fire: false };

  const KEYMAP = {
    ArrowLeft: "left", a: "left", A: "left",
    ArrowRight: "right", d: "right", D: "right",
    ArrowUp: "up", w: "up", W: "up",
    ArrowDown: "down", s: "down", S: "down",
    " ": "fire",
  };

  function newRun() {
    return {
      ship: { x: W / 2, y: H - 90, vx: 0, vy: 0 },
      bullets: [], rocks: [], drops: [], bits: [],
      // Three depths of starfield. The far layer barely moves, which is what
      // makes the near one read as speed.
      stars: Array.from({ length: 110 }, () => ({
        x: Math.random() * W, y: Math.random() * H, z: rand(0.25, 1),
      })),
      score: 0, lives: 3, wave: 1, kills: 0,
      waveT: 0, spawnT: 0.8, fireT: 0,
      streak: 0, mult: 1,
      shield: false, rapidT: 0, invulnT: 1.2,
      time: 0, shake: 0,
      over: false, paused: false,
      pointer: { active: false, x: W / 2, y: H - 90 },
    };
  }

  /* ------------------------------------------------------------------ *
   *  Spawning
   * ------------------------------------------------------------------ */
  function spawnInterval() {
    // Rocks arrive faster every wave, but never so fast that there is no gap
    // left to fly through.
    return Math.max(0.3, 1.15 - G.wave * 0.06);
  }

  function makeRock(tier, x, y, vx, vy) {
    const t = TIERS[tier];
    return {
      tier, x, y, vx, vy,
      r: t.r * rand(0.88, 1.12),
      hp: t.hp,
      rot: rand(0, TAU),
      spin: rand(-1.6, 1.6),
      flash: 0,
      // A lumpy outline and a couple of craters, decided once at spawn so
      // the rock keeps its identity as it tumbles.
      shape: Array.from({ length: 9 }, () => rand(0.76, 1.16)),
      craters: Array.from({ length: 2 + ((Math.random() * 2) | 0) }, () => ({
        x: rand(-0.45, 0.45), y: rand(-0.45, 0.45), r: rand(0.08, 0.17),
      })),
    };
  }

  function spawnRock() {
    // Later waves bring bigger rocks; the first few are mostly gravel so the
    // player has a chance to learn the controls.
    const bigBias = clamp((G.wave - 1) * 0.06, 0, 0.45);
    const roll = Math.random();
    const tier = roll < 0.3 - bigBias * 0.3 ? 0 : roll < 0.75 - bigBias ? 1 : 2;
    const t = TIERS[tier];
    const x = rand(t.r + 10, W - t.r - 10);
    const speed = rand(58, 108) + G.wave * 7;
    G.rocks.push(makeRock(tier, x, -t.r - 12, rand(-26, 26), Math.min(speed, 320)));
  }

  function maybeDrop(x, y) {
    if (Math.random() > DROP_CHANCE) return;
    // A shield is the most useful thing to find, so it is the most common.
    const kind = Math.random() < 0.45 ? "shield" : Math.random() < 0.7 ? "rapid" : "bomb";
    G.drops.push({ kind, x, y, vx: rand(-20, 20), vy: rand(55, 85), r: 13, rot: 0, life: 14 });
  }

  function burst(x, y, count, color, spread) {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * TAU;
      const sp = rand(40, spread);
      G.bits.push({
        x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        r: rand(1.4, 3.6), life: rand(0.3, 0.8), maxLife: 0.8, color,
      });
    }
  }

  /* ------------------------------------------------------------------ *
   *  Scoring and combo
   * ------------------------------------------------------------------ */
  function addKill(points) {
    G.kills++;
    G.score += points * G.mult;
    G.streak++;
    const next = Math.min(COMBO_MAX, 1 + Math.floor(G.streak / COMBO_KILLS));
    if (next > G.mult) {
      G.mult = next;
      flash("Combo ×" + G.mult, "good");
      Audio_.levelUp();
    }
  }

  function breakCombo() {
    G.streak = 0;
    G.mult = 1;
  }

  /* ------------------------------------------------------------------ *
   *  Rock destruction
   *  `scored` is false when a rock is removed by ramming it, so a collision
   *  never pays the player for the hull they just lost.
   * ------------------------------------------------------------------ */
  function destroyRock(rock, scored) {
    const t = TIERS[rock.tier];
    if (scored) addKill(t.score);

    for (let i = 0; i < t.splits; i++) {
      const a = rand(0, TAU);
      const sp = rand(40, 90);
      G.rocks.push(makeRock(
        rock.tier - 1,
        rock.x + Math.cos(a) * rock.r * 0.4,
        rock.y + Math.sin(a) * rock.r * 0.4,
        rock.vx + Math.cos(a) * sp,
        Math.max(40, rock.vy + rand(-20, 40))
      ));
    }

    burst(rock.x, rock.y, rock.tier === 2 ? 20 : rock.tier === 1 ? 14 : 9, "#c9a887", 220);
    if (rock.tier === 0) Audio_.tap(); else Audio_.explode();
    if (scored) maybeDrop(rock.x, rock.y);

    const i = G.rocks.indexOf(rock);
    if (i >= 0) G.rocks.splice(i, 1);
  }

  function collect(drop) {
    const def = DROPS[drop.kind];
    if (drop.kind === "shield") {
      G.shield = true;
      Audio_.shield();
      flash("Shield Up", "good");
    } else if (drop.kind === "rapid") {
      G.rapidT = def.seconds;
      Audio_.pickup();
      flash("Rapid Fire", "good");
    } else {
      // The pulse clears the field and pays for every rock on it, which makes
      // it worth saving for a moment when the screen is crowded.
      const doomed = G.rocks.slice();
      doomed.forEach((r) => destroyRock(r, true));
      G.shake = Math.max(G.shake, 0.55);
      Audio_.bigboom();
      flash("Pulse!", "good");
    }
    const i = G.drops.indexOf(drop);
    if (i >= 0) G.drops.splice(i, 1);
  }

  function hullHit(rock) {
    if (G.invulnT > 0) return;

    if (G.shield) {
      G.shield = false;
      G.invulnT = 0.9;
      G.shake = Math.max(G.shake, 0.3);
      destroyRock(rock, false);
      Audio_.shield();
      flash("Shield Down", "warn");
      return;
    }

    G.lives--;
    breakCombo();
    G.invulnT = SHIP.invuln;
    G.shake = Math.max(G.shake, 0.6);
    destroyRock(rock, false);
    burst(G.ship.x, G.ship.y, 26, "#ff9a5d", 300);
    Audio_.bigboom();

    if (G.lives <= 0) gameOver();
    else {
      Audio_.warn();
      flash("Hull Breach", "warn");
    }
  }

  /* ------------------------------------------------------------------ *
   *  Simulation
   * ------------------------------------------------------------------ */
  function step(dt) {
    G.time += dt;
    if (G.shake > 0) G.shake = Math.max(0, G.shake - dt * 1.6);
    if (G.invulnT > 0) G.invulnT -= dt;
    if (G.rapidT > 0) G.rapidT = Math.max(0, G.rapidT - dt);

    // Staying alive pays, and it pays more while a combo is up: the two
    // scoring routes reward the same careful flying.
    G.score += SURVIVAL_POINTS * G.mult * dt;

    /* ---- waves ---- */
    G.waveT += dt;
    if (G.waveT >= WAVE_SECONDS) {
      G.waveT -= WAVE_SECONDS;
      G.wave++;
      flash("Wave " + G.wave);
      Audio_.wave();
    }

    /* ---- ship ---- */
    const s = G.ship;
    if (G.pointer.active) {
      // Steer toward the finger with a spring rather than snapping to it, so
      // touch flying has the same momentum as keyboard flying.
      s.vx += clamp((G.pointer.x - s.x) * 10, -SHIP.accel, SHIP.accel) * dt;
      s.vy += clamp((G.pointer.y - s.y) * 10, -SHIP.accel, SHIP.accel) * dt;
    } else {
      if (keys.left) s.vx -= SHIP.accel * dt;
      if (keys.right) s.vx += SHIP.accel * dt;
      if (keys.up) s.vy -= SHIP.accel * dt;
      if (keys.down) s.vy += SHIP.accel * dt;
    }
    s.vx -= s.vx * SHIP.drag * dt;
    s.vy -= s.vy * SHIP.drag * dt;

    const speed = Math.hypot(s.vx, s.vy);
    if (speed > SHIP.maxSpeed) {
      s.vx = (s.vx / speed) * SHIP.maxSpeed;
      s.vy = (s.vy / speed) * SHIP.maxSpeed;
    }
    s.x = clamp(s.x + s.vx * dt, SHIP.margin, W - SHIP.margin);
    s.y = clamp(s.y + s.vy * dt, SHIP.margin + 34, H - SHIP.margin);

    Audio_.throttle((speed / SHIP.maxSpeed) * 0.4);

    // Engine trail, thickest when the ship is really moving.
    if (speed > 40 && Math.random() < 0.7) {
      G.bits.push({
        x: s.x + rand(-3, 3), y: s.y + 14, vx: rand(-20, 20), vy: rand(60, 130),
        r: rand(1.2, 2.6), life: 0.26, maxLife: 0.26, color: "#ffc47a",
      });
    }

    /* ---- firing ---- */
    G.fireT -= dt;
    if ((keys.fire || G.pointer.active) && G.fireT <= 0) {
      G.fireT = G.rapidT > 0 ? SHIP.rapidGap : SHIP.fireGap;
      G.bullets.push({ x: s.x, y: s.y - 20, vy: -BULLET.speed, life: BULLET.life });
      // Rapid fire spreads a second barrel, so the power-up changes the
      // shape of your cone and not only its tempo.
      if (G.rapidT > 0) {
        G.bullets.push({ x: s.x - 9, y: s.y - 12, vy: -BULLET.speed, life: BULLET.life });
        G.bullets.push({ x: s.x + 9, y: s.y - 12, vy: -BULLET.speed, life: BULLET.life });
      }
      Audio_.shoot();
    }

    /* ---- spawning ---- */
    G.spawnT -= dt;
    if (G.spawnT <= 0) {
      G.spawnT = spawnInterval() * rand(0.75, 1.25);
      spawnRock();
    }

    /* ---- bullets ---- */
    for (let i = G.bullets.length - 1; i >= 0; i--) {
      const b = G.bullets[i];
      b.y += b.vy * dt;
      b.life -= dt;
      if (b.life <= 0 || b.y < -20) G.bullets.splice(i, 1);
    }

    /* ---- rocks ---- */
    for (let i = G.rocks.length - 1; i >= 0; i--) {
      const r = G.rocks[i];
      r.x += r.vx * dt;
      r.y += r.vy * dt;
      r.rot += r.spin * dt;
      if (r.flash > 0) r.flash -= dt;

      // Bounce off the side walls so a drifting rock stays in play instead of
      // sliding out of the field and wasting the spawn.
      if (r.x < r.r) { r.x = r.r; r.vx = Math.abs(r.vx); }
      if (r.x > W - r.r) { r.x = W - r.r; r.vx = -Math.abs(r.vx); }

      if (r.y - r.r > H + 10) { G.rocks.splice(i, 1); continue; }

      // Rock vs bullet
      let killed = false;
      for (let j = G.bullets.length - 1; j >= 0; j--) {
        const b = G.bullets[j];
        if (Math.hypot(b.x - r.x, b.y - r.y) > r.r + BULLET.r) continue;
        G.bullets.splice(j, 1);
        r.hp--;
        r.flash = 0.07;
        burst(b.x, b.y, 4, "#ffd9a8", 120);
        if (r.hp <= 0) { destroyRock(r, true); killed = true; }
        else Audio_.tap();
        break;
      }
      if (killed) continue;

      // Rock vs ship
      if (Math.hypot(G.ship.x - r.x, G.ship.y - r.y) < r.r + SHIP.r) hullHit(r);
      if (G.over) return;
    }

    /* ---- power-ups ---- */
    for (let i = G.drops.length - 1; i >= 0; i--) {
      const d = G.drops[i];
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      d.rot += dt * 2.2;
      d.life -= dt;
      if (d.life <= 0 || d.y - d.r > H + 10) { G.drops.splice(i, 1); continue; }
      if (Math.hypot(G.ship.x - d.x, G.ship.y - d.y) < d.r + SHIP.r + 4) collect(d);
    }

    /* ---- particles and stars ---- */
    for (let i = G.bits.length - 1; i >= 0; i--) {
      const p = G.bits[i];
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx -= p.vx * 2.2 * dt;
      p.vy -= p.vy * 2.2 * dt;
      p.life -= dt;
      if (p.life <= 0) G.bits.splice(i, 1);
    }

    G.stars.forEach((st) => {
      st.y += (24 + st.z * 96) * dt;
      if (st.y > H) { st.y = -2; st.x = Math.random() * W; }
    });
  }

  /* ------------------------------------------------------------------ *
   *  Rendering
   * ------------------------------------------------------------------ */
  let rockFills = null;   // one cached gradient per tier, in local coordinates

  function buildRockFills() {
    rockFills = TIERS.map((t) => {
      const g = ctx.createRadialGradient(-t.r * 0.32, -t.r * 0.36, t.r * 0.12, 0, 0, t.r * 1.15);
      g.addColorStop(0, "#a89279");
      g.addColorStop(0.55, "#6b5a4d");
      g.addColorStop(1, "#332a23");
      return g;
    });
  }

  function draw() {
    ctx.save();

    // Screen shake: a couple of pixels is plenty to sell an impact, and more
    // than that makes the field hard to read at the moment it matters most.
    if (G.shake > 0) {
      ctx.translate(rand(-1, 1) * G.shake * 7, rand(-1, 1) * G.shake * 7);
    }

    ctx.fillStyle = "#07060c";
    ctx.fillRect(-12, -12, W + 24, H + 24);

    /* ---- starfield ---- */
    G.stars.forEach((st) => {
      ctx.globalAlpha = 0.25 + st.z * 0.65;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(st.x, st.y, st.z * 1.9, st.z * 1.9);
    });
    ctx.globalAlpha = 1;

    /* ---- particles (behind everything solid) ---- */
    G.bits.forEach((p) => {
      ctx.globalAlpha = clamp(p.life / p.maxLife, 0, 1);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, TAU);
      ctx.fill();
    });
    ctx.globalAlpha = 1;

    /* ---- rocks ---- */
    if (!rockFills) buildRockFills();
    G.rocks.forEach((r) => {
      ctx.save();
      ctx.translate(r.x, r.y);
      ctx.rotate(r.rot);
      const scale = r.r / TIERS[r.tier].r;
      ctx.scale(scale, scale);

      ctx.beginPath();
      const n = r.shape.length;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * TAU;
        const rad = TIERS[r.tier].r * r.shape[i];
        const x = Math.cos(a) * rad, y = Math.sin(a) * rad;
        if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      }
      ctx.closePath();
      ctx.fillStyle = r.flash > 0 ? "#ffe7c4" : rockFills[r.tier];
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = "rgba(0,0,0,.45)";
      ctx.stroke();

      ctx.fillStyle = "rgba(0,0,0,.26)";
      r.craters.forEach((c) => {
        ctx.beginPath();
        ctx.arc(c.x * TIERS[r.tier].r, c.y * TIERS[r.tier].r, c.r * TIERS[r.tier].r, 0, TAU);
        ctx.fill();
      });
      ctx.restore();
    });

    /* ---- power-ups ---- */
    G.drops.forEach((d) => {
      const def = DROPS[d.kind];
      ctx.save();
      ctx.translate(d.x, d.y);
      // Fade out over the last two seconds so a drop never just vanishes.
      ctx.globalAlpha = d.life < 2 ? clamp(d.life / 2, 0.15, 1) : 1;
      ctx.rotate(d.rot);
      ctx.beginPath();
      ctx.moveTo(0, -d.r); ctx.lineTo(d.r, 0); ctx.lineTo(0, d.r); ctx.lineTo(-d.r, 0);
      ctx.closePath();
      ctx.fillStyle = "rgba(8,6,14,.9)";
      ctx.fill();
      ctx.lineWidth = 2.4;
      ctx.strokeStyle = def.color;
      ctx.stroke();
      ctx.rotate(-d.rot);
      ctx.fillStyle = def.color;
      ctx.font = "700 14px Rajdhani, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(def.glyph, 0, 1);
      ctx.restore();
    });
    ctx.globalAlpha = 1;

    /* ---- bullets ---- */
    ctx.fillStyle = "#ffe0ac";
    ctx.shadowColor = "#ffb347";
    ctx.shadowBlur = 10;
    G.bullets.forEach((b) => {
      ctx.beginPath();
      ctx.ellipse(b.x, b.y, BULLET.r, BULLET.r * 2.6, 0, 0, TAU);
      ctx.fill();
    });
    ctx.shadowBlur = 0;

    drawShip();
    ctx.restore();
  }

  function drawShip() {
    const s = G.ship;
    // Blink through the mercy window so the player can see they are safe.
    const hidden = G.invulnT > 0 && Math.floor(G.time * 14) % 2 === 0;

    ctx.save();
    ctx.translate(s.x, s.y);
    // Bank into the direction of travel: cheap, and it sells the movement.
    ctx.rotate(clamp(s.vx / 1100, -0.32, 0.32));
    if (hidden) ctx.globalAlpha = 0.3;

    /* Exhaust */
    const thrust = clamp(Math.hypot(s.vx, s.vy) / SHIP.maxSpeed, 0, 1);
    if (thrust > 0.06) {
      const len = 10 + thrust * 20 + Math.sin(G.time * 40) * 2;
      ctx.beginPath();
      ctx.moveTo(-5, 10);
      ctx.lineTo(0, 10 + len);
      ctx.lineTo(5, 10);
      ctx.closePath();
      ctx.fillStyle = "rgba(255,196,112,.85)";
      ctx.fill();
    }

    /* Hull */
    ctx.beginPath();
    ctx.moveTo(0, -21);
    ctx.lineTo(13, 11);
    ctx.lineTo(5, 7);
    ctx.lineTo(0, 13);
    ctx.lineTo(-5, 7);
    ctx.lineTo(-13, 11);
    ctx.closePath();
    const hull = ctx.createLinearGradient(-13, 0, 13, 0);
    hull.addColorStop(0, "#8e99a6");
    hull.addColorStop(0.45, "#e6ecf2");
    hull.addColorStop(1, "#7d8896");
    ctx.fillStyle = hull;
    ctx.fill();
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = "#ffb347";
    ctx.stroke();

    /* Cockpit */
    ctx.beginPath();
    ctx.arc(0, -6, 4, 0, TAU);
    ctx.fillStyle = "#5ad1ff";
    ctx.fill();

    ctx.restore();

    /* Shield bubble sits outside the blink so you can always see it. */
    if (G.shield) {
      ctx.beginPath();
      ctx.arc(s.x, s.y, SHIP.r + 11 + Math.sin(G.time * 6) * 1.5, 0, TAU);
      ctx.lineWidth = 2;
      ctx.strokeStyle = "rgba(90,209,255,.75)";
      ctx.stroke();
      ctx.globalAlpha = 0.12;
      ctx.fillStyle = "#5ad1ff";
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }

  /* ------------------------------------------------------------------ *
   *  HUD
   *  Text nodes are cheap to touch every frame; rebuilding the boost strip
   *  is not, so that only happens when its contents actually change.
   * ------------------------------------------------------------------ */
  let boostSig = "";

  function paintHud() {
    $("#hud-score").textContent = Math.floor(G.score).toLocaleString();
    $("#hud-wave").textContent = G.wave;
    $("#hud-mult").textContent = "×" + G.mult;
    $("#hud-mult").parentElement.classList.toggle("is-hot", G.mult >= COMBO_MAX);
    $("#hud-lives").textContent = "▲".repeat(Math.max(0, G.lives));
    $("#hud-best").textContent = Math.max(Best.get(), Math.floor(G.score)).toLocaleString();

    const sig = `${G.shield ? 1 : 0}|${Math.ceil(G.rapidT)}`;
    if (sig === boostSig) return;
    boostSig = sig;

    const parts = [];
    if (G.shield) {
      parts.push(`<span class="boost boost--shield">Shield</span>`);
    }
    if (G.rapidT > 0) {
      const pct = (G.rapidT / DROPS.rapid.seconds) * 100;
      parts.push(
        `<span class="boost boost--rapid">Rapid` +
        `<span class="boost__bar"><span class="boost__fill" style="width:${pct.toFixed(0)}%"></span></span></span>`
      );
    }
    $("#boosts").innerHTML = parts.join("");
  }

  /** Big centred callout. Several can overlap; each removes itself when its
   *  animation finishes, so nothing accumulates over a long run. */
  function flash(text, kind = "") {
    const host = $("#flash");
    const el = document.createElement("div");
    el.className = "flash__text" + (kind ? " flash__text--" + kind : "");
    el.textContent = text;
    host.appendChild(el);
    setTimeout(() => el.remove(), 1300);
  }

  /* ------------------------------------------------------------------ *
   *  Loop
   * ------------------------------------------------------------------ */
  function frame(t) {
    if (!G) return;
    raf = requestAnimationFrame(frame);
    if (G.paused || G.over) { lastT = null; return; }

    if (lastT === null) lastT = t;
    // Cap the step: a backgrounded tab returns with a huge delta, and without
    // this the ship would teleport through whatever arrived while away.
    const dt = Math.min((t - lastT) / 1000, 0.05);
    lastT = t;

    step(dt);
    if (!G || G.over) return;
    draw();
    paintHud();
  }

  function startRun() {
    stopRun();
    const canvas = $("#canvas");
    ctx = canvas.getContext("2d");
    rockFills = null;         // rebuilt against this context on first draw
    boostSig = "";
    $("#boosts").innerHTML = "";
    $("#flash").innerHTML = "";
    G = newRun();
    lastT = null;
    setPaused(false);
    paintHud();
    raf = requestAnimationFrame(frame);
  }

  function stopRun() {
    if (raf) cancelAnimationFrame(raf);
    raf = null;
    lastT = null;
    G = null;
    Audio_.throttle(0);
    $("#pause-veil").classList.remove("is-open");
  }

  function setPaused(on) {
    if (!G || G.over) return;
    G.paused = !!on;
    lastT = null;
    $("#pause-veil").classList.toggle("is-open", G.paused);
    if (G.paused) Audio_.throttle(0);
  }

  /* ------------------------------------------------------------------ *
   *  End of run
   * ------------------------------------------------------------------ */
  function gameOver() {
    G.over = true;
    Audio_.throttle(0);
    Audio_.over();

    const score = Math.round(G.score);
    const record = Best.submit(score);
    const stats = { score, wave: G.wave, kills: G.kills, record };

    setTimeout(() => showResult(stats), 700);
  }

  function showResult({ score, wave, kills, record }) {
    const modal = $("#modal-result .modal--result");
    modal.classList.toggle("is-record", record);
    $("#result-badge").textContent = record ? "★" : "✖";
    $("#result-title").textContent = record ? "New Personal Best!" : "Run Over";
    $("#result-body").textContent = record
      ? `Wave ${wave}, ${kills} rock${kills === 1 ? "" : "s"} broken. Nothing you have flown before comes close.`
      : `You made it to wave ${wave} and broke ${kills} rock${kills === 1 ? "" : "s"}.`;

    $("#result-score").innerHTML =
      `<span class="result-score__num">${score.toLocaleString()}</span>` +
      `<span class="result-score__label">${record ? "New best score" : "Final score"}</span>` +
      `<span class="result-score__line">Best: <b>${Best.get().toLocaleString()}</b> · ` +
      `Wave <b>${wave}</b> · Rocks <b>${kills}</b></span>`;

    const actions = $("#result-actions");
    actions.innerHTML = "";

    const again = document.createElement("button");
    again.className = "menu-btn menu-btn--small";
    again.textContent = "Fly Again";
    again.onclick = () => { closeModal("modal-result"); Audio_.click(); startRun(); };
    actions.appendChild(again);

    const menu = document.createElement("button");
    menu.className = "menu-btn menu-btn--small menu-btn--ghost";
    menu.textContent = "Main Menu";
    menu.onclick = () => { closeModal("modal-result"); Audio_.click(); showScreen("screen-start"); };
    actions.appendChild(menu);

    $("#result-sync").innerHTML = "";
    $("#result-sync").hidden = true;
    openModal("modal-result");

    // Hand the run to the arcade layer (arcade.js), which decides whether it
    // goes to the leaderboard or stays in this browser. The game itself stays
    // completely unaware of accounts and networking.
    document.dispatchEvent(new CustomEvent("asteroid-run:run-complete", {
      detail: { score, wave, kills },
    }));
  }

  /* ------------------------------------------------------------------ *
   *  Screens and modals
   * ------------------------------------------------------------------ */
  function showScreen(id) {
    $$(".screen").forEach((s) => s.classList.toggle("active", s.id === id));
    if (id === "screen-game") {
      startRun();
    } else {
      stopRun();
      if (id === "screen-start") $("#start-best").textContent = Best.get().toLocaleString();
    }
    Audio_.music(id === "screen-game" ? "chase" : "menu");
  }

  const openModal = (id) => $("#" + id).classList.add("active");
  const closeModal = (id) => $("#" + id).classList.remove("active");
  const anyModalOpen = () => $$(".modal-overlay.active").length > 0;

  /* ------------------------------------------------------------------ *
   *  Input
   * ------------------------------------------------------------------ */
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      const open = $$(".modal-overlay.active");
      // Escape backs out of whatever is on top: a modal first, then the run.
      if (open.length) { open.forEach((m) => m.classList.remove("active")); return; }
      if (G && !G.over) setPaused(!G.paused);
      return;
    }
    if ((e.key === "p" || e.key === "P") && G && !G.over && !anyModalOpen()) {
      setPaused(!G.paused);
      return;
    }
    const k = KEYMAP[e.key];
    if (!k) return;
    keys[k] = true;
    // Space and the arrows scroll the page unless we say otherwise, and the
    // field is the whole screen here.
    if (G) e.preventDefault();
  });

  window.addEventListener("keyup", (e) => {
    const k = KEYMAP[e.key];
    if (k) keys[k] = false;
  });

  // A held key would stay held forever if the window lost focus mid-press.
  window.addEventListener("blur", () => {
    Object.keys(keys).forEach((k) => { keys[k] = false; });
    if (G && !G.over) setPaused(true);
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden && G && !G.over) setPaused(true);
  });

  /* Pointer flying: the canvas is scaled by CSS, so client coordinates have
     to be mapped back into the fixed 900x620 space the game thinks in. */
  const canvasEl = $("#canvas");

  function toField(e) {
    const rect = canvasEl.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * W,
      y: ((e.clientY - rect.top) / rect.height) * H,
    };
  }

  canvasEl.addEventListener("pointerdown", (e) => {
    if (!G || G.over) return;
    if (G.paused) { setPaused(false); return; }
    const p = toField(e);
    G.pointer.active = true;
    G.pointer.x = p.x;
    G.pointer.y = p.y;
    canvasEl.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  canvasEl.addEventListener("pointermove", (e) => {
    if (!G || !G.pointer.active) return;
    const p = toField(e);
    G.pointer.x = p.x;
    G.pointer.y = p.y;
  });

  ["pointerup", "pointercancel", "pointerleave"].forEach((evt) =>
    canvasEl.addEventListener(evt, () => {
      if (G) G.pointer.active = false;
    })
  );

  /* ------------------------------------------------------------------ *
   *  Nav wiring
   * ------------------------------------------------------------------ */
  $("#btn-start").addEventListener("click", () => { Audio_.click(); showScreen("screen-game"); });
  $("#btn-howto").addEventListener("click", () => { Audio_.click(); openModal("modal-howto"); });
  $("#btn-settings").addEventListener("click", () => { Audio_.click(); openModal("modal-settings"); });
  $("#btn-quit").addEventListener("click", () => { Audio_.click(); openModal("modal-quit"); });
  $("#btn-pause").addEventListener("click", () => { Audio_.click(); setPaused(true); });
  $("#btn-resume").addEventListener("click", () => { Audio_.click(); setPaused(false); });

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

  $("#btn-reset-best").addEventListener("click", () => {
    Best.reset();
    $("#start-best").textContent = "0";
    Audio_.click();
  });

  /* ------------------------------------------------------------------ *
   *  Boot
   * ------------------------------------------------------------------ */
  $("#start-best").textContent = Best.get().toLocaleString();

  /* The engine cannot legally make a sound until the player clicks something,
     so this only registers the intent — the menu theme starts on their first
     interaction with the page. */
  Audio_.music("menu");
})();
