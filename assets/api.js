/* ==========================================================================
   Danes Arcade — backend API
   --------------------------------------------------------------------------
   One module that every page and every game talks to. It wraps Supabase for
   accounts and scores, and it degrades to browser-local storage when the
   backend is not configured (or is unreachable) so the arcade is never hard
   down — you just lose the global leaderboard.

   Nothing here trusts the client for correctness: the database enforces who
   may write what through Row Level Security (db/schema.sql). This module is
   only responsible for asking politely and reporting failures honestly.
   ========================================================================== */

import { SUPABASE_URL, SUPABASE_ANON_KEY, isConfigured } from "./config.js";

/* ------------------------------------------------------------------ *
 *  Client bootstrap
 * ------------------------------------------------------------------ */
let supabase = null;
let bootError = null;

if (isConfigured) {
  try {
    const { createClient } = await import(
      "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm"
    );
    supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true },
    });
  } catch (err) {
    // Offline, blocked CDN, bad URL — fall through to local-only mode rather
    // than leaving every page with a dead import.
    bootError = err;
    console.warn("[arcade] Supabase unavailable, running local-only:", err);
  }
}

export const online = () => supabase !== null;

export const offlineReason = () =>
  !isConfigured
    ? "This arcade is not connected to a database yet. Add your Supabase keys in assets/config.js to turn on global leaderboards."
    : bootError
    ? "Could not reach the score server. Scores are being saved in this browser instead."
    : "";

/* ------------------------------------------------------------------ *
 *  Local storage — guest play and offline fallback
 * ------------------------------------------------------------------ */
const LS_SCORES = "da_local_scores";
const LS_GUEST = "da_guest_name";

const Local = {
  read(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  },
  write(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  },
};

/* Local score rows use the same shape the server returns, so the UI can
   render either source without branching on where it came from. */
function localSubmit(gameId, score, details) {
  const all = Local.read(LS_SCORES, []);
  const row = {
    game_id: gameId,
    username: guestName(),
    score,
    details,
    created_at: new Date().toISOString(),
    local: true,
  };
  all.push(row);
  Local.write(LS_SCORES, all);
  return row;
}

function localBest(gameId) {
  const mine = Local.read(LS_SCORES, []).filter((r) => r.game_id === gameId);
  if (!mine.length) return null;
  return mine.reduce((a, b) => (b.score > a.score ? b : a));
}

/** The best run this browser has stored for a game, regardless of who is
 *  signed in. Used to carry a guest's run over once they create an account. */
export function localBestFor(gameId) {
  return localBest(gameId);
}

export function guestName() {
  return Local.read(LS_GUEST, null) || "Guest";
}

export function setGuestName(name) {
  const clean = String(name || "").trim().slice(0, 20);
  Local.write(LS_GUEST, clean || "Guest");
  emit();
}

/* ------------------------------------------------------------------ *
 *  Auth
 * ------------------------------------------------------------------ */
let currentUser = null; // { id, email, username } or null
let ready = false;
const listeners = new Set();

function emit() {
  listeners.forEach((fn) => {
    try {
      fn(currentUser);
    } catch (err) {
      console.error("[arcade] auth listener threw:", err);
    }
  });
}

/** Subscribe to sign-in / sign-out. Fires immediately with the current state
 *  so callers never have to handle a "not loaded yet" case themselves. */
export function onAuthChange(fn) {
  listeners.add(fn);
  if (ready) fn(currentUser);
  return () => listeners.delete(fn);
}

async function hydrateProfile(authUser) {
  if (!authUser) return null;
  const { data } = await supabase
    .from("profiles")
    .select("username")
    .eq("id", authUser.id)
    .maybeSingle();
  return {
    id: authUser.id,
    email: authUser.email,
    // The trigger in schema.sql fills profiles on sign-up; the metadata and
    // email fallbacks cover rows created before that trigger existed.
    username:
      data?.username ||
      authUser.user_metadata?.username ||
      authUser.email?.split("@")[0] ||
      "Player",
  };
}

if (supabase) {
  const { data } = await supabase.auth.getSession();
  currentUser = await hydrateProfile(data?.session?.user ?? null);
  supabase.auth.onAuthStateChange(async (_event, session) => {
    currentUser = await hydrateProfile(session?.user ?? null);
    emit();
  });
}
ready = true;

export const user = () => currentUser;
export const displayName = () => currentUser?.username || guestName();

