# Attack Surface Matrix

| Surface | Example | Expected attacker behavior | Telemetry generated |
|---|---|---|---|
| Homepage | `GET /` | Initial discovery | `HTTP_REQUEST` |
| Robots | `GET /robots.txt` | Enumeration seed, crawler baseline | `ROBOTS_ACCESS` |
| Sitemap | `GET /sitemap.xml` | Systematic content discovery | `SITEMAP_ACCESS` |
| Health | `GET /health`, `/healthz` | Infra fingerprinting | `HEALTH_ENDPOINT_ACCESS` |
| API docs | `GET /api/docs`, `/openapi.json` | API discovery | `API_DOCUMENTATION_ACCESS` |
| API root | `GET /api/v1` | Endpoint enumeration | `API_REQUEST` |
| Users list | `GET /api/v1/users` | Object discovery | `API_REQUEST`, possibly `OBJECT_ENUMERATION` |
| User by ID | `GET /api/v1/users/:id` | Sequential ID enumeration / IDOR probing | `ID_ENUMERATION` |
| Search | `GET /search?q=` | Injection probing, parameter fuzzing | `SUSPICIOUS_QUERY` |
| Login | `POST /login` | Credential stuffing, username enumeration | `LOGIN_ATTEMPT`/`LOGIN_FAILURE` |
| Register | `POST /register` | Automation/spam testing, account farming | `REGISTRATION_ATTEMPT` |
| Password reset | `POST /reset-password` | Enumeration via response-timing/messaging | `PASSWORD_RESET_ATTEMPT` |
| Profile | `GET /profile`, `/users/:id/profile` | Post-auth exploration, IDOR | `HTTP_REQUEST` / `ID_ENUMERATION` |
| File/object access | `GET /files/:id`, `/documents/:id` | Object enumeration, path traversal attempts | `FILE_ACCESS_ATTEMPT` |
| Admin area | `GET /admin`, `/admin/dashboard` | Privilege probing | `ADMIN_PAGE_ACCESS` (high risk) |
| Admin login | `POST /admin/login` | Credential attacks against privileged surface | `ADMIN_LOGIN_ATTEMPT` (high risk) |
| Config-looking endpoint | `GET /config`, `/.well-known/security.txt` | Reconnaissance | `TECHNOLOGY_ENUMERATION` |
| Dotfiles/backup | `GET /.env`, `/.git/config`, `/backup.zip` | Opportunistic scanning | `HONEYPOT_TRIGGER` (high risk) |
| Upload | `POST /profile/avatar` | Malicious file upload testing | `UPLOAD_ATTEMPT` / `SUSPICIOUS_UPLOAD` |
| Synthetic API key in config response | `GET /api/v1/config` → embeds a canary key | Key reuse/exploitation attempt elsewhere in the app | `CANARY_TRIGGERED` (critical) |
| Synthetic internal URL in a doc/comment | Fake internal hostname in a "changelog" or HTML comment | Follow-the-breadcrumb exploration | `CANARY_TRIGGERED` (critical) |
| Pagination params | `GET /api/v1/users?page=&limit=` | Parameter fuzzing, large-limit DoS probing | `PARAMETER_ENUMERATION` |
| Unsupported HTTP methods | `PUT/DELETE/TRACE` on any route | Method fuzzing | `INVALID_METHOD` |
| Malformed JSON body | `POST /api/v1/*` with broken JSON | Parser/robustness probing | `API_ERROR` |
| Unknown routes | `GET /wp-login.php`, `/phpmyadmin` | Blind mass-scanner signatures | `INVALID_ROUTE`, contributes to `reconnaissance` detection |
| Version/tech headers | Any response | Passive tech fingerprinting | Recorded as observed response shape, no extra event |
| Static assets | `GET /assets/*.js` | Client bundle inspection for endpoint/secret leakage | `HTTP_REQUEST`; bundle is checked to contain no real secrets |
