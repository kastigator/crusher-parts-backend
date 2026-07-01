-- Purge trash entries that point to removed legacy OEM/original catalog tables.
-- These entities are no longer restorable because the underlying legacy tables were dropped.

DELETE tei
  FROM trash_entry_items tei
  JOIN trash_entries te ON te.id = tei.trash_entry_id
 WHERE te.entity_type LIKE 'oem_part%'
    OR te.entity_type IN ('oem_parts', 'original_part_groups')
    OR te.entity_type LIKE 'supplier_bundle%'
    OR tei.item_type LIKE 'oem_part%'
    OR tei.item_type LIKE 'supplier_bundle%';

DELETE FROM trash_entries
 WHERE entity_type LIKE 'oem_part%'
    OR entity_type IN ('oem_parts', 'original_part_groups')
    OR entity_type LIKE 'supplier_bundle%';

