-- Lat/lng for the Geography page's heat map (docs/ROADMAP.md Phase 2 follow-up). ipinfo.io
-- already returns these in its "loc" field ("37.4056,-122.0775") on every lookup this project
-- already makes — no extra API calls or cost, just parsing what was previously discarded. See
-- packages/detection/src/providers/ipinfo.ts.
ALTER TABLE actors
  ADD COLUMN lat double precision,
  ADD COLUMN lng double precision;
