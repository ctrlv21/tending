# Tending — Product & Design Specification

**Status:** Build-ready v1 specification  
**Working name:** Tending  
**Promise:** Know what still needs your reply—without turning your inbox into another noisy feed.  
**Primary user:** Rucha, initially single-user; multi-user isolation is required from day one.

## 1. Product intent

Tending watches the conversations the user explicitly connects, identifies unread and genuinely reply-worthy messages, and gently brings them back at the right moment. It is a **reminder and triage tool**, not an autonomous communications agent. It never sends, archives, labels, deletes, or changes a message without a separate, explicit user action.

The product solves two distinct problems:

1. *Unread awareness:* “What arrived that I have not seen?”
2. *Follow-through awareness:* “What did I see but still owe a reply to—and which unanswered messages could have a real cost?”

The user should be able to open the dashboard once in the morning, understand their communications obligation in under 15 seconds, and trust that an important loose end will surface again without constant anxiety-inducing alerts.

## 2. Product principles

- **Calm is a feature.** A small, justified queue is more valuable than an exhaustive inbox mirror.
- **Explain the nudge.** Every priority and reminder exposes its reason in plain language.
- **The user stays in control.** Remind, snooze, mark handled, and open source are allowed; sending and mailbox mutation are not part of v1.
- **Private by construction.** Tokens and imported data never reach browser-side storage; content is minimized and encrypted at rest where appropriate.
- **Useful before clever.** The initial scorer is deterministic, inspectable, and user-tunable. AI is optional enrichment, never the sole basis for an urgent alert.
- **Source-native resolution.** Clicking an item opens Gmail or X in the correct conversation. Tending does not become a replacement email client.

## 3. Scope

### v1 (P0)

- Google Gmail connection via OAuth.
- X direct-message connection only where the connected X app/account has approved lookup access.
- Initial synchronization of recent inbox/DM conversations and incremental sync thereafter.
- A unified dashboard with `Needs reply`, `Unread`, `Waiting`, and `Done` views.
- Deterministic importance and reply-owed scoring with visible reasons.
- Browser/installed-PWA desktop notifications, quiet hours, notification permission flow, snooze, reminder cadence, and a once-daily digest.
- User-configurable VIP senders, domains, keywords, reminder windows, and source-specific notification settings.
- A settings area with connections, privacy controls, data deletion, and notification controls.
- Explicit empty, loading, stale-source, disconnected, and permission-denied states.

### v1.1 (P1)

- Optional model-assisted classification behind an explicit “Use message content to improve prioritization” setting.
- Draft a reply in Gmail/X only after the user initiates it; no send action.
- Calendar-aware deadline detection and “remind after the meeting” timing.
- Native macOS wrapper (Tauri) for notifications while a browser is not running.
- Per-contact learning from `important`, `not important`, and `handled` feedback.

### Explicit non-goals

- No automatic reply, sending, archiving, reading, labeling, deletion, or bulk mailbox mutation.
- No email search product, CRM, shared/team inbox, or full Gmail/X client.
- No scraping of X web pages or browser-session cookies. X support uses official API access only.
- No continuous screen watching, keystroke capture, or background browser extension in v1.
- No promise that every message receives real-time push delivery; sync health is visible and a periodic safety poll closes gaps.

## 4. Existing-code fit

Build Tending as a new sibling application at `tending/`, not inside the root Workabout Vite app.

Use `edition-prototype/` as the implementation base because it already has:

- Next.js/Vercel server boundaries.
- Supabase server-only access with no browser RLS policies.
- A private app session model.
- OAuth 2.0 PKCE session handling.
- AES-GCM encryption helpers for access and refresh tokens.
- An existing X OAuth configuration/repository pattern.

Relevant reusable references:

| Need | Existing reference |
| --- | --- |
| Token encryption and secure random state | `edition-prototype/lib/security/secrets.ts` |
| Owner-scoped, server-only database pattern | `edition-prototype/supabase/migrations/202607180001_initial_schema.sql` |
| X OAuth connection persistence | `edition-prototype/lib/x/repository.ts` |
| Atmospheric, editorial visual restraint | `edition-prototype/app/globals.css` |
| Warm, permission-first interaction copy | `petal-prototype/src/main.tsx` |
| Type scale, monochrome theme and mono metadata | `src/styles.css` |

