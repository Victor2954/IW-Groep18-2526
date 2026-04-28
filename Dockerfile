# ── Stage 1: dependencies ──────────────────────────────────────────────
FROM node:20-alpine AS deps

WORKDIR /app

# Kopieer alleen package-bestanden -> betere layer caching
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ── Stage 2: runtime ───────────────────────────────────────────────────
FROM node:20-alpine

WORKDIR /app

# Kopieer node_modules van deps-stage
COPY --from=deps /app/node_modules ./node_modules

# Kopieer de rest van de broncode
COPY src/       ./src/
COPY public/    ./public/
COPY scripts/   ./scripts/
COPY sql/       ./sql/
COPY package.json ./

# Poort waarop Express luistert
EXPOSE 3000

# Gezondheidscheck -> Docker weet of de container echt werkt
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

# Productie-modus
ENV NODE_ENV=production

CMD ["node", "src/server.js"]
