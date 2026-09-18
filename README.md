# Danes Arcade

A free browser game platform. Everything is static HTML, CSS and JavaScript — no
build step, no framework, no bundler. Players and scores live in a free Supabase
(PostgreSQL) project.

Currently live: **Danes Rocket**, a three-mission flight sim.

```
index.html              Arcade home — the game shelf
leaderboards.html       Global leaderboards, one tab per game
account.html            Player profile and personal bests
assets/
  config.js             Supabase keys (you fill these in)
  api.js                Auth + scores; falls back to local storage when offline
  shell.js              Site header, sign-in dialog, toasts
  games.js              The game registry — the list of what the arcade offers
  platform.css          Shell styling
games/
  danes-rocket/         One folder per game
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
into a score submission.

## How scoring works in Danes Rocket

Each mission pays a base for finishing plus bonuses for doing it well — a clean
assembly, fuel left in the tanks, a gentle touchdown. A player's **campaign
score** is the sum of their best run at each of the three missions, so the
leaderboard rewards mastering all three rather than grinding one. The per-mission
breakdown travels with the score in the `details` column and is shown on the
leaderboard.