Do not copy the newspaper layout literally. Borrow its material sensibility (paper, ink, rules, deliberate hierarchy) and the companion prototype’s warmth, but make the operational dashboard quiet and extremely legible.

## 5. Information architecture

```text
Tending
├── Today                     default dashboard
│   ├── Needs reply
│   ├── Unread
│   ├── Waiting / snoozed
│   └── Recently handled
├── All conversations         filterable operational list
├── Settings
│   ├── Notifications
│   ├── Priority rules
│   ├── Connected accounts
│   └── Privacy & data
└── Connection onboarding     first-use-only flow
```

### Dashboard hierarchy

`Needs reply` is the product’s central view. It is not a list of all unread mail. It contains only conversations for which the scorer believes the user owes a response or decision. `Unread` shows new, unseen items that do not yet meet that bar. `Waiting` contains user-snoozed conversations and messages deliberately deferred until a chosen time.

## 6. Core domain model

Normalize Gmail threads and X DM conversations into one `conversation` record. A conversation is the unit of triage, snoozing, notification, and handling; individual source messages are kept only as necessary evidence and source links.

```text
Connection (one source account)
  └─ Conversation (one Gmail thread or X DM conversation)
       └─ Message (normalized message metadata; body retained only if enabled)
       └─ Assessment (priority, reply-owed state, reasons, version)
       └─ Reminder (scheduled notification/digest entry)
       └─ User action (handled, snoozed, importance feedback)
```

### Conversation lifecycle

```text
discovered → unread | seen → needs_reply → reminded → handled
                              ↘ snoozed ───────────────↗
```

`needs_reply` and `unread` may both be true. `handled` is an app-local state, not a change to the source mailbox. A new inbound source message reopens a handled or snoozed conversation automatically and records why.

## 7. Priority and reply-owed policy

### 7.1 Rules before models

The initial scoring engine uses structured fields and safely parsed text signals. An item becomes `needs_reply` when it has a reasonable direct-request signal, an unanswered inbound message, or a user/VIP rule. An item becomes `urgent` only with an explicit high-confidence reason; the app must never call something urgent merely because it is unread.

### 7.2 Score (0–100)

| Signal | Points | Notes |
| --- | ---: | --- |
| User marked sender/domain as VIP | +30 | High-trust preference, always visible as the reason. |
| Direct question or request | +20 | From structured heuristic or optional model. |
| Explicit deadline within 48 hours | +25 | Include detected deadline and timezone in UI. |
| Client/customer/investor/legal/finance custom category | +20 | User-defined keyword/domain rule, not an opaque assumption. |
| Sender has 2+ prior user-marked important items | +15 | P1 learning signal. |
| Conversation has aged past reminder window | +10 | One-time contribution; does not endlessly increase. |
| Bulk/list/automated sender | −35 | Suppress unless VIP or direct reply indicator exists. |
| User marked similar sender/thread “not important” | −30 | User feedback wins. |

Thresholds:

- `80–100`: urgent; eligible for immediate notification, subject to quiet hours.
- `55–79`: needs reply; listed on Today, eligible for scheduled reminder.
- `30–54`: unread/watch; listed in Unread but no interruptive notification.
- `<30`: excluded from Today; discoverable in All conversations.

### 7.3 Reasons copy

Reasons are short, specific, and never pretend certainty:

- “From a VIP: Maya Chen”
- “Contains a question”
- “Deadline mentioned: Friday, 5 PM”
- “You marked this sender as client work”
- “Waiting 28 hours since the latest message”

Show at most two reasons on a list row; show all evidence in the detail drawer. For an AI-enriched judgement, label it “Tending’s suggestion” and provide `Not important` feedback directly beside it.

### 7.4 Source-specific reply semantics

**Gmail:** A thread needs a reply when the latest externally authored message arrived after the user’s latest sent message, is not sent by an automated/list source, and has a qualifying request or user rule. A conversation with no qualifying request remains unread/watch, not reply-owed.

**X DM:** A conversation needs a reply when the latest event is inbound, newer than the user’s latest sent event, and it is not user-handled/snoozed. X “read receipt” is not assumed to be reliable or available; user handling state is Tending’s source of truth.

## 8. Notifications

### 8.1 Delivery surfaces

- **PWA/browser notification:** primary v1 surface. Works while the installed app/service worker is available, subject to browser and OS settings.
- **In-product toast:** when Tending is open; never duplicates a system notification within 10 minutes.
- **Daily digest:** an in-app card plus optional one browser notification at the user-selected time.
- **Native desktop notifications:** P1 via Tauri for reliable delivery while browsers are closed.

