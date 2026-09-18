# Danes Arcade

A free browser game platform. Everything is static HTML, CSS and JavaScript — no
build step, no framework, no bundler. Players and scores live in a free Supabase
(PostgreSQL) project.

Three games are live:

| Game | Genre | What it is |
| --- | --- | --- |
| **Danes Rocket** | Simulation | Three missions: assemble the rocket, reach orbit, land on Mars. |
| **Asteroid Run** | Arcade | Endless belt shooter with combo multipliers and power-ups. |
| **Orbital Puzzle** | Puzzle | Twelve gravity slingshots: one probe, one launch, one burn. |

```
index.html              Arcade home — the game shelf
leaderboards.html       Global leaderboards, one tab per game
account.html            Player profile and personal bests
assets/
  config.js             Supabase keys (you fill these in)
  api.js                Auth + scores; falls back to local storage when offline
  shell.js              Site header, sign-in dialog, toasts
  games.js              The game registry — the list of what the arcade offers
  audio.js              Sound effects and music, synthesised in the browser
  platform.css          Shell styling
games/
  danes-rocket/         One folder per game
  asteroid-run/
  orbital-puzzle/
    index.html  style.css  game.js   The game itself
    arcade.js                        Glue: turns a finished run into a score
db/
  schema.sql            Tables, Row Level Security, triggers
```

## Running it locally

Any static file server works. Because the site uses ES modules, opening
`index.html` as a `file://` URL will **not** work — you need HTTP.

```bash
python -m http.server 8777
# then open http://localhost:8777
```

The arcade is fully playable before you connect a database. Scores are kept in
the browser and every page shows a notice explaining why the leaderboard is
local.

## Connecting the database (free)

1. Create a project at [supabase.com](https://supabase.com). The free tier gives
   you a 500 MB PostgreSQL database and 50,000 monthly active users.
2. In the project's **SQL Editor**, paste all of `db/schema.sql` and press Run.
   It creates the tables, the leaderboard view, the sign-up trigger and the
   security rules. Re-running it later is safe.
3. In **Project Settings → API**, copy the **Project URL** and the **anon
   public** key into `assets/config.js`.
4. Reload the site. The "not connected" notices disappear and Sign in works.

### About the anon key

The anon key is meant to be public and is safe to commit — it identifies the
project, it does not grant privileges. Everything that actually protects data is
in the Row Level Security policies in `db/schema.sql`:

- anyone may read profiles, games and the leaderboard
- a player may insert scores only for their own user id
- scores are **append-only** from the browser: no update or delete policy
  exists, so a score can neither be erased nor edited after the fact
- a score above the game's declared `max_score` is rejected outright

Never put the `service_role` key in this repo — that one bypasses RLS entirely.

### Email confirmation

Supabase sends a confirmation email on sign-up by default, so a new player must
click through before they can sign in. The UI already handles this and says
"check your email". To let players in immediately instead, turn off
**Authentication → Sign In / Providers → Confirm email** in the dashboard.

## Deploying

The site is static, so anything that serves files will host it: GitHub Pages,
Netlify, Cloudflare Pages, Vercel. Push the repo and point the host at the root
directory — there is nothing to build.

One thing to set afterwards: in Supabase under **Authentication → URL
Configuration**, add your live URL to the redirect allow-list, or password reset
emails will bounce users back to localhost.

## Adding a new game

1. Create `games/<your-game-id>/` with an `index.html` entry point.
2. Add an entry to the `GAMES` array in `assets/games.js`. The home page,
   leaderboard tabs and account page all read from that list.
3. Add a row to the `games` table so the backend accepts its scores:

   ```sql
   insert into public.games (id, title, tagline, score_label, max_score, sort_order)
   values ('your-game-id', 'Your Game', 'One line about it.', 'Score', 100000, 2);
   ```

   `max_score` is the ceiling the insert policy enforces — set it a little above
   the best score the game can legitimately produce.
4. Submit scores from the game:

   ```js
   import * as Arcade from "../../assets/api.js";
   await Arcade.submitScore("your-game-id", score, { anything: "you like" });
   ```

   `submitScore` handles all four cases for you: signed in, guest, backend
   unreachable, and backend not configured. A run is never silently lost — if it
   cannot go to the server it is kept in the browser.

Look at `games/danes-rocket/arcade.js` for a worked example. The pattern there is
worth copying: the game itself knows nothing about accounts or networking, it
just fires a DOM event when a run ends, and a small separate module turns that
into a score submission. All three games' `arcade.js` files are near-identical,
which is the point — joining the leaderboard costs one event.

## Sound

`assets/audio.js` is the whole audio system, shared by every game. Nothing is
recorded: effects and music are synthesised with WebAudio, so there are no
binaries in the repo, nothing to download at runtime, and a sound can be retuned
by editing a number.

Load it before the game script (it is a classic script, not a module, because
the games' `game.js` files are too) and call it:

```html
<script src="../../assets/audio.js"></script>
<script src="game.js"></script>
```

```js
ArcadeAudio.sfx("explode");     // one-shot effect
ArcadeAudio.music("chase");     // start or swap the background track
ArcadeAudio.music(null);        // stop it
ArcadeAudio.thruster(0.7);      // continuous engine noise, 0 = off
```

`ArcadeAudio.effects()` and `ArcadeAudio.tracks()` list what is available. The
six tracks are generated from a chord progression plus pad, bass, arpeggio and
percussion layers, stepped by a lookahead sequencer, so each one loops forever
without a seam.

Two details worth knowing if you add a game:

- **Browsers will not start audio before the player interacts with the page.**
  Asking for music during start-up is fine and normal — the request is
  remembered and begins on the first click or keypress.
- **Sound effects and music are separate preferences**, stored under the
  `da_audio` key and shared across the whole arcade, so a player who turns the
  music off does it once. Each game's settings panel drives the same switches.

## How scoring works

Each game ranks one number, and each stores its own breakdown in the `details`
column for the leaderboard to display.

**Danes Rocket** — each mission pays a base for finishing plus bonuses for doing
it well: a clean assembly, fuel left in the tanks, a gentle touchdown. A player's
**campaign score** is the sum of their best run at each of the three missions, so
the leaderboard rewards mastering all three rather than grinding one. Theoretical
maximum 4,950.

**Asteroid Run** — rocks pay by size, and the small ones pay most because they
are hardest to hit. Staying alive pays too, and both routes are multiplied by a
combo that climbs every eight kills and resets whenever you take a hit, so a
careful run outscores a reckless one. The run is endless, so there is no maximum;
the `max_score` in the schema is a sanity ceiling, not a target.

**Orbital Puzzle** — a solved puzzle pays 400, solving it first try pays 300 more
(sliding to nothing by the sixth attempt), and each crystal pays 120. The
**campaign score** is the sum of the best result at each of the twelve puzzles, so
going back to clean up a messy solution always pays. Every crystal is reachable
on a trajectory that also docks, so the maximum — 10,440 — is genuinely
attainable.

### Levels in Orbital Puzzle

The twelve levels are hand-placed data at the top of
`games/orbital-puzzle/game.js`: bodies with a position, a radius and a gravity
`mass` (deliberately independent, so a void can be small and vicious while a gas
giant is large and gentle), plus a start pad, a station, optional crystals and
optional barriers. Everything except the station is lethal on contact.

If you edit a level, check it still has a solution. The physics is deterministic,
so a brute-force sweep over launch angle and power settles it — that is how the
shipped levels were verified, and how the crystals were placed on arcs that
actually reach the station.
