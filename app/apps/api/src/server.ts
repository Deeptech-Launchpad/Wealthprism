import Fastify from "fastify";
import cors from "@fastify/cors";
import { ZodError } from "zod";
import { config } from "./config.js";
import authRoutes from "./routes/auth.js";
import familyRoutes from "./routes/family.js";
import portfolioRoutes from "./routes/portfolio.js";
import moduleRoutes from "./routes/modules.js";
import importRoutes from "./routes/imports.js";
import marketRoutes from "./routes/market.js";
import realEstateRoutes from "./routes/realestate.js";
import depositRoutes from "./routes/deposits.js";
import notificationRoutes from "./routes/notifications.js";
import planningRoutes from "./routes/planning.js";
import policyRoutes from "./routes/policy.js";
import rebalanceRoutes from "./routes/rebalance.js";
import glRoutes from "./routes/gl.js";
import researchRoutes from "./routes/research.js";
import connectorRoutes from "./routes/connectors.js";
import documentRoutes, { fileRoutes } from "./routes/documents.js";
import reportRoutes, { inviteRoutes } from "./routes/reports.js";
import openDataRoutes from "./routes/opendata.js";
import balanceRoutes from "./routes/balance.js";
import analyticsRoutes from "./routes/analytics.js";
import bankingRoutes, { aaPublicRoutes } from "./routes/banking.js";
import ingestRoutes, { ingestPublicRoutes } from "./routes/ingest.js";
import allocationRoutes from "./routes/allocation.js";
import investmentsRoutes from "./routes/investments.js";
import startupsRoutes from "./routes/startups.js";
import mfaRoutes from "./routes/auth_mfa.js";
import webauthnRoutes from "./routes/webauthn.js";
import { accountRoutes } from "./routes/family.js";
import globalRoutes from "./routes/global.js";
import { installDelivery } from "./lib/delivery.js";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import multipart from "@fastify/multipart";
import { registerStubs } from "./lib/stubs.js";
import { createMcp, injectApiCall } from "./lib/mcp.js";
import { existsSync } from "node:fs";
import { pool, txContext } from "./lib/db.js";

