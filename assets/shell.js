/* ==========================================================================
   Danes Arcade — shared shell
   --------------------------------------------------------------------------
   Renders the site header, the sign-in / sign-up dialog and the toast strip
   on every page, including inside a game. Drop this on a page with:

     <body data-page="home">
     <script type="module" src="assets/shell.js"></script>

   Pages nested deeper (games/<id>/index.html) need no extra configuration —
   links are resolved against the module's own URL, not the page's.
   ========================================================================== */

import * as Arcade from "./api.js";

/* The site root, derived from this module sitting in /assets/. Keeps every
   header link correct whether the page is at / or at /games/danes-rocket/. */
export const ROOT = new URL("../", import.meta.url).href;
export const url = (path) => new URL(path, ROOT).href;

/* ------------------------------------------------------------------ *
 *  Toasts
 * ------------------------------------------------------------------ */
let toastHost = null;

export function toast(message, kind = "info", ms = 4000) {
  if (!toastHost) {
    toastHost = document.createElement("div");
    toastHost.className = "toast-host";
    document.body.appendChild(toastHost);
  }
  const el = document.createElement("div");
  el.className = "toast toast--" + kind;
  el.setAttribute("role", kind === "error" ? "alert" : "status");
  el.textContent = message;
  toastHost.appendChild(el);
  setTimeout(() => {
    el.classList.add("is-leaving");
    setTimeout(() => el.remove(), 300);
  }, ms);
}

/* ------------------------------------------------------------------ *
 *  Header
 * ------------------------------------------------------------------ */
const NAV = [
  { key: "home", label: "Games", href: "index.html" },
  { key: "leaderboards", label: "Leaderboards", href: "leaderboards.html" },
  { key: "account", label: "My Account", href: "account.html" },
];

function headerMarkup(active) {
  const links = NAV.map(
    (n) =>
      `<a class="site-nav__link${n.key === active ? " is-active" : ""}" href="${url(
        n.href
      )}">${n.label}</a>`
  ).join("");

  return `
    <a class="site-brand" href="${url("index.html")}" aria-label="Danes Arcade home">
      <svg class="site-brand__mark" viewBox="0 0 40 40" aria-hidden="true">
        <circle cx="20" cy="20" r="18" class="brand-ring"/>
        <path d="M20 7 C25 14 26 21 26 26 L14 26 C14 21 15 14 20 7 Z" class="brand-rocket"/>
        <path d="M14 22 L9 30 L14 28 Z" class="brand-fin"/>
        <path d="M26 22 L31 30 L26 28 Z" class="brand-fin"/>
        <circle cx="20" cy="17" r="3" class="brand-window"/>
        <ellipse cx="20" cy="31" rx="4" ry="6" class="brand-flame"/>
      </svg>
      <span class="site-brand__text">Danes<em>Arcade</em></span>
    </a>
    <nav class="site-nav" aria-label="Main">${links}</nav>
    <div class="site-account" id="site-account"></div>
  `;
}

function renderAccountArea(player) {
  const host = document.getElementById("site-account");
  if (!host) return;

  if (player) {
    host.innerHTML = `
      <a class="account-chip" href="${url("account.html")}">
        <span class="account-chip__avatar" aria-hidden="true">${escapeHtml(
          player.username.charAt(0).toUpperCase()
        )}</span>
        <span class="account-chip__name">${escapeHtml(player.username)}</span>
      </a>
      <button class="btn btn--ghost btn--sm" id="btn-sign-out" type="button">Sign out</button>`;
    host.querySelector("#btn-sign-out").addEventListener("click", async () => {
      await Arcade.signOut();
      toast("Signed out.", "info");
    });
  } else {
    const note = Arcade.online() ? "" : `<span class="account-offline" title="${escapeHtml(
      Arcade.offlineReason()
    )}">offline</span>`;
    host.innerHTML = `
      ${note}
      <span class="account-chip account-chip--guest">
        <span class="account-chip__avatar account-chip__avatar--guest" aria-hidden="true">?</span>
        <span class="account-chip__name">${escapeHtml(Arcade.guestName())}</span>
      </span>
      <button class="btn btn--primary btn--sm" id="btn-sign-in" type="button">Sign in</button>`;
    host.querySelector("#btn-sign-in").addEventListener("click", () => openAuth("signin"));
  }
}

