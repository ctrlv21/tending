import { createServerSupabaseClient } from "../../server/supabaseServer.js";

type RequestLike = { headers?: Record<string, string | string[] | undefined>; query?: Record<string, string | string[] | undefined>; method?: string };
type ResponseLike = { status: (code: number) => ResponseLike; json: (payload: unknown) => unknown };
type Source = "gmail" | "x";
const first = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] : value;
function config() { const url = String(process.env.TENDING_SUPABASE_URL ?? "").trim(); const key = String(process.env.TENDING_SUPABASE_SERVICE_ROLE_KEY ?? "").trim(); if (!url || !key) throw new Error("Tending is not configured."); return { url, key }; }
async function user(request: RequestLike) { const token = first(request.headers?.authorization)?.match(/^Bearer\s+(.+)$/i)?.[1]; if (!token) throw new Error("Sign in is required."); const settings = config(); const client = createServerSupabaseClient(settings.url, settings.key); const { data: { user }, error } = await client.auth.getUser(token); if (error || !user) throw new Error("Your session has expired. Please sign in again."); return { user, client }; }
function source(value: string | undefined): Source { if (value === "gmail" || value === "x") return value; throw new Error("Choose Gmail or X."); }

export async function keywords(request: RequestLike, response: ResponseLike) {
  try {
    const { user: owner, client } = await user(request);
    const selectedSource = source(String(first(request.query?.source) ?? ""));
    if (request.method === "POST") {
      const phrase = String(first(request.query?.phrase) ?? "").trim().replace(/\s+/g, " ");
      if (phrase.length < 2 || phrase.length > 60) throw new Error("Use a word or short phrase between 2 and 60 characters.");
      const { error } = await client.from("tending_watch_keywords").upsert({ owner_id: owner.id, source: selectedSource, phrase, normalized_phrase: phrase.toLowerCase() }, { onConflict: "owner_id,source,normalized_phrase" });
      if (error) throw error;
    }
    if (request.method === "DELETE") { const id = String(first(request.query?.id) ?? ""); if (id) { const { error } = await client.from("tending_watch_keywords").delete().eq("owner_id", owner.id).eq("source", selectedSource).eq("id", id); if (error) throw error; } }
    const { data, error } = await client.from("tending_watch_keywords").select("id, phrase, source").eq("owner_id", owner.id).eq("source", selectedSource).order("created_at", { ascending: true });
    if (error) throw error;
    return response.status(200).json({ keywords: data ?? [] });
  } catch (error) { return response.status(400).json({ keywords: [], error: error instanceof Error ? error.message : "Could not update watch words." }); }
}
