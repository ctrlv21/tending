-- Tending private data model. Apply this migration in the Supabase SQL editor.
-- Browser roles intentionally have no direct access; API routes use the service role.
create table if not exists public.tending_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.tending_gmail_oauth_states (
  state_hash text primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  code_verifier_encrypted text not null,
  redirect_uri text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists tending_gmail_oauth_states_expiry_idx on public.tending_gmail_oauth_states (expires_at);

create table if not exists public.tending_gmail_connections (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  gmail_email text,
  access_token_encrypted text not null,
  refresh_token_encrypted text,
  token_expires_at timestamptz not null,
  history_id text,
  status text not null default 'connected' check (status in ('connected', 'needs_reconnect', 'disconnected')),
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_synced_at timestamptz
);

create table if not exists public.tending_gmail_threads (
  owner_id uuid not null references auth.users(id) on delete cascade,
  gmail_thread_id text not null,
  sender text not null,
  subject text not null,
  snippet text not null default '',
  latest_message_at timestamptz not null,
  unread boolean not null default false,
  reply_worthy boolean not null default false,
  source_url text not null,
  updated_at timestamptz not null default now(),
  primary key (owner_id, gmail_thread_id)
);
create index if not exists tending_gmail_threads_queue_idx on public.tending_gmail_threads (owner_id, reply_worthy desc, unread desc, latest_message_at desc);

create table if not exists public.tending_x_oauth_states (
  state_hash text primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  code_verifier_encrypted text not null,
  redirect_uri text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists public.tending_x_connections (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  x_user_id text not null,
  username text,
  display_name text,
  access_token_encrypted text not null,
  refresh_token_encrypted text,
  token_expires_at timestamptz not null,
  status text not null default 'connected',
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_synced_at timestamptz
);

create table if not exists public.tending_x_events (
  owner_id uuid not null references auth.users(id) on delete cascade,
  x_event_id text not null,
  conversation_id text,
  sender_id text,
  sender_name text not null,
  text text not null,
  created_at_x timestamptz not null,
  inbound boolean not null default true,
  reply_worthy boolean not null default false,
  classification text not null default 'not_pending',
  relevance_score integer not null default 0,
  spam_score integer not null default 0,
  sender_followed boolean not null default false,
  source_url text,
  updated_at timestamptz not null default now(),
  primary key (owner_id, x_event_id)
);
create index if not exists tending_x_oauth_states_expiry_idx on public.tending_x_oauth_states (expires_at);
create index if not exists tending_x_events_queue_idx on public.tending_x_events (owner_id, reply_worthy desc, inbound desc, created_at_x desc);

alter table public.tending_profiles enable row level security;
alter table public.tending_gmail_oauth_states enable row level security;
alter table public.tending_gmail_connections enable row level security;
alter table public.tending_gmail_threads enable row level security;
alter table public.tending_x_oauth_states enable row level security;
alter table public.tending_x_connections enable row level security;
alter table public.tending_x_events enable row level security;

revoke all on table public.tending_profiles from anon, authenticated;
revoke all on table public.tending_gmail_oauth_states from anon, authenticated;
revoke all on table public.tending_gmail_connections from anon, authenticated;
revoke all on table public.tending_gmail_threads from anon, authenticated;
revoke all on table public.tending_x_oauth_states from anon, authenticated;
revoke all on table public.tending_x_connections from anon, authenticated;
revoke all on table public.tending_x_events from anon, authenticated;
