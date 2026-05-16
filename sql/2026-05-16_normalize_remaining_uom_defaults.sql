UPDATE rfq_supplier_line_selections SET uom = CASE LOWER(uom)
  WHEN 'pcs' THEN 'шт'
  WHEN 'pc' THEN 'шт'
  WHEN 'ea' THEN 'шт'
  WHEN 'each' THEN 'шт'
  WHEN 'piece' THEN 'шт'
  WHEN 'pieces' THEN 'шт'
  WHEN 'set' THEN 'компл'
  WHEN 'kit' THEN 'компл'
  WHEN 'kg' THEN 'кг'
  WHEN 'g' THEN 'г'
  WHEN 't' THEN 'т'
  WHEN 'm' THEN 'м'
  WHEN 'cm' THEN 'см'
  WHEN 'mm' THEN 'мм'
  WHEN 'm2' THEN 'м²'
  WHEN 'm3' THEN 'м³'
  ELSE uom END WHERE uom IS NOT NULL;

ALTER TABLE oem_parts
  MODIFY uom VARCHAR(16) NOT NULL DEFAULT 'шт';

ALTER TABLE standard_parts
  MODIFY uom VARCHAR(16) NOT NULL DEFAULT 'шт';

ALTER TABLE supplier_parts
  MODIFY uom VARCHAR(16) NOT NULL DEFAULT 'шт';

ALTER TABLE rfq_items
  MODIFY uom VARCHAR(16) NULL DEFAULT 'шт';

ALTER TABLE client_request_revision_items
  MODIFY uom VARCHAR(16) NULL DEFAULT 'шт';
