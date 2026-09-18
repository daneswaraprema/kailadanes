/* ==========================================================================
   Danes Arcade — game registry
   --------------------------------------------------------------------------
   This list is the single source of truth for what the arcade offers. The
   home page, the leaderboard filters and the account page all read from it.

   To add a game:
     1. Drop its files in  games/<id>/  with an index.html entry point.
     2. Add an entry below.
     3. Insert a matching row in the `games` table (see db/schema.sql) so the
        backend will accept its scores.

   The `id` must match the primary key used in the database.
   ========================================================================== */

export const GAMES = [
  {
    id: "danes-rocket",
    title: "Danes Rocket",
    tagline: "Build it, launch it, land it on Mars.",
    description:
      "A three-mission flight sim. Assemble the rocket from the parts rack, " +
      "hold the insertion window to reach orbit, then brake a Mars descent " +
      "down to a landing the frame can survive.",
    path: "games/danes-rocket/",
    genre: "Simulation",
    players: "1 player",
    controls: "Mouse + arrow keys",
    scoreLabel: "Campaign score",
    accent: "#49f2ac",
    released: true,
    art: "rocket",
  },
];

/* Placeholder tiles shown alongside the real games so the shelf reads as a
   platform rather than a single-game site. Delete entries as they ship. */
export const COMING_SOON = [
  { title: "Asteroid Run", genre: "Arcade", art: "asteroid" },
  { title: "Orbital Puzzle", genre: "Puzzle", art: "orbit" },
];

export const gameById = (id) => GAMES.find((g) => g.id === id) || null;
