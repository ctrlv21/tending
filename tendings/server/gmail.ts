import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { createServerSupabaseClient } from "../../server/supabaseServer.js";

type RequestLike = { headers?: Record<string, string | string[] | undefined>; url?: string; method?: string; query?: Record<string, string | string[] | undefined> };
type ResponseLike = { status: (code: number) => ResponseLike; json: (payload: unknown) => unknown; redirect: (code: number, location: string) => unknown; setHeader: (name: string, value: string | string[]) => void };

const STATE_TTL_MS = 10 * 60 * 1000;
const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

type GmailConfig = { clientId: string; clientSecret: string; encryptionKey: string; supabaseUrl: string; serviceKey: string };
type GmailConnectionRow = { owner_id: string; gmail_email: string | null; access_token_encrypted: string; refresh_token_encrypted: string | null; token_expires_at: string; history_id: string | null; status: string; last_synced_at: string | null };

function first(value: string | string[] | undefined) { return Array.isArray(value) ? value[0] : value; }
function getConfig(): GmailConfig {
  const clientId = String(process.env.GMAIL_OAUTH_CLIENT_ID ?? "").trim();
  const clientSecret = String(process.env.GMAIL_OAUTH_CLIENT_SECRET ?? "").trim();
  const encryptionKey = String(process.env.TOKEN_ENCRYPTION_KEY ?? "").trim();
  const supabaseUrl = String(process.env.TENDING_SUPABASE_URL || process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "").trim();
  const serviceKey = String(process.env.TENDING_SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (!clientId || !clientSecret || !encryptionKey || !supabaseUrl || !serviceKey) throw new Error("Gmail is not configured.");
  if (encryptionKey.length < 32) throw new Error("TOKEN_ENCRYPTION_KEY must contain at least 32 characters.");
  return { clientId, clientSecret, encryptionKey, supabaseUrl, serviceKey };
}
function base64url(value: Buffer) { return value.toString("base64url"); }
function digest(value: string) { return createHash("sha256").update(value).digest("base64url"); }
function encrypt(value: string, secret: string) {
  const key = createHash("sha256").update(secret).digest(); const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `v1.${base64url(iv)}.${base64url(cipher.getAuthTag())}.${base64url(ciphertext)}`;
}
function decrypt(payload: string, secret: string) {
  const [version, ivText, tagText, ciphertextText] = payload.split(".");
  if (version !== "v1" || !ivText || !tagText || !ciphertextText) throw new Error("Unsupported encrypted Gmail credential.");
  const key = createHash("sha256").update(secret).digest(); const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivText, "base64url"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextText, "base64url")), decipher.final()]).toString("utf8");
}
function appUrl(request: RequestLike) {
  const configured = String(process.env.TENDING_APP_URL ?? "").trim(); if (configured) return configured.replace(/\/$/, "");
  const host = first(request.headers?.["x-forwarded-host"]) || first(request.headers?.host) || "localhost:5173"; const protocol = first(request.headers?.["x-forwarded-proto"]) || (host.startsWith("localhost") ? "http" : "https"); return `${protocol}://${host}`;
}
function callbackUrl(request: RequestLike) { return `${appUrl(request)}/api/tending/gmail/callback`; }
function db(config: GmailConfig) { return createServerSupabaseClient(config.supabaseUrl, config.serviceKey); }
async function getConnection(ownerId: string, config: GmailConfig) { const { data, error } = await db(config).from("tending_gmail_connections").select("*").eq("owner_id", ownerId).maybeSingle(); if (error) throw error; return data as GmailConnectionRow | null; }
async function getAuthenticatedUser(request: RequestLike, config: GmailConfig) {
  const authorization = first(request.headers?.authorization);
  const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) throw new Error("Sign in is required before connecting Gmail.");
  const { data: { user }, error } = await db(config).auth.getUser(token);
  if (error || !user) throw new Error("Your session has expired. Please sign in again.");
  const { error: profileError } = await db(config).from("tending_profiles").upsert({
    id: user.id,
    email: user.email ?? null,
    display_name: typeof user.user_metadata?.full_name === "string" ? user.user_metadata.full_name : null,
    updated_at: new Date().toISOString(),
  }, { onConflict: "id" });
  if (profileError) throw profileError;
  return user;
}

