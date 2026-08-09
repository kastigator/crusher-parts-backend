ALTER TABLE commercial_offer_revisions
  ADD COLUMN payment_policy_snapshot_json JSON NULL AFTER payment_terms;
