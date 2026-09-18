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

export const SUPABASE_URL = "https://qovhipzrljzfbndclrcw.supabase.co";
export const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFvdmhpcHpybGp6ZmJuZGNscmN3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk2ODI0MTEsImV4cCI6MjEwNTI1ODQxMX0.Kg_7fOydTYuNFue-whmdhu_ANJLUg57_XD4dQdV5rPM";

export const isConfigured =
  SUPABASE_URL.startsWith("https://") && SUPABASE_ANON_KEY.length > 40;