async function refreshAccessToken(connection: GmailConnectionRow, config: GmailConfig) {
  if (new Date(connection.token_expires_at).getTime() > Date.now() + 60_000) return decrypt(connection.access_token_encrypted, config.encryptionKey);
  if (!connection.refresh_token_encrypted) throw new Error("Gmail needs to be reconnected.");
  const refreshToken = decrypt(connection.refresh_token_encrypted, config.encryptionKey);
  const body = new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" });
  const response = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body }); const payload = await response.json() as { access_token?: string; expires_in?: number; error?: string };
  if (!response.ok || !payload.access_token) { await db(config).from("tending_gmail_connections").update({ status: "needs_reconnect", updated_at: new Date().toISOString() }).eq("owner_id", connection.owner_id); throw new Error(payload.error === "invalid_grant" ? "Gmail needs to be reconnected." : "Gmail token refresh failed."); }
  await db(config).from("tending_gmail_connections").update({ access_token_encrypted: encrypt(payload.access_token, config.encryptionKey), token_expires_at: new Date(Date.now() + (payload.expires_in ?? 3600) * 1000).toISOString(), status: "connected", updated_at: new Date().toISOString() }).eq("owner_id", connection.owner_id); return payload.access_token;
}

export async function gmailStatus(request: RequestLike, response: ResponseLike) {
  let config: GmailConfig;
  try { config = getConfig(); }
  catch (error) { response.setHeader("Cache-Control", "no-store"); return response.status(200).json({ configured: false, connected: false, status: "setup_required", message: error instanceof Error ? error.message : "Gmail is not configured." }); }
  try { const user = await getAuthenticatedUser(request, config); const connection = await getConnection(user.id, config); response.setHeader("Cache-Control", "no-store"); return response.status(200).json({ configured: true, connected: connection?.status === "connected", status: connection?.status ?? "not_connected", email: connection?.gmail_email ?? null, lastSyncedAt: connection?.last_synced_at ?? null }); }
  catch (error) { response.setHeader("Cache-Control", "no-store"); return response.status(200).json({ configured: true, connected: false, status: "sign_in_required", message: error instanceof Error ? error.message : "Sign in is required before connecting Gmail." }); }
}

export async function gmailStart(request: RequestLike, response: ResponseLike) {
  try {
    const config = getConfig(); const user = await getAuthenticatedUser(request, config); const state = base64url(randomBytes(32)); const verifier = base64url(randomBytes(48)); const redirectUri = callbackUrl(request); const now = new Date();
    await db(config).from("tending_gmail_oauth_states").delete().lt("expires_at", now.toISOString());
    const { error } = await db(config).from("tending_gmail_oauth_states").insert({ state_hash: digest(state), owner_id: user.id, code_verifier_encrypted: encrypt(verifier, config.encryptionKey), redirect_uri: redirectUri, expires_at: new Date(now.getTime() + STATE_TTL_MS).toISOString() }); if (error) throw error;
    const query = new URLSearchParams({ client_id: config.clientId, redirect_uri: redirectUri, response_type: "code", scope: GMAIL_SCOPE, access_type: "offline", prompt: "consent", include_granted_scopes: "true", state, code_challenge: digest(verifier), code_challenge_method: "S256" }); return response.status(200).json({ authorizationUrl: `https://accounts.google.com/o/oauth2/v2/auth?${query}` });
  } catch (error) { return response.status(500).json({ error: error instanceof Error ? error.message : "Could not start Gmail connection." }); }
}

export async function gmailCallback(request: RequestLike, response: ResponseLike) {
  const code = first(request.query?.code); const state = first(request.query?.state); const providerError = first(request.query?.error); if (providerError || !code || !state) return response.redirect(302, `${appUrl(request)}/?gmail=cancelled`);
  try {
    const config = getConfig(); const { data: oauthState, error: stateError } = await db(config).from("tending_gmail_oauth_states").delete().eq("state_hash", digest(state)).select("owner_id, code_verifier_encrypted, redirect_uri, expires_at").maybeSingle(); if (stateError) throw stateError; if (!oauthState || new Date(oauthState.expires_at).getTime() < Date.now()) throw new Error("Your Gmail connection link expired. Please try again."); const ownerId = oauthState.owner_id;
    const body = new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, code, redirect_uri: oauthState.redirect_uri, grant_type: "authorization_code", code_verifier: decrypt(oauthState.code_verifier_encrypted, config.encryptionKey) }); const tokenResponse = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body }); const token = await tokenResponse.json() as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string }; if (!tokenResponse.ok || !token.access_token) throw new Error(token.error || "Google did not return an access token.");
    const profileResponse = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", { headers: { Authorization: `Bearer ${token.access_token}` } }); const profile = await profileResponse.json() as { emailAddress?: string; historyId?: string }; if (!profileResponse.ok) throw new Error("Gmail profile could not be read."); const now = new Date().toISOString();
    const { error: connectionError } = await db(config).from("tending_gmail_connections").upsert({ owner_id: ownerId, gmail_email: profile.emailAddress ?? null, access_token_encrypted: encrypt(token.access_token, config.encryptionKey), refresh_token_encrypted: token.refresh_token ? encrypt(token.refresh_token, config.encryptionKey) : null, token_expires_at: new Date(Date.now() + (token.expires_in ?? 3600) * 1000).toISOString(), history_id: profile.historyId ?? null, status: "connected", connected_at: now, updated_at: now }, { onConflict: "owner_id" }); if (connectionError) throw connectionError;
    await syncGmail(ownerId, config); return response.redirect(302, `${appUrl(request)}/?gmail=connected`);
  } catch (error) { return response.redirect(302, `${appUrl(request)}/?gmail=error&message=${encodeURIComponent(error instanceof Error ? error.message : "Gmail connection failed.")}`); }
}