### 8.2 Notification policy

| Trigger | Delivery | Default |
| --- | --- | --- |
| Newly discovered urgent item | Immediate, one notification | On |
| A `needs reply` item reaches its first reminder time | Scheduled notification | On |
| Still-unhandled urgent item after 24 hours | One escalation notification | On |
| Normal reply-owed item remains after 48 hours | Add to daily digest only | On |
| New unread item without reply/urgency signal | Dashboard only | No popup |
| More than 3 eligible notifications in 60 minutes | Digest/bundle | Always |

Default reminder windows: urgent 4 hours, normal 24 hours, low 72 hours. Defaults are starting points, not imposed behaviour.

### 8.3 Quiet hours and safety

- Default quiet hours: 10 PM–8 AM local time; user can change or disable them.
- During quiet hours, urgent items queue for the next allowed time. A user may opt into `critical only` interruptions.
- At most one message-specific escalation after the first reminder; Tending must not repeatedly nag.
- A notification contains sender, source, subject/first line, age, and one reason. It never displays an entire sensitive message body.
- Clicking a notification opens the associated conversation detail in Tending; the detail provides `Open in Gmail` or `Open in X`.

### 8.4 Notification popup examples

```text
Tending · Gmail
Reply due soon
Maya Chen asked about the revised contract.
Waiting 26h · deadline Friday
[Open] [Snooze tomorrow]
```

```text
Tending · Daily check-in
Three conversations still need you.
One is time-sensitive. Take a look when ready.
[Review]
```

## 9. Interface specification

### 9.1 Visual direction

The interface should feel like a carefully edited desk rather than a corporate command center:

- Warm mineral paper background, nearly black ink, one restrained vermilion urgency cue.
- Editorial serif for page-level statements; compact sans for actions; mono for timestamps and source metadata.
- Fine hairline rules, generous white space, almost no rounded “app cards.”
- Color supplements labels and icons; it never carries priority information alone.
- Motion is small and tactile: 160–220 ms opacity/position transitions; honor reduced-motion preferences.

### 9.2 Tokens

```css
--paper: #eee9dc;
--paper-raised: #f7f3ea;
--ink: #191714;
--soft-ink: #5d574e;
--rule: rgba(25, 23, 20, .22);
--urgent: #b73126;
--watch: #9c6c21;
--safe: #536443;
--display: "Iowan Old Style", "Baskerville", Georgia, serif;
--utility: Inter, ui-sans-serif, system-ui, sans-serif;
--mono: "IBM Plex Mono", ui-monospace, monospace;
--space-1: 4px; --space-2: 8px; --space-3: 12px;
--space-4: 16px; --space-5: 24px; --space-6: 32px; --space-8: 48px;
--radius-control: 4px;
--focus: 2px solid var(--urgent);
```

Use the Goings-On paper texture only at low contrast and never underneath dense list text. Do not use illustration, a pixel companion, gradients, or animated decorative elements in the primary triage view. The result should be quietly beautiful, not cute or busy.

### 9.3 Desktop layout (≥ 1100 px)

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│ TENDING                         Tuesday, Jul 28       ● synced just now  ⚙ │
├───────────────┬───────────────────────────────────────┬─────────────────────┤
│ TODAY         │ A small number of things need you.    │ DETAIL              │
│               │                                       │                     │
│  03 Needs     │ NEEDS REPLY (3)                       │ Maya Chen           │
│  08 Unread    │ ───────────────────────────────────   │ Gmail · 26h ago     │
│  02 Waiting   │ ! Maya Chen                           │                     │
│               │   Revised contract                    │ “Can you confirm…  │
│ ALL           │   deadline Friday · waiting 26h       │                     │
│  All          │                                       │ Why this surfaced   │
│               │ ○ Alexis Park                         │ • contains question │
│ SETTINGS      │   Deck for Thursday                   │ • deadline Friday   │
│ Notifications │   waiting 1d                          │                     │
│ Rules         │                                       │ [Open in Gmail]     │
│ Connections   │ UNREAD (8)                            │ [Mark handled]      │
│ Privacy       │ ───────────────────────────────────   │ [Snooze ▾]          │
└───────────────┴───────────────────────────────────────┴─────────────────────┘
```

- Left rail: 208 px fixed; source counts use tabular numerals.
- Main list: fluid, 520–760 px preferred width; list rows are 68–84 px, separated by rules.
- Detail panel: 360 px; opens when a row is selected, remains empty with a quiet instructional state otherwise.
- The main page container has a 20–28 px outer breathing margin, matching the framed, material feel of the editorial prototype.

### 9.4 Tablet and mobile

- **Tablet (700–1099 px):** hide detail panel until selection; show it as a 420 px overlay from the right.
- **Mobile (<700 px):** a single-column list; fixed top wordmark and a 44 px bottom navigation (`Today`, `All`, `Settings`). Detail opens as a full-height sheet. Primary row actions remain in detail; swipe is optional P1, never the only way to act.
- Do not make the dashboard a dense table on narrow screens. Preserve sender, title/preview, source, and one reason; hide secondary timestamps only after 320 px.

### 9.5 Today page states

**Connected and quiet:**

```text
You’re caught up.

