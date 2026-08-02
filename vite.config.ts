import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { gmailCallback, gmailStart, gmailStatus, gmailSync, gmailThreads } from "./tendings/server/gmail";
import { xCallback, xEvents, xStart, xStatus, xSync } from "./tendings/server/x";
import { priorities } from "./tendings/server/priorities";
import { keywords } from "./tendings/server/keywords";

function responseAdapter(response: import("node:http").ServerResponse) {
  const adapter = {
    status(code: number) { response.statusCode = code; return adapter; },
    json(payload: unknown) { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(payload)); },
    redirect(code: number, location: string) { response.statusCode = code; response.setHeader("Location", location); response.end(); },
    setHeader(name: string, value: string | string[]) { response.setHeader(name, value); },
  };
  return adapter;
}

function localApi(): Plugin {
  return {
    name: "tending-local-api",
    configureServer(server) {
      server.middlewares.use("/api/tending/gmail", async (request, response, next) => {
        const action = request.url?.split("?")[0]?.replace(/^\//, "");
        const query = Object.fromEntries(new URL(request.url ?? "/", "http://localhost").searchParams.entries());
        const requestWithQuery = Object.assign(request, { query });
        const adapted = responseAdapter(response);
        if (action === "status") return gmailStatus(requestWithQuery, adapted);
        if (action === "start") return gmailStart(requestWithQuery, adapted);
        if (action === "callback") return gmailCallback(requestWithQuery, adapted);
        if (action === "sync") return gmailSync(requestWithQuery, adapted);
        if (action === "threads") return gmailThreads(requestWithQuery, adapted);
        next();
      });
      server.middlewares.use("/api/tending/x", async (request, response, next) => {
        const action = request.url?.split("?")[0]?.replace(/^\//, "");
        const query = Object.fromEntries(new URL(request.url ?? "/", "http://localhost").searchParams.entries());
        const requestWithQuery = Object.assign(request, { query });
        const adapted = responseAdapter(response);
        if (action === "status") return xStatus(requestWithQuery, adapted);
        if (action === "start") return xStart(requestWithQuery, adapted);
        if (action === "callback") return xCallback(requestWithQuery, adapted);
        if (action === "sync") return xSync(requestWithQuery, adapted);
        if (action === "events") return xEvents(requestWithQuery, adapted);
        next();
      });
      server.middlewares.use("/api/tending/priorities", async (request, response) => {
        const query = Object.fromEntries(new URL(request.url ?? "/", "http://localhost").searchParams.entries());
        return priorities(Object.assign(request, { query }), responseAdapter(response));
      });
      server.middlewares.use("/api/tending/keywords", async (request, response) => {
        const query = Object.fromEntries(new URL(request.url ?? "/", "http://localhost").searchParams.entries());
        return keywords(Object.assign(request, { query }), responseAdapter(response));
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  // `vercel build` writes pulled production variables to `.vercel/`.
  // Load that directory too so Vite can embed the explicitly public VITE_ values.
  const env = {
    ...loadEnv(mode, ".", ""),
    ...loadEnv(mode, ".vercel", ""),
  };
  Object.assign(process.env, Object.fromEntries(Object.entries(env).filter(([key]) => !process.env[key])));
  const publicEnv = Object.fromEntries(
    Object.entries(env)
      .filter(([key]) => key.startsWith("VITE_"))
      .map(([key, value]) => [`import.meta.env.${key}`, JSON.stringify(value)]),
  );
  return { plugins: [react(), localApi()], define: publicEnv };
});