/** Wire only the account widget, for pages that supply their own chrome —
 *  a game, for instance, whose screens are full-viewport overlays and cannot
 *  give up a strip at the top of the document. The page must contain an
 *  element with id="site-account". */
export function mountAccount() {
  Arcade.onAuthChange(renderAccountArea);
}

export function mountHeader(active) {
  let host = document.getElementById("site-header");
  if (!host) {
    host = document.createElement("header");
    host.id = "site-header";
    document.body.prepend(host);
  }
  host.className = "site-header";
  host.innerHTML = headerMarkup(active);
  Arcade.onAuthChange(renderAccountArea);
}

/* ------------------------------------------------------------------ *
 *  Auth dialog
 * ------------------------------------------------------------------ */
let authEl = null;
let lastFocused = null;

function buildAuth() {
  const el = document.createElement("div");
  el.className = "auth-overlay";
  el.id = "auth-overlay";
  el.innerHTML = `
    <div class="auth" role="dialog" aria-modal="true" aria-labelledby="auth-title">
      <button class="auth__close" type="button" data-auth-close aria-label="Close">&#10005;</button>
      <h2 class="auth__title" id="auth-title">Sign in</h2>
      <p class="auth__sub" id="auth-sub">Sign in to put your scores on the global leaderboard.</p>

      <div class="auth__tabs" role="tablist">
        <button class="auth__tab is-active" type="button" data-auth-tab="signin" role="tab">Sign in</button>
        <button class="auth__tab" type="button" data-auth-tab="signup" role="tab">Create account</button>
      </div>

      <form class="auth__form" id="auth-form" novalidate>
        <label class="field" data-only="signup">
          <span class="field__label">Player name</span>
          <input class="field__input" type="text" name="username" autocomplete="nickname"
                 maxlength="20" placeholder="How you appear on leaderboards">
        </label>
        <label class="field">
          <span class="field__label">Email</span>
          <input class="field__input" type="email" name="email" autocomplete="email" required
                 placeholder="you@example.com">
        </label>
        <label class="field">
          <span class="field__label">Password</span>
          <input class="field__input" type="password" name="password" required minlength="6"
                 autocomplete="current-password" placeholder="At least 6 characters">
        </label>

        <p class="auth__error" id="auth-error" role="alert" hidden></p>

        <button class="btn btn--primary btn--block" type="submit" id="auth-submit">Sign in</button>
        <button class="btn btn--link" type="button" id="auth-forgot" data-only="signin">Forgot password?</button>
      </form>

      <div class="auth__divider"><span>or</span></div>

      <form class="auth__guest" id="guest-form">
        <label class="field">
          <span class="field__label">Play as a guest</span>
          <input class="field__input" type="text" name="guest" maxlength="20"
                 placeholder="Pick a display name">
        </label>
        <button class="btn btn--ghost btn--block" type="submit">Continue as guest</button>
        <p class="auth__note">Guest scores stay in this browser only.</p>
      </form>
    </div>`;
  document.body.appendChild(el);

  el.addEventListener("click", (e) => {
    if (e.target === el || e.target.closest("[data-auth-close]")) closeAuth();
  });
  el.querySelectorAll("[data-auth-tab]").forEach((tab) =>
    tab.addEventListener("click", () => setAuthMode(tab.dataset.authTab))
  );
  el.querySelector("#auth-form").addEventListener("submit", onAuthSubmit);
  el.querySelector("#guest-form").addEventListener("submit", onGuestSubmit);
  el.querySelector("#auth-forgot").addEventListener("click", onForgot);

  return el;
}

let authMode = "signin";

