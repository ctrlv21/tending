import { xCallback } from "../../../tendings/server/x.js";
// X signs the exact POST body, so Vercel must leave it unread for xCallback.
export const config = { api: { bodyParser: false } };
export default function handler(request: any, response: any) { return xCallback(request, response); }
