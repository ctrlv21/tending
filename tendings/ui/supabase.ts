import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_TENDING_SUPABASE_URL as string | undefined;
const publishableKey = import.meta.env.VITE_TENDING_SUPABASE_PUBLISHABLE_KEY as string | undefined;

export const tendingSupabase = url && publishableKey
  ? createClient(url, publishableKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    })
  : null;
