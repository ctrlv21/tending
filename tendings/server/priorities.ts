import { createServerSupabaseClient } from "../../server/supabaseServer.js";
import { gmailSenders } from "./gmail.js";

type RequestLike = { headers?: Record<string, string | string[] | undefined>; query?: Record<string, string | string[] | undefined>; method?: string };
type ResponseLike = { status: (code: number) => ResponseLike; json: (payload: unknown) => unknown };
const first = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] : value;
function config() { const url = String(process.env.TENDING_SUPABASE_URL ?? "").trim(); const key = String(process.env.TENDING_SUPABASE_SERVICE_ROLE_KEY ?? "").trim(); if (!url || !key) throw new Error("Tending is not configured."); return { url, key }; }
async function user(request: RequestLike) { const token = first(request.headers?.authorization)?.match(/^Bearer\s+(.+)$/i)?.[1]; if (!token) throw new Error("Sign in is required."); const settings = config(); const client = createServerSupabaseClient(settings.url, settings.key); const { data: { user }, error } = await client.auth.getUser(token); if (error || !user) throw new Error("Your session has expired. Please sign in again."); return { user, client }; }

export async function priorities(request: RequestLike, response: ResponseLike) {
  try {
    const { user: owner, client } = await user(request);
    if (first(request.query?.resource) === "message-state") {
      const source = String(first(request.query?.source) ?? "");
      if (request.method === "GET") {
        await client.from("tending_message_states").update({ disposition: "open", snoozed_until: null, updated_at: new Date().toISOString() }).eq("owner_id", owner.id).eq("disposition", "snoozed").lte("snoozed_until", new Date().toISOString());
        const { data, error } = await client.from("tending_message_states").select("source, message_id, disposition, snoozed_until, updated_at").eq("owner_id", owner.id);
        if (error) throw error;
        return response.status(200).json({ states: data ?? [] });
      }
      if (request.method === "POST") {
        const messageId = String(first(request.query?.messageId) ?? "").trim();
        const disposition = String(first(request.query?.disposition) ?? "open");
        const snoozedUntil = String(first(request.query?.snoozedUntil) ?? "").trim() || null;
        if (!['gmail', 'x'].includes(source) || !messageId || !['open', 'handled', 'not_important', 'snoozed'].includes(disposition)) throw new Error("Invalid follow-through state.");
        if ((disposition === "snoozed") !== Boolean(snoozedUntil)) throw new Error("A snooze needs a wake-up time.");
        const { error } = await client.from("tending_message_states").upsert({ owner_id: owner.id, source, message_id: messageId, disposition, snoozed_until: snoozedUntil, updated_at: new Date().toISOString() }, { onConflict: "owner_id,source,message_id" });
        if (error) throw error;
      }
      return response.status(200).json({ saved: true });
    }
    const search = String(first(request.query?.search) ?? "").trim().slice(0, 80);
    if (request.method === "GET" && search.length >= 2) {
      let status = 200; let payload: unknown = { suggestions: [] };
      const relay = { status(code: number) { status = code; return relay; }, json(value: unknown) { payload = value; }, redirect() { return undefined; }, setHeader() { return undefined; } };
      // Node/Vercel request headers are not enumerable, so spreading the request
      // drops Authorization and made an authenticated contact lookup look signed out.
      await gmailSenders({ headers: request.headers, method: request.method, query: { ...request.query, query: search } }, relay);
      return response.status(status).json(payload);
    }
    if (request.method === "POST") {
      const identifier = String(first(request.query?.identifier) ?? "").replace(/^@/, "").trim();
      if (!identifier || identifier.length > 120) throw new Error("Add a name, email, or X handle.");
      const { error } = await client.from("tending_priority_people").upsert({ owner_id: owner.id, identifier, normalized_identifier: identifier.toLowerCase(), label: String(first(request.query?.label) ?? identifier).trim().slice(0, 120) }, { onConflict: "owner_id,normalized_identifier" });
      if (error) throw error;
    }
    if (request.method === "DELETE") { const id = String(first(request.query?.id) ?? ""); if (id) { const { error } = await client.from("tending_priority_people").delete().eq("owner_id", owner.id).eq("id", id); if (error) throw error; } }
    const { data, error } = await client.from("tending_priority_people").select("id, identifier, label").eq("owner_id", owner.id).order("created_at", { ascending: true });
    if (error) throw error;
    return response.status(200).json({ people: data ?? [] });
  } catch (error) { return response.status(400).json({ people: [], error: error instanceof Error ? error.message : "Could not update priority people." }); }
}
