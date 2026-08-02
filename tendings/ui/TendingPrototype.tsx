import { useEffect, useMemo, useState } from "react";
import type { User } from "@supabase/supabase-js";
import "./tending.css";
import { tendingSupabase } from "./supabase";

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

type GmailStatus = { configured: boolean; connected: boolean; status: string; email: string | null; lastSyncedAt: string | null; message?: string };
type GmailThread = { gmail_thread_id: string; sender: string; subject: string; snippet: string; latest_message_at: string; unread: boolean; reply_worthy: boolean; source_url: string };
type XStatus = { configured: boolean; connected: boolean; status: string; username: string | null; message?: string };
type XEvent = { x_event_id: string; sender_name: string; text: string; created_at_x: string; reply_worthy: boolean; classification: "needs_reply" | "worth_a_look"; sender_followed: boolean; source_url: string };

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
  const [conversations, setConversations] = useState(INITIAL_CONVERSATIONS);
  const [activeView, setActiveView] = useState<Bucket>("needs_reply");
  const [selectedId, setSelectedId] = useState("maya");
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
    if (!authReady) return;
    if (!user) {
      setGmail(null);
      setConversations(INITIAL_CONVERSATIONS);
      setSelectedId("maya");
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
          setConversations([]);
          setSelectedId("");
          return;
        }
        const threadResponse = await gmailFetch("/api/tending/gmail/threads");
        const payload = await threadResponse.json() as { threads?: GmailThread[] };
        if (cancelled || !payload.threads) return;
        const liveConversations: Conversation[] = payload.threads.map((thread) => {
          const bucket: Bucket = thread.reply_worthy ? "needs_reply" : "unread";
          return {
            id: `gmail-${thread.gmail_thread_id}`,
            sender: thread.sender,
            initials: thread.sender.split(/\s+/).map((word) => word[0]).join("").slice(0, 2).toUpperCase() || "GM",
            title: thread.subject,
            preview: thread.snippet,
            source: "Gmail",
            age: new Intl.RelativeTimeFormat("en", { numeric: "auto" }).format(Math.round((new Date(thread.latest_message_at).getTime() - Date.now()) / 3_600_000), "hour"),
            priority: thread.reply_worthy ? "reply" : "watch",
            bucket,
            reason: thread.reply_worthy ? "contains a request" : "unread",
            reasons: thread.reply_worthy ? ["The latest message is from this sender", "Contains a question or request"] : ["New inbox message"],
            detail: thread.snippet,
            sourceUrl: thread.source_url,
          };
        });
        setConversations(liveConversations);
        setSelectedId(liveConversations[0]?.id ?? "");
      } catch {
        if (!cancelled) setGmail({ configured: false, connected: false, status: "setup_required", email: null, lastSyncedAt: null, message: "Gmail setup is not complete." });
      }
    }
    void loadGmail();
    return () => { cancelled = true; };
  }, [authReady, user?.id]);

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
        const xConversations: Conversation[] = payload.events.map((event) => ({
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
          reasons: ["Latest message is from this sender", ...(event.sender_followed ? ["You follow this account"] : []), ...(event.reply_worthy ? ["Contains a question or request"] : ["Not classified as likely promotion"])],
          detail: event.text,
          sourceUrl: event.source_url,
        }));
        setConversations((current) => [...current.filter((conversation) => conversation.source !== "X DM"), ...xConversations]);
      } catch { if (!cancelled) setX({ configured: false, connected: false, status: "setup_required", username: null, message: "X setup is not complete." }); }
    }
    void loadX();
    return () => { cancelled = true; };
  }, [authReady, user?.id]);

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

  function markHandled() {
    if (!selected) return;
    updateConversation(selected.id, { bucket: "handled", reason: "handled just now" }, "Marked handled. We’ll bring it back if a new message arrives.");
    setActiveView("needs_reply");
  }

  function snooze(label: string) {
    if (!selected) return;
    updateConversation(selected.id, { bucket: "waiting", snoozeLabel: label, reason: `snoozed until ${label.toLowerCase()}` }, `Okay — we’ll bring this back ${label.toLowerCase()}.`);
    setActiveView("needs_reply");
  }

  async function enableNotifications() {
    if (!("Notification" in window)) {
      setNotificationState("blocked");
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission === "granted") {
      setNotificationState("enabled");
      new Notification("Tending · Gmail", {
        body: "Maya Chen asked about the revised contract. Waiting 26h · deadline Friday",
      });
      setToast("A sample reminder is on its way to your desktop.");
    } else {
      setNotificationState("blocked");
    }
  }

  async function signIn() {
    if (!tendingSupabase) {
      setToast("Add Tending’s public Supabase URL and publishable key to enable sign-in.");
      return;
    }
    const { error } = await tendingSupabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${window.location.origin}/tending` },
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
      const result = await response.json() as { synced: boolean; count?: number; error?: string };
      setToast(result.synced ? `X refreshed — ${result.count ?? 0} direct messages checked.` : result.error ?? "X could not refresh.");
      if (result.synced) window.setTimeout(() => window.location.reload(), 450);
    } catch { setToast("X could not refresh right now."); }
  }

  async function syncGmailNow() {
    try {
      const response = await gmailFetch("/api/tending/gmail/sync", { method: "POST" });
      const result = await response.json() as { synced: boolean; count?: number; error?: string };
      setToast(result.synced ? `Gmail refreshed — ${result.count ?? 0} inbox threads checked.` : result.error ?? "Gmail could not refresh.");
      if (result.synced) window.setTimeout(() => window.location.reload(), 450);
    } catch { setToast("Gmail could not refresh right now."); }
  }

  return (
    <main className="tending-shell">
      <header className="tending-topbar">
        <a className="tending-wordmark" href="/tending" aria-label="Tending home">tending<span>·</span></a>
        <div className="tending-date">Tuesday, July 28</div>
        <div className="tending-status"><i /> {user ? (gmail?.connected ? "Gmail connected" : user.email ?? "Signed in") : "Private by default"} <button onClick={() => setSettingsOpen(true)} aria-label="Open settings">Settings</button><button onClick={user ? signOut : signIn}>{user ? "Sign out" : "Sign in"}</button></div>
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
              <h1>{activeView === "needs_reply" && counts.needs_reply ? <>A small number of<br/><span className="heading-tail">things <em>need you.</em></span></> : activeView === "unread" ? <>New things, <em>no rush.</em></> : activeView === "waiting" ? <>You chose to <em>come back.</em></> : <>A little <em>lighter.</em></>}</h1>
            </div>
            <button className="queue-refresh" onClick={gmail?.connected ? syncGmailNow : () => setToast("Connect Gmail when you’re ready — fixtures are shown for now.")}>↻ <span>Refresh</span></button>
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
            <div className="detail-message"><h3>{selected.title}</h3><p>{selected.detail}</p>{selected.deadline && <div className="deadline">Deadline <b>{selected.deadline}</b></div>}</div>
            <div className="detail-reasons"><p className="eyebrow">WHY THIS SURFACED</p>{selected.reasons.map((reason) => <p key={reason}><i>+</i>{reason}</p>)}</div>
            {selected.bucket === "waiting" && <div className="detail-snoozed">Snoozed until <b>{selected.snoozeLabel}</b></div>}
            <div className="detail-actions">
              <button className="open-source" onClick={() => selected.sourceUrl ? window.open(selected.sourceUrl, "_blank", "noopener,noreferrer") : setToast(`In the live app, this opens the original ${selected.source} conversation.`)}>Open in {selected.source === "Gmail" ? "Gmail" : "X"} <span>↗</span></button>
              {selected.bucket !== "handled" && <div className="action-pair"><button onClick={markHandled}>Mark handled</button><div className="snooze-wrap"><button onClick={() => setSnoozeMenu(!snoozeMenu)}>Snooze <span>⌄</span></button>{snoozeMenu && <div className="snooze-menu"><button onClick={() => snooze("later today")}>Later today</button><button onClick={() => snooze("tomorrow · 9 AM")}>Tomorrow morning</button><button onClick={() => snooze("Monday · 10 AM")}>Monday</button></div>}</div></div>}
              <button className="not-important" onClick={() => updateConversation(selected.id, { bucket: "handled", reason: "not important" }, "Removed from your queue. You can always change this later.")}>Not important</button>
            </div>
          </> : <div className="detail-empty"><span>→</span><h2>Choose a conversation.</h2><p>Its context and your next move will stay right here.</p></div>}
        </aside>
      </div>

      <nav className="tending-mobile-nav" aria-label="Mobile navigation">
        {(["needs_reply", "unread", "waiting"] as Bucket[]).map((view) => <button key={view} className={activeView === view ? "active" : ""} onClick={() => setActiveView(view)}>{view === "needs_reply" ? "Today" : VIEW_LABELS[view]}<b>{counts[view]}</b></button>)}
        <button onClick={() => setSettingsOpen(true)}>Settings</button>
      </nav>

      {toast && <div className="tending-toast" role="status">{toast}<button onClick={() => setToast(null)}>×</button></div>}

      {settingsOpen && <div className="settings-backdrop" role="presentation" onMouseDown={() => setSettingsOpen(false)}><section className="settings-sheet" role="dialog" aria-modal="true" aria-labelledby="settings-title" onMouseDown={(event) => event.stopPropagation()}>
        <button className="close-settings" onClick={() => setSettingsOpen(false)} aria-label="Close settings">×</button>
        <p className="eyebrow">YOUR BOUNDARIES</p><h2 id="settings-title">A little help, on your terms.</h2><p className="settings-intro">Tending only reminds you about conversations you connect. It never sends, archives, or changes anything.</p>
        <div className="setting-row"><div><b>Desktop reminders</b><small>{notificationState === "enabled" ? "Enabled — your test reminder was sent." : notificationState === "blocked" ? "Permission wasn’t granted. You can enable it in your browser settings." : "Get a small desktop nudge when something needs you."}</small></div><button className={notificationState === "enabled" ? "setting-button on" : "setting-button"} onClick={enableNotifications}>{notificationState === "enabled" ? "Enabled" : "Try a reminder"}</button></div>
        <div className="setting-row"><div><b>Quiet hours</b><small>Hold ordinary reminders from 10 PM until 8 AM.</small></div><button className={quietHours ? "switch on" : "switch"} onClick={() => setQuietHours(!quietHours)} aria-label="Toggle quiet hours"><i /></button></div>
        <div className="setting-row"><div><b>Priority people</b><small>Maya Chen, Alexis Park, northstar.vc</small></div><button className="text-action" onClick={() => setToast("Priority people editing is the next prototype interaction.")}>Edit</button></div>
        <div className="connection-row"><span className="connection-icon gmail">M</span><div><b>Connected sources</b><small>{gmail?.connected ? `${gmail.email ?? "Gmail"} is connected` : "Choose Gmail, X DMs, or both."}</small></div><button onClick={() => { setSettingsOpen(false); setConnectionsOpen(true); }}>Manage</button></div>
      </section></div>}

      {connectionsOpen && <div className="settings-backdrop connections-backdrop" role="presentation" onMouseDown={() => setConnectionsOpen(false)}><section className="connections-sheet" role="dialog" aria-modal="true" aria-labelledby="connections-title" onMouseDown={(event) => event.stopPropagation()}>
        <button className="close-settings" onClick={() => setConnectionsOpen(false)} aria-label="Close connections">×</button>
        <p className="eyebrow">CHOOSE YOUR SOURCES</p><h2 id="connections-title">Bring only the conversations you want held close.</h2>
        <p className="connections-intro">{user ? "Tending works with either source, or both. Connect now, add the other later, and disconnect whenever you like." : "Start by signing in with Google. Then choose Gmail, X DMs, or both."}</p>
        <div className="connection-cards">
          <article className="connection-card">
            <div className="connection-card-top"><span className="connection-icon gmail">M</span><span className={gmail?.connected ? "connection-state connected" : "connection-state"}>{gmail?.connected ? "Connected" : "Optional"}</span></div>
            <h3>Gmail</h3><p>Surface unread email and conversations that may still need your reply.</p>
            <ul><li>Read-only access</li><li>Never sends, archives, or labels mail</li><li>Disconnect whenever you like</li></ul>
            <button className={gmail?.connected ? "connection-primary connected" : "connection-primary"} onClick={gmail?.connected ? syncGmailNow : connectGmail}>{gmail?.connected ? "Refresh Gmail" : user ? "Connect Gmail" : "Sign in to connect"}<span>↗</span></button>
          </article>
          <article className="connection-card">
            <div className="connection-card-top"><span className="connection-icon x">𝕏</span><span className={x?.connected ? "connection-state connected" : "connection-state"}>{x?.connected ? "Connected" : "Optional"}</span></div>
            <h3>X direct messages</h3><p>Keep unread DMs and the conversations you still owe a reply in the same quiet place.</p>
            <ul><li>Read-only direct-message access</li><li>No posting or sending on your behalf</li><li>Uses your own X account</li></ul>
            <button className={x?.connected ? "connection-primary connected" : "connection-primary"} onClick={x?.connected ? syncXNow : connectX}>{x?.connected ? "Refresh X DMs" : user ? "Connect X DMs" : "Sign in to connect"}<span>↗</span></button>
          </article>
        </div>
        <p className="connections-footnote">You stay in control. Tending only uses the sources you explicitly connect.</p>
      </section></div>}
    </main>
  );
}
