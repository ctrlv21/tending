import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { createServerSupabaseClient } from "../../server/supabaseServer.js";
import { analyzeMessages, type MessageAnalysis } from "./messageAnalysis.js";

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
type XEvent = { id: string; sender_id?: string; text?: string; created_at?: string; dm_conversation_id?: string; participant_ids?: string[] };
type XUser = { id: string; name?: string; username?: string; verified?: boolean; description?: string; public_metrics?: { followers_count?: number; following_count?: number } };
type Classification = "needs_reply" | "worth_a_look" | "filtered" | "not_pending";

function hasReplySignal(text: string) { return /\?|\b(can you|could you|would you|please|let me know|thoughts\?|confirm|urgent|asap|deadline|today|tomorrow|time-sensitive|important|need your|action required)\b/i.test(text); }
function keywordMatch(text: string, words: string[]) { const lower = text.toLowerCase(); return words.some((word) => lower.includes(word)); }
function conversationKey(event: XEvent, ownerId: string) {
  // X supplies a stable conversation ID for normal DMs.  For the occasional
  // event without one, normalise all known participants (including ourselves)
  // so an inbound/outbound pair still has one key instead of two event keys.
  if (event.dm_conversation_id) return event.dm_conversation_id;
  const participants = new Set([ownerId, event.sender_id ?? "", ...(event.participant_ids ?? [])]);
  participants.delete("");
  return participants.size > 1 ? [...participants].sort().join("-") : event.id;
}
function spamScore(text: string) {
  const links = text.match(/https?:\/\/\S+/gi)?.length ?? 0;
  let score = links > 1 ? 3 : links === 1 ? 1 : 0;
  if (/\b(airdrop|crypto|giveaway|investment opportunity|forex|onlyfans|telegram|whatsapp|make money|earn \$|sponsor(?:ship)?|promote|collab(?:oration)?|click (?:here|the link)|send me your (?:email|number)|paid partnership|brand deal|check my profile)\b/i.test(text)) score += 5;
  if (/\b(hello dear|kindly|congratulations[,!]? you(?:'ve| have) been selected)\b/i.test(text)) score += 3;
  return score;
}
function botScore(sender: XUser | undefined) {
  if (!sender) return 2;
  const identity = `${sender.name ?? ""} ${sender.username ?? ""} ${sender.description ?? ""}`;
  const followers = sender.public_metrics?.followers_count ?? 0;
  const following = sender.public_metrics?.following_count ?? 0;
  let score = 0;
  if (/\b(bot|airdrop|crypto|trader|marketing|agency|growth|promo|support)\b/i.test(identity)) score += 3;
  if (/\d{4,}$/.test(sender.username ?? "")) score += 1;
  if (followers < 20 && following > 120) score += 2;
  if (!sender.verified && followers < 8) score += 2;
  return score;
}
function classify(event: XEvent, senderFollowed: boolean, sender: XUser | undefined, isLatestInbound: boolean, matchesKeyword: boolean, analysis?: MessageAnalysis) {
  const text = event.text ?? "";
  const directAsk = hasReplySignal(text);
  const risk = spamScore(text) + botScore(sender);
  const followers = sender?.public_metrics?.followers_count ?? 0;
  const following = sender?.public_metrics?.following_count ?? 0;
  const credibleUnfollowedSender = Boolean(sender?.verified || (followers >= 50 && following <= Math.max(300, followers * 4)));
  const humanAsk = directAsk && risk < 2;
  const ageHours = Math.max(0, (Date.now() - new Date(event.created_at ?? Date.now()).getTime()) / 3_600_000);
  let relevance = (senderFollowed ? 5 : 0) + (directAsk ? 3 : 0) + (matchesKeyword ? 3 : 0) + (credibleUnfollowedSender ? 1 : 0);
  if (sender?.verified) relevance += 1;
  if ((sender?.public_metrics?.followers_count ?? 0) > 100) relevance += 1;
  relevance -= risk;
  const deterministic: Classification = !isLatestInbound || (ageHours > 96 && !matchesKeyword)
    ? "not_pending"
    : risk >= 2
      ? "filtered"
      : humanAsk
        ? "needs_reply"
        : matchesKeyword
          ? "worth_a_look"
          : "filtered";
  // The action queue is deliberately strict. A contextual "watch" is useful
  // signal, but should not become another inbox unless the user asked us to
  // watch for that phrase. Old messages are likewise held out by default.
  const classification: Classification = !isLatestInbound || ageHours > 96 && !matchesKeyword || !analysis
    ? deterministic
    : analysis.urgency === "ignore"
      ? "filtered"
      : analysis.urgency === "urgent" || analysis.urgency === "reply"
        ? "needs_reply"
        : matchesKeyword ? "worth_a_look" : "filtered";
  return { classification, relevance: Math.max(relevance, analysis?.score ?? 0), risk };
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

async function testXFeedForOwner(ownerId: string, config: Config) {
  const item = await connection(ownerId, config);
  if (!item || item.status !== "connected") throw new Error("Connect X before testing its API feed.");
  const token = await accessToken(item, config);
  const query = new URLSearchParams({ max_results: "100", "dm_event.fields": "created_at,sender_id,text,dm_conversation_id" });
  const apiResponse = await fetch(`https://api.x.com/2/dm_events?${query}`, { headers: { Authorization: `Bearer ${token}` } });
  const payload = await apiResponse.json() as { data?: XEvent[]; errors?: Array<{ detail?: string; title?: string }> };
  const timestamps = (payload.data ?? []).map((event) => event.created_at).filter((value): value is string => Boolean(value)).sort();
  return { ok: apiResponse.ok, status: apiResponse.status, eventCount: payload.data?.length ?? 0, newestEventAt: timestamps[timestamps.length - 1] ?? null, requestId: apiResponse.headers.get("x-request-id") || apiResponse.headers.get("x-transaction-id"), error: apiResponse.ok ? null : payload.errors?.[0]?.detail || payload.errors?.[0]?.title || "X rejected the test request." };
}

export async function xStatus(request: RequestLike, response: ResponseLike) { let config: Config; try { config = getConfig(); } catch (error) { return response.status(200).json({ configured: false, connected: false, status: "setup_required", message: error instanceof Error ? error.message : "X is not configured." }); } try { const user = await currentUser(request, config); if (first(request.query?.test) === "1") { const result = await testXFeedForOwner(user.id, config); response.setHeader("Cache-Control", "no-store"); return response.status(result.ok ? 200 : 400).json(result); } const item = await connection(user.id, config); const { data: latest } = await db(config).from("tending_x_events").select("created_at_x").eq("owner_id", user.id).eq("inbound", true).order("created_at_x", { ascending: false }).limit(1).maybeSingle(); const latestEventAt = latest?.created_at_x ?? null; const delayed = Boolean(latestEventAt && Date.now() - new Date(latestEventAt).getTime() > 36 * 3_600_000); response.setHeader("Cache-Control", "no-store"); return response.status(200).json({ configured: true, connected: item?.status === "connected", status: item?.status ?? "not_connected", username: item?.username ?? null, lastSyncedAt: item?.last_synced_at ?? null, latestEventAt, dataFreshness: !item ? "not_connected" : !latestEventAt ? "no_messages" : delayed ? "delayed" : "current" }); } catch (error) { response.setHeader("Cache-Control", "no-store"); return response.status(200).json({ configured: true, connected: false, status: "sign_in_required", message: error instanceof Error ? error.message : "Sign in is required before connecting X." }); } }
export async function xStart(request: RequestLike, response: ResponseLike) { try { const config = getConfig(); const user = await currentUser(request, config); const state = base64url(randomBytes(32)); const verifier = base64url(randomBytes(48)); const redirectUri = callbackUrl(request); const { error } = await db(config).from("tending_x_oauth_states").insert({ state_hash: digest(state), owner_id: user.id, code_verifier_encrypted: encrypt(verifier, config.encryptionKey), redirect_uri: redirectUri, expires_at: new Date(Date.now() + STATE_TTL_MS).toISOString() }); if (error) throw error; const query = new URLSearchParams({ response_type: "code", client_id: config.clientId, redirect_uri: redirectUri, scope: X_SCOPE, state, code_challenge: digest(verifier), code_challenge_method: "S256" }); return response.status(200).json({ authorizationUrl: `https://x.com/i/oauth2/authorize?${query}` }); } catch (error) { return response.status(500).json({ error: error instanceof Error ? error.message : "Could not start X connection." }); } }
export async function xCallback(request: RequestLike, response: ResponseLike) { const code = first(request.query?.code); const state = first(request.query?.state); if (!code || !state || first(request.query?.error)) return response.redirect(302, `${appUrl(request)}/?x=cancelled`); try { const config = getConfig(); const { data: stateRow, error } = await db(config).from("tending_x_oauth_states").delete().eq("state_hash", digest(state)).select("owner_id, code_verifier_encrypted, redirect_uri, expires_at").maybeSingle(); if (error || !stateRow || new Date(stateRow.expires_at).getTime() < Date.now()) throw new Error("Your X connection link expired. Please try again."); const body = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: stateRow.redirect_uri, code_verifier: decrypt(stateRow.code_verifier_encrypted, config.encryptionKey), client_id: config.clientId }); const tokenResponse = await fetch("https://api.x.com/2/oauth2/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}` }, body }); const token = await tokenResponse.json() as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string }; if (!tokenResponse.ok || !token.access_token) throw new Error(token.error || "X did not return an access token."); const meResponse = await fetch("https://api.x.com/2/users/me?user.fields=name,username", { headers: { Authorization: `Bearer ${token.access_token}` } }); const me = await meResponse.json() as { data?: { id?: string; name?: string; username?: string } }; if (!meResponse.ok || !me.data?.id) throw new Error("X profile could not be read."); const now = new Date().toISOString(); const { error: upsertError } = await db(config).from("tending_x_connections").upsert({ owner_id: stateRow.owner_id, x_user_id: me.data.id, username: me.data.username ?? null, display_name: me.data.name ?? null, access_token_encrypted: encrypt(token.access_token, config.encryptionKey), refresh_token_encrypted: token.refresh_token ? encrypt(token.refresh_token, config.encryptionKey) : null, token_expires_at: new Date(Date.now() + (token.expires_in ?? 7200) * 1000).toISOString(), status: "connected", connected_at: now, updated_at: now }, { onConflict: "owner_id" }); if (upsertError) throw upsertError; await syncX(stateRow.owner_id, config); return response.redirect(302, `${appUrl(request)}/?x=connected`); } catch (error) { return response.redirect(302, `${appUrl(request)}/?x=error&message=${encodeURIComponent(error instanceof Error ? error.message : "X connection failed.")}`); } }
export async function syncX(ownerId: string, config: Config) {
  const item = await connection(ownerId, config);
  if (!item || item.status !== "connected") throw new Error("X is not connected.");
  const token = await accessToken(item, config);
  const events: XEvent[] = []; const users = new Map<string, XUser>(); let paginationToken: string | undefined;
  for (let page = 0; page < 5; page += 1) {
    const query = new URLSearchParams({ max_results: "100", event_types: "MessageCreate", "dm_event.fields": "created_at,dm_conversation_id,participant_ids,sender_id,text", expansions: "sender_id", "user.fields": "name,username,verified,description,public_metrics" });
    if (paginationToken) query.set("pagination_token", paginationToken);
    const response = await fetch(`https://api.x.com/2/dm_events?${query}`, { headers: { Authorization: `Bearer ${token}` } });
    const payload = await response.json() as { data?: XEvent[]; includes?: { users?: XUser[] }; errors?: Array<{ detail?: string }>; meta?: { next_token?: string } };
    if (!response.ok) throw new Error(payload.errors?.[0]?.detail || "X direct messages could not be read.");
    events.push(...(payload.data ?? []));
    for (const person of payload.includes?.users ?? []) users.set(person.id, person);
    paginationToken = payload.meta?.next_token;
    if (!paginationToken) break;
  }
  const follows = await followedIds(token, item.x_user_id);
  const { data: keywordRows } = await db(config).from("tending_watch_keywords").select("normalized_phrase").eq("owner_id", ownerId).eq("source", "x");
  const keywords = (keywordRows ?? []).map((row) => String(row.normalized_phrase));
  const latestByConversation = new Map<string, XEvent>();
  for (const event of events) {
    const key = conversationKey(event, item.x_user_id);
    const existing = latestByConversation.get(key);
    if (!existing || new Date(event.created_at ?? 0).getTime() > new Date(existing.created_at ?? 0).getTime()) latestByConversation.set(key, event);
  }
  const analyses = await analyzeMessages(events.filter((event) => {
    const inbound = event.sender_id !== item.x_user_id;
    const latest = latestByConversation.get(conversationKey(event, item.x_user_id))?.id === event.id;
    return inbound && latest && spamScore(event.text ?? "") + botScore(users.get(event.sender_id ?? "")) < 2;
  }).sort((a, b) => new Date(b.created_at ?? 0).getTime() - new Date(a.created_at ?? 0).getTime()).map((event) => { const sender = users.get(event.sender_id ?? ""); const metrics = sender?.public_metrics; return { id: event.id, source: "x" as const, text: event.text ?? "", ageHours: Math.max(0, Math.round((Date.now() - new Date(event.created_at ?? Date.now()).getTime()) / 3_600_000)), watchWord: keywordMatch(event.text ?? "", keywords), senderProfile: [sender?.name, sender?.username ? `@${sender.username}` : "", sender?.description, sender?.verified ? "verified" : "", metrics ? `${metrics.followers_count ?? 0} followers / ${metrics.following_count ?? 0} following` : "", event.sender_id && follows.has(event.sender_id) ? "you follow this account" : ""].filter(Boolean).join(" · ") }; }));
  const now = new Date().toISOString();
  const rows = events.map((event) => {
    const sender = users.get(event.sender_id ?? "");
    const inbound = event.sender_id !== item.x_user_id;
    const isLatestInbound = latestByConversation.get(conversationKey(event, item.x_user_id))?.id === event.id && inbound;
    const senderFollowed = Boolean(event.sender_id && follows.has(event.sender_id));
    const matchesKeyword = keywordMatch(event.text ?? "", keywords);
    const analysis = analyses.get(event.id);
    const scored = classify(event, senderFollowed, sender, isLatestInbound, matchesKeyword, analysis);
    return { owner_id: ownerId, x_event_id: event.id, conversation_id: event.dm_conversation_id ?? null, sender_id: event.sender_id ?? null, sender_name: sender?.name || sender?.username || (inbound ? "X user" : "You"), text: event.text ?? "", created_at_x: event.created_at ?? now, inbound, reply_worthy: scored.classification === "needs_reply", classification: scored.classification, relevance_score: scored.relevance, spam_score: scored.risk, sender_followed: senderFollowed, keyword_match: matchesKeyword, analysis_reason: analysis?.reason ?? null, analysis_provider: analysis ? "anthropic" : null, analyzed_at: analysis ? now : null, source_url: event.dm_conversation_id ? `https://x.com/messages/${event.dm_conversation_id}` : "https://x.com/messages", updated_at: now };
  });
  // An empty response is not evidence that the inbox is empty. X has
  // occasionally returned a partial/stale DM feed, so preserve the last
  // known queue until it returns at least one event we can reconcile.
  if (rows.length) {
    const { error: clearError } = await db(config).from("tending_x_events").update({ reply_worthy: false, classification: "not_pending", updated_at: now }).eq("owner_id", ownerId);
    if (clearError) throw clearError;
  }
  if (rows.length) {
    const { error } = await db(config).from("tending_x_events").upsert(rows, { onConflict: "owner_id,x_event_id" });
    if (error) throw error;
  }
  await db(config).from("tending_x_connections").update({ last_synced_at: now, updated_at: now }).eq("owner_id", ownerId);
  const newestInbound = rows.filter((row) => row.inbound).sort((a, b) => new Date(b.created_at_x).getTime() - new Date(a.created_at_x).getTime())[0]?.created_at_x ?? null;
  return {
    count: rows.filter((row) => row.classification !== "not_pending").length,
    latestEventAt: newestInbound,
    dataFreshness: !newestInbound ? "no_messages" : Date.now() - new Date(newestInbound).getTime() > 36 * 3_600_000 ? "delayed" : "current",
  };
}
export async function xSync(request: RequestLike, response: ResponseLike) { try { const config = getConfig(); const user = await currentUser(request, config); const result = await syncX(user.id, config); return response.status(200).json({ synced: true, ...result }); } catch (error) { return response.status(400).json({ synced: false, error: error instanceof Error ? error.message : "X could not refresh." }); } }
export async function xEvents(request: RequestLike, response: ResponseLike) { try { const config = getConfig(); const user = await currentUser(request, config); const { data, error } = await db(config).from("tending_x_events").select("x_event_id, sender_name, text, created_at_x, reply_worthy, classification, sender_followed, keyword_match, analysis_reason, source_url").eq("owner_id", user.id).eq("inbound", true).in("classification", ["needs_reply", "worth_a_look"]).order("relevance_score", { ascending: false }).order("created_at_x", { ascending: false }).limit(100); if (error) throw error; return response.status(200).json({ events: data ?? [] }); } catch (error) { return response.status(400).json({ events: [], error: error instanceof Error ? error.message : "X messages could not be loaded." }); } }
