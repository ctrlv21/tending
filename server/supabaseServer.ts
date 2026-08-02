import { createClient } from "@supabase/supabase-js";
import WebSocket from "ws";

export function createServerSupabaseClient(url: string, serviceKey: string) {
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { transport: WebSocket as unknown as typeof globalThis.WebSocket },
  });
}