Nothing is asking for a reply right now.
We’ll keep an eye on the conversations you connected.
```

Include `View unread (8)` if unread items exist. The empty state is not celebratory confetti; it is a modest pause.

**First use / no connection:**

```text
Keep your loose ends close.

Connect Gmail to surface unread messages and replies worth your attention.
[Connect Gmail]
```

X is shown as `Connect X DMs (availability depends on your X app access)` to avoid overpromising.

**Stale connection:** Banner above the list: `Gmail last checked 42 minutes ago. We’ll retry automatically.` Button: `Reconnect` only when refresh/token failure requires action.

### 9.6 Conversation list row

Each row includes:

1. Priority mark: `!` urgent, `•` needs reply, `○` unread/watch. Text label is screen-reader accessible.
2. Sender/conversation participant (one line, 42 character soft limit).
3. Subject/title or a generated source-safe fallback (`Direct message from Maya Chen`).
4. One-line sanitized preview (120 desktop / 88 mobile characters; redact where required by settings).
5. Source stamp (`Gmail` or `X DM`), relative age, and one highest-confidence reason.

Hover: paper-raised background and 2 px inset ink line at left. Selected: subtle ink wash, not a filled brand-colored card. Keyboard focus uses `--focus` with 3 px offset.

### 9.7 Detail panel interactions

The panel never becomes a composer. It displays only the minimum text necessary to make the triage decision and deliberately routes the user to the source for full context.

Actions, in visual order:

- `Open in Gmail` / `Open in X`: primary, opens a new source-native tab.
- `Mark handled`: marks the app-local conversation handled; confirmation text reads “We’ll bring it back if a new message arrives.”
- `Snooze`: menu: `Later today`, `Tomorrow morning`, `Monday`, `Pick a time`.
- `Not important`: removes it from Today and helps tune future ranking; reversible via undo toast for 8 seconds.

Only `Open` has a dark filled treatment. All other actions are text controls or outlined controls. Destructive data actions live only in Settings.

### 9.8 Onboarding

Four small screens, no long questionnaire:

1. **Promise:** “Tending notices the messages still waiting on you. It never sends or changes anything.”
2. **Connect Gmail:** explain read-only access and why it is requested; permit skip.
3. **Choose nudges:** reminder windows, digest time, quiet hours, then request notifications *after* the user enables a notification option.
4. **Set your guardrails:** VIP names/domains and one optional sensitive category. Include `Skip for now` everywhere.

After initial sync, show an attribution-safe review: “I found 3 conversations that may need you. Want to take a look?” Do not fire a notification during onboarding.

## 10. Data schema

Use a new Supabase migration within `tending/supabase/migrations/`. Reuse the secure `users`, `app_sessions`, and `oauth_sessions` pattern from `edition-prototype`, but do not share a production database until ownership and retention are explicitly decided.

### Core tables

| Table | Key fields | Purpose |
| --- | --- | --- |
| `users` | `id`, `email`, `display_name` | Application identity. |
| `app_sessions` | `token_hash`, `owner_id`, `expires_at` | Opaque, HTTP-only browser session. |
| `connections` | `owner_id`, `platform`, encrypted tokens, `sync_cursor`, `status`, `last_synced_at` | One Gmail or X connection per owner/platform. |
| `conversations` | source IDs, participants, latest-message fields, `source_url`, `app_status`, `handled_at`, `snoozed_until` | Normalized triage unit. |
| `messages` | conversation/source IDs, sender, direction, timestamp, headers, encrypted/minimized body | Sync evidence. |
| `assessments` | score, bucket, `reply_owed`, reasons JSON, scorer version, assessed timestamp | Explainable ranking record. |
| `reminders` | due time, kind, status, notification ID, attempts | Dedupe and cadence enforcement. |
| `preference_rules` | VIP, domain, keyword, source, score adjustment, enabled | User-tunable priority policy. |
| `user_actions` | handled/snoozed/not-important/important, timestamp, reversible metadata | Auditability and learning signals. |
| `sync_runs` | status, platform, started/completed, counts, safe error code | Connection health UI and operations. |

Constraints:

- Unique `owner_id, platform, platform_conversation_id` for conversations.
- Unique `owner_id, platform, platform_message_id` for messages.
- Every owner-scoped table has an indexed `owner_id` and server-only access.
- Connection access and refresh tokens are AES-GCM encrypted; never log token values.
- `source_url` is source-native and validated against allow-listed Gmail/X URL patterns before rendering.

### Retention defaults

- Store message metadata and assessment evidence for 90 days.
- Store content excerpt/body only when the user enables content-based ranking; encrypt it and delete it after 30 days by default.
- Keep user actions and rule settings until deleted, because they represent user preference rather than imported communication content.
- Disconnect immediately stops future sync and schedules deletion of imported messages/conversations/tokens within 24 hours; show status in the UI.

## 11. Backend and sync architecture

```text
Gmail OAuth ─┐                  ┌─ assessment/rules engine ─┐
             ├─ connector sync ─┤                           ├─ Supabase
