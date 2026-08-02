# Tending

Tending is a quiet follow-through dashboard for Gmail and X DMs: it surfaces messages that need a reply without becoming another inbox.

## Local setup

1. Copy `.env.example` to `.env.local` and add the credentials for Supabase, Gmail OAuth, and X OAuth.
2. Apply [`supabase/schema.sql`](supabase/schema.sql) in the Supabase SQL editor.
3. Run `npm install`, then `npm run dev`.

## Deployment

Deploy to Vercel with the variables in `.env.example`. Set `TENDING_APP_URL` to the production URL and register these callback URLs with the providers:

- `https://your-domain/api/tending/gmail/callback`
- `https://your-domain/api/tending/x/callback`

OAuth tokens are encrypted at rest with `TOKEN_ENCRYPTION_KEY`; never commit `.env.local`.