export function buildApp() {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" }, routerOptions: { maxParamLength: 2048 } });   // signed file tokens travel in the path
  app.register(cors, { origin: config.corsOrigin === "*" ? true : config.corsOrigin.split(","), allowedHeaders: ["Authorization", "Content-Type", "X-Family-Id"] });
  app.register(helmet, { contentSecurityPolicy: false });
  app.register(rateLimit, { max: Number(process.env.RATE_LIMIT_MAX ?? 300), timeWindow: "1 minute", allowList: (req) => req.url === "/healthz" || req.url === "/readyz" });
  app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024, files: 1 } });
  // a response never leaves before the family transactions opened while handling the request have committed
  app.addHook("onRequest", (_req, reply, done) => {
    // Fastify's async-handler wrapper re-sends when the response has not ended by the time the handler's promise resolves; with an
    // asynchronous onSend that can happen while the write is still pending. First send wins; a second call is a no-op.
    const send = reply.send; let sent = false; reply.send = function (this: any, payload?: unknown) { if (sent && payload === undefined) return this; sent = true; return send.call(this, payload); } as typeof reply.send;
    txContext.run({ pending: [], open: 0 }, done);
  });
  app.addHook("onSend", (_req, _reply, payload, done) => { const st = txContext.getStore(); if (!st || st.open === 0) return done(null, payload); Promise.allSettled(st.pending).then(() => done(null, payload)); });
  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof ZodError) return reply.code(422).send({ title: "Validation failed", status: 422, errors: err.issues });
    const status = err.statusCode ?? 500;
    if (status >= 500) app.log.error(err);
    reply.code(status).send({ title: err.message ?? "Error", status });
  });
  installDelivery();   // notify's e-mail goes through EMAIL_TRANSPORT (log | ses | smtp)
  app.get("/healthz", async () => ({ ok: true }));
  app.get("/readyz", async () => { await pool.query("select 1"); return { ok: true }; });
  /** MCP over HTTP (FO-104 v1.2, roadmap gap): the same tools as the stdio transport (src/mcp.ts), reachable by a hosted / remote assistant
   *  that cannot spawn a local process. Each request authenticates with its own bearer API key — unlike stdio, this is multi-tenant, so a
   *  fresh handle (and scope cache) is built per request rather than once per process. Streamable-HTTP-style: one JSON-RPC message or batch
   *  per POST, synchronous response, no SSE stream (this server has no server-initiated notifications to push). */
  app.post("/mcp", async (req, reply) => {
    const h = req.headers.authorization ?? ""; const apiKey = h.startsWith("Bearer ") ? h.slice(7) : "";
    const handle = createMcp(injectApiCall(app, apiKey));
    const body = req.body as any; const msgs = Array.isArray(body) ? body : [body];
    const out: any[] = []; for (const m of msgs) { const r = await handle(m); if (r) out.push(r); }
    if (!out.length) return reply.code(202).send();
    return Array.isArray(body) ? out : out[0];
  });
  app.register(authRoutes, { prefix: "/api/v1" });
  app.register(familyRoutes, { prefix: "/api/v1" });
  app.register(portfolioRoutes, { prefix: "/api/v1" });
  app.register(moduleRoutes, { prefix: "/api/v1" });
  app.register(importRoutes, { prefix: "/api/v1" });
  app.register(marketRoutes, { prefix: "/api/v1" });
  app.register(realEstateRoutes, { prefix: "/api/v1" });
  app.register(depositRoutes, { prefix: "/api/v1" });
  app.register(notificationRoutes, { prefix: "/api/v1" });
  app.register(planningRoutes, { prefix: "/api/v1" });
  app.register(policyRoutes, { prefix: "/api/v1" });
  app.register(rebalanceRoutes, { prefix: "/api/v1" });
  app.register(glRoutes, { prefix: "/api/v1" });
  app.register(researchRoutes, { prefix: "/api/v1" });
  app.register(connectorRoutes, { prefix: "/api/v1" });
  app.register(documentRoutes, { prefix: "/api/v1" });
  app.register(fileRoutes, { prefix: "/api/v1" });
  app.register(reportRoutes, { prefix: "/api/v1" });
  app.register(inviteRoutes, { prefix: "/api/v1" });
  app.register(openDataRoutes, { prefix: "/api/v1" });
  app.register(balanceRoutes, { prefix: "/api/v1" });
  app.register(analyticsRoutes, { prefix: "/api/v1" });
  app.register(bankingRoutes, { prefix: "/api/v1" });
  app.register(aaPublicRoutes, { prefix: "/api/v1" });
  app.register(ingestRoutes, { prefix: "/api/v1" });
  app.register(ingestPublicRoutes, { prefix: "/api/v1" });
  app.register(allocationRoutes, { prefix: "/api/v1" });
  app.register(globalRoutes, { prefix: "/api/v1" });
  app.register(investmentsRoutes, { prefix: "/api/v1" });
  app.register(startupsRoutes, { prefix: "/api/v1" });
  app.register(mfaRoutes, { prefix: "/api/v1" });
  app.register(webauthnRoutes, { prefix: "/api/v1" });
  app.register(accountRoutes, { prefix: "/api/v1" });
  const spec = [process.env.OPENAPI_PATH, new URL("../../../../api/openapi.yaml", import.meta.url).pathname, "/api/openapi.yaml"].find((p) => p && existsSync(p));
  if (spec) app.register(async (a) => { await a.after(); registerStubs(app, spec); });
  return app;
}
const entry = process.argv[1] ?? "";
if (entry.endsWith("server.ts") || entry.endsWith("server.js")) {
  const app = buildApp();
  app.listen({ port: config.port, host: "0.0.0.0" }).then(() => app.log.info(`listening on :${config.port}`));
}
