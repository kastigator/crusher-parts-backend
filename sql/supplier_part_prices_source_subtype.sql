-- RFQ_RESPONSE source subtype for supplier_part_prices
ALTER TABLE supplier_part_prices
  ADD COLUMN IF NOT EXISTS source_subtype VARCHAR(32) NULL AFTER source_type;

-- Backfill subtype for already saved RFQ responses where we can infer it from response line entry_source.
UPDATE supplier_part_prices spp
JOIN rfq_response_lines rfl ON rfl.id = spp.source_id
SET spp.source_subtype = UPPER(rfl.entry_source)
WHERE spp.source_type = 'RFQ_RESPONSE'
  AND spp.source_subtype IS NULL;
