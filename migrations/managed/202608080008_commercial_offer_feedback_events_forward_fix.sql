-- Wave 5 forward fix: one sent snapshot can receive multiple independently
-- evidenced client feedback events (for example, partial replies over time).
ALTER TABLE commercial_client_feedback
  DROP INDEX uq_commercial_feedback_snapshot,
  ADD KEY idx_commercial_feedback_snapshot (sent_offer_snapshot_id, received_at);