export async function signUp(email, password, username) {
  if (!supabase) return { error: "Accounts need a database connection." };

  const name = String(username || "").trim();
  if (!/^[A-Za-z0-9_ -]{3,20}$/.test(name)) {
    return {
      error: "Username must be 3-20 characters: letters, numbers, spaces, _ or -.",
    };
  }

  // Checked up front so the common mistake gets a clear message instead of
  // the raw unique-constraint violation the trigger would otherwise raise.
  const { data: taken } = await supabase
    .from("profiles")
    .select("id")
    .ilike("username", name)
    .maybeSingle();
  if (taken) return { error: "That username is already taken." };

  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { username: name } },
  });
  if (error) return { error: error.message };

  // With email confirmation switched on there is no session yet — report it
  // so the caller can say "check your inbox" instead of pretending they are
  // signed in.
  return { needsConfirmation: !data.session, user: data.user };
}

export async function signIn(email, password) {
  if (!supabase) return { error: "Accounts need a database connection." };
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  return error ? { error: error.message } : {};
}

export async function signOut() {
  if (!supabase) return {};
  const { error } = await supabase.auth.signOut();
  return error ? { error: error.message } : {};
}

export async function resetPassword(email) {
  if (!supabase) return { error: "Accounts need a database connection." };
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: new URL("account.html", location.href).href,
  });
  return error ? { error: error.message } : {};
}

/* ------------------------------------------------------------------ *
 *  Scores
 * ------------------------------------------------------------------ */

/** Submit a score. Signed-in players go to the server; guests (and everyone
 *  when the backend is down) get a local record, so a good run is never
 *  silently thrown away. */
export async function submitScore(gameId, score, details = {}) {
  const value = Math.max(0, Math.round(Number(score) || 0));

  if (!supabase || !currentUser) {
    localSubmit(gameId, value, details);
    return { stored: "local", reason: supabase ? "guest" : "offline" };
  }

  const { error } = await supabase
    .from("scores")
    .insert({ user_id: currentUser.id, game_id: gameId, score: value, details });

  if (error) {
    localSubmit(gameId, value, details);
    console.warn("[arcade] score submit failed, kept locally:", error.message);
    return { stored: "local", reason: "error", error: error.message };
  }
  return { stored: "server" };
}

/** Top scores for one game — one row per player, showing their best. */
export async function topScores(gameId, limit = 20) {
  if (!supabase) {
    const best = localBest(gameId);
    return { rows: best ? [best] : [], source: "local" };
  }
  const { data, error } = await supabase
    .from("leaderboard")
    .select("game_id, user_id, username, score, details, created_at")
    .eq("game_id", gameId)
    .order("score", { ascending: false })
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error) {
    console.warn("[arcade] leaderboard read failed:", error.message);
    return { rows: [], source: "error", error: error.message };
  }
  return { rows: data ?? [], source: "server" };
}

/** The signed-in player's best score for a game, plus where it ranks. */
export async function myBest(gameId) {
  if (!supabase || !currentUser) {
    const best = localBest(gameId);
    return best ? { ...best, rank: null } : null;
  }
  const { data } = await supabase
    .from("leaderboard")
    .select("score, details, created_at")
    .eq("game_id", gameId)
    .eq("user_id", currentUser.id)
    .maybeSingle();
  if (!data) return null;

  // Rank = how many players beat this score, plus one. head:true fetches the
  // count without transferring any rows.
  const { count } = await supabase
    .from("leaderboard")
    .select("user_id", { count: "exact", head: true })
    .eq("game_id", gameId)
    .gt("score", data.score);

  return { ...data, rank: (count ?? 0) + 1 };
}

/** Every game the current player has a best score in. */
export async function myScores() {
  if (!supabase || !currentUser) {
    const all = Local.read(LS_SCORES, []);
    const best = new Map();
    all.forEach((r) => {
      const prev = best.get(r.game_id);
      if (!prev || r.score > prev.score) best.set(r.game_id, r);
    });
    return [...best.values()];
  }
  const { data } = await supabase
    .from("leaderboard")
    .select("game_id, score, details, created_at")
    .eq("user_id", currentUser.id);
  return data ?? [];
}

/** Arcade-wide counters for the home page. Null when offline. */
export async function arcadeStats() {
  if (!supabase) return null;
  const [plays, players] = await Promise.all([
    supabase.from("scores").select("id", { count: "exact", head: true }),
    supabase.from("profiles").select("id", { count: "exact", head: true }),
  ]);
  return { plays: plays.count ?? 0, players: players.count ?? 0 };
}
