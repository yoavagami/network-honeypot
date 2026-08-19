# Multi-stage build for the admin API. Kept as a fully separate image/container/DB-role from
# the honeypot app — see docs/ARCHITECTURE.md §3.
FROM node:22-bookworm-slim AS deps
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile

FROM node:22-bookworm-slim AS runtime
RUN corepack enable && groupadd -g 10002 adminapi && useradd -u 10002 -g adminapi -M -s /usr/sbin/nologin adminapi
WORKDIR /app
COPY --from=deps /app /app
USER adminapi
ENV NODE_ENV=production
EXPOSE 8090
CMD ["node_modules/.bin/tsx", "apps/admin-api/src/index.ts"]
