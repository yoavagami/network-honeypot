-- Agent sensing report — run with infrastructure/aws/agent-report.sh (or psql -f).
-- Sections: 1) labeled runs  2) per-run browser + behavior summary  3) unlabeled AI/bot claims
-- 4) fingerprint clusters (same client under different names)  5) agent DOM artifacts.
\pset pager off
\x auto

\echo '=== 1. Labeled runs: who / when / how it connected ==='
SELECT s.lab_label,
       min(s.created_at)::timestamp(0)                                   AS first_seen,
       max(s.created_at)::timestamp(0)                                   AS last_seen,
       count(*)                                                          AS requests,
       count(DISTINCT r.path)                                            AS paths,
       string_agg(DISTINCT host(r.ip_raw), ' ')                          AS ips,
       string_agg(DISTINCT a.organization, ' / ')                        AS network,
       string_agg(DISTINCT s.identity_verdict || coalesce(':' || s.identity_agent, ''), ' ') AS verdicts,
       string_agg(DISTINCT s.ja4, ' ')                                   AS ja4,
       string_agg(DISTINCT s.h2_fp, ' ')                                 AS h2,
       string_agg(DISTINCT s.wba_status || coalesce(':' || s.wba_signer, ''), ' ') AS web_bot_auth,
       string_agg(DISTINCT left(r.user_agent_raw, 120), ' || ')          AS user_agents
FROM request_signals s
JOIN requests r USING (request_id)
LEFT JOIN actors a ON a.actor_id = s.actor_id
WHERE s.lab_label IS NOT NULL
GROUP BY s.lab_label
ORDER BY first_seen;

\echo '=== 2. Labeled runs: what the page saw (fingerprint + behavior) ==='
WITH fp AS (
  SELECT DISTINCT ON (lab_label) lab_label, data
  FROM client_signals WHERE kind = 'fp' AND lab_label IS NOT NULL
  ORDER BY lab_label, created_at
), beh AS (
  SELECT lab_label,
         count(*) FILTER (WHERE kind = 'fp')                                      AS page_loads,
         sum((data #>> '{behavior,mouseMoves}')::int)                             AS mouse_moves,
         round(sum((data #>> '{behavior,mouseDistance}')::numeric))               AS mouse_px,
         sum((data #>> '{behavior,clickCount}')::int)                             AS clicks,
         sum((data #>> '{behavior,keyDowns}')::int)                               AS key_downs,
         sum((data #>> '{behavior,inputWithoutKey}')::int)                        AS input_without_key,
         sum((data #>> '{behavior,scrolls}')::int)                                AS scrolls,
         sum((data #>> '{behavior,wheels}')::int)                                 AS wheels,
         bool_or((data ->> 'visibility') = 'hidden' AND (data ->> 'focus') = 'false') AS driven_while_hidden,
         jsonb_agg(data #> '{behavior,clicks}') FILTER (WHERE jsonb_array_length(coalesce(data #> '{behavior,clicks}', '[]')) > 0) AS click_samples
  FROM client_signals WHERE lab_label IS NOT NULL GROUP BY lab_label
)
SELECT f.lab_label,
       f.data #>> '{nav,webdriver}'                 AS webdriver,
       f.data #>> '{automation,cdpRuntime}'         AS cdp,
       f.data #>> '{automation,globals}'            AS automation_globals,
       f.data ->> 'globalsDiff'                     AS injected_globals,
       f.data #>> '{webgl,renderer}'                AS gpu,
       f.data #>> '{screen,outerW}'                 AS outer_w,
       f.data #>> '{doc,hasFocus}'                  AS focused,
       f.data #>> '{doc,visibility}'                AS visibility,
       f.data #>> '{intl,tz}'                       AS timezone,
       f.data #>> '{nav,languages}'                 AS languages,
       f.data #>> '{uaData,fullVersionList}'        AS brands,
       f.data #>> '{timing,protocol}'               AS protocol,
       b.*
FROM fp f LEFT JOIN beh b USING (lab_label)
ORDER BY f.lab_label;

\echo '=== 3. Unlabeled traffic claiming to be an AI agent / bot (last 30 days) ==='
SELECT s.ua_claim,
       s.identity_verdict,
       count(*)                                    AS requests,
       count(DISTINCT s.actor_id)                  AS actors,
       string_agg(DISTINCT a.organization, ' / ')  AS networks,
       max(s.created_at)::date                     AS last_seen,
       min(s.data #>> '{identity,reasons,0}')      AS example_reason
FROM request_signals s LEFT JOIN actors a ON a.actor_id = s.actor_id
WHERE s.ua_claim IS NOT NULL AND s.lab_label IS NULL AND s.created_at > now() - interval '30 days'
GROUP BY 1, 2 ORDER BY 1, 2;

\echo '=== 3b. Verdict mix (last 7 days, unlabeled) ==='
SELECT identity_verdict, coalesce(identity_agent, '-') AS agent, count(*) AS requests, count(DISTINCT actor_id) AS actors
FROM request_signals WHERE lab_label IS NULL AND created_at > now() - interval '7 days'
GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 40;

\echo '=== 4. Fingerprint clusters: one TLS+HTTP2 client, many user-agents (last 30 days) ==='
SELECT s.ja4, coalesce(s.h2_fp, '(http/1.1)') AS h2,
       count(DISTINCT r.user_agent_raw) AS user_agents,
       count(DISTINCT s.actor_id)       AS actors,
       count(*)                         AS requests,
       string_agg(DISTINCT coalesce(s.ua_claim, s.ua_library, s.data #>> '{ua,browser,family}', '?'), ', ') AS claims_seen
FROM request_signals s JOIN requests r USING (request_id)
WHERE s.ja4 IS NOT NULL AND s.created_at > now() - interval '30 days'
GROUP BY 1, 2 HAVING count(DISTINCT r.user_agent_raw) > 1
ORDER BY user_agents DESC, requests DESC LIMIT 25;

\echo '=== 5. Agent / extension DOM artifacts seen in pages ==='
SELECT c.created_at::timestamp(0), coalesce(c.lab_label, '-') AS lab, c.path, art ->> 'known' AS known_agent,
       art ->> 'id' AS id, art ->> 'tag' AS tag, art ->> 'cls' AS class
FROM client_signals c, jsonb_array_elements(coalesce(c.data -> 'artifacts', '[]')) art
ORDER BY c.created_at DESC LIMIT 40;
