# Builds the admin dashboard SPA and serves it as static files via Nginx. This Nginx instance
# is entirely separate from the public-facing one in infrastructure/nginx — different config,
# different network (admin only). See docs/ARCHITECTURE.md §3.
FROM node:22-bookworm-slim AS build
RUN corepack enable
WORKDIR /app
COPY . .
ARG VITE_ADMIN_API_URL=http://localhost:8090
ENV VITE_ADMIN_API_URL=${VITE_ADMIN_API_URL}
RUN pnpm install --frozen-lockfile && pnpm --filter @honeypot/app-admin-web run build

FROM nginx:1.27-alpine AS runtime
COPY --from=build /app/apps/admin-web/dist /usr/share/nginx/html
COPY infrastructure/docker/admin-web.nginx.conf /etc/nginx/conf.d/default.conf
COPY infrastructure/docker/admin-web-entrypoint.sh /admin-web-entrypoint.sh
RUN chmod +x /admin-web-entrypoint.sh
EXPOSE 80
ENTRYPOINT ["/admin-web-entrypoint.sh"]
