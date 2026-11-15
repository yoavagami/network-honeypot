# Merchant platform API (apps/merchant-api). Separate image, container and database roles from the
# honeypot: it serves merchants' data, and never touches the honeypot database.
FROM node:22-bookworm-slim AS deps
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile

FROM node:22-bookworm-slim AS runtime
RUN corepack enable && groupadd -g 10003 merchantapi && useradd -u 10003 -g merchantapi -M -s /usr/sbin/nologin merchantapi
WORKDIR /app
COPY --from=deps /app /app
USER merchantapi
ENV NODE_ENV=production
EXPOSE 8095
CMD ["node_modules/.bin/tsx", "apps/merchant-api/src/index.ts"]
