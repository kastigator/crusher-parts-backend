ALTER TABLE supplier_purchase_order_lines
  ADD COLUMN selection_line_id INT NULL AFTER rfq_response_line_id,
  ADD COLUMN coverage_option_id BIGINT NULL AFTER selection_line_id,
  ADD COLUMN shipment_group_id BIGINT NULL AFTER coverage_option_id,
  ADD KEY idx_spol_selection_line (selection_line_id),
  ADD KEY idx_spol_coverage_option (coverage_option_id),
  ADD KEY idx_spol_shipment_group (shipment_group_id);

UPDATE supplier_purchase_order_lines pol
JOIN (
  SELECT
    pol2.id AS po_line_id,
    MIN(sl.id) AS selection_line_id,
    MIN(sl.coverage_option_id) AS coverage_option_id,
    MIN(sl.shipment_group_id) AS shipment_group_id
  FROM supplier_purchase_order_lines pol2
  JOIN supplier_purchase_orders po ON po.id = pol2.supplier_purchase_order_id
  JOIN selection_lines sl
    ON sl.selection_id = po.selection_id
   AND sl.rfq_response_line_id = pol2.rfq_response_line_id
   AND (sl.supplier_id = po.supplier_id OR sl.supplier_id IS NULL)
   AND (po.shipment_group_id IS NULL OR sl.shipment_group_id = po.shipment_group_id)
  WHERE pol2.selection_line_id IS NULL
  GROUP BY pol2.id
  HAVING COUNT(sl.id) = 1
) resolved ON resolved.po_line_id = pol.id
SET
  pol.selection_line_id = resolved.selection_line_id,
  pol.coverage_option_id = resolved.coverage_option_id,
  pol.shipment_group_id = resolved.shipment_group_id;
