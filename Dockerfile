# ── Stage 1: dependencies ──────────────────────────────
FROM node:20-slim AS deps

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

# ── Stage 2: runtime ───────────────────────────────────
FROM node:20-slim

# Install FFmpeg (static build — smaller than apt version on slim images)
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy dependencies from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy application code
COPY server.js ./
COPY package.json ./

# Temp directories for uploads/outputs (Railway uses ephemeral /tmp)
RUN mkdir -p /tmp/cs-uploads /tmp/cs-outputs

# Railway sets $PORT at runtime (defaults to 3001 in server.js)
EXPOSE 3001

# Health check so Railway knows when the container is ready
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:' + (process.env.PORT||3001) + '/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "server.js"]
