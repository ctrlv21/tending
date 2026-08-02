import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { createServerSupabaseClient } from "../../server/supabaseServer.js";

type RequestLike = { headers?: Record<string, string | string[] | undefined>; query?: Record<string, string | string[] | undefined> };
type ResponseLike = { status: (code: number) => ResponseLike; json: (payload: unknown) => unknown; redirect: (code: number, location: string) => unknown; setHeader: (name: string, value: string | string[]) => void };
type Config = { clientId: string; clientSecret: string; encryptionKey: string; supabaseUrl: string; serviceKey: string };
type Connection = { owner_id: string; x_user_id: string; username: string | null; access_token_encrypted: string; refresh_token_encrypted: string | null; token_expires_at: string; status: string; last_synced_at: string | null };

const STATE_TTL_MS = 10 * 60 * 1000;
const X_SCOPE = "dm.read users.read follows.read tweet.read offline.access";
const first = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] : value;
const digest = (value: string) => createHash("sha256").update(value).digest("base64url");
const base64url = (value: Buffer) => value.toString("base64url");

function getConfig(): Config {
  const clientId = String(process.env.X_OAUTH_CLIENT_ID ?? "").trim();
  const clientSecret = String(process.env.X_OAUTH_CLIENT_SECRET ?? "").trim();
  const encryptionKey = String(process.env.TOKEN_ENCRYPTION_KEY ?? "").trim();
  const supabaseUrl = String(process.env.TENDING_SUPABASE_URL || process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "").trim();
  const serviceKey = String(process.env.TENDING_SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (!clientId || !clientSecret || !encryptionKey || !supabaseUrl || !serviceKey) throw new Error("X is not configured.");
  if (encryptionKey.length < 32) throw new Error("TOKEN_ENCRYPTION_KEY must contain at least 32 characters.");
  return { clientId, clientSecret, encryptionKey, supabaseUrl, serviceKey };
}
function db(config: Config) { return createServerSupabaseClient(config.supabaseUrl, config.serviceKey); }
function encrypt(value: string, secret: string) { const key = createHash("sha256").update(secret).digest(); const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", key, iv); const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]); return `v1.${base64url(iv)}.${base64url(cipher.getAuthTag())}.${base64url(ciphertext)}`; }
function decrypt(payload: string, secret: string) { const [version, iv, tag, ciphertext] = payload.split("."); if (version !== "v1" || !iv || !tag || !ciphertext) throw new Error("Unsupported encrypted X credential."); const decipher = createDecipheriv("aes-256-gcm", createHash("sha256").update(secret).digest(), Buffer.from(iv, "base64url")); decipher.setAuthTag(Buffer.from(tag, "base64url")); return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8"); }
function appUrl(request: RequestLike) { const configured = String(process.env.TENDING_APP_URL ?? "").trim(); if (configured) return configured.replace(/\/$/, ""); const host = first(request.headers?.["x-forwarded-host"]) || first(request.headers?.host) || "localhost:5175"; const protocol = first(request.headers?.["x-forwarded-proto"]) || (host.startsWith("localhost") ? "http" : "https"); return `${protocol}://${host}`; }
function callbackUrl(request: RequestLike) { return `${appUrl(request)}/api/tending/x/callback`; }
async function currentUser(request: RequestLike, config: Config) { const token = first(request.headers?.authorization)?.match(/^Bearer\s+(.+)$/i)?.[1]; if (!token) throw new Error("Sign in is required before connecting X."); const { data: { user }, error } = await db(config).auth.getUser(token); if (error || !user) throw new Error("Your session has expired. Please sign in again."); await db(config).from("tending_profiles").upsert({ id: user.id, email: user.email ?? null, display_name: typeof user.user_metadata?.full_name === "string" ? user.user_metadata.full_name : null, updated_at: new Date().toISOString() }, { onConflict: "id" }); return user; }
async function connection(ownerId: string, config: Config) { const { data, error } = await db(config).from("tending_x_connections").select("*").eq("owner_id", ownerId).maybeSingle(); if (error) throw error; return data as Connection | null; }
async function accessToken(item: Connection, config: Config) { if (new Date(item.token_expires_at).getTime() > Date.now() + 60_000) return decrypt(item.access_token_encrypted, config.encryptionKey); if (!item.refresh_token_encrypted) throw new Error("X needs to be reconnected."); const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: decrypt(item.refresh_token_encrypted, config.encryptionKey), client_id: config.clientId }); const response = await fetch("https://api.x.com/2/oauth2/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}` }, body }); const token = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string }; if (!response.ok || !token.access_token) throw new Error(token.error || "X token refresh failed."); await db(config).from("tending_x_connections").update({ access_token_encrypted: encrypt(token.access_token, config.encryptionKey), refresh_token_encrypted: token.refresh_token ? encrypt(token.refresh_token, config.encryptionKey) : item.refresh_token_encrypted, token_expires_at: new Date(Date.now() + (token.expires_in ?? 7200) * 1000).toISOString(), updated_at: new Date().toISOString() }).eq("owner_id", item.owner_id); return token.access_token; }
type XEvent = { id: string; sender_id?: string; text?: string; created_at?: string; dm_conversation_id?: string };
type XUser = { id: string; name?: string; username?: string; verified?: boolean; public_metrics?: { followers_count?: number; following_count?: number } };
type Classification = "needs_reply" | "worth_a_look" | "filtered" | "not_pending";

function hasReplySignal(text: string) { return /\?|\b(can you|could you|would you|please|let me know|thoughts\?|confirm|urgent|asap|deadline|today|tomorrow|time-sensitive|important|need your|action required)\b/i.test(text); }
function spamScore(text: string) {
  const links = text.match(/https?:\/\/\S+/gi)?.length ?? 0;
  let score = links > 1 ? 3 : links === 1 ? 1 : 0;
  if (/\b(airdrop|crypto|giveaway|investment opportunity|forex|onlyfans|telegram|whatsapp|make money|earn \$|sponsor(?:ship)?|promote|collab(?:oration)?|click (?:here|the link))\b/i.test(text)) score += 5;
  if (/\b(hello dear|kindly|congratulations[,!]? you(?:'ve| have) been selected)\b/i.test(text)) score += 3;
  return score;
}
function classify(event: XEvent, senderFollowed: boolean, sender: XUser | undefined, isLatestInbound: boolean) {
  const text = event.text ?? "";
  const directAsk = hasReplySignal(text);
  const risk = spamScore(text);
  let relevance = (senderFollowed ? 4 : 0) + (directAsk ? 3 : 0);
  if (sender?.verified) relevance += 1;
  if ((sender?.public_metrics?.followers_count ?? 0) > 100) relevance += 1;
  relevance -= risk;
  const classification: Classification = !isLatestInbound ? "not_pending" : risk >= 5 && relevance < 3 ? "filtered" : directAsk || (senderFollowed && relevance >= 4) ? "needs_reply" : relevance >= 1 ? "worth_a_look" : "filtered";
  return { classification, relevance, risk };
}
async function followedIds(token: string, userId: string) {
  const following = new Set<string>();
  let paginationToken: string | undefined;
  // A bounded cache of recent follows is enough to rank the DM queue and avoids an unbounded sync.
  for (let page = 0; page < 10; page += 1) {
    const query = new URLSearchParams({ max_results: "100", "user.fields": "id" });
    if (paginationToken) query.set("pagination_token", paginationToken);
    const response = await fetch(`https://api.x.com/2/users/${userId}/following?${query}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) return following;
    const payload = await response.json() as { data?: Array<{ id: string }>; meta?: { next_token?: string } };
    for (const person of payload.data ?? []) following.add(person.id);
    paginationToken = payload.meta?.next_token;
    if (!paginationToken) break;
  }
  return following;
}

export async function xStatus(request: RequestLike, response: ResponseLike) { let config: Config; try { config = getConfig(); } catch (error) { return response.status(200).json({ configured: false, connected: false, status: "setup_required", message: error instanceof Error ? error.message : "X is not configured." }); } try { const user = await currentUser(request, config); const item = await connection(user.id, config); return response.status(200).json({ configured: true, connected: item?.status === "connected", status: item?.status ?? "not_connected", username: item?.username ?? null, lastSyncedAt: item?.last_synced_at ?? null }); } catch (error) { return response.status(200).json({ configured: true, connected: false, status: "sign_in_required", message: error instanceof Error ? error.message : "Sign in is required before connecting X." }); } }
export async function xStart(request: RequestLike, response: ResponseLike) { try { const config = getConfig(); const user = await currentUser(request, config); const state = base64url(randomBytes(32)); const verifier = base64url(randomBytes(48)); const redirectUri = callbackUrl(request); const { error } = await db(config).from("tending_x_oauth_states").insert({ state_hash: digest(state), owner_id: user.id, code_verifier_encrypted: encrypt(verifier, config.encryptionKey), redirect_uri: redirectUri, expires_at: new Date(Date.now() + STATE_TTL_MS).toISOString() }); if (error) throw error; const query = new URLSearchParams({ response_type: "code", client_id: config.clientId, redirect_uri: redirectUri, scope: X_SCOPE, state, code_challenge: digest(verifier), code_challenge_method: "S256" }); return response.status(200).json({ authorizationUrl: `https://x.com/i/oauth2/authorize?${query}` }); } catch (error) { return response.status(500).json({ error: error instanceof Error ? error.message : "Could not start X connection." }); } }
export async function xCallback(request: RequestLike, response: ResponseLike) { const code = first(request.query?.code); const state = first(request.query?.state); if (!code || !state || first(request.query?.error)) return response.redirect(302, `${appUrl(request)}/?x=cancelled`); try { const config = getConfig(); const { data: stateRow, error } = await db(config).from("tending_x_oauth_states").delete().eq("state_hash", digest(state)).select("owner_id, code_verifier_encrypted, redirect_uri, expires_at").maybeSingle(); if (error || !stateRow || new Date(stateRow.expires_at).getTime() < Date.now()) throw new Error("Your X connection link expired. Please try again."); const body = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: stateRow.redirect_uri, code_verifier: decrypt(stateRow.code_verifier_encrypted, config.encryptionKey), client_id: config.clientId }); const tokenResponse = await fetch("https://api.x.com/2/oauth2/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}` }, body }); const token = await tokenResponse.json() as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string }; if (!tokenResponse.ok || !token.access_token) throw new Error(token.error || "X did not return an access token."); const meResponse = await fetch("https://api.x.com/2/users/me?user.fields=name,username", { headers: { Authorization: `Bearer ${token.access_token}` } }); const me = await meResponse.json() as { data?: { id?: string; name?: string; username?: string } }; if (!meResponse.ok || !me.data?.id) throw new Error("X profile could not be read."); const now = new Date().toISOString(); const { error: upsertError } = await db(config).from("tending_x_connections").upsert({ owner_id: stateRow.owner_id, x_user_id: me.data.id, username: me.data.username ?? null, display_name: me.data.name ?? null, access_token_encrypted: encrypt(token.access_token, config.encryptionKey), refresh_token_encrypted: token.refresh_token ? encrypt(token.refresh_token, config.encryptionKey) : null, token_expires_at: new Date(Date.now() + (token.expires_in ?? 7200) * 1000).toISOString(), status: "connected", connected_at: now, updated_at: now }, { onConflict: "owner_id" }); if (upsertError) throw upsertError; await syncX(stateRow.owner_id, config); return response.redirect(302, `${appUrl(request)}/?x=connected`); } catch (error) { return response.redirect(302, `${appUrl(request)}/?x=error&message=${encodeURIComponent(error instanceof Error ? error.message : "X connection failed.")}`); } }
export async function syncX(ownerId: string, config: Config) {
  const item = await connection(ownerId, config);
  if (!item || item.status !== "connected") throw new Error("X is not connected.");
  const token = await accessToken(item, config);
  const query = new URLSearchParams({ max_results: "100", event_types: "MessageCreate", "dm_event.fields": "created_at,dm_conversation_id,sender_id,text", expansions: "sender_id", "user.fields": "name,username,verified,public_metrics" });
  const response = await fetch(`https://api.x.com/2/dm_events?${query}`, { headers: { Authorization: `Bearer ${token}` } });
  const payload = await response.json() as { data?: XEvent[]; includes?: { users?: XUser[] }; errors?: Array<{ detail?: string }> };
  if (!response.ok) throw new Error(payload.errors?.[0]?.detail || "X direct messages could not be read.");
  const events = payload.data ?? [];
  const users = new Map((payload.includes?.users ?? []).map((person) => [person.id, person]));
  const follows = await followedIds(token, item.x_user_id);
  const latestByConversation = new Map<string, XEvent>();
  for (const event of events) {
    const key = event.dm_conversation_id ?? event.id;
    const existing = latestByConversation.get(key);
    if (!existing || new Date(event.created_at ?? 0).getTime() > new Date(existing.created_at ?? 0).getTime()) latestByConversation.set(key, event);
  }
  const now = new Date().toISOString();
  const rows = events.map((event) => {
    const sender = users.get(event.sender_id ?? "");
    const inbound = event.sender_id !== item.x_user_id;
    const isLatestInbound = latestByConversation.get(event.dm_conversation_id ?? event.id)?.id === event.id && inbound;
    const senderFollowed = Boolean(event.sender_id && follows.has(event.sender_id));
    const scored = classify(event, senderFollowed, sender, isLatestInbound);
    return { owner_id: ownerId, x_event_id: event.id, conversation_id: event.dm_conversation_id ?? null, sender_id: event.sender_id ?? null, sender_name: sender?.name || sender?.username || (inbound ? "X user" : "You"), text: event.text ?? "", created_at_x: event.created_at ?? now, inbound, reply_worthy: scored.classification === "needs_reply", classification: scored.classification, relevance_score: scored.relevance, spam_score: scored.risk, sender_followed: senderFollowed, source_url: event.dm_conversation_id ? `https://x.com/messages/${event.dm_conversation_id}` : "https://x.com/messages", updated_at: now };
  });
  const { error: clearError } = await db(config).from("tending_x_events").update({ reply_worthy: false, classification: "not_pending", updated_at: now }).eq("owner_id", ownerId);
  if (clearError) throw clearError;
  if (rows.length) {
    const { error } = await db(config).from("tending_x_events").upsert(rows, { onConflict: "owner_id,x_event_id" });
    if (error) throw error;
  }
  await db(config).from("tending_x_connections").update({ last_synced_at: now, updated_at: now }).eq("owner_id", ownerId);
  return rows.filter((row) => row.classification !== "not_pending").length;
}
export async function xSync(request: RequestLike, response: ResponseLike) { try { const config = getConfig(); const user = await currentUser(request, config); return response.status(200).json({ synced: true, count: await syncX(user.id, config) }); } catch (error) { return response.status(400).json({ synced: false, error: error instanceof Error ? error.message : "X could not refresh." }); } }
export async function xEvents(request: RequestLike, response: ResponseLike) { try { const config = getConfig(); const user = await currentUser(request, config); const { data, error } = await db(config).from("tending_x_events").select("x_event_id, sender_name, text, created_at_x, reply_worthy, classification, sender_followed, source_url").eq("owner_id", user.id).eq("inbound", true).in("classification", ["needs_reply", "worth_a_look"]).order("created_at_x", { ascending: false }).limit(100); if (error) throw error; return response.status(200).json({ events: data ?? [] }); } catch (error) { return response.status(400).json({ events: [], error: error instanceof Error ? error.message : "X messages could not be loaded." }); } }
