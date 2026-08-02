import { useEffect, useMemo, useRef, useState } from "react";
import type { User } from "@supabase/supabase-js";
import "./tending.css";
import { tendingSupabase } from "./supabase";

declare const __TENDING_RELEASE__: string;

type Bucket = "needs_reply" | "unread" | "waiting" | "handled";
type Source = "Gmail" | "X DM";
type Priority = "urgent" | "reply" | "watch";

type Conversation = {
  id: string;
  sender: string;
  initials: string;
  title: string;
  preview: string;
  source: Source;
  age: string;
  priority: Priority;
  bucket: Bucket;
  reason: string;
  reasons: string[];
  detail: string;
  deadline?: string;
  snoozeLabel?: string;
  sourceUrl?: string;
  receivedAt?: string;
};

const INITIAL_CONVERSATIONS: Conversation[] = [
  {
    id: "maya",
    sender: "Maya Chen",
    initials: "MC",
    title: "Revised contract",
    preview: "Can you confirm the liability language before I send this to legal?",
    source: "Gmail",
    age: "26h ago",
    priority: "urgent",
    bucket: "needs_reply",
    reason: "deadline Friday",
    reasons: ["Contains a direct question", "Deadline mentioned: Friday, 5 PM", "Maya is on your priority list"],
    detail: "Can you confirm the liability language before I send this to legal? I’d love to get it out before the weekend.",
    deadline: "Friday · 5 PM",
  },
  {
    id: "alexis",
    sender: "Alexis Park",
    initials: "AP",
    title: "Deck for Thursday",
    preview: "Would you have fifteen minutes to look at the new opening before the investor meeting?",
    source: "Gmail",
    age: "1d ago",
    priority: "reply",
    bucket: "needs_reply",
    reason: "contains a question",
    reasons: ["Contains a direct question", "Waiting 1 day since the latest message"],
    detail: "Would you have fifteen minutes to look at the new opening before the investor meeting? I think your notes last time made the structure much clearer.",
  },
  {
    id: "nate",
    sender: "Nate Holloway",
    initials: "NH",
    title: "A quick thought",
    preview: "No rush at all — curious where you landed on the partnership idea.",
    source: "X DM",
    age: "2d ago",
    priority: "reply",
    bucket: "needs_reply",
    reason: "waiting 2 days",
    reasons: ["Latest message is from Nate", "Waiting 2 days since the latest message"],
    detail: "No rush at all — curious where you landed on the partnership idea. I’m mapping the fall a little more seriously now.",
  },
  {
    id: "sophia",
    sender: "Sophia Ruiz",
    initials: "SR",
    title: "Voice note from last night",
    preview: "I had a thought after our conversation — sending a note here so I don’t lose it.",
    source: "X DM",
    age: "4h ago",
    priority: "watch",
    bucket: "unread",
    reason: "new this morning",
    reasons: ["New direct message", "Not yet marked as needing a reply"],
    detail: "I had a thought after our conversation — sending a note here so I don’t lose it. Let me know when you’ve had a minute.",
  },
  {
    id: "studio",
    sender: "Studio Daylight",
    initials: "SD",
    title: "Your July receipt",
    preview: "Your receipt for this month’s membership is ready to view.",
    source: "Gmail",
    age: "6h ago",
    priority: "watch",
    bucket: "unread",
    reason: "unread",
    reasons: ["New inbox message", "Automated sender — no reply signal"],
    detail: "Your receipt for this month’s membership is ready to view. No action is required.",
  },
  {
    id: "mira",
    sender: "Mira Patel",
    initials: "MP",
    title: "A small introduction",
    preview: "I’d love to make a thoughtful introduction when timing is right.",
    source: "Gmail",
    age: "3d ago",
    priority: "reply",
    bucket: "waiting",
    reason: "snoozed until tomorrow",
    reasons: ["You chose to revisit this tomorrow morning"],
    detail: "I’d love to make a thoughtful introduction when timing is right. No pressure at all — just tell me when it would be useful.",
    snoozeLabel: "Tomorrow · 9 AM",
  },
  {
    id: "ben",
    sender: "Ben Ortiz",
    initials: "BO",
    title: "Notes from our call",
    preview: "I added the three links we mentioned and a possible next step.",
    source: "Gmail",
    age: "Yesterday",
    priority: "reply",
    bucket: "waiting",
    reason: "snoozed until Monday",
    reasons: ["You chose to revisit this Monday"],
    detail: "I added the three links we mentioned and a possible next step. Feel free to respond whenever you’re ready.",
    snoozeLabel: "Monday · 10 AM",
  },
];

const VIEW_LABELS: Record<Bucket, string> = {
  needs_reply: "Needs reply",
  unread: "Unread",
  waiting: "Waiting",
  handled: "Handled",
};

type GmailStatus = { configured: boolean; connected: boolean; status: string; email: string | null; emails?: string[]; lastSyncedAt: string | null; message?: string };
type GmailThread = { gmail_thread_id: string; sender: string; subject: string; snippet: string; latest_message_at: string; unread: boolean; reply_worthy: boolean; source_url: string; importance_score: number; urgency: Priority; priority_person: boolean; keyword_match: boolean; analysis_reason?: string | null };
type PriorityPerson = { id: string; identifier: string; label: string };
type PrioritySuggestion = { identifier: string; label: string };
type XStatus = { configured: boolean; connected: boolean; status: string; username: string | null; lastSyncedAt?: string | null; latestEventAt?: string | null; dataFreshness?: "current" | "delayed" | "no_messages" | "not_connected"; message?: string };
type XEvent = { x_event_id: string; sender_name: string; text: string; created_at_x: string; reply_worthy: boolean; classification: "needs_reply" | "worth_a_look"; sender_followed: boolean; keyword_match: boolean; analysis_reason?: string | null; source_url: string };
type WatchKeyword = { id: string; phrase: string; source: "gmail" | "x" };
type MessageState = { source: "gmail" | "x"; message_id: string; disposition: "open" | "handled" | "not_important" | "snoozed"; snoozed_until: string | null; updated_at: string };

