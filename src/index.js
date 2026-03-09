/**
 * index.js
 * Express HTTP server exposing the Notion MCP server over SSE transport.
 *
 * Routes:
 *   GET  /health    – liveness probe (no auth required)
 *   GET  /sse       – SSE stream; MCP client connects here
 *   POST /messages  – MCP message endpoint; used by client after connecting
 *
 * Auth (optional but strongly recommended for public deployments):
 *   Set MCP_AUTH_TOKEN in env. Clients must send:
 *     Authorization: Bearer <MCP_AUTH_TOKEN>
 *   or append ?token=<MCP_AUTH_TOKEN> to the URL.
 */

import express from "express";
import cors from "cors";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createNotionMCPServer } from "./server.js";

const app = express();
app.use(express.json());
app.use(cors());

// ─── Active transports (keyed by sessionId) ──────────────────────────────────
// Each SSE connection gets its own Server + Transport pair.

const transports = new Map();

// ─── Auth middleware ──────────────────────────────────────────────────────────

function authMiddleware(req, res, next) {
  const token = process.env.MCP_AUTH_TOKEN;
  if (!token) return next(); // No auth configured — allow all

  const authHeader = req.headers.authorization;
  const bearerToken = authHeader?.startsWith("Bearer ")
    ? authHeader.slice(7)
    : null;
  const queryToken = req.query.token;

  if (bearerToken === token || queryToken === token) {
    return next();
  }

  console.warn(
    `[Auth] Rejected request from ${req.ip} – missing or invalid token`
  );
  return res.status(401).json({ error: "Unauthorized: invalid or missing token" });
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// Health check — no auth, used by Railway/Render/Docker healthchecks
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "notion-mcp-server",
    timestamp: new Date().toISOString(),
    active_sessions: transports.size,
  });
});

// SSE connection — MCP client (e.g. ElevenLabs) connects here
app.get("/sse", authMiddleware, async (req, res) => {
  console.log(`[SSE] New connection from ${req.ip}`);

  const transport = new SSEServerTransport("/messages", res);
  const server = createNotionMCPServer();

  transports.set(transport.sessionId, transport);
  console.log(
    `[SSE] Session ${transport.sessionId} opened (total: ${transports.size})`
  );

  res.on("close", () => {
    transports.delete(transport.sessionId);
    console.log(
      `[SSE] Session ${transport.sessionId} closed (total: ${transports.size})`
    );
  });

  await server.connect(transport);
});

// POST messages — MCP client sends tool calls here
app.post("/messages", authMiddleware, async (req, res) => {
  const sessionId = req.query.sessionId;

  if (!sessionId) {
    return res.status(400).json({ error: "sessionId query parameter is required" });
  }

  const transport = transports.get(sessionId);

  if (!transport) {
    console.warn(`[POST] No transport for session: ${sessionId}`);
    return res.status(404).json({ error: "Session not found or expired" });
  }

  await transport.handlePostMessage(req, res);
});

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || "3000", 10);

app.listen(PORT, "0.0.0.0", () => {
  const hasAuth = !!process.env.MCP_AUTH_TOKEN;
  console.log(`┌─────────────────────────────────────────────┐`);
  console.log(`│  Notion MCP Server                          │`);
  console.log(`│  Listening on http://0.0.0.0:${PORT}          │`);
  console.log(`│  Auth: ${hasAuth ? "ENABLED ✓" : "DISABLED ✗ (set MCP_AUTH_TOKEN)"}               │`);
  console.log(`│  Endpoints:                                 │`);
  console.log(`│    GET  /health                             │`);
  console.log(`│    GET  /sse     ← MCP client connects here│`);
  console.log(`│    POST /messages                           │`);
  console.log(`└─────────────────────────────────────────────┘`);
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("[Shutdown] SIGTERM received, closing connections...");
  for (const [id, transport] of transports) {
    transport.close().catch(() => {});
    transports.delete(id);
  }
  process.exit(0);
});
