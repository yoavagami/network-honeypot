-- One verdict field: decision (allow / confirm / block). suggested_action (allow / review /
-- challenge) is removed from assessments, the decision history and merchant policies.

-- Policies: each situation now holds a decision. review and challenge become confirm; the old
-- block_when list becomes block on its situations.
UPDATE merchants SET policy =
  coalesce((SELECT jsonb_object_agg(k, CASE WHEN v IN ('"review"'::jsonb, '"challenge"'::jsonb) THEN '"confirm"'::jsonb ELSE v END)
            FROM jsonb_each(policy - 'block_when') AS e(k, v)), '{}'::jsonb)
  || CASE WHEN coalesce(policy->'block_when', '[]'::jsonb) ? 'spoofed_agent' THEN '{"spoofed_agent": "block"}'::jsonb ELSE '{}'::jsonb END
  || CASE WHEN coalesce(policy->'block_when', '[]'::jsonb) ? 'unverified_agent' THEN '{"unverified_agent": "block"}'::jsonb ELSE '{}'::jsonb END
WHERE policy <> '{}'::jsonb;

UPDATE assessments SET response = response - 'suggested_action' WHERE response ? 'suggested_action';

ALTER TABLE decisions DROP COLUMN suggested_action;
