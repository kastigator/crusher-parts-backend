-- Add boolean preferred flag for supplier_part_originals links.
-- Date: 2026-03-01

ALTER TABLE supplier_part_originals
  ADD COLUMN is_preferred tinyint(1) NOT NULL DEFAULT 0 AFTER priority_rank;

-- Backfill from legacy numeric priority:
-- any previously ranked link becomes preferred.
UPDATE supplier_part_originals
   SET is_preferred = 1
 WHERE priority_rank IS NOT NULL
   AND priority_rank > 0;

-- Optional performance index for RFQ hint/suggestion lookups.
CREATE INDEX idx_spo_original_preferred
  ON supplier_part_originals (original_part_id, is_preferred, supplier_part_id);

