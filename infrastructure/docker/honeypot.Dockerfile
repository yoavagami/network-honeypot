# Multi-stage build for the public honeypot app. Runs as a dedicated non-root user with a
# read-only root filesystem at the compose layer — see docs/SECURITY.md §3.
#
# Builds against the full pnpm workspace (simplest correct option for a workspace:* monorepo —
# see docs/ARCHITECTURE.md; splitting into a minimal per-service context is a Phase 3+ image-size
# optimization, not a Phase 1 requirement).
FROM node:22-bookworm-slim AS deps
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile

FROM node:22-bookworm-slim AS runtime
RUN corepack enable && groupadd -g 10001 honeypot && useradd -u 10001 -g honeypot -M -s /usr/sbin/nologin honeypot
WORKDIR /app
COPY --from=deps /app /app
USER honeypot
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node_modules/.bin/tsx", "apps/honeypot/src/index.ts"]
