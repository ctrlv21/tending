import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { createServerSupabaseClient } from "../../server/supabaseServer.js";
import { analyzeMessages } from "./messageAnalysis.js";

type RequestLike = { headers?: Record<string, string | string[] | undefined>; url?: string; method?: string; query?: Record<string, string | string[] | undefined> };
type ResponseLike = { status: (code: number) => ResponseLike; json: (payload: unknown) => unknown; redirect: (code: number, location: string) => unknown; setHeader: (name: string, value: string | string[]) => void };

const STATE_TTL_MS = 10 * 60 * 1000;
const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/contacts.readonly";

type GmailConfig = { clientId: string; clientSecret: string; encryptionKey: string; supabaseUrl: string; serviceKey: string };
type GmailConnectionRow = { id: string; owner_id: string; gmail_email: string | null; access_token_encrypted: string; refresh_token_encrypted: string | null; token_expires_at: string; history_id: string | null; status: string; last_synced_at: string | null };

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
async function getConnections(ownerId: string, config: GmailConfig) { const { data, error } = await db(config).from("tending_gmail_connections").select("*").eq("owner_id", ownerId).order("connected_at", { ascending: true }); if (error) throw error; return (data ?? []) as GmailConnectionRow[]; }
async function getConnection(ownerId: string, config: GmailConfig) { return (await getConnections(ownerId, config)).find((item) => item.status === "connected") ?? null; }
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
  if (!response.ok || !payload.access_token) { await db(config).from("tending_gmail_connections").update({ status: "needs_reconnect", updated_at: new Date().toISOString() }).eq("id", connection.id); throw new Error(payload.error === "invalid_grant" ? "Gmail needs to be reconnected." : "Gmail token refresh failed."); }
  await db(config).from("tending_gmail_connections").update({ access_token_encrypted: encrypt(payload.access_token, config.encryptionKey), token_expires_at: new Date(Date.now() + (payload.expires_in ?? 3600) * 1000).toISOString(), status: "connected", updated_at: new Date().toISOString() }).eq("id", connection.id); return payload.access_token;
}

export async function gmailStatus(request: RequestLike, response: ResponseLike) {
  let config: GmailConfig;
  try { config = getConfig(); }
  catch (error) { response.setHeader("Cache-Control", "no-store"); return response.status(200).json({ configured: false, connected: false, status: "setup_required", message: error instanceof Error ? error.message : "Gmail is not configured." }); }
  try { const user = await getAuthenticatedUser(request, config); const connections = await getConnections(user.id, config); const connected = connections.filter((item) => item.status === "connected"); const syncTimes = connected.map((item) => item.last_synced_at).filter((value): value is string => Boolean(value)).sort(); response.setHeader("Cache-Control", "no-store"); return response.status(200).json({ configured: true, connected: connected.length > 0, status: connected.length ? "connected" : connections[0]?.status ?? "not_connected", email: connected[0]?.gmail_email ?? null, emails: connected.map((item) => item.gmail_email).filter(Boolean), lastSyncedAt: syncTimes[syncTimes.length - 1] ?? null }); }
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
    const { error: connectionError } = await db(config).from("tending_gmail_connections").upsert({ owner_id: ownerId, gmail_email: profile.emailAddress ?? null, access_token_encrypted: encrypt(token.access_token, config.encryptionKey), refresh_token_encrypted: token.refresh_token ? encrypt(token.refresh_token, config.encryptionKey) : null, token_expires_at: new Date(Date.now() + (token.expires_in ?? 3600) * 1000).toISOString(), history_id: profile.historyId ?? null, status: "connected", connected_at: now, updated_at: now }, { onConflict: "owner_id,gmail_email" }); if (connectionError) throw connectionError;
    await syncGmail(ownerId, config); return response.redirect(302, `${appUrl(request)}/?gmail=connected`);
  } catch (error) { return response.redirect(302, `${appUrl(request)}/?gmail=error&message=${encodeURIComponent(error instanceof Error ? error.message : "Gmail connection failed.")}`); }
}

