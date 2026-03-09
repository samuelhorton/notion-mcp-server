/**
 * index.js
 * Express HTTP server exposing the Notion MCP server over two transports:
 *
 *   1. Streamable HTTP  (MCP spec 2025-03-26) — used by ElevenLabs and newer clients
 *        POST   /mcp   – send a request / open SSE stream
 *        GET    /mcp   – re-attach to existing SSE stream
 *        DELETE /mcp   – close session
 *
 *   2. Legacy SSE  (older clients / Claude Desktop)
 *        GET  /sse       – SSE stream
 *        POST /messages  – message endpoint
 *
 *   GET  /health  – liveness probe (no auth)
 *
 * Auth: set MCP_AUTH_TOKEN in env.
 *   Clients send:  Authorization: Bearer <token>
 *   OR append:     ?token=<token>  to the URL
 */

import express from "express";
import cors from "cors";
import { randomUUID } from "crypto";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createNotionMCPServer } from "./server.js";

const app = express();
app.use(express.json());
app.use(cors());

// ─── Transport maps ───────────────────────────────────────────────────────────

const sseTransports        = new Map(); // legacy SSE sessions
const httpTransports       = new Map(); // streamable HTTP sessions

// ─── Auth middleware ──────────────────────────────────────────────────────────

function authMiddleware(req, res, next) {
  const token = process.env.MCP_AUTH_TOKEN;
  if (!token) return next();

  const authHeader = req.headers.authorization;
  const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const queryToken  = req.query.token;

  if (bearerToken === token || queryToken === token) return next();

  console.warn(`[Auth] Rejected ${req.method} ${req.path} from ${req.ip}`);
  return res.status(401).json({ error: "Unauthorized: invalid or missing token" });
}

// ─── Health ───────────────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "notion-mcp-server",
    timestamp: new Date().toISOString(),
    active_sessions: sseTransports.size + httpTransports.size,
  });
});

// ─── Streamable HTTP transport (ElevenLabs + modern clients) ─────────────────

// POST /mcp — new session OR existing session message
app.post("/mcp", authMiddleware, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];

  // Re-use existing transport if sessionId matches
  if (sessionId && httpTransports.has(sessionId)) {
    const transport = httpTransports.get(sessionId);
    await transport.handleRequest(req, res, req.body);
    return;
  }

  // New session
  console.log(`[HTTP] New session from ${req.ip}`);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id) => {
      httpTransports.set(id, transport);
      console.log(`[HTTP] Session ${id} opened (total: ${httpTransports.size})`);
    },
  });

  transport.onclose = () => {
    if (transport.sessionId) {
      httpTransports.delete(transport.sessionId);
      console.log(`[HTTP] Session ${transport.sessionId} closed (total: ${httpTransports.size})`);
    }
  };

  const server = createNotionMCPServer();
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

// GET /mcp — client re-attaches to SSE stream for an existing session
app.get("/mcp", authMiddleware, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  const transport = sessionId ? httpTransports.get(sessionId) : null;

  if (!transport) {
    return res.status(404).json({ error: "Session not found" });
  }

  await transport.handleRequest(req, res);
});

// DELETE /mcp — client terminates session
app.delete("/mcp", authMiddleware, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  const transport = sessionId ? httpTransports.get(sessionId) : null;

  if (transport) {
    await transport.close();
    res.status(200).end();
  } else {
    res.status(404).json({ error: "Session not found" });
  }
});

// ─── Legacy SSE transport (Claude Desktop + older clients) ───────────────────

app.get("/sse", authMiddleware, async (req, res) => {
  console.log(`[SSE] New connection from ${req.ip}`);
  const transport = new SSEServerTransport("/messages", res);
  const server    = createNotionMCPServer();

  sseTransports.set(transport.sessionId, transport);
  console.log(`[SSE] Session ${transport.sessionId} opened (total: ${sseTransports.size})`);

  res.on("close", () => {
    sseTransports.delete(transport.sessionId);
    console.log(`[SSE] Session ${transport.sessionId} closed`);
  });

  await server.connect(transport);
});

app.post("/messages", authMiddleware, async (req, res) => {
  const sessionId  = req.query.sessionId;
  const transport  = sseTransports.get(sessionId);

  if (!transport) {
    console.warn(`[SSE-POST] No transport for session: ${sessionId}`);
    return res.status(404).json({ error: "Session not found or expired" });
  }

  await transport.handlePostMessage(req, res);
});

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || "3000", 10);

app.listen(PORT, "0.0.0.0", () => {
  const hasAuth = !!process.env.MCP_AUTH_TOKEN;
  console.log(`┌──────────────────────────────────────────────────┐`);
  console.log(`│  Notion MCP Server  v2                           │`);
  console.log(`│  Port: ${PORT}    Auth: ${hasAuth ? "ENABLED ✓ " : "DISABLED ✗"}                  │`);
  console.log(`│                                                  │`);
  console.log(`│  Streamable HTTP (ElevenLabs):                   │`);
  console.log(`│    POST/GET/DELETE /mcp                          │`);
  console.log(`│  Legacy SSE (Claude Desktop):                    │`);
  console.log(`│    GET /sse   POST /messages                     │`);
  console.log(`│  Health: GET /health                             │`);
  console.log(`└──────────────────────────────────────────────────┘`);
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("[Shutdown] SIGTERM received...");
  [...sseTransports.values(), ...httpTransports.values()]
    .forEach(t => t.close().catch(() => {}));
  process.exit(0);
});
