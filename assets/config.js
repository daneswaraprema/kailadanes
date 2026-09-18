/* ==========================================================================
   Danes Arcade — backend configuration
   --------------------------------------------------------------------------
   Fill these in with the values from your Supabase project:
     Supabase dashboard -> Project Settings -> API
       Project URL  ->  SUPABASE_URL
       anon public  ->  SUPABASE_ANON_KEY

   The anon key is designed to be public — it is safe to commit and ship to
   the browser. All real protection comes from the Row Level Security rules
   in db/schema.sql, never from hiding this key. Never put the *service_role*
   key in this file; that one bypasses RLS entirely.

   Leave the placeholders as they are and the arcade still runs: games are
   fully playable, scores are kept in this browser only, and the leaderboards
   explain that they are offline.
   ========================================================================== */

export const SUPABASE_URL = "YOUR_SUPABASE_PROJECT_URL";
export const SUPABASE_ANON_KEY = "YOUR_SUPABASE_ANON_KEY";

export const isConfigured =
  SUPABASE_URL.startsWith("https://") && SUPABASE_ANON_KEY.length > 40;
