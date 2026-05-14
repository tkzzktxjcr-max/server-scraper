# ─────────────────────────────────────────────
# SCRAPER SERVER - Lightweight Dockerfile (HTTP-only)
# No Chromium/Playwright — scrapers use pure HTTP
# ─────────────────────────────────────────────

FROM node:20-slim AS builder

WORKDIR /app

COPY package.json package-lock.json ./

# Use npm install instead of npm ci for reliability
RUN npm install --legacy-peer-deps

COPY . .
RUN npm run build

# ─── Production ───
FROM node:20-slim AS production

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3001

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3001/health', r => {process.exit(r.statusCode === 200 ? 0 : 1)})"

CMD ["node", "dist/index.js"]