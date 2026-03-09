# ─────────────────────────────────────────────────────────────
# Notion MCP Server – Dockerfile
# Multi-stage build: install deps then copy app
# ─────────────────────────────────────────────────────────────

# Stage 1: Install production dependencies
FROM node:20-alpine AS deps
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Stage 2: Runtime image
FROM node:20-alpine AS runner
WORKDIR /app

# Non-root user for security
RUN addgroup -S mcp && adduser -S mcp -G mcp

# Copy app files
COPY --from=deps /app/node_modules ./node_modules
COPY src ./src
COPY package.json ./

# Own files
RUN chown -R mcp:mcp /app
USER mcp

# Railway/Render inject PORT automatically
ENV PORT=3000
EXPOSE 3000

# Healthcheck — used by Docker, Railway, Render
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:${PORT}/health || exit 1

CMD ["node", "src/index.js"]
