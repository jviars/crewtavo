# Crewtavo: web app, API and background tasks in one container. In a Crewtavo instance (Railway
# template or docker-compose.yml) it's also the gateway to the instance's Supabase services and
# applies database migrations as it starts. See deploy/README.md.
#   docker compose up        the whole instance, locally
#   docker build -t crewtavo .

FROM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY apps/api/package.json apps/api/
COPY packages/core/package.json packages/core/
RUN npm ci --no-audit --no-fund
COPY . .
# The web build (the Word editor's bundle and its source map especially) needs more than Node's
# default heap in a container.
RUN NODE_OPTIONS=--max-old-space-size=4096 npm run build:server

FROM node:22-alpine
WORKDIR /app
# The release this image is (set by .github/workflows/release.yml); /api/health reports it.
ARG CREWTAVO_VERSION=dev
ENV NODE_ENV=production PORT=8080 CREWTAVO_VERSION=$CREWTAVO_VERSION
COPY --from=build --chown=node:node /src/dist/server ./
COPY --from=build --chown=node:node /src/LICENSE /src/NOTICE /src/TERMS ./
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" >/dev/null || exit 1
# Applies pending migrations itself (when SUPABASE_DB_URL is set), then starts background tasks.
CMD ["node", "server.mjs"]
