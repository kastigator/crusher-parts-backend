ALTER TABLE warehouse_documents
  MODIFY doc_type ENUM('receipt','transfer','writeoff','reserve','unreserve','inventory','assembly','packing','shipment','minmax') NOT NULL;

ALTER TABLE warehouse_documents
  ADD COLUMN source_type VARCHAR(64) NULL AFTER client_reference,
  ADD COLUMN source_id VARCHAR(64) NULL AFTER source_type,
  ADD COLUMN source_line_id VARCHAR(64) NULL AFTER source_id,
  ADD COLUMN source_label VARCHAR(255) NULL AFTER source_line_id,
  ADD KEY idx_warehouse_documents_source (source_type, source_id, source_line_id);
