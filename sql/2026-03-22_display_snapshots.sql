ALTER TABLE selection_lines
  ADD COLUMN client_display_part_number_snapshot VARCHAR(255) NULL AFTER route_name_snapshot,
  ADD COLUMN client_display_description_snapshot TEXT NULL AFTER client_display_part_number_snapshot,
  ADD COLUMN supplier_display_part_number_snapshot VARCHAR(255) NULL AFTER client_display_description_snapshot,
  ADD COLUMN supplier_display_description_snapshot TEXT NULL AFTER supplier_display_part_number_snapshot;

ALTER TABLE sales_quote_lines
  ADD COLUMN client_display_part_number_snapshot VARCHAR(255) NULL AFTER note,
  ADD COLUMN client_display_description_snapshot TEXT NULL AFTER client_display_part_number_snapshot;

ALTER TABLE supplier_purchase_order_lines
  ADD COLUMN supplier_display_part_number_snapshot VARCHAR(255) NULL AFTER note,
  ADD COLUMN supplier_display_description_snapshot TEXT NULL AFTER supplier_display_part_number_snapshot;