X OAuth ─────┘                  └─ reminder scheduler ──────┘
                    ▲                   │                    │
Gmail Pub/Sub ──────┘                   └─ Web Push ────────┼─ Dashboard
Scheduled safety sync ──────────────────────────────────────┘
```

### Gmail connector (P0)

- OAuth web-server flow with offline access and the least viable scope: `gmail.readonly` for read/sync; do not request `gmail.modify`.
- Use Gmail mailbox `watch` on `INBOX` backed by Google Cloud Pub/Sub for fast change signals.
- Persist the returned `historyId`; process deltas with `history.list` and re-establish a watch before expiration.
- Run a scheduled recovery sync at least every 6 hours in case a push event is delayed/dropped.
- Use thread/message lookup to determine latest inbound/outbound state, headers, labels, and a source-native Gmail link.
- Deduplicate by Gmail thread and message ID; keep sync idempotent.

### X DM connector (conditional P0)

- Reuse OAuth 2.0 PKCE, encrypted token, refresh, disconnect, and owner-bound session patterns from `edition-prototype`.
- Before displaying the connection option as available, run a capability check against the configured X app/account. If DM lookup scope/product access is missing, present it as unavailable rather than a broken integration.
- Poll at a conservative, configurable interval within X limits; persist a cursor/latest event time and back off on rate limits.
- Do not scrape x.com, store browser credentials, or infer DM read states.
- Feature-flag all X DM code so Gmail can ship independently.

### Jobs

| Job | Trigger | Required behaviour |
| --- | --- | --- |
| `syncConnection` | OAuth completion, Gmail push, scheduled poll, user refresh | Idempotent, retryable, owner-scoped. |
| `assessConversation` | new/latest message or rule change | Creates versioned reasons; schedules/cancels reminders. |
| `deliverReminder` | due reminder | Enforces quiet hours, throttle, dedupe, and browser subscription status. |
| `refreshGmailWatch` | daily scheduler | Recreates watch before expiry and records health. |
| `retentionCleanup` | daily scheduler | Expires bodies, disconnected content, stale OAuth sessions, and old records. |

Vercel Cron is suitable for periodic recovery, watch renewal, reminder delivery, and cleanup. Gmail Pub/Sub delivery requires a signed server webhook endpoint. Use an idempotency key (`platform + connection + source event/history id`) for every incoming change.

## 12. API contracts

All APIs require a valid application session. Return owner-filtered data only. No source token, raw OAuth metadata, or full body is ever returned by a generic list endpoint.

| Method / route | Purpose |
| --- | --- |
| `GET /api/today` | Counts, selected Today queue, sync health, digest state. |
| `GET /api/conversations?view=&cursor=` | Paginated list; filters `needs-reply`, `unread`, `waiting`, `all`. |
| `GET /api/conversations/:id` | Detail drawer payload and safe source URL. |
| `POST /api/conversations/:id/actions` | `{type: handled|snooze|important|not_important, until?}`. |
| `GET /api/settings` / `PATCH /api/settings` | Notification, quiet hour, retention, and rule preferences. |
| `POST /api/connections/gmail/start` | Initiates Google OAuth. |
| `GET /api/connections/gmail/callback` | Exchanges code, stores encrypted tokens, starts initial sync. |
| `POST /api/connections/x/start` | Initiates X OAuth only when feature flag/capability passes. |
| `POST /api/connections/:platform/disconnect` | Stops sync and schedules deletion. |
| `POST /api/notifications/subscribe` | Stores a Web Push subscription after permission grant. |
| `POST /api/webhooks/gmail` | Validates and queues Gmail Pub/Sub event. |

`POST /api/conversations/:id/actions` response must include the revised conversation assessment and scheduled reminder state so the client can update optimistically and reconcile.

## 13. Security, privacy, and trust requirements

- OAuth state is single-use, expires in 10 minutes, and is bound to the app session.
- Persist refresh tokens server-side only, encrypted with AES-GCM using a rotation-capable secret. Cookies contain only an opaque, `HttpOnly`, `Secure`, `SameSite=Lax` session token.
- No `NEXT_PUBLIC_` secret, service-role key, OAuth client secret, or encryption key.
- Minimize content exposure: list endpoints use subject/sender/timestamp/reasons, not raw full messages.
- Log only operational metadata (job ID, connection ID, count, safe error class). Do not put message text or email addresses in analytics/error logs.
- Explain Gmail scope, data handling, retention, and disconnect deletion in-product before authorization.
- Provide `Export my app data` and `Delete all Tending data` in v1 Settings. Account/data deletion must include tokens, push subscriptions, connections, message content, conversations, actions, and sessions.
- Never show a notification body on a locked screen unless the user enables `Show message previews in notifications`.
- Add a threat-model review before public deployment, including OAuth redirect manipulation, webhook forgery, cross-account reads, token theft, notification leakage, and replayed sync events.

## 14. Accessibility and quality bar

- WCAG 2.2 AA minimum, including 4.5:1 text contrast and visible focus states.
- Semantic navigation, list, heading, dialog, and status regions; notification/sync updates announced via polite live region.
- Full keyboard path: `j/k` optional row navigation; Enter opens detail; `h` marks handled only after confirmation; all functions also reachable with Tab/Shift+Tab.
- No color-only priority cues. Include labels in detail and accessible names on priority marks.
- Respect `prefers-reduced-motion`; all motion becomes instant or a simple fade.
- No row title/preview truncation that hides the only reason an item was surfaced; preserve reason text first.

## 15. Acceptance criteria

### Gmail connection and sync

- Given an authorized Gmail account, when the initial sync completes, then recent inbox threads appear without duplicate conversation rows.
- Given an incoming Gmail thread that changes after a stored history ID, when a push or safety sync runs, then only the relevant thread is updated and reassessed.
- Given a refresh token is revoked, when sync runs, then the connection becomes `needs_reconnect`, the dashboard keeps last known data marked stale, and the user sees a non-technical reconnect action.
- Given a Gmail message is unread but not a likely request, when it syncs, then it appears in `Unread` and does not create an interruptive popup by default.

### Triage and reminders

- Given an inbound Gmail/X conversation with an explicit question and no later user reply, when it is assessed, then it is marked `needs reply` with a visible `contains a question` reason.
- Given a VIP message with a deadline in 48 hours, when it syncs outside quiet hours, then it is eligible for one immediate notification and appears first in `Needs reply`.
- Given a normal-priority item is snoozed until tomorrow, when the dashboard refreshes, then it leaves `Needs reply`, appears in `Waiting`, and no notification is sent before the chosen time.
- Given an item is marked handled, when no new source message appears, then it remains out of Today. Given a new inbound source message, then it reopens and shows `new message received` as its reason.
- Given four eligible reminders within an hour, when the fourth becomes due, then the system sends no more than three individual notifications and bundles the remaining one into a digest.

### Privacy and user control

- Given a user clicks `Open in Gmail` or `Open in X`, then the source opens in a new tab and Tending does not send or mutate the conversation.
- Given a user disconnects Gmail/X, then future sync stops immediately; encrypted tokens are removed; deletion progress is visible.
- Given two application users, when either requests any dashboard or conversation route, then data from the other owner is never returned.
- Given notification preview is disabled, when a notification is delivered, then it includes only a generic count/status and not source content.

## 16. Measurement plan

Track events without message content or full sender identity. Hash stable identifiers with a per-environment salt if aggregation is required.

| Metric | Target after 30 days | Measurement |
| --- | ---: | --- |
| Gmail connection completion | ≥80% of started connects | OAuth start → connected. |
| First-value rate | ≥70% | User opens an item from Today within first session after sync. |
| Queue usefulness | ≥60% | `handled` or `open_source` action on a surfaced Needs reply item. |
| False-positive feedback | <15% | `not_important` / surfaced items. |
| Notification helpfulness | ≥35% | Notification-open / delivered notifications. |
| Notification fatigue | <5% | Notifications disabled within 7 days of first delivery. |
| Sync freshness | 95% within 10 min for Gmail push / 6 h recovery | Sync health timestamp. |

## 17. Delivery plan

### Phase 0 — product-shaped prototype (3–5 days)

- Create `tending/` as a Next.js app using fixture data only.
- Build responsive Today, list row, detail drawer, settings, empty/stale states, and Notification Permission education screen.
- Add a service-worker notification simulator and test the complete snooze/handled lifecycle locally.
- User test the visual hierarchy with 10–20 realistic but fictional conversations.

**Exit:** A person can understand what needs a reply, why, and what each action does without integrations.

### Phase 1 — Gmail private alpha (1–2 weeks)

- Implement identity/session, encrypted Gmail OAuth token storage, Supabase schema, initial sync, incremental history sync, scorer, actions, settings, Web Push subscriptions, and cron jobs.
- Implement Gmail Pub/Sub after scheduled sync is correct and observable.
- Add sync/retry/connection-health instrumentation and retention cleanup.

**Exit:** A connected Gmail account accurately produces a private, useful queue and reminder without duplicate or repeated notification failures.

### Phase 2 — tuning and trust (1 week)

- Add rule editor, VIPs, safe feedback loops, preview privacy toggle, export/deletion, score explanations, and a quality review pass for edge cases.
- Validate notification cadence for a full work week before widening use.

**Exit:** User can confidently explain why every item appears and can reverse/override the system easily.

### Phase 3 — X DM feasibility and connector (conditional)

- Confirm X account/app capability and pricing with a test account before committing UI work.
- Implement DM lookup polling, normalizer, cursor persistence, rate-limit backoff, and connection/reconnect states behind a feature flag.

**Exit:** A test account can sync DM conversations repeatedly without duplicates, leaks, scraping, or rate-limit loops. If capability is unavailable, leave the Gmail product complete and hide X rather than shipping a degraded promise.

## 18. Decisions to make before implementation

1. **Identity:** Is this strictly for one personal account initially, or should friends/beta users be able to sign up? The spec assumes app-owned multi-user isolation but a single owner for alpha.
2. **Deployment:** Use a new Vercel project and a new Supabase project, or intentionally share the edition prototype’s project? Recommendation: separate projects for cleaner data retention and blast-radius boundaries.
3. **Message-content policy:** Start metadata/headers only, or opt into encrypted body excerpts for stronger question/deadline detection? Recommendation: metadata plus latest-message excerpt only after explicit user consent.
4. **Notification surface:** Is an installed browser app sufficient for alpha? Recommendation: yes; defer native macOS wrapper until notification behavior is proven useful.
5. **X:** Do you already have an approved X developer app with DM lookup access? This is the only external capability that may prevent the X portion from shipping on the Gmail timeline.

## 19. Build handoff

Recommended first implementation artifacts:

```text
tending/
  app/
    page.tsx                         # Today
    all/page.tsx
    settings/page.tsx
    api/...
  components/
    TodayQueue.tsx
    ConversationRow.tsx
    ConversationDetail.tsx
    PriorityReason.tsx
    NotificationSettings.tsx
    ConnectionStatus.tsx
  lib/
    inbox/types.ts
    inbox/score.ts
    inbox/normalizers/gmail.ts
    inbox/normalizers/x.ts
    inbox/reminders.ts
    gmail/
    x/
    security/
  supabase/migrations/
  public/manifest.webmanifest
  tests/
```

Start with fixtures and a deterministic `score.ts`; no live OAuth code should be necessary to validate the core interface. The production integrations should slot into the normalized conversation contract rather than shape the UI.
