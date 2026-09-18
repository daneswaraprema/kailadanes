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
  {
    id: "asteroid-run",
    title: "Asteroid Run",
    tagline: "Fly the belt. Break the rocks. Stay alive.",
    description:
      "An endless arcade shooter. Waves of asteroids keep coming and keep " +
      "getting faster; chain your kills to build a combo multiplier and grab " +
      "the power-ups the rocks drop. Three hulls, no finish line.",
    path: "games/asteroid-run/",
    genre: "Arcade",
    players: "1 player",
    controls: "Arrows / WASD, or touch",
    scoreLabel: "High score",
    accent: "#ffb347",
    released: true,
    art: "asteroid",
  },
  {
    id: "orbital-puzzle",
    title: "Orbital Puzzle",
    tagline: "Aim once. Let gravity do the rest.",
    description:
      "Twelve gravity slingshots. You get one probe, one launch and a single " +
      "mid-course burn — everything else is the pull of the planets, stars " +
      "and voids between you and the station.",
    path: "games/orbital-puzzle/",
    genre: "Puzzle",
    players: "1 player",
    controls: "Mouse or arrow keys",
    scoreLabel: "Campaign score",
    accent: "#5ad1ff",
    released: true,
    art: "orbit",
  },
];

/* Placeholder tiles shown alongside the real games so the shelf reads as a
   platform rather than a single-game site. Delete entries as they ship. */
export const COMING_SOON = [];

export const gameById = (id) => GAMES.find((g) => g.id === id) || null;
