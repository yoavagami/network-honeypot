-- GeoIP/ASN enrichment fields — see docs/ROADMAP.md Phase 2, packages/detection/src/enrichment.ts.
-- Stored on the actor (not per-request): an actor's IP rarely changes mid-session, and
-- enrichment is deliberately cached/looked-up once per actor to respect provider rate limits —
-- see apps/honeypot/src/ingestion/enrichment.ts.
ALTER TABLE actors
  ADD COLUMN country text,
  ADD COLUMN region text,
  ADD COLUMN city text,
  ADD COLUMN asn text,
  ADD COLUMN organization text,
  ADD COLUMN enrichment_updated_at timestamptz;

CREATE INDEX idx_actors_country ON actors (country);
CREATE INDEX idx_actors_asn ON actors (asn);
