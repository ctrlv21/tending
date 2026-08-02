import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { gmailCallback, gmailStart, gmailStatus, gmailSync, gmailThreads } from "./tendings/server/gmail";
import { xCallback, xEvents, xStart, xStatus, xSync } from "./tendings/server/x";

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
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");
  Object.assign(process.env, Object.fromEntries(Object.entries(env).filter(([key]) => !process.env[key])));
  return { plugins: [react(), localApi()] };
});
