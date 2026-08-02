import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_TENDING_SUPABASE_URL as string | undefined;
const publishableKey = import.meta.env.VITE_TENDING_SUPABASE_PUBLISHABLE_KEY as string | undefined;

let client: SupabaseClient | null = null;

if (url && publishableKey) {
  try {
    client = createClient(url, publishableKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    });
  } catch {
    // Keep the dashboard available when a deployment has placeholder configuration.
    // The connection UI will explain that sign-in still needs to be configured.
    client = null;
  }
}

export const tendingSupabase = client;