function stateKey(source: "gmail" | "x", messageId: string) { return `${source}:${messageId}`; }
function applyMessageState(conversation: Conversation, state: MessageState | undefined) {
  if (!state || state.disposition === "open") return conversation;
  if (state.disposition === "snoozed" && state.snoozed_until && new Date(state.snoozed_until).getTime() > Date.now()) return { ...conversation, bucket: "waiting" as Bucket, snoozeLabel: new Intl.DateTimeFormat("en", { weekday: "short", hour: "numeric", minute: "2-digit" }).format(new Date(state.snoozed_until)), reason: "snoozed" };
  if ((state.disposition === "handled" || state.disposition === "not_important") && (!conversation.receivedAt || new Date(state.updated_at).getTime() >= new Date(conversation.receivedAt).getTime())) return null;
  return conversation;
}

function priorityLabel(priority: Priority) {
  return priority === "urgent" ? "Urgent" : priority === "reply" ? "Needs reply" : "Unread";
}

function priorityMark(priority: Priority) {
  return priority === "urgent" ? "!" : priority === "reply" ? "•" : "○";
}

export default function TendingPrototype() {
  useEffect(() => {
    document.title = "Tending";
  }, []);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeView, setActiveView] = useState<Bucket>("needs_reply");
  const [selectedId, setSelectedId] = useState("");
  const [detailOpen, setDetailOpen] = useState(false);
  const [snoozeMenu, setSnoozeMenu] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [quietHours, setQuietHours] = useState(true);
  const [notificationState, setNotificationState] = useState<"ready" | "enabled" | "blocked">("ready");
  const [gmail, setGmail] = useState<GmailStatus | null>(null);
  const [x, setX] = useState<XStatus | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [priorityPeople, setPriorityPeople] = useState<PriorityPerson[]>([]);
  const [priorityDraft, setPriorityDraft] = useState("");
  const [prioritySuggestions, setPrioritySuggestions] = useState<PrioritySuggestion[]>([]);
  const [priorityLookupMessage, setPriorityLookupMessage] = useState<string | null>(null);
  const [priorityBusy, setPriorityBusy] = useState(false);
  const [watchWords, setWatchWords] = useState<Record<"gmail" | "x", WatchKeyword[]>>({ gmail: [], x: [] });
  const [watchDrafts, setWatchDrafts] = useState<Record<"gmail" | "x", string>>({ gmail: "", x: "" });
  const [refreshing, setRefreshing] = useState(false);
  const [xTesting, setXTesting] = useState(false);
  const [refreshEpoch, setRefreshEpoch] = useState(0);
  const [messageStates, setMessageStates] = useState<MessageState[]>([]);
  const [xLimitationsOpen, setXLimitationsOpen] = useState(false);
  const notificationBaseline = useRef<Set<string> | null>(null);

  useEffect(() => {
    if (!tendingSupabase) {
      setAuthReady(true);
      return;
    }
    void tendingSupabase.auth.getSession().then(({ data }) => {
      setUser(data.session?.user ?? null);
      setAuthReady(true);
    });
    const { data: listener } = tendingSupabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
      setAuthReady(true);
    });
    return () => listener.subscription.unsubscribe();
  }, []);

  async function gmailFetch(path: string, init?: RequestInit) {
    if (!tendingSupabase) throw new Error("Tending sign-in has not been configured.");
    const { data: { session } } = await tendingSupabase.auth.getSession();
    if (!session?.access_token) throw new Error("Sign in is required before connecting Gmail.");
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${session.access_token}`);
    return fetch(path, { ...init, credentials: "same-origin", headers });
  }

  useEffect(() => {
    if (!authReady || !user) {
      setPriorityPeople([]);
      return;
    }
    let cancelled = false;
    void gmailFetch("/api/tending/priorities").then(async (response) => {
      const payload = await response.json() as { people?: PriorityPerson[] };
      if (!cancelled && response.ok) setPriorityPeople(payload.people ?? []);
    }).catch(() => { /* Settings remains usable if this optional preference cannot load. */ });
    return () => { cancelled = true; };
  }, [authReady, user?.id]);

  useEffect(() => {
    if (!authReady || !user) { setMessageStates([]); return; }
    void gmailFetch("/api/tending/priorities?resource=message-state").then(async (response) => {
      const payload = await response.json() as { states?: MessageState[] };
      if (response.ok) setMessageStates(payload.states ?? []);
    }).catch(() => { /* A source queue must remain readable even if preferences are unavailable. */ });
  }, [authReady, user?.id, refreshEpoch]);

  useEffect(() => {
    if (!user) return;
    const timer = window.setInterval(() => setRefreshEpoch((value) => value + 1), 120_000);
    return () => window.clearInterval(timer);
  }, [user?.id]);

  useEffect(() => {
    const xchat = new URLSearchParams(window.location.search).get("xchat");
    if (!xchat) return;
    setXLimitationsOpen(true);
    window.history.replaceState({}, "", window.location.pathname);
  }, [user?.id]);

  useEffect(() => {
    if (!authReady || !user) { setWatchWords({ gmail: [], x: [] }); return; }
    void Promise.all((["gmail", "x"] as const).map(async (source) => {
      const response = await gmailFetch(`/api/tending/keywords?source=${source}`);
      const payload = await response.json() as { keywords?: WatchKeyword[] };
      return [source, payload.keywords ?? []] as const;
    })).then((entries) => setWatchWords(Object.fromEntries(entries) as Record<"gmail" | "x", WatchKeyword[]>)).catch(() => { /* Optional settings remain available. */ });
  }, [authReady, user?.id]);

  useEffect(() => {
    if (!user || priorityDraft.trim().length < 2) {
      setPrioritySuggestions([]);
      setPriorityLookupMessage(null);
      return;
    }
    let cancelled = false;
    const timeout = window.setTimeout(() => {
      void gmailFetch(`/api/tending/priorities?search=${encodeURIComponent(priorityDraft.trim())}`).then(async (response) => {
        const payload = await response.json() as { suggestions?: PrioritySuggestion[]; lookupMessage?: string | null; error?: string };
        if (!cancelled) {
          setPrioritySuggestions(response.ok ? payload.suggestions ?? [] : []);
          setPriorityLookupMessage(response.ok ? payload.lookupMessage ?? null : payload.error ?? "Contact lookup could not run.");
        }
      }).catch(() => { if (!cancelled) { setPrioritySuggestions([]); setPriorityLookupMessage("Contact lookup could not run."); } });
    }, 180);
    return () => { cancelled = true; window.clearTimeout(timeout); };
  }, [priorityDraft, user?.id]);

  useEffect(() => {
    if (!user) return;
    const source = window.sessionStorage.getItem("tending-connect-source");
    if (source === "gmail" || source === "x") {
      window.sessionStorage.removeItem("tending-connect-source");
      setConnectionsOpen(true);
    }
  }, [user?.id]);

  useEffect(() => {
    if (!authReady) return;
    if (!user) {
      setGmail(null);
      setConversations([]);
      setSelectedId("");
      return;
    }
    let cancelled = false;
    async function loadGmail() {
      try {
        const statusResponse = await gmailFetch("/api/tending/gmail/status");
        const status = await statusResponse.json() as GmailStatus;
        if (cancelled) return;
        setGmail(status);
        if (!status.connected) {
          setConversations((current) => current.filter((conversation) => conversation.source !== "Gmail"));
          return;
        }
        const threadResponse = await gmailFetch("/api/tending/gmail/threads");
        const payload = await threadResponse.json() as { threads?: GmailThread[] };
        if (cancelled || !payload.threads) return;
        const savedStates = new Map(messageStates.map((state) => [stateKey(state.source, state.message_id), state]));
        const liveConversations = payload.threads.map((thread): Conversation => {
          const bucket: Bucket = thread.reply_worthy ? "needs_reply" : "unread";
          return {
            id: `gmail-${thread.gmail_thread_id}`,
            sender: thread.sender,
            initials: thread.sender.split(/\s+/).map((word) => word[0]).join("").slice(0, 2).toUpperCase() || "GM",
            title: thread.subject,
            preview: thread.snippet,
            source: "Gmail",
            age: new Intl.RelativeTimeFormat("en", { numeric: "auto" }).format(Math.round((new Date(thread.latest_message_at).getTime() - Date.now()) / 3_600_000), "hour"),
            priority: thread.urgency === "urgent" ? "urgent" : thread.reply_worthy ? "reply" : "watch",
            bucket,
            reason: thread.priority_person ? "priority person" : thread.urgency === "urgent" ? "time-sensitive" : thread.reply_worthy ? "contains a request" : "unread",
            reasons: [
              ...(thread.priority_person ? ["A person on your priority list sent this"] : []),
              ...(thread.keyword_match ? ["Matches one of your Gmail watch words"] : []),
              ...(thread.analysis_reason ? [thread.analysis_reason] : []),
              ...(thread.reply_worthy ? ["Contains a question, request, or direct follow-up"] : []),
              ...(thread.urgency === "urgent" ? ["Language or timing suggests this is time-sensitive"] : []),
              ...(thread.unread ? ["Still unread in Gmail"] : []),
            ],
            detail: thread.snippet,
            sourceUrl: thread.source_url,
            receivedAt: thread.latest_message_at,
          };
        }).map((conversation) => applyMessageState(conversation, savedStates.get(stateKey("gmail", conversation.id.slice("gmail-".length))))).filter((conversation): conversation is Conversation => Boolean(conversation));
        setConversations((current) => [...current.filter((conversation) => conversation.source !== "Gmail"), ...liveConversations]);
        setSelectedId((current) => current || liveConversations[0]?.id || "");
      } catch {
        if (!cancelled) setGmail({ configured: false, connected: false, status: "setup_required", email: null, lastSyncedAt: null, message: "Gmail setup is not complete." });
      }
    }
    void loadGmail();
    return () => { cancelled = true; };
  }, [authReady, user?.id, refreshEpoch, messageStates]);

  useEffect(() => {
    if (!authReady || !user) {
      setX(null);
      return;
    }
    let cancelled = false;
    async function loadX() {
      try {
        const statusResponse = await gmailFetch("/api/tending/x/status");
        const status = await statusResponse.json() as XStatus;
        if (cancelled) return;
        setX(status);
        if (!status.connected) return;
        const eventResponse = await gmailFetch("/api/tending/x/events");
        const payload = await eventResponse.json() as { events?: XEvent[] };
        if (cancelled || !payload.events) return;
        const savedStates = new Map(messageStates.map((state) => [stateKey(state.source, state.message_id), state]));
        const xConversations = payload.events.map((event): Conversation => ({
          id: `x-${event.x_event_id}`,
          sender: event.sender_name,
          initials: event.sender_name.split(/\s+/).map((word) => word[0]).join("").slice(0, 2).toUpperCase() || "X",
          title: event.reply_worthy ? "Needs your reply" : "Worth a look",
          preview: event.text,
          source: "X DM",
          age: new Intl.RelativeTimeFormat("en", { numeric: "auto" }).format(Math.round((new Date(event.created_at_x).getTime() - Date.now()) / 3_600_000), "hour"),
          priority: event.reply_worthy ? "reply" : "watch",
          bucket: event.reply_worthy ? "needs_reply" : "unread",
          reason: event.reply_worthy ? "contains a request" : "worth a look",
          reasons: ["Latest message is from this sender", ...(event.sender_followed ? ["You follow this account"] : []), ...(event.keyword_match ? ["Matches one of your X watch words"] : []), ...(event.analysis_reason ? [event.analysis_reason] : []), ...(event.reply_worthy ? ["Contains a question or request"] : ["Not classified as likely promotion"])],
          detail: event.text,
          sourceUrl: event.source_url,
          receivedAt: event.created_at_x,
        })).map((conversation) => applyMessageState(conversation, savedStates.get(stateKey("x", conversation.id.slice("x-".length))))).filter((conversation): conversation is Conversation => Boolean(conversation));
        setConversations((current) => [...current.filter((conversation) => conversation.source !== "X DM"), ...xConversations]);
      } catch { if (!cancelled) setX({ configured: false, connected: false, status: "setup_required", username: null, message: "X setup is not complete." }); }
    }
    void loadX();
    return () => { cancelled = true; };
  }, [authReady, user?.id, refreshEpoch, messageStates]);

  const counts = useMemo(() => {
    const count = (bucket: Bucket) => conversations.filter((conversation) => conversation.bucket === bucket).length;
    return { needs_reply: count("needs_reply"), unread: count("unread"), waiting: count("waiting"), handled: count("handled") };
  }, [conversations]);
  const visible = conversations.filter((conversation) => conversation.bucket === activeView);
  const selected = conversations.find((conversation) => conversation.id === selectedId) ?? visible[0] ?? null;

  function selectConversation(id: string) {
    setSelectedId(id);
    setDetailOpen(true);
    setSnoozeMenu(false);
  }

  function updateConversation(id: string, update: Partial<Conversation>, message: string) {
    setConversations((current) => current.map((conversation) => conversation.id === id ? { ...conversation, ...update } : conversation));
    setToast(message);
    setSnoozeMenu(false);
    window.setTimeout(() => setToast(null), 3400);
  }

  async function saveMessageState(conversation: Conversation, disposition: MessageState["disposition"], snoozedUntil?: Date) {
    const source = conversation.source === "Gmail" ? "gmail" : "x";
    const messageId = conversation.id.slice(source === "gmail" ? "gmail-".length : "x-".length);
    const query = new URLSearchParams({ resource: "message-state", source, messageId, disposition });
    if (snoozedUntil) query.set("snoozedUntil", snoozedUntil.toISOString());
    const response = await gmailFetch(`/api/tending/priorities?${query}`, { method: "POST" });
    const payload = await response.json() as { error?: string };
    if (!response.ok) throw new Error(payload.error ?? "Could not save this follow-through choice.");
    setMessageStates((current) => [...current.filter((state) => stateKey(state.source, state.message_id) !== stateKey(source, messageId)), { source, message_id: messageId, disposition, snoozed_until: snoozedUntil?.toISOString() ?? null, updated_at: new Date().toISOString() }]);
  }

  function markHandled() {
    if (!selected) return;
    void saveMessageState(selected, "handled").then(() => updateConversation(selected.id, { bucket: "handled", reason: "handled just now" }, "Marked handled. We’ll bring it back if a newer message arrives.")).catch((error) => setToast(error instanceof Error ? error.message : "Could not save this change."));
    setActiveView("needs_reply");
  }

  function snooze(label: string, until: Date) {
    if (!selected) return;
    void saveMessageState(selected, "snoozed", until).then(() => updateConversation(selected.id, { bucket: "waiting", snoozeLabel: label, reason: `snoozed until ${label.toLowerCase()}` }, `Okay — we’ll bring this back ${label.toLowerCase()}.`)).catch((error) => setToast(error instanceof Error ? error.message : "Could not save this snooze."));
    setActiveView("needs_reply");
  }

  function snoozeDate(kind: "later" | "tomorrow" | "monday") {
    const now = new Date(); const date = new Date(now);
    if (kind === "later") { if (now.getHours() >= 17) { date.setDate(date.getDate() + 1); date.setHours(9, 0, 0, 0); } else date.setHours(Math.max(now.getHours() + 3, 17), 0, 0, 0); return date; }
    if (kind === "tomorrow") { date.setDate(date.getDate() + 1); date.setHours(9, 0, 0, 0); return date; }
    date.setDate(date.getDate() + ((8 - date.getDay()) % 7 || 7)); date.setHours(10, 0, 0, 0); return date;
  }

  async function enableNotifications() {
    if (!("Notification" in window)) {
      setNotificationState("blocked");
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission === "granted") {
      setNotificationState("enabled");
      setToast("Desktop alerts are enabled while Tending is open.");
    } else {
      setNotificationState("blocked");
    }
  }

  useEffect(() => {
    const actionable = conversations.filter((conversation) => conversation.bucket === "needs_reply");
    const current = new Set(actionable.map((conversation) => conversation.id));
    if (!notificationBaseline.current) { notificationBaseline.current = current; return; }
    const hour = new Date().getHours(); const quiet = quietHours && (hour >= 22 || hour < 8);
    const newItems = actionable.filter((conversation) => !notificationBaseline.current?.has(conversation.id));
    if (notificationState === "enabled" && !quiet) newItems.forEach((conversation) => new Notification(`Tending · ${conversation.sender}`, { body: `${conversation.source}: ${conversation.title}` }));
    notificationBaseline.current = current;
  }, [conversations, notificationState, quietHours]);

  async function signIn(source?: "gmail" | "x") {
    if (!tendingSupabase) {
      setToast("Add Tending’s public Supabase URL and publishable key to enable sign-in.");
      return;
    }
    if (source) window.sessionStorage.setItem("tending-connect-source", source);
    const { error } = await tendingSupabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin },
    });
    if (error) setToast(error.message);
  }

  async function signOut() {
    if (!tendingSupabase) return;
    await tendingSupabase.auth.signOut();
    setToast("Signed out. Your Gmail connection remains protected in your account.");
  }

  async function connectGmail() {
    if (!user) {
      await signIn();
      return;
    }
    if (!gmail?.configured) {
      setSettingsOpen(true);
      setToast("Add the Gmail OAuth and server-only database settings first.");
      return;
    }
    try {
      const response = await gmailFetch("/api/tending/gmail/start", { method: "POST" });
      const payload = await response.json() as { authorizationUrl?: string; error?: string };
      if (!response.ok || !payload.authorizationUrl) throw new Error(payload.error ?? "Gmail connection could not start.");
      window.location.assign(payload.authorizationUrl);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Gmail connection could not start.");
    }
  }

  async function connectX() {
    if (!user) {
      await signIn();
      return;
    }
    if (!x?.configured) {
      setToast("Add the X OAuth client ID and secret before connecting X.");
      return;
    }
    try {
      const response = await gmailFetch("/api/tending/x/start", { method: "POST" });
      const payload = await response.json() as { authorizationUrl?: string; error?: string };
      if (!response.ok || !payload.authorizationUrl) throw new Error(payload.error ?? "X connection could not start.");
      window.location.assign(payload.authorizationUrl);
    } catch (error) { setToast(error instanceof Error ? error.message : "X connection could not start."); }
  }

  async function syncXNow() {
    try {
      const response = await gmailFetch("/api/tending/x/sync", { method: "POST" });
      const result = await response.json() as { synced: boolean; count?: number; dataFreshness?: "current" | "delayed" | "no_messages"; latestEventAt?: string | null; error?: string };
      setToast(result.synced ? result.dataFreshness === "delayed" ? `X was checked just now, but its newest legacy DM is ${result.latestEventAt ? new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(new Date(result.latestEventAt)) : "unknown"}. X did not supply a current inbox feed.` : result.dataFreshness === "no_messages" ? "X was checked just now but returned no legacy DM events. Your previous queue was kept." : `X refreshed — ${result.count ?? 0} direct messages checked.` : result.error ?? "X could not refresh.");
      if (result.synced) setRefreshEpoch((value) => value + 1);
    } catch { setToast("X could not refresh right now."); }
  }

  async function testXFeed() {
    setXTesting(true);
    try {
      const response = await gmailFetch("/api/tending/x/status?test=1");
      const result = await response.json() as { ok: boolean; eventCount?: number; newestEventAt?: string | null; requestId?: string | null; activity?: { ready: boolean; reason?: string }; error?: string };
      const liveStatus = result.activity?.ready ? " Live XChat is active." : result.activity ? ` Live XChat is not active: ${result.activity.reason}` : "";
      setToast(result.ok ? `Official X test: ${result.eventCount ?? 0} events; newest ${result.newestEventAt ? new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(result.newestEventAt)) : "timestamp unavailable"}.${result.requestId ? ` Request ${result.requestId}.` : ""}${liveStatus}` : result.error ?? "X API test could not run.");
    } catch { setToast("X API test could not run right now."); } finally { setXTesting(false); }
  }

  async function syncGmailNow() {
    try {
      const response = await gmailFetch("/api/tending/gmail/sync", { method: "POST" });
      const result = await response.json() as { synced: boolean; count?: number; error?: string };
      setToast(result.synced ? `Gmail refreshed — ${result.count ?? 0} inbox threads checked.` : result.error ?? "Gmail could not refresh.");
      if (result.synced) setRefreshEpoch((value) => value + 1);
    } catch { setToast("Gmail could not refresh right now."); }
  }

  async function syncAllNow() {
    const sources = [
      ...(gmail?.connected ? [{ label: "Gmail", path: "/api/tending/gmail/sync" }] : []),
      ...(x?.connected ? [{ label: "X DMs", path: "/api/tending/x/sync" }] : []),
    ];
    if (!sources.length) { setConnectionsOpen(true); setToast("Connect a source first, then Tending can refresh everything together."); return; }
    setRefreshing(true);
    try {
      const results = await Promise.all(sources.map(async (source) => {
        const response = await gmailFetch(source.path, { method: "POST" });
        const payload = await response.json() as { synced?: boolean; count?: number };
        return payload.synced ? `${source.label}: ${payload.count ?? 0}` : `${source.label}: not refreshed`;
      }));
      setToast(`Everything refreshed — ${results.join(" · ")}.`);
      setRefreshEpoch((value) => value + 1);
    } catch { setToast("One of your sources could not refresh. Please try again."); }
    finally { setRefreshing(false); }
  }

  async function addPriorityPerson(candidate?: PrioritySuggestion) {
    const identifier = candidate?.identifier ?? priorityDraft.trim();
    if (!identifier || priorityBusy) return;
    setPriorityBusy(true);
    try {
      const label = candidate?.label ?? identifier;
      const response = await gmailFetch(`/api/tending/priorities?identifier=${encodeURIComponent(identifier)}&label=${encodeURIComponent(label)}`, { method: "POST" });
      const payload = await response.json() as { people?: PriorityPerson[]; error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Could not save this person.");
      setPriorityPeople(payload.people ?? []);
      setPriorityDraft("");
      setPrioritySuggestions([]);
      setToast("Priority person saved. Refresh Gmail to re-rank your inbox.");
    } catch (error) { setToast(error instanceof Error ? error.message : "Could not save this person."); }
    finally { setPriorityBusy(false); }
  }

  async function removePriorityPerson(id: string) {
    if (priorityBusy) return;
    setPriorityBusy(true);
    try {
      const response = await gmailFetch(`/api/tending/priorities?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      const payload = await response.json() as { people?: PriorityPerson[]; error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Could not remove this person.");
      setPriorityPeople(payload.people ?? []);
      setToast("Priority person removed. Refresh Gmail to re-rank your inbox.");
    } catch (error) { setToast(error instanceof Error ? error.message : "Could not remove this person."); }
    finally { setPriorityBusy(false); }
  }

  async function addWatchWord(source: "gmail" | "x") {
    const phrase = watchDrafts[source].trim();
    if (!phrase) return;
    try {
      const response = await gmailFetch(`/api/tending/keywords?source=${source}&phrase=${encodeURIComponent(phrase)}`, { method: "POST" });
      const payload = await response.json() as { keywords?: WatchKeyword[]; error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Could not save this watch word.");
      setWatchWords((current) => ({ ...current, [source]: payload.keywords ?? [] }));
      setWatchDrafts((current) => ({ ...current, [source]: "" }));
      setToast(`Watch word saved. Refresh ${source === "gmail" ? "Gmail" : "X DMs"} to apply it.`);
    } catch (error) { setToast(error instanceof Error ? error.message : "Could not save this watch word."); }
  }

  async function removeWatchWord(source: "gmail" | "x", id: string) {
    try {
      const response = await gmailFetch(`/api/tending/keywords?source=${source}&id=${encodeURIComponent(id)}`, { method: "DELETE" });
      const payload = await response.json() as { keywords?: WatchKeyword[]; error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Could not remove this watch word.");
      setWatchWords((current) => ({ ...current, [source]: payload.keywords ?? [] }));
    } catch (error) { setToast(error instanceof Error ? error.message : "Could not remove this watch word."); }
  }

  if (!user) {
    return <main className="landing-shell">
      <header className="landing-nav">
        <a className="tending-wordmark" href="/" aria-label="Tending home">tending<span>·</span></a>
        <div className="landing-nav-right"><span>Private by default</span><button onClick={() => signIn()}>Sign in <b>↗</b></button></div>
      </header>
      <section className="landing-hero">
        <div className="landing-copy">
          <p className="landing-kicker"><i /> A quieter way to keep up</p>
          <h1>A few things <em>need you.</em></h1>
          <p className="landing-intro">Tending watches the messages that would otherwise slip through, then leaves you with one small, considered queue.</p>
          <div className="landing-connect"><p>Choose what to connect first</p><div><button className="landing-primary" onClick={() => signIn("gmail")}>Connect Gmail <span>↗</span></button><button className="landing-source" onClick={() => signIn("x")}>Connect X DMs <span>↗</span></button></div></div>
          <button className="landing-secondary" onClick={() => window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" })}>See how it works <span>↓</span></button><p className="landing-note">Connect either, or both · read-only · no sending on your behalf</p>
        </div>
        <div className="landing-window" aria-label="A preview of the Tending queue">
          <div className="glass-topline"><span><i /> Today, quietly</span><span>03 waiting</span></div>
          <div className="glass-title"><p>Your follow-through</p><h2>Worth<br/>coming back to.</h2></div>
          <div className="glass-list">
            <article><span className="glass-mark urgent">!</span><div><b>Maya Chen</b><strong>Revised contract</strong><p>Can you confirm the liability language before I send this to legal?</p></div><time>26h</time></article>
            <article><span className="glass-mark">•</span><div><b>Alexis Park</b><strong>Deck for Thursday</strong><p>Would you have fifteen minutes before the investor meeting?</p></div><time>1d</time></article>
            <article className="glass-muted"><span className="glass-mark">·</span><div><b>New DM</b><strong>Held out of your way</strong><p>Promotional messages do not enter the queue.</p></div></article>
          </div>
          <div className="glass-foot"><span>Only direct, human messages surface.</span><b>Open the desk ↗</b></div>
        </div>
      </section>
      <section className="landing-principles" aria-label="Tending principles"><p><b>01</b> Finds direct asks, deadlines, and unfinished conversations.</p><p><b>02</b> Keeps marketing, bot-like DMs, and noise out.</p><p><b>03</b> Gives you the original message—not another place to reply.</p></section>
    </main>;
  }

  return (
    <main className="tending-shell">
      <header className="tending-topbar">
        <a className="tending-wordmark" href="/" aria-label="Tending home">tending<span>·</span></a>
        <div className="tending-date">Tuesday, July 28</div>
        <div className="tending-status"><i /> {user ? `${[gmail?.connected ? "Gmail" : null, x?.connected ? "X" : null].filter(Boolean).join(" + ") || user.email || "Signed in"}${gmail?.connected || x?.connected ? " connected" : ""}` : "Private by default"} <button onClick={() => setSettingsOpen(true)} aria-label="Open settings">Settings</button><button onClick={user ? signOut : () => signIn()}>{user ? "Sign out of Tending" : "Sign in"}</button></div>
      </header>

      <div className="tending-layout">
        <nav className="tending-rail" aria-label="Tending navigation">
          <p className="rail-label">Today</p>
          {(["needs_reply", "unread", "waiting"] as Bucket[]).map((view) => (
            <button key={view} className={activeView === view ? "rail-item active" : "rail-item"} onClick={() => setActiveView(view)}>
              <span>{VIEW_LABELS[view]}</span><b>{String(counts[view]).padStart(2, "0")}</b>
            </button>
          ))}
          <p className="rail-label rail-label-lower">Review</p>
          <button className={activeView === "handled" ? "rail-item active" : "rail-item"} onClick={() => setActiveView("handled")}><span>Handled</span><b>{String(counts.handled).padStart(2, "0")}</b></button>
          <button className="rail-item" onClick={() => setConnectionsOpen(true)}><span>Connections</span><b>→</b></button>
          <button className="rail-item" onClick={() => setSettingsOpen(true)}><span>Settings</span><b>→</b></button>
          <div className="rail-note"><span>◌</span><p><b>Quiet by default</b>Only reply-worthy messages interrupt you.</p></div>
        </nav>

        <section className="tending-queue" aria-live="polite">
          <div className="queue-heading">
            <div>
              <p className="eyebrow">{activeView === "needs_reply" ? "YOUR FOLLOW-THROUGH" : "TODAY'S INBOX"}</p>
              <h1>{activeView === "needs_reply" && counts.needs_reply ? <>A small number of things <span className="heading-tail"><em>need&nbsp;you.</em></span></> : activeView === "unread" ? <>New things, <em>no rush.</em></> : activeView === "waiting" ? <>You chose to <em>come back.</em></> : <>A little <em>lighter.</em></>}</h1>
            </div>
            <button className="queue-refresh" onClick={syncAllNow} disabled={refreshing}>↻ <span>{refreshing ? "Refreshing…" : "Refresh all"}</span></button>
          </div>

          {visible.length ? (
            <div className="conversation-list" role="list" aria-label={VIEW_LABELS[activeView]}>
              <div className="list-caption"><span>{VIEW_LABELS[activeView]}</span><b>{String(visible.length).padStart(2, "0")}</b></div>
              {visible.map((conversation) => (
                <button key={conversation.id} role="listitem" onClick={() => selectConversation(conversation.id)} className={selected?.id === conversation.id ? "conversation-row selected" : "conversation-row"}>
                  <span className={`priority-mark ${conversation.priority}`} aria-label={priorityLabel(conversation.priority)}>{priorityMark(conversation.priority)}</span>
                  <span className="conversation-main"><b>{conversation.sender}</b><strong>{conversation.title}</strong><small>{conversation.preview}</small></span>
                  <span className="conversation-meta"><small>{conversation.source}</small><time>{conversation.age}</time><em>{conversation.reason}</em></span>
                </button>
              ))}
            </div>
          ) : (
            <div className="queue-empty"><span>·</span><h2>Nothing waiting here.</h2><p>{activeView === "needs_reply" ? "You’re caught up for now. We’ll keep watch without making a fuss." : "There’s room to breathe. Check another view whenever you like."}</p></div>
          )}
        </section>

        <aside className={detailOpen ? "tending-detail is-open" : "tending-detail"} aria-label="Conversation detail">
          <button className="detail-close" onClick={() => setDetailOpen(false)} aria-label="Close conversation detail">×</button>
          {selected ? <>
            <div className="detail-topline"><span className={`detail-priority ${selected.priority}`}>{priorityLabel(selected.priority)}</span><span>{selected.source}</span></div>
            <div className="detail-person"><div className="initials">{selected.initials}</div><div><h2>{selected.sender}</h2><p>{selected.age} · latest message</p></div></div>
            <div className="detail-message"><p className="detail-preview-label">{selected.source === "Gmail" ? "Latest email preview" : "Latest direct message"}</p><h3>{selected.title}</h3><p>{selected.detail}</p>{selected.deadline && <div className="deadline">Deadline <b>{selected.deadline}</b></div>}</div>
            <div className="detail-reasons"><p className="eyebrow">WHY THIS SURFACED</p>{selected.reasons.map((reason) => <p key={reason}><i>+</i>{reason}</p>)}</div>
            {selected.bucket === "waiting" && <div className="detail-snoozed">Snoozed until <b>{selected.snoozeLabel}</b></div>}
            <div className="detail-actions">
              <button className="open-source" onClick={() => selected.sourceUrl ? window.open(selected.sourceUrl, "_blank", "noopener,noreferrer") : setToast(`In the live app, this opens the original ${selected.source} conversation.`)}>Open in {selected.source === "Gmail" ? "Gmail" : "X"} <span>↗</span></button>
              {selected.bucket !== "handled" && <div className="action-pair"><button onClick={markHandled}>Mark handled</button><div className="snooze-wrap"><button onClick={() => setSnoozeMenu(!snoozeMenu)}>Snooze <span>⌄</span></button>{snoozeMenu && <div className="snooze-menu"><button onClick={() => snooze("later today", snoozeDate("later"))}>Later today</button><button onClick={() => snooze("tomorrow · 9 AM", snoozeDate("tomorrow"))}>Tomorrow morning</button><button onClick={() => snooze("Monday · 10 AM", snoozeDate("monday"))}>Monday</button></div>}</div></div>}
              <button className="not-important" onClick={() => void saveMessageState(selected, "not_important").then(() => updateConversation(selected.id, { bucket: "handled", reason: "not important" }, "Removed from your queue. A newer message will still return.")).catch((error) => setToast(error instanceof Error ? error.message : "Could not save this change."))}>Not important</button>
            </div>
          </> : <div className="detail-empty"><span>→</span><h2>Choose a conversation.</h2><p>Its context and your next move will stay right here.</p></div>}
        </aside>
      </div>

      <nav className="tending-mobile-nav" aria-label="Mobile navigation">
        {(["needs_reply", "unread", "waiting"] as Bucket[]).map((view) => <button key={view} className={activeView === view ? "active" : ""} onClick={() => setActiveView(view)}>{view === "needs_reply" ? "Today" : VIEW_LABELS[view]}<b>{counts[view]}</b></button>)}
        <button onClick={() => setSettingsOpen(true)}>Settings</button>
      </nav>

      {xLimitationsOpen && <div className="settings-backdrop x-limitations-backdrop" role="presentation" onMouseDown={() => setXLimitationsOpen(false)}><section className="x-limitations-sheet" role="dialog" aria-modal="true" aria-labelledby="x-limitations-title" onMouseDown={(event) => event.stopPropagation()}>
        <button className="close-settings" onClick={() => setXLimitationsOpen(false)} aria-label="Close X tracking details">×</button>
        <p className="eyebrow">X, WITHOUT PRETENDING</p><h2 id="x-limitations-title">What Tending can actually hold.</h2>
        <div className="x-limitations-list"><article><span>01</span><div><b>New encrypted chats, from now on</b><p>After X is connected, Tending receives live arrival and sent-message signals. It can bring a new conversation to your attention and clear it once X reports that you replied.</p></div></article><article><span>02</span><div><b>The message body stays in X</b><p>Encrypted XChat content is not available to third-party apps. Tending shows the sender and timing, then opens X for the original message.</p></div></article><article><span>03</span><div><b>Older DMs are a separate, imperfect feed</b><p>X’s legacy history endpoint can lag or omit chats. When that happens, Tending labels it as delayed and does not silently fill your queue with stale results.</p></div></article></div>
        <p className="x-limitations-note">Tending never sends a DM, and it cannot reliably tell whether you merely opened one.</p><button className="x-limitations-confirm" onClick={() => setXLimitationsOpen(false)}>I understand <span>→</span></button>
      </section></div>}

      {toast && <div className="tending-toast" role="status">{toast}<button onClick={() => setToast(null)}>×</button></div>}

      {settingsOpen && <div className="settings-backdrop" role="presentation" onMouseDown={() => setSettingsOpen(false)}><section className="settings-sheet" role="dialog" aria-modal="true" aria-labelledby="settings-title" onMouseDown={(event) => event.stopPropagation()}>
        <button className="close-settings" onClick={() => setSettingsOpen(false)} aria-label="Close settings">×</button>
        <p className="eyebrow">YOUR BOUNDARIES</p><h2 id="settings-title">A little help, on your terms.</h2><p className="settings-intro">Tending only reminds you about conversations you connect. It never sends, archives, or changes anything.</p>
        <div className="setting-row"><div><b>Desktop reminders</b><small>{notificationState === "enabled" ? "Enabled while Tending is open. Closed-browser push is not switched on yet." : notificationState === "blocked" ? "Permission wasn’t granted. You can enable it in your browser settings." : "Get a small desktop nudge for new items while this desk is open."}</small></div><button className={notificationState === "enabled" ? "setting-button on" : "setting-button"} onClick={enableNotifications}>{notificationState === "enabled" ? "Enabled" : "Enable alerts"}</button></div>
        <div className="setting-row"><div><b>Quiet hours</b><small>Hold ordinary reminders from 10 PM until 8 AM.</small></div><button className={quietHours ? "switch on" : "switch"} onClick={() => setQuietHours(!quietHours)} aria-label="Toggle quiet hours"><i /></button></div>
        <div className="setting-row priority-setting"><div><b>Priority people</b><small>Search Google Contacts and choose their email. They receive a stronger Gmail signal; no messages are sent or changed.</small><div className="priority-editor"><input value={priorityDraft} onChange={(event) => { setPriorityDraft(event.target.value); setPriorityLookupMessage(null); }} onKeyDown={(event) => { if (event.key === "Enter") void addPriorityPerson(); }} placeholder="Search a name or email" aria-label="Search Google Contacts" /><button className="text-action" onClick={() => void addPriorityPerson()} disabled={!priorityDraft.trim() || priorityBusy}>{priorityBusy ? "Saving…" : "Add"}</button></div>{prioritySuggestions.length > 0 && <div className="priority-suggestions" role="listbox">{prioritySuggestions.map((person) => <button key={person.identifier} role="option" onClick={() => void addPriorityPerson(person)}><b>{person.label}</b><small>{person.identifier}</small><span>+</span></button>)}</div>}{priorityLookupMessage && <p className="priority-empty priority-lookup-message">{priorityLookupMessage}</p>}{priorityPeople.length ? <div className="priority-chips" aria-label="Priority people">{priorityPeople.map((person) => <span key={person.id}>{person.label}<button onClick={() => void removePriorityPerson(person.id)} aria-label={`Remove ${person.label}`}>×</button></span>)}</div> : <p className="priority-empty">Add someone above, then refresh Gmail to apply it to your recent inbox.</p>}</div></div>
        {(["gmail", "x"] as const).map((source) => <div key={source} className="setting-row priority-setting"><div><b>{source === "gmail" ? "Gmail watch words" : "X watch words"}</b><small>Words or short phrases that should make a human message more likely to surface.</small><div className="priority-editor"><input value={watchDrafts[source]} onChange={(event) => setWatchDrafts((current) => ({ ...current, [source]: event.target.value }))} onKeyDown={(event) => { if (event.key === "Enter") void addWatchWord(source); }} placeholder={source === "gmail" ? "e.g. partnership, contract" : "e.g. project, collaboration"} aria-label={`Add a ${source} watch word`} /><button className="text-action" onClick={() => void addWatchWord(source)} disabled={!watchDrafts[source].trim()}>Add</button></div>{watchWords[source].length ? <div className="priority-chips">{watchWords[source].map((word) => <span key={word.id}>{word.phrase}<button onClick={() => void removeWatchWord(source, word.id)} aria-label={`Remove ${word.phrase}`}>×</button></span>)}</div> : <p className="priority-empty">No watch words yet.</p>}</div></div>)}
        <div className="connection-row"><span className="connection-icon gmail">M</span><div><b>Connected sources</b><small>{gmail?.connected ? `${gmail.emails?.length ?? 1} Gmail account${(gmail.emails?.length ?? 1) === 1 ? "" : "s"} connected${x?.connected ? " · X DMs connected" : ""}` : x?.connected ? "X DMs connected" : "Choose Gmail, X DMs, or both."}</small></div><button onClick={() => { setSettingsOpen(false); setConnectionsOpen(true); }}>Manage</button></div>
      </section></div>}

      {connectionsOpen && <div className="settings-backdrop connections-backdrop" role="presentation" onMouseDown={() => setConnectionsOpen(false)}><section className="connections-sheet" role="dialog" aria-modal="true" aria-labelledby="connections-title" onMouseDown={(event) => event.stopPropagation()}>
        <button className="close-settings" onClick={() => setConnectionsOpen(false)} aria-label="Close connections">×</button>
        <p className="eyebrow">CHOOSE YOUR SOURCES</p><h2 id="connections-title">Bring only the conversations you want held close.</h2>
        <p className="connections-intro">{user ? "Tending works with either source, or both. Connect now, add the other later, and disconnect whenever you like." : "Start by signing in with Google. Then choose Gmail, X DMs, or both."}</p>
        <div className="connection-cards">
          <article className="connection-card">
            <div className="connection-card-top"><span className="connection-icon gmail">M</span><span className={gmail?.connected ? "connection-state connected" : "connection-state"}>{gmail?.connected ? "Connected" : "Optional"}</span></div>
            <h3>Gmail</h3><p>Surface unread email and conversations that may still need your reply. Connect more than one mailbox whenever you need.</p>
            <ul><li>Read-only access</li><li>Never sends, archives, or labels mail</li><li>Disconnect whenever you like</li></ul>
            <button className={gmail?.connected ? "connection-primary connected" : "connection-primary"} onClick={gmail?.connected ? syncGmailNow : connectGmail}>{gmail?.connected ? `Refresh ${gmail.emails?.length ?? 1} Gmail account${(gmail.emails?.length ?? 1) === 1 ? "" : "s"}` : user ? "Connect Gmail" : "Sign in to connect"}<span>↗</span></button>{gmail?.connected && <button className="connection-secondary" onClick={connectGmail}>Add another Gmail <span>↗</span></button>}
          </article>
          <article className="connection-card">
            <div className="connection-card-top"><span className="connection-icon x">𝕏</span><span className={x?.connected && x.dataFreshness !== "delayed" ? "connection-state connected" : "connection-state"}>{x?.dataFreshness === "delayed" ? "Feed delayed" : x?.connected ? "Connected" : "Optional"}</span></div>
            <h3>X direct messages</h3><p>{x?.dataFreshness === "delayed" ? `Checked ${x.lastSyncedAt ? new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" }).format(new Date(x.lastSyncedAt)) : "recently"}. X responded, but only supplied legacy events through ${x.latestEventAt ? new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(x.latestEventAt)) : "an unknown date"}. Newer XChat and Message Requests are not in this history feed.` : "New encrypted X chats are tracked live after you connect; legacy DM history may be incomplete."}</p>
            <ul><li>Read-only direct-message access</li><li>No posting or sending on your behalf</li><li>Uses your own X account</li></ul>
            <button className={x?.connected ? "connection-primary connected" : "connection-primary"} onClick={x?.connected ? syncXNow : connectX}>{x?.connected ? "Check legacy X DMs" : user ? "Connect X DMs" : "Sign in to connect"}<span>↗</span></button>{x?.connected && <><button className="connection-secondary" onClick={() => setXLimitationsOpen(true)}>How X tracking works <span>↗</span></button><button className="connection-secondary" onClick={() => void testXFeed()} disabled={xTesting}>{xTesting ? "Testing X API…" : "Test X connection"} <span>↗</span></button><button className="connection-secondary" onClick={connectX}>Reconnect X <span>↗</span></button></>}
          </article>
        </div>
        <p className="connections-footnote">You stay in control. Tending only uses the sources you explicitly connect.</p>
      </section></div>}
    </main>
  );
}
