-- Who opens the merchant platform's public pages: the request-access page, the developer guide,
-- the agent file and llms.txt (apps/merchant-api/src/pageHits.ts). Not merchant data, so no
-- merchant_id and no access for merchant_app: only merchant_admin writes and reads it (admin
-- dashboard → Merchants → "Who opened the merchant pages").
-- Raw IPs are cleared after 30 days by the retention job; rows are kept for 365 days.
CREATE TABLE public_page_hits (
  hit_id      bigserial PRIMARY KEY,
  created_at  timestamptz NOT NULL DEFAULT now(),
  path        text NOT NULL,
  status      integer NOT NULL,
  ip          inet,
  country     text,
  network     text,
  user_agent  text,
  referrer    text,
  -- What the user-agent says it is: an AI agent/crawler id, an HTTP library, or NULL for a browser.
  agent       text
);
CREATE INDEX idx_public_page_hits_created ON public_page_hits (created_at DESC);
GRANT SELECT, INSERT, UPDATE, DELETE ON public_page_hits TO merchant_admin;
GRANT USAGE ON SEQUENCE public_page_hits_hit_id_seq TO merchant_admin;