function header(headers: Array<{ name?: string; value?: string }> | undefined, name: string) { return headers?.find((item) => item.name?.toLowerCase() === name.toLowerCase())?.value ?? ""; }
function senderName(value: string) { return value.replace(/\s*<[^>]+>/, "").replace(/"/g, "").trim() || "Unknown sender"; }
function preview(value: string) { return value.replace(/\s+/g, " ").replace(/^(re|fw|fwd):\s*/i, "").trim().slice(0, 220); }
function looksReplyWorthy(subject: string, snippet: string) { return /\?|\b(can you|could you|would you|please|let me know|thoughts\?|confirm|urgent|asap|deadline|today|tomorrow|time-sensitive|important|need your|action required)\b/i.test(`${subject} ${snippet}`); }
export async function syncGmail(ownerId: string, config: GmailConfig) {
  const connection = await getConnection(ownerId, config); if (!connection || connection.status !== "connected") throw new Error("Gmail is not connected."); const accessToken = await refreshAccessToken(connection, config);
  const threadsResponse = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/threads?labelIds=INBOX&maxResults=50", { headers: { Authorization: `Bearer ${accessToken}` } }); const listing = await threadsResponse.json() as { threads?: Array<{ id: string }>; error?: { message?: string } }; if (!threadsResponse.ok) throw new Error(listing.error?.message || "Gmail inbox could not be read.");
  const threads = await Promise.all((listing.threads ?? []).slice(0, 30).map(async ({ id }) => { const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`, { headers: { Authorization: `Bearer ${accessToken}` } }); if (!response.ok) return null; const thread = await response.json() as { id: string; snippet?: string; messages?: Array<{ internalDate?: string; labelIds?: string[]; payload?: { headers?: Array<{ name?: string; value?: string }> } }> }; const latest = thread.messages?.[thread.messages.length - 1]; if (!latest) return null; const subject = header(latest.payload?.headers, "Subject") || "No subject"; const snippet = preview(thread.snippet ?? ""); const unread = Boolean(latest.labelIds?.includes("UNREAD")); const fromValue = header(latest.payload?.headers, "From"); const inbound = !connection.gmail_email || !fromValue.toLowerCase().includes(connection.gmail_email.toLowerCase()); return { owner_id: ownerId, gmail_thread_id: thread.id, sender: senderName(fromValue), subject, snippet, latest_message_at: new Date(Number(latest.internalDate ?? Date.now())).toISOString(), unread, reply_worthy: inbound && looksReplyWorthy(subject, snippet), source_url: `https://mail.google.com/mail/u/0/#inbox/${thread.id}`, updated_at: new Date().toISOString() }; }));
  const usable = threads.filter((thread): thread is NonNullable<typeof thread> => Boolean(thread)); if (usable.length) { const { error } = await db(config).from("tending_gmail_threads").upsert(usable, { onConflict: "owner_id,gmail_thread_id" }); if (error) throw error; }
  await db(config).from("tending_gmail_connections").update({ last_synced_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("owner_id", ownerId); return usable.length;
}
export async function gmailSync(request: RequestLike, response: ResponseLike) { try { const config = getConfig(); const user = await getAuthenticatedUser(request, config); const count = await syncGmail(user.id, config); return response.status(200).json({ synced: true, count }); } catch (error) { return response.status(400).json({ synced: false, error: error instanceof Error ? error.message : "Gmail sync failed." }); } }
export async function gmailThreads(request: RequestLike, response: ResponseLike) {
  try {
    const config = getConfig(); const user = await getAuthenticatedUser(request, config);
    const { data, error } = await db(config).from("tending_gmail_threads").select("gmail_thread_id, sender, subject, snippet, latest_message_at, unread, reply_worthy, source_url").eq("owner_id", user.id).eq("reply_worthy", true).order("latest_message_at", { ascending: false }).limit(30);
    if (error) throw error;
    response.setHeader("Cache-Control", "no-store"); return response.status(200).json({ threads: data ?? [] });
  } catch (error) { return response.status(400).json({ threads: [], error: error instanceof Error ? error.message : "Gmail messages could not be loaded." }); }
}