function header(headers: Array<{ name?: string; value?: string }> | undefined, name: string) { return headers?.find((item) => item.name?.toLowerCase() === name.toLowerCase())?.value ?? ""; }
function senderName(value: string) { return value.replace(/\s*<[^>]+>/, "").replace(/"/g, "").trim() || "Unknown sender"; }
function senderEmail(value: string) { return value.toLowerCase().match(/<([^>]+)>/)?.[1]?.trim() || (value.includes("@") ? value.trim().toLowerCase() : ""); }
function isAutomatedAddress(email: string) { return /(?:^|[._+-])(?:no-?reply|donotreply|notifications?|updates?|mailer-daemon)(?:[._+-]|@)|@(?:accounts|mail)\.google\.com$/i.test(email); }
function cleanMessageText(value: string) { return value.replace(/<(?:style|script)\b[^>]*>[\s\S]*?<\/(?:style|script)>/gi, " ").replace(/<[^>]*>/g, " ").replace(/(?:^|\s)[.#*]?[\w-]+\s*\{[^}]{0,800}\}/g, " ").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/\s+/g, " ").trim(); }
function preview(value: string) { return cleanMessageText(value).replace(/^(re|fw|fwd):\s*/i, "").slice(0, 220); }
function analysisPreview(value: string) { return cleanMessageText(value).slice(0, 900); }
function payloadText(payload: { mimeType?: string; body?: { data?: string }; parts?: Array<{ mimeType?: string; body?: { data?: string }; parts?: unknown[] }> } | undefined): string {
  if (!payload) return "";
  const decode = (data?: string) => data ? Buffer.from(data, "base64url").toString("utf8") : "";
  if (payload.mimeType === "text/plain") return decode(payload.body?.data);
  const plainPart = payload.parts?.find((part) => part.mimeType === "text/plain");
  if (plainPart) return decode(plainPart.body?.data);
  return decode(payload.body?.data) || payload.parts?.map((part) => decode(part.body?.data)).join(" ") || "";
}
function isCompletedTransaction(subject: string, snippet: string) { return /\b(payment (?:confirmation|received|processed|successful|scheduled)|receipt|thanks for your payment|(?:payment|transaction|transfer|order) (?:has )?(?:been )?(?:completed|confirmed|processed|scheduled|received)|autopay (?:confirmation|scheduled))\b/i.test(`${subject} ${snippet}`); }
function isRoutineNotice(subject: string, snippet: string) { return /\b(?:you (?:allowed|shared).{0,90}(?:google account data|access)|recent (?:trip|purchase|order).{0,80}(?:hear from you|feedback|survey)|tell us (?:about|how).{0,80}(?:trip|experience)|rate your experience)\b/i.test(`${subject} ${snippet}`); }
function hasAdministrativeSignal(subject: string, snippet: string) { return /\b(payment (?:due|overdue|failed|declined)|amount due|rent reminder|balance (?:below|low)|low balance|invoice (?:due|overdue)|bill(?:ing)? (?:due|overdue)|lease (?:renewal|ending)|renewal (?:due|ending)|subscription (?:renewal|ending)|appointment|meeting (?:rescheduled|cancelled|canceled|changed)|interview|sponsorship|partnership|proposal|contract|account (?:locked|suspended)|security alert|unrecognized (?:sign.?in|activity)|verification required|application (?:update|deadline)|reservation (?:changed|cancelled)|travel (?:change|alert))\b/i.test(`${subject} ${snippet}`); }
function looksReplyWorthy(subject: string, snippet: string) { if (isCompletedTransaction(subject, snippet) || isRoutineNotice(subject, snippet)) return false; return /\?|\b(can you|could you|would you|please|let me know|thoughts\?|confirm|urgent|asap|deadline|today|tomorrow|time-sensitive|important|need your|action required)\b/i.test(`${subject} ${snippet}`) || hasAdministrativeSignal(subject, snippet); }
function looksPromotional(from: string, labels: string[] | undefined, subject: string, snippet: string) { const text = `${subject} ${snippet}`; const email = senderEmail(from); const identity = `${from} ${email}`; if (labels?.some((label) => ["SPAM", "TRASH", "CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "CATEGORY_FORUMS"].includes(label))) return true; if (hasAdministrativeSignal(subject, snippet)) return false; return /(?:^|\b)(?:no-?reply|newsletter|notifications?|marketing|updates)@/i.test(email) || /\b(?:substack|aritzia)\b/i.test(identity) || /\b(unsubscribe|manage preferences|view (?:this )?in browser|weekly digest|new post from|recommended for you|shop now|free shipping|sale ends|airdrop|crypto|forex|telegram|whatsapp|make money|investment opportunity|paid partnership|brand deal|feedback|survey)\b/i.test(text); }
function keywordMatch(text: string, words: string[]) { const lower = text.toLowerCase(); return words.some((word) => lower.includes(word)); }
function urgencyScore(subject: string, snippet: string, unread: boolean, priorityPerson: boolean, matchesKeyword: boolean, latestAt: number) { const text = `${subject} ${snippet}`; let score = unread ? 1 : 0; if (priorityPerson) score += 4; if (matchesKeyword) score += 3; if (/\b(urgent|asap|action required|time-sensitive|eod|end of day)\b/i.test(text)) score += 5; if (hasAdministrativeSignal(subject, snippet)) score += 5; if (/\b(deadline|due|today|tomorrow|by friday|this week)\b/i.test(text)) score += 3; if (/\?|\b(can you|could you|would you|please|confirm|let me know)\b/i.test(text)) score += 2; if (Date.now() - latestAt > 86_400_000) score += 1; return score; }
export async function syncGmail(ownerId: string, config: GmailConfig) {
  const connections = (await getConnections(ownerId, config)).filter((item) => item.status === "connected"); if (!connections.length) throw new Error("Gmail is not connected.");
  const counts = await Promise.all(connections.map((connection) => syncGmailConnection(ownerId, config, connection)));
  return counts.reduce((total, count) => total + count, 0);
}
async function syncGmailConnection(ownerId: string, config: GmailConfig, connection: GmailConnectionRow) {
  const accessToken = await refreshAccessToken(connection, config);
  const { data: priorityRows } = await db(config).from("tending_priority_people").select("normalized_identifier").eq("owner_id", ownerId);
  const priorities = new Set((priorityRows ?? []).map((row) => String(row.normalized_identifier)));
  const { data: keywordRows } = await db(config).from("tending_watch_keywords").select("normalized_phrase").eq("owner_id", ownerId).eq("source", "gmail");
  const keywords = (keywordRows ?? []).map((row) => String(row.normalized_phrase));
  const threadsResponse = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/threads?labelIds=INBOX&maxResults=50", { headers: { Authorization: `Bearer ${accessToken}` } }); const listing = await threadsResponse.json() as { threads?: Array<{ id: string }>; error?: { message?: string } }; if (!threadsResponse.ok) throw new Error(listing.error?.message || "Gmail inbox could not be read.");
  const threads = await Promise.all((listing.threads ?? []).slice(0, 50).map(async ({ id }) => { const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(id)}?format=full`, { headers: { Authorization: `Bearer ${accessToken}` } }); if (!response.ok) return null; const thread = await response.json() as { id: string; snippet?: string; messages?: Array<{ internalDate?: string; labelIds?: string[]; payload?: { headers?: Array<{ name?: string; value?: string }>; mimeType?: string; body?: { data?: string }; parts?: Array<{ mimeType?: string; body?: { data?: string } }> } }> }; const latest = thread.messages?.[thread.messages.length - 1]; if (!latest) return null; const subject = header(latest.payload?.headers, "Subject") || "No subject"; const body = analysisPreview(payloadText(latest.payload)); const snippet = preview(thread.snippet || body); const unread = Boolean(latest.labelIds?.includes("UNREAD")); const fromValue = header(latest.payload?.headers, "From"); const sender = senderName(fromValue); const email = senderEmail(fromValue); const latestAt = Number(latest.internalDate ?? Date.now()); const text = `${snippet} ${body}`; const completedTransaction = isCompletedTransaction(subject, text); const routineNotice = isRoutineNotice(subject, text); const suppressed = looksPromotional(fromValue, latest.labelIds, subject, text) || completedTransaction || routineNotice; const priorityPerson = priorities.has(sender.toLowerCase()) || priorities.has(email); const matchesKeyword = keywordMatch(`${subject} ${text}`, keywords); const score = suppressed ? 0 : urgencyScore(subject, text, unread, priorityPerson, matchesKeyword, latestAt); const inbound = !connection.gmail_email || !fromValue.toLowerCase().includes(connection.gmail_email.toLowerCase()); return { owner_id: ownerId, gmail_connection_id: connection.id, gmail_thread_id: thread.id, sender, sender_email: email || null, subject, snippet, latest_message_at: new Date(latestAt).toISOString(), unread, reply_worthy: inbound && unread && !suppressed && (looksReplyWorthy(subject, text) || priorityPerson || matchesKeyword), source_url: `https://mail.google.com/mail/u/${encodeURIComponent(connection.gmail_email ?? "0")}/#all/${thread.id}`, updated_at: new Date().toISOString(), importance_score: score, urgency: score >= 7 ? "urgent" : score >= 3 ? "reply" : "watch", priority_person: priorityPerson, keyword_match: matchesKeyword, suppressed, _inbound: inbound, _latestAt: latestAt, _analysisText: analysisPreview(`${subject}\n${body || thread.snippet || ""}`) }; }));
  const usable = threads.filter((thread): thread is NonNullable<typeof thread> => Boolean(thread));
  const analyses = await analyzeMessages(usable.filter((thread) => thread._inbound && thread.unread && !thread.suppressed).sort((a, b) => b.importance_score - a.importance_score).map((thread) => ({ id: thread.gmail_thread_id, source: "gmail" as const, text: thread._analysisText, ageHours: Math.max(0, Math.round((Date.now() - thread._latestAt) / 3_600_000)), priorityPerson: thread.priority_person, watchWord: thread.keyword_match })));
  // Hard receipt, routine-notice, spam, and promotion filters run before any
  // excerpt is analysed. Claude can then suppress other non-actionable noise.
  const enriched = usable.map(({ _inbound, _latestAt, _analysisText, ...thread }) => { const analysis = analyses.get(thread.gmail_thread_id); const actionSignal = hasAdministrativeSignal(thread.subject, _analysisText) || thread.priority_person || thread.keyword_match; const ignored = analysis?.urgency === "ignore" && !actionSignal; const score = Math.max(thread.importance_score, analysis?.score ?? 0); const urgency = analysis?.urgency === "urgent" ? "urgent" : analysis?.urgency === "reply" ? "reply" : score >= 7 ? "urgent" : score >= 3 ? "reply" : "watch"; return { ...thread, suppressed: thread.suppressed || ignored, reply_worthy: !ignored && _inbound && thread.unread && (thread.reply_worthy || analysis?.urgency === "urgent" || analysis?.urgency === "reply"), importance_score: ignored ? 0 : score, urgency, analysis_reason: analysis?.reason ?? null, analysis_provider: analysis ? "anthropic" : null, analyzed_at: analysis ? new Date().toISOString() : null }; });
  // Gmail can return a partial page during a transient sync. Never blank the
  // previously known queue until a replacement row for that thread is present.
  if (enriched.length) { const { error } = await db(config).from("tending_gmail_threads").upsert(enriched, { onConflict: "owner_id,gmail_connection_id,gmail_thread_id" }); if (error) throw error; }
  await db(config).from("tending_gmail_connections").update({ last_synced_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", connection.id); return usable.length;
}
export async function gmailSync(request: RequestLike, response: ResponseLike) { try { const config = getConfig(); const user = await getAuthenticatedUser(request, config); const count = await syncGmail(user.id, config); return response.status(200).json({ synced: true, count }); } catch (error) { return response.status(400).json({ synced: false, error: error instanceof Error ? error.message : "Gmail sync failed." }); } }
export async function gmailSenders(request: RequestLike, response: ResponseLike) {
  try {
    const config = getConfig(); const user = await getAuthenticatedUser(request, config); const connections = (await getConnections(user.id, config)).filter((item) => item.status === "connected"); const query = String(first(request.query?.query) ?? "").trim().replace(/[^\p{L}\p{N}@._\-\s]/gu, "").slice(0, 80);
    if (!connections.length) throw new Error("Connect Gmail to search recent senders.");
    if (query.length < 2) return response.status(200).json({ suggestions: [] });
    const primaryToken = await refreshAccessToken(connections[0], config);
    const peopleResponse = await fetch(`https://people.googleapis.com/v1/people:searchContacts?${new URLSearchParams({ query, readMask: "names,emailAddresses", pageSize: "10" })}`, { headers: { Authorization: `Bearer ${primaryToken}` } });
    const peoplePayload = await peopleResponse.json() as { results?: Array<{ person?: { names?: Array<{ displayName?: string }>; emailAddresses?: Array<{ value?: string }> } }>; error?: { message?: string } };
    const matchesSearch = (item: { identifier: string; label: string }) => `${item.label} ${item.identifier}`.toLowerCase().includes(query.toLowerCase());
    const usableContact = (item: { identifier: string; label: string }) => !isAutomatedAddress(item.identifier) && matchesSearch(item);
    const contactSuggestions = (peoplePayload.results ?? []).flatMap((result) => { const person = result.person; const label = person?.names?.[0]?.displayName?.trim(); return (person?.emailAddresses ?? []).flatMap((email) => email.value ? [{ identifier: email.value.toLowerCase(), label: label || email.value }] : []); }).filter(usableContact);
    if (contactSuggestions.length) return response.status(200).json({ suggestions: contactSuggestions.slice(0, 6), lookupMessage: null });
    const senderGroups = await Promise.all(connections.map(async (connection) => { const accessToken = await refreshAccessToken(connection, config); const listing = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?${new URLSearchParams({ q: `in:anywhere ${query}`, maxResults: "20" })}`, { headers: { Authorization: `Bearer ${accessToken}` } }); const payload = await listing.json() as { messages?: Array<{ id: string }>; error?: { message?: string } }; if (!listing.ok) throw new Error(payload.error?.message || "Gmail senders could not be searched."); return Promise.all((payload.messages ?? []).map(async (item) => { const itemResponse = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(item.id)}?format=metadata&metadataHeaders=From`, { headers: { Authorization: `Bearer ${accessToken}` } }); if (!itemResponse.ok) return null; const message = await itemResponse.json() as { payload?: { headers?: Array<{ name?: string; value?: string }> } }; const from = header(message.payload?.headers, "From"); const email = senderEmail(from); return email ? { identifier: email, label: senderName(from) } : null; })); }));
    const results = senderGroups.flat().filter((item): item is NonNullable<typeof item> => Boolean(item)); const seen = new Set<string>(); const suggestions = results.filter(usableContact).filter((item) => !seen.has(item.identifier) && Boolean(seen.add(item.identifier))).slice(0, 6);
    const typedEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(query) && !isAutomatedAddress(query) ? [{ identifier: query.toLowerCase(), label: query.toLowerCase() }] : [];
    const suggested = suggestions.length ? suggestions : typedEmail;
    const lookupMessage = !peopleResponse.ok ? "Contact lookup needs the Google People API enabled and Gmail reconnected with Contacts permission." : suggested.length ? null : "No matching contact found. Try their full name or email address.";
    return response.status(200).json({ suggestions: suggested, lookupMessage });
  } catch (error) { return response.status(400).json({ suggestions: [], error: error instanceof Error ? error.message : "Gmail senders could not be searched." }); }
}
export async function gmailThreads(request: RequestLike, response: ResponseLike) {
  try {
    const config = getConfig(); const user = await getAuthenticatedUser(request, config);
    const { data, error } = await db(config).from("tending_gmail_threads").select("gmail_thread_id, sender, subject, snippet, latest_message_at, unread, reply_worthy, source_url, importance_score, urgency, priority_person, keyword_match, analysis_reason").eq("owner_id", user.id).eq("unread", true).eq("suppressed", false).order("latest_message_at", { ascending: false }).order("importance_score", { ascending: false }).limit(30);
    if (error) throw error;
    response.setHeader("Cache-Control", "no-store"); return response.status(200).json({ threads: data ?? [] });
  } catch (error) { return response.status(400).json({ threads: [], error: error instanceof Error ? error.message : "Gmail messages could not be loaded." }); }
}
