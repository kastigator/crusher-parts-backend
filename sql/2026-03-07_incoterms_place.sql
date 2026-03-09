ALTER TABLE rfq_response_lines
  ADD COLUMN incoterms_place VARCHAR(255) DEFAULT NULL AFTER incoterms;

ALTER TABLE rfq_shipment_groups
  ADD COLUMN incoterms_place VARCHAR(255) DEFAULT NULL AFTER incoterms;

ALTER TABLE supplier_purchase_orders
  ADD COLUMN incoterms_place VARCHAR(255) DEFAULT NULL AFTER incoterms;

ALTER TABLE client_orders
  ADD COLUMN incoterms_place VARCHAR(255) DEFAULT NULL AFTER incoterms;
