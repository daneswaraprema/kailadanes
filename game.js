/* ==========================================================================
   Danes Rocket — game logic
   Plain vanilla JS. No build step, no external libraries.
   ========================================================================== */
(() => {
  "use strict";

  /* ------------------------------------------------------------------ *
   *  Small helpers
   * ------------------------------------------------------------------ */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const fmt1 = (n) => n.toFixed(1);

  // Some browsers (private-mode Safari, locked-down iframes) throw on any
  // localStorage access rather than just returning null — guard every call
  // so the game still runs, it just won't remember progress between visits.
  const Store = {
    get: (key) => { try { return localStorage.getItem(key); } catch (e) { return null; } },
    set: (key, val) => { try { localStorage.setItem(key, val); } catch (e) { /* ignore */ } },
  };

  /* ------------------------------------------------------------------ *
   *  Audio — tiny WebAudio beeps, no asset files needed
   * ------------------------------------------------------------------ */
  const Audio_ = (() => {
    let ctx = null;
    let enabled = Store.get("dr_sound") !== "off";

    function ensureCtx() {
      if (!ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) ctx = new AC();
      }
      if (ctx && ctx.state === "suspended") ctx.resume();
      return ctx;
    }

    function tone(freq, dur, type = "sine", gain = 0.08, delay = 0) {
      if (!enabled) return;
      const c = ensureCtx();
      if (!c) return;
      const osc = c.createOscillator();
      const g = c.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      g.gain.value = gain;
      osc.connect(g);
      g.connect(c.destination);
      const t0 = c.currentTime + delay;
      g.gain.setValueAtTime(gain, t0);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.start(t0);
      osc.stop(t0 + dur + 0.02);
    }

    return {
      click: () => tone(520, 0.06, "square", 0.05),
      place: () => tone(660, 0.09, "triangle", 0.07),
      error: () => tone(140, 0.22, "sawtooth", 0.07),
      success: () => { tone(523, 0.14, "triangle", 0.09, 0); tone(659, 0.14, "triangle", 0.09, 0.12); tone(784, 0.22, "triangle", 0.09, 0.24); },
      fail: () => { tone(220, 0.3, "sawtooth", 0.08, 0); tone(160, 0.4, "sawtooth", 0.08, 0.18); },
      isEnabled: () => enabled,
      setEnabled: (v) => { enabled = v; Store.set("dr_sound", v ? "on" : "off"); },
    };
  })();

  /* ------------------------------------------------------------------ *
   *  Progress persistence
   * ------------------------------------------------------------------ */
  const Progress = (() => {
    const KEY = "dr_progress";
    let data = { m1: false, m2: false, m3: false };
    try {
      const saved = JSON.parse(Store.get(KEY));
      if (saved) data = Object.assign(data, saved);
    } catch (e) { /* ignore malformed storage */ }

    function save() { Store.set(KEY, JSON.stringify(data)); }
    return {
      isComplete: (n) => !!data["m" + n],
      isUnlocked: (n) => n === 1 || !!data["m" + (n - 1)],
      complete: (n) => { data["m" + n] = true; save(); },
      reset: () => { data = { m1: false, m2: false, m3: false }; save(); },
    };
  })();

  /* ------------------------------------------------------------------ *
   *  Screen navigation
   * ------------------------------------------------------------------ */
  let activeMission = 0; // 0 = none, used to route keyboard input

  function showScreen(id) {
    $$(".screen").forEach((s) => s.classList.toggle("active", s.id === id));
    stopMission2();
    stopMission3();
    if (id === "screen-mission1") initMission1();
    if (id === "screen-mission2") initMission2();
    if (id === "screen-mission3") initMission3();
    if (id === "screen-missions") refreshMissionCards();
  }

  function openModal(id) { $("#" + id).classList.add("active"); }
  function closeModal(id) { $("#" + id).classList.remove("active"); }

  /* ------------------------------------------------------------------ *
   *  Mission select cards
   * ------------------------------------------------------------------ */
  function refreshMissionCards() {
    [1, 2, 3].forEach((n) => {
      const card = $("#card-m" + n);
      const unlocked = Progress.isUnlocked(n);
      const complete = Progress.isComplete(n);
      card.classList.toggle("is-locked", !unlocked);
      card.classList.toggle("is-complete", complete);
    });
  }

  $$(".mission-card").forEach((card) => {
    card.addEventListener("click", () => {
      const n = Number(card.dataset.mission);
      if (!Progress.isUnlocked(n)) { Audio_.error(); return; }
      Audio_.click();
      showScreen("screen-mission" + n);
    });
  });

  /* ------------------------------------------------------------------ *
   *  Generic result modal
   * ------------------------------------------------------------------ */
  function showResult({ success, title, body, missionNum, nextUnlocksMission }) {
    const modal = $("#modal-result .modal--result");
    modal.classList.toggle("is-fail", !success);
    $("#result-badge").textContent = success ? "\u2605" : "\u2716";
    $("#result-title").textContent = title;
    $("#result-body").textContent = body;

    const actions = $("#result-actions");
    actions.innerHTML = "";

    if (success && nextUnlocksMission) {
      const nextBtn = document.createElement("button");
      nextBtn.className = "menu-btn menu-btn--small";
      nextBtn.textContent = "Next Mission";
      nextBtn.onclick = () => { closeModal("modal-result"); Audio_.click(); showScreen("screen-mission" + nextUnlocksMission); };
      actions.appendChild(nextBtn);
    } else if (!success) {
      const retryBtn = document.createElement("button");
      retryBtn.className = "menu-btn menu-btn--small";
      retryBtn.textContent = "Retry";
      retryBtn.onclick = () => { closeModal("modal-result"); Audio_.click(); showScreen("screen-mission" + missionNum); };
      actions.appendChild(retryBtn);
    }
    const selectBtn = document.createElement("button");
    selectBtn.className = "menu-btn menu-btn--small menu-btn--ghost";
    selectBtn.textContent = "Mission Select";
    selectBtn.onclick = () => { closeModal("modal-result"); Audio_.click(); showScreen("screen-missions"); };
    actions.appendChild(selectBtn);

    if (success) { Progress.complete(missionNum); Audio_.success(); }
    else Audio_.fail();

    openModal("modal-result");
  }

  /* ==================================================================== *
   *  MISSION 1 — Assembly Bay
   * ==================================================================== */
  const SLOT_LABELS = ["Nose Cone", "Capsule", "Upper Tank", "Lower Tank", "Engine"];

  function svgNose(color = "#d8dde2", stroke = "#6d747c") {
    return `<svg viewBox="0 0 100 56"><path d="M20 46 C20 20 50 8 50 8 C50 8 80 20 80 46 Z" fill="${color}" stroke="${stroke}" stroke-width="2"/></svg>`;
  }
  function svgCapsule(color = "#e2c46b", stroke = "#8a6c26") {
    return `<svg viewBox="0 0 100 56"><path d="M25 48 C22 24 30 10 50 10 C70 10 78 24 75 48 Z" fill="${color}" stroke="${stroke}" stroke-width="2"/><circle cx="50" cy="28" r="8" fill="#3fb8e8" stroke="#1a4c66" stroke-width="1.5"/></svg>`;
  }
  function svgTank(color = "#c7ccd1", stroke = "#6d747c") {
    return `<svg viewBox="0 0 100 56"><rect x="24" y="8" width="52" height="40" rx="6" fill="${color}" stroke="${stroke}" stroke-width="2"/><line x1="24" y1="20" x2="76" y2="20" stroke="${stroke}" stroke-width="1.5"/><line x1="24" y1="36" x2="76" y2="36" stroke="${stroke}" stroke-width="1.5"/></svg>`;
  }
  function svgEngine(color = "#a7adb4", stroke = "#4a5057") {
    return `<svg viewBox="0 0 100 56"><path d="M30 8 L70 8 L80 44 L20 44 Z" fill="${color}" stroke="${stroke}" stroke-width="2"/><path d="M28 44 L18 52 L36 48 Z" fill="#3a6ea8" stroke="#1c3a5c" stroke-width="1"/><path d="M72 44 L82 52 L64 48 Z" fill="#3a6ea8" stroke="#1c3a5c" stroke-width="1"/></svg>`;
  }
  function svgTankCracked() {
    return `<svg viewBox="0 0 100 56"><rect x="24" y="8" width="52" height="40" rx="6" fill="#c7ccd1" stroke="#6d747c" stroke-width="2"/><path d="M40 8 L50 26 L42 30 L58 48" fill="none" stroke="#ff5d5d" stroke-width="2.5"/></svg>`;
  }
  function svgEngineRusty() {
    return `<svg viewBox="0 0 100 56"><path d="M30 8 L70 8 L80 44 L20 44 Z" fill="#a06a3f" stroke="#5c3a1f" stroke-width="2"/><path d="M28 44 L18 52 L36 48 Z" fill="#7a4a2c" stroke="#3c2412" stroke-width="1"/><path d="M72 44 L82 52 L64 48 Z" fill="#7a4a2c" stroke="#3c2412" stroke-width="1"/></svg>`;
  }
  function svgAntenna() {
    return `<svg viewBox="0 0 100 56"><line x1="50" y1="48" x2="50" y2="12" stroke="#8894a0" stroke-width="3"/><circle cx="50" cy="10" r="5" fill="#e8b64f" stroke="#9c6e26" stroke-width="1.5"/></svg>`;
  }

  const MISSION1_PARTS = [
    { id: "nose", slot: 0, svg: svgNose() },
    { id: "capsule", slot: 1, svg: svgCapsule() },
    { id: "tankA", slot: 2, svg: svgTank() },
    { id: "tankB", slot: 3, svg: svgTank() },
    { id: "engine", slot: 4, svg: svgEngine() },
    { id: "tankCracked", slot: -1, svg: svgTankCracked() },
    { id: "engineRusty", slot: -1, svg: svgEngineRusty() },
    { id: "antenna", slot: -1, svg: svgAntenna() },
  ];

  let m1Mistakes = 0;
  let m1Placed = 0;
  let m1DragEl = null;
  let m1DragPart = null;

  function initMission1() {
    m1Mistakes = 0;
    m1Placed = 0;
    $("#m1-mistakes").textContent = "Mistakes: 0";

    const gantry = $("#gantry");
    gantry.innerHTML = "";
    SLOT_LABELS.forEach((label, i) => {
      const slot = document.createElement("div");
      slot.className = "slot";
      slot.dataset.slot = i;
      slot.textContent = label;
      gantry.appendChild(slot);
    });

    const rack = $("#parts-rack");
    rack.innerHTML = "";
    const shuffled = [...MISSION1_PARTS].sort(() => Math.random() - 0.5);
    shuffled.forEach((p) => {
      const el = document.createElement("div");
      el.className = "part";
      el.dataset.id = p.id;
      el.innerHTML = p.svg;
      el.addEventListener("pointerdown", (ev) => onPartPointerDown(ev, el, p));
      rack.appendChild(el);
    });
  }

  function onPartPointerDown(ev, el, part) {
    if (el.classList.contains("placed")) return;
    ev.preventDefault();
    m1DragEl = el;
    m1DragPart = part;
    el.classList.add("dragging");

    const ghost = el.cloneNode(true);
    ghost.classList.remove("dragging");
    ghost.style.position = "fixed";
    ghost.style.zIndex = "999";
    ghost.style.pointerEvents = "none";
    ghost.style.width = el.offsetWidth + "px";
    ghost.style.left = ev.clientX - el.offsetWidth / 2 + "px";
    ghost.style.top = ev.clientY - el.offsetHeight / 2 + "px";
    ghost.style.background = getComputedStyle(el).background;
    ghost.style.border = getComputedStyle(el).border;
    ghost.style.borderRadius = getComputedStyle(el).borderRadius;
    document.body.appendChild(ghost);
    el._ghost = ghost;

    const move = (e) => {
      ghost.style.left = e.clientX - el.offsetWidth / 2 + "px";
      ghost.style.top = e.clientY - el.offsetHeight / 2 + "px";
      $$(".slot").forEach((s) => s.classList.remove("drag-over"));
      const under = document.elementFromPoint(e.clientX, e.clientY);
      const slot = under && under.closest(".slot");
      if (slot && !slot.classList.contains("filled")) slot.classList.add("drag-over");
    };
    const up = (e) => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      document.removeEventListener("pointercancel", up);
      $$(".slot").forEach((s) => s.classList.remove("drag-over"));
      ghost.remove();
      handlePartDrop(e.clientX, e.clientY, el, part);
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
    document.addEventListener("pointercancel", up);
  }

  function handlePartDrop(x, y, el, part) {
    const under = document.elementFromPoint(x, y);
    const slotEl = under && under.closest(".slot");
    el.classList.remove("dragging");

    if (!slotEl) return; // dropped outside — snaps back to rack automatically

    const slotIndex = Number(slotEl.dataset.slot);
    if (slotEl.classList.contains("filled")) {
      flashWrong(slotEl);
      return;
    }
    if (part.slot === slotIndex) {
      slotEl.classList.add("filled");
      slotEl.textContent = "";
      slotEl.innerHTML = part.svg;
      el.classList.add("placed");
      Audio_.place();
      m1Placed++;
      if (m1Placed === SLOT_LABELS.length) {
        setTimeout(() => {
          showResult({
            success: true,
            title: "Rocket Assembled!",
            body: `Every part locked in place with ${m1Mistakes} mistake${m1Mistakes === 1 ? "" : "s"}. The gantry rolls back — Mission 02 is go.`,
            missionNum: 1,
            nextUnlocksMission: 2,
          });
        }, 350);
      }
    } else {
      flashWrong(slotEl);
      m1Mistakes++;
      $("#m1-mistakes").textContent = "Mistakes: " + m1Mistakes;
      Audio_.error();
    }
  }

  function flashWrong(slotEl) {
    slotEl.classList.add("wrong-flash");
    setTimeout(() => slotEl.classList.remove("wrong-flash"), 350);
  }

  /* ==================================================================== *
   *  MISSION 2 — Orbit Insertion
   * ==================================================================== */
  const M2 = {
    G0: 24, RE: 300, ZA: 600,
    maxThrustAccel: 34,
    fuelBurnRate: 0.7,     // % fuel per second at full throttle
    vMin: 40, vMax: 50, vEscape: 66,
    scale: 7.8 / 45,       // one factor for BOTH altitude and velocity display, so a
                            // reading of "x km" and "y km/s" stay dimensionally consistent
    timeLimit: 90,
  };

  let m2 = null; // running state
  let m2Raf = null;
  let m2Keys = { up: false, down: false };

  function initMission2() {
    activeMission = 2;
    const canvas = $("#canvas-m2");
    const ctx = canvas.getContext("2d");
    m2 = {
      altitude: 0, velocity: 0, fuel: 100, throttle: 0,
      time: 0, hasLaunched: false, ended: false,
      stars: Array.from({ length: 60 }, () => ({ x: Math.random() * 900, y: Math.random() * 420, r: Math.random() * 1.4 + 0.3 })),
    };

    $("#m2-throttle").value = 0;
    $("#m2-throttle-val").textContent = "0%";
    $("#m2-timer").textContent = "T+00:00";

    const band = $("#m2-vband-safe");
    band.style.left = (M2.vMin / M2.vEscape) * 100 + "%";
    band.style.width = ((M2.vMax - M2.vMin) / M2.vEscape) * 100 + "%";
    const danger = $("#m2-vband-danger");
    danger.style.width = (1 - M2.vMax / M2.vEscape) * 100 + "%";
    const altTarget = $("#m2-alt-target");
    altTarget.style.left = (M2.ZA / (M2.ZA * 1.15)) * 100 + "%";

    $("#m2-throttle").oninput = (e) => { m2.throttle = Number(e.target.value); };

    drawMission2(ctx);
    m2Raf = requestAnimationFrame((t) => mission2Loop(t, ctx));
  }

  function stopMission2() {
    if (m2Raf) cancelAnimationFrame(m2Raf);
    m2Raf = null;
    activeMission = activeMission === 2 ? 0 : activeMission;
  }

  let m2LastT = null;
  function mission2Loop(t, ctx) {
    if (!m2 || m2.ended) return;
    if (m2LastT === null) m2LastT = t;
    const dt = Math.min((t - m2LastT) / 1000, 0.05);
    m2LastT = t;

    stepMission2(dt);
    drawMission2(ctx);
    updateMission2Hud();

    if (!m2.ended) m2Raf = requestAnimationFrame((tt) => mission2Loop(tt, ctx));
  }

  function stepMission2(dt) {
    m2.time += dt;
    if (m2Keys.up) m2.throttle = clamp(m2.throttle + 60 * dt, 0, 100);
    if (m2Keys.down) m2.throttle = clamp(m2.throttle - 60 * dt, 0, 100);
    $("#m2-throttle").value = Math.round(m2.throttle);

    const thrustAccel = m2.fuel > 0 ? (m2.throttle / 100) * M2.maxThrustAccel : 0;
    const gravity = M2.G0 * Math.pow(M2.RE / (M2.RE + m2.altitude), 2);
    const netAccel = thrustAccel - gravity;

    m2.velocity += netAccel * dt;
    m2.altitude += m2.velocity * dt;

    if (m2.fuel > 0) m2.fuel = clamp(m2.fuel - (m2.throttle / 100) * M2.fuelBurnRate * dt, 0, 100);

    if (m2.altitude > 2) m2.hasLaunched = true;
    if (m2.altitude <= 0) {
      m2.altitude = 0;
      if (!m2.hasLaunched) m2.velocity = Math.max(m2.velocity, 0);
    }

    if (m2.velocity > M2.vEscape) {
      endMission2(false, "Escaped Earth's Gravity", "The rocket crossed escape velocity and is now sailing off into deep space, never to settle into orbit. Ease off the throttle sooner next time.");
      return;
    }
    if (m2.altitude >= M2.ZA && m2.velocity >= M2.vMin && m2.velocity <= M2.vMax) {
      endMission2(true, "Orbit Achieved!", `Velocity held at ${fmt1(m2.velocity * M2.scale)} km/s at ${Math.round(m2.altitude * M2.scale)} km \u2014 right in the insertion window. Mars is next.`, 3);
      return;
    }
    if (m2.hasLaunched && m2.altitude <= 0 && m2.velocity <= 0) {
      endMission2(false, "Fell Back to Earth", "Velocity dropped off before reaching orbital altitude and gravity pulled the rocket back down. Give it more throttle on the way up.");
      return;
    }
    if (m2.time >= M2.timeLimit) {
      endMission2(false, "Launch Window Missed", "Ninety seconds of flight and still no stable orbit. Commit to a burn instead of hovering.");
      return;
    }
  }

  function endMission2(success, title, body, nextMission) {
    m2.ended = true;
    if (m2Raf) cancelAnimationFrame(m2Raf);
    m2LastT = null;
    setTimeout(() => showResult({ success, title, body, missionNum: 2, nextUnlocksMission: nextMission }), 250);
  }

  function updateMission2Hud() {
    $("#m2-alt").textContent = Math.round(m2.altitude * M2.scale) + " km";
    $("#m2-alt-fill").style.width = clamp((m2.altitude / (M2.ZA * 1.15)) * 100, 0, 100) + "%";
    $("#m2-vel").textContent = fmt1(m2.velocity * M2.scale) + " km/s";
    $("#m2-vneedle").style.left = clamp((m2.velocity / M2.vEscape) * 100, 0, 100) + "%";
    $("#m2-fuel").textContent = Math.round(m2.fuel) + "%";
    $("#m2-fuel-fill").style.width = m2.fuel + "%";
    $("#m2-throttle-val").textContent = Math.round(m2.throttle) + "%";
    const secs = Math.floor(m2.time);
    $("#m2-timer").textContent = "T+" + String(Math.floor(secs / 60)).padStart(2, "0") + ":" + String(secs % 60).padStart(2, "0");
  }

  function drawMission2(ctx) {
    const W = 900, H = 560;
    ctx.clearRect(0, 0, W, H);
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, "#050a16");
    grad.addColorStop(1, "#0d1c38");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    ctx.fillStyle = "#dfe8ff";
    m2.stars.forEach((s) => { ctx.globalAlpha = 0.6; ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2); ctx.fill(); });
    ctx.globalAlpha = 1;

    // target orbit line
    const targetY = mapAltToY(M2.ZA);
    ctx.strokeStyle = "rgba(73,242,172,0.55)";
    ctx.setLineDash([8, 8]);
    ctx.beginPath(); ctx.moveTo(0, targetY); ctx.lineTo(W, targetY); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "rgba(73,242,172,0.8)";
    ctx.font = "600 14px Rajdhani, sans-serif";
    ctx.fillText("TARGET ORBIT", 14, targetY - 8);

    // Earth
    const earthGrad = ctx.createRadialGradient(450, 700, 60, 450, 700, 260);
    earthGrad.addColorStop(0, "#6fc6e8");
    earthGrad.addColorStop(0.5, "#2f7fb8");
    earthGrad.addColorStop(1, "#0c2740");
    ctx.fillStyle = earthGrad;
    ctx.beginPath(); ctx.arc(450, 700, 260, 0, Math.PI * 2); ctx.fill();

    // rocket
    const ry = mapAltToY(m2.altitude);
    drawRocketIcon(ctx, 450, ry, m2.throttle);
  }

  function mapAltToY(alt) {
    const H = 560, top = 50, bottom = 470;
    const frac = clamp(alt / (M2.ZA * 1.15), 0, 1);
    return bottom - frac * (bottom - top);
  }

  function drawRocketIcon(ctx, cx, cy, throttle) {
    ctx.save();
    ctx.translate(cx, cy);
    if (throttle > 2) {
      const flameLen = 14 + (throttle / 100) * 26;
      const fg = ctx.createLinearGradient(0, 16, 0, 16 + flameLen);
      fg.addColorStop(0, "rgba(255,220,140,0.95)");
      fg.addColorStop(1, "rgba(255,120,40,0)");
      ctx.fillStyle = fg;
      ctx.beginPath();
      ctx.moveTo(-6, 16); ctx.lineTo(6, 16); ctx.lineTo(0, 16 + flameLen); ctx.closePath(); ctx.fill();
    }
    ctx.fillStyle = "#c7ccd1"; ctx.strokeStyle = "#6d747c"; ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(0, -18); ctx.lineTo(7, 2); ctx.lineTo(7, 14); ctx.lineTo(-7, 14); ctx.lineTo(-7, 2); ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = "#3a6ea8";
    ctx.beginPath(); ctx.moveTo(-7, 8); ctx.lineTo(-13, 16); ctx.lineTo(-7, 14); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.moveTo(7, 8); ctx.lineTo(13, 16); ctx.lineTo(7, 14); ctx.closePath(); ctx.fill();
    ctx.fillStyle = "#3fb8e8";
    ctx.beginPath(); ctx.arc(0, -2, 2.6, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  /* ==================================================================== *
   *  MISSION 3 — Mars Descent
   * ==================================================================== */
  const M3 = {
    gravity: 3.7,           // Mars surface gravity, m/s² — units below are literal metres
    maxThrustAccel: 6.0,
    fuelBurnRate: 2.2,      // % fuel per second at full throttle
    startAltitude: 1200,
    startVelocity: 70,
    safeLandingSpeed: 6,
    hudSpeedMax: 25,        // just scales the on-screen gauge, not a gameplay threshold
    timeLimit: 120,
  };

  let m3 = null;
  let m3Raf = null;
  let m3Keys = { up: false };

  function initMission3() {
    activeMission = 3;
    const canvas = $("#canvas-m3");
    const ctx = canvas.getContext("2d");
    m3 = {
      altitude: M3.startAltitude, velocity: M3.startVelocity, fuel: 100, throttle: 0,
      time: 0, ended: false,
      terrain: Array.from({ length: 10 }, (_, i) => 40 + Math.random() * 26),
    };

    $("#m3-throttle").value = 0;
    $("#m3-throttle-val").textContent = "0%";
    $("#m3-timer").textContent = "T+00:00";

    const band = $("#m3-vband-safe");
    const maxShown = M3.hudSpeedMax;
    band.style.left = "0%";
    band.style.width = (M3.safeLandingSpeed / maxShown) * 100 + "%";

    $("#m3-throttle").oninput = (e) => { m3.throttle = Number(e.target.value); };

    drawMission3(ctx);
    m3Raf = requestAnimationFrame((t) => mission3Loop(t, ctx));
  }

  function stopMission3() {
    if (m3Raf) cancelAnimationFrame(m3Raf);
    m3Raf = null;
    activeMission = activeMission === 3 ? 0 : activeMission;
  }

  let m3LastT = null;
  function mission3Loop(t, ctx) {
    if (!m3 || m3.ended) return;
    if (m3LastT === null) m3LastT = t;
    const dt = Math.min((t - m3LastT) / 1000, 0.05);
    m3LastT = t;

    stepMission3(dt);
    drawMission3(ctx);
    updateMission3Hud();

    if (!m3.ended) m3Raf = requestAnimationFrame((tt) => mission3Loop(tt, ctx));
  }

  function stepMission3(dt) {
    m3.time += dt;
    if (m3Keys.up) m3.throttle = clamp(m3.throttle + 70 * dt, 0, 100);
    else m3.throttle = clamp(m3.throttle - 90 * dt, 0, 100);
    $("#m3-throttle").value = Math.round(m3.throttle);

    const thrustAccel = m3.fuel > 0 ? (m3.throttle / 100) * M3.maxThrustAccel : 0;
    const netAccel = M3.gravity - thrustAccel; // positive = speeding up descent

    m3.velocity += netAccel * dt;
    m3.altitude -= m3.velocity * dt;

    if (m3.fuel > 0) m3.fuel = clamp(m3.fuel - (m3.throttle / 100) * M3.fuelBurnRate * dt, 0, 100);

    if (m3.altitude <= 0) {
      m3.altitude = 0;
      if (m3.velocity <= M3.safeLandingSpeed) {
        endMission3(true, "Touchdown!", `Landed at ${fmt1(m3.velocity)} m/s \u2014 well within tolerance. Danes Rocket has reached Mars.`);
      } else {
        endMission3(false, "Impact Too Hard", `Touched down at ${fmt1(m3.velocity)} m/s, faster than the ${M3.safeLandingSpeed} m/s the frame can absorb. The rocket didn't survive.`);
      }
      return;
    }
    if (m3.time >= M3.timeLimit) {
      endMission3(false, "Descent Window Exceeded", "Two minutes of burn management and the rocket still hasn't touched down. Commit to a landing instead of hovering.");
      return;
    }
  }

  function endMission3(success, title, body) {
    m3.ended = true;
    if (m3Raf) cancelAnimationFrame(m3Raf);
    m3LastT = null;
    setTimeout(() => showResult({ success, title, body, missionNum: 3, nextUnlocksMission: null }), 250);
  }

  function updateMission3Hud() {
    $("#m3-alt").textContent = Math.round(m3.altitude) + " m";
    $("#m3-alt-fill").style.width = clamp((m3.altitude / M3.startAltitude) * 100, 0, 100) + "%";
    $("#m3-vel").textContent = fmt1(m3.velocity) + " m/s";
    const maxShown = M3.hudSpeedMax;
    $("#m3-vneedle").style.left = clamp((m3.velocity / maxShown) * 100, 0, 100) + "%";
    $("#m3-fuel").textContent = Math.round(m3.fuel) + "%";
    $("#m3-fuel-fill").style.width = m3.fuel + "%";
    $("#m3-throttle-val").textContent = Math.round(m3.throttle) + "%";
    const secs = Math.floor(m3.time);
    $("#m3-timer").textContent = "T+" + String(Math.floor(secs / 60)).padStart(2, "0") + ":" + String(secs % 60).padStart(2, "0");
  }

  function drawMission3(ctx) {
    const W = 900, H = 560;
    ctx.clearRect(0, 0, W, H);
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, "#170a08");
    grad.addColorStop(1, "#3a1810");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    // terrain
    const baseY = 500;
    ctx.fillStyle = "#7a3a22";
    ctx.beginPath();
    ctx.moveTo(0, H);
    const seg = W / (m3.terrain.length - 1);
    m3.terrain.forEach((h, i) => ctx.lineTo(i * seg, baseY - h));
    ctx.lineTo(W, H);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "rgba(0,0,0,0.15)";
    ctx.fillRect(0, baseY, W, H - baseY);

    // rocket
    const ry = 60 + (1 - clamp(m3.altitude / M3.startAltitude, 0, 1)) * (baseY - 60 - 24);
    drawRocketIcon(ctx, 450, ry, m3.throttle);
  }

  /* ------------------------------------------------------------------ *
   *  Shared keyboard controls for missions 2 & 3
   * ------------------------------------------------------------------ */
  window.addEventListener("keydown", (e) => {
    if (e.key === "ArrowUp") { if (activeMission === 2) m2Keys.up = true; if (activeMission === 3) m3Keys.up = true; e.preventDefault(); }
    if (e.key === "ArrowDown") { if (activeMission === 2) m2Keys.down = true; e.preventDefault(); }
  });
  window.addEventListener("keyup", (e) => {
    if (e.key === "ArrowUp") { m2Keys.up = false; m3Keys.up = false; }
    if (e.key === "ArrowDown") { m2Keys.down = false; }
  });

  /* ------------------------------------------------------------------ *
   *  Global nav wiring
   * ------------------------------------------------------------------ */
  $("#btn-start").addEventListener("click", () => { Audio_.click(); showScreen("screen-missions"); });
  $("#btn-settings").addEventListener("click", () => { Audio_.click(); openModal("modal-settings"); });
  $("#btn-quit").addEventListener("click", () => { Audio_.click(); openModal("modal-quit"); });
  $("#btn-quit-confirm").addEventListener("click", () => { window.close(); setTimeout(() => { alert("You can close this browser tab whenever you're ready."); }, 300); });

  $$("[data-goto]").forEach((btn) => btn.addEventListener("click", () => { Audio_.click(); showScreen(btn.dataset.goto); }));
  $$("[data-close-modal]").forEach((btn) => btn.addEventListener("click", () => closeModal(btn.dataset.closeModal)));

  const soundToggle = $("#toggle-sound");
  soundToggle.setAttribute("aria-pressed", Audio_.isEnabled() ? "true" : "false");
  soundToggle.addEventListener("click", () => {
    const next = soundToggle.getAttribute("aria-pressed") !== "true";
    soundToggle.setAttribute("aria-pressed", next ? "true" : "false");
    Audio_.setEnabled(next);
    if (next) Audio_.click();
  });

  $("#btn-reset-progress").addEventListener("click", () => {
    Progress.reset();
    refreshMissionCards();
    Audio_.click();
  });

  refreshMissionCards();
})();
