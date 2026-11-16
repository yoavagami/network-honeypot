-- Signed lab links on merchant sites (same tokens as the honeypot's ?lab= links, LAB_LINK_SECRET):
-- the tag picks up ?lab= on landing and sends it with every beacon; merchant-api verifies it.
-- Visits carry the label so lab runs on merchant sites join the admin lab scorecard.
ALTER TABLE merchant_events ADD COLUMN lab_label text, ADD COLUMN lab_verified boolean NOT NULL DEFAULT false;
ALTER TABLE merchant_visits ADD COLUMN lab_label text, ADD COLUMN lab_verified boolean NOT NULL DEFAULT false;
CREATE INDEX idx_merchant_visits_lab ON merchant_visits (lab_label) WHERE lab_label IS NOT NULL;
