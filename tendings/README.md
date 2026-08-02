# Tending

All Tending-specific product code lives here.

- `ui/` — the `/tending` React interface and its styles
- `server/` — Gmail OAuth, encrypted-token handling, and sync logic
- `api/` — Gmail API handlers
- `Tending_Product_Spec.md` — product, architecture, and design specification

The small files in `/api/tending/gmail/` are deployment entry points required by Vercel. They only delegate into this folder.
