/* ==========================================================================
   Asteroid Run — arcade integration
   --------------------------------------------------------------------------
   The bridge between the game and the platform. game.js knows nothing about
   accounts or networking: it just fires an "asteroid-run:run-complete" event
   and this module decides where the score goes.

   Same shape as games/danes-rocket/arcade.js — the only differences are the
   game id and the fact that a run here is a single score rather than a
   campaign total, so there is no per-mission breakdown to carry.
   ========================================================================== */

import * as Arcade from "../../assets/api.js";
import { mountAccount, openAuth, toast } from "../../assets/shell.js";

const GAME_ID = "asteroid-run";

/* The game draws its own compact bar (the screens are full-viewport overlays,
   so there is no room for the site header) but reuses the shell's account
   widget inside it, keeping sign-in state consistent across the site. */
mountAccount();

/* ------------------------------------------------------------------ *
 *  Score submission
 * ------------------------------------------------------------------ */
const syncLine = document.getElementById("result-sync");

function setSync(html) {
  if (!syncLine) return;
  syncLine.innerHTML = html;
  syncLine.hidden = !html;
}

document.addEventListener("asteroid-run:run-complete", async (e) => {
  const { score, wave, kills } = e.detail;

  setSync("<span class='result-sync__pending'>Saving score…</span>");

  // The wave and kill count ride along so the leaderboard can show how the
  // score was earned, not just how big it was.
  const res = await Arcade.submitScore(GAME_ID, score, { wave, kills });

  if (res.stored === "server") {
    const best = await Arcade.myBest(GAME_ID);
    setSync(
      `&#9989; Saved to the leaderboard` +
        (best?.rank ? ` — you are <b>#${best.rank}</b>` : "")
    );
    return;
  }

  if (res.reason === "guest") {
    setSync(
      `Saved in this browser only. <button class="btn btn--link" id="sync-signin" type="button">Sign in to rank globally</button>`
    );
    document.getElementById("sync-signin")?.addEventListener("click", () => openAuth("signup"));
    return;
  }

  // "offline" means no database is configured at all; "error" means one is
  // configured but the write failed. Different fixes, so different wording.
  setSync(
    res.reason === "offline"
      ? "Saved in this browser. No leaderboard is connected to this arcade yet."
      : "Saved in this browser — the score server could not be reached."
  );
});

/* When a guest signs in mid-session, push their local best up so the run they
   just finished is not lost behind the sign-up. */
document.addEventListener("arcade:signedin", async () => {
  const mine = Arcade.localBestFor(GAME_ID);
  if (!mine) return;
  const res = await Arcade.submitScore(GAME_ID, mine.score, mine.details || {});
  if (res.stored === "server") toast("Your best run has been added to the leaderboard.", "success");
});
