#!/bin/sh
# Renders two runtime files the SPA/Nginx need before start, so admin-api's URL can be set
# per-deployment without rebuilding the image — needed on Render, where the final service URL
# isn't known until after deploy (see docs/DEPLOY_RENDER.md). Both are written to /tmp (tmpfs,
# writable under our read_only:true container).
#
# If ADMIN_API_URL is unset entirely, config.js is emitted empty so the SPA falls back to its
# build-time VITE_ADMIN_API_URL default (the plain docker-compose / local-dev path), and the CSP
# falls back to that same default origin. If ADMIN_API_URL is set — including set to an empty
# string, meaning "same origin, use relative /api paths" — both honor that explicitly. See
# apps/admin-web/src/api.ts for the corresponding client-side precedence logic.
set -eu

CONFIG_JS=/tmp/config.js
CSP_CONF=/tmp/csp.conf
Q="'"

if [ "${ADMIN_API_URL+is_set}" = "is_set" ]; then
  escaped=$(printf '%s' "$ADMIN_API_URL" | sed 's/\\/\\\\/g; s/"/\\"/g')
  printf 'window.__ADMIN_API_URL__ = "%s";\n' "$escaped" > "$CONFIG_JS"

  if [ -z "$ADMIN_API_URL" ]; then
    connect_src="${Q}self${Q}"
  else
    origin=$(printf '%s' "$ADMIN_API_URL" | sed -E 's#^(https?://[^/]+).*#\1#')
    connect_src="${Q}self${Q} $origin"
  fi
else
  printf '// no runtime ADMIN_API_URL set — SPA falls back to its build-time default\n' > "$CONFIG_JS"
  connect_src="${Q}self${Q} http://localhost:8090"
fi

csp="default-src ${Q}self${Q}; connect-src ${connect_src}; script-src ${Q}self${Q}; style-src ${Q}self${Q} ${Q}unsafe-inline${Q}; frame-ancestors ${Q}none${Q}"
printf 'add_header Content-Security-Policy "%s" always;\n' "$csp" > "$CSP_CONF"

exec /docker-entrypoint.sh nginx -g "daemon off;"