function setAuthMode(mode) {
  authMode = mode;
  const el = authEl;
  el.querySelectorAll("[data-auth-tab]").forEach((t) =>
    t.classList.toggle("is-active", t.dataset.authTab === mode)
  );
  el.querySelectorAll("[data-only]").forEach((n) => {
    n.hidden = n.dataset.only !== mode;
  });
  el.querySelector("#auth-title").textContent =
    mode === "signup" ? "Create account" : "Sign in";
  el.querySelector("#auth-sub").textContent =
    mode === "signup"
      ? "One account works across every game in the arcade."
      : "Sign in to put your scores on the global leaderboard.";
  el.querySelector("#auth-submit").textContent =
    mode === "signup" ? "Create account" : "Sign in";
  el.querySelector('[name="password"]').autocomplete =
    mode === "signup" ? "new-password" : "current-password";
  showAuthError("");
}

function showAuthError(msg) {
  const p = authEl.querySelector("#auth-error");
  p.textContent = msg;
  p.hidden = !msg;
}

export function openAuth(mode = "signin") {
  if (!authEl) authEl = buildAuth();
  lastFocused = document.activeElement;
  authEl.classList.add("is-open");
  setAuthMode(mode);
  authEl.querySelector('[name="guest"]').value = Arcade.guestName() === "Guest" ? "" : Arcade.guestName();

  if (!Arcade.online()) {
    showAuthError(Arcade.offlineReason());
    authEl.querySelector("#auth-submit").disabled = true;
  } else {
    authEl.querySelector("#auth-submit").disabled = false;
  }
  setTimeout(() => {
    const first = authEl.querySelector(
      mode === "signup" ? '[name="username"]' : '[name="email"]'
    );
    first?.focus();
  }, 60);
}

export function closeAuth() {
  if (!authEl) return;
  authEl.classList.remove("is-open");
  lastFocused?.focus?.();
}

async function onAuthSubmit(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const btn = form.querySelector("#auth-submit");
  const email = form.email.value.trim();
  const password = form.password.value;
  const username = form.username.value.trim();

  if (!email || !password) return showAuthError("Email and password are required.");
  if (authMode === "signup" && !username) return showAuthError("Pick a player name.");

  btn.disabled = true;
  btn.textContent = authMode === "signup" ? "Creating…" : "Signing in…";
  showAuthError("");

  const res =
    authMode === "signup"
      ? await Arcade.signUp(email, password, username)
      : await Arcade.signIn(email, password);

  btn.disabled = false;
  btn.textContent = authMode === "signup" ? "Create account" : "Sign in";

  if (res.error) return showAuthError(res.error);

  if (res.needsConfirmation) {
    showAuthError("");
    closeAuth();
    toast("Account created — check your email to confirm it, then sign in.", "success", 7000);
    return;
  }
  closeAuth();
  toast(authMode === "signup" ? "Welcome to the arcade!" : "Signed in.", "success");
  document.dispatchEvent(new CustomEvent("arcade:signedin"));
}

function onGuestSubmit(e) {
  e.preventDefault();
  const name = e.currentTarget.guest.value.trim();
  if (!name) return showAuthError("Give yourself a display name first.");
  Arcade.setGuestName(name);
  closeAuth();
  toast(`Playing as ${name}. Scores stay in this browser.`, "info");
}

async function onForgot() {
  const email = authEl.querySelector('[name="email"]').value.trim();
  if (!email) return showAuthError("Enter your email first, then tap Forgot password.");
  const res = await Arcade.resetPassword(email);
  if (res.error) return showAuthError(res.error);
  showAuthError("");
  toast("Password reset link sent — check your email.", "success", 6000);
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && authEl?.classList.contains("is-open")) closeAuth();
});

/* ------------------------------------------------------------------ *
 *  Utilities
 * ------------------------------------------------------------------ */
export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);
}

export function timeAgo(iso) {
  const secs = (Date.now() - new Date(iso).getTime()) / 1000;
  if (secs < 60) return "just now";
  const mins = secs / 60;
  if (mins < 60) return `${Math.floor(mins)}m ago`;
  const hrs = mins / 60;
  if (hrs < 24) return `${Math.floor(hrs)}h ago`;
  const days = hrs / 24;
  if (days < 30) return `${Math.floor(days)}d ago`;
  return new Date(iso).toLocaleDateString();
}

/* ------------------------------------------------------------------ *
 *  Auto-mount
 * ------------------------------------------------------------------ */
const page = document.body?.dataset.page;
if (page && page !== "none") mountHeader(page);

export { Arcade };
