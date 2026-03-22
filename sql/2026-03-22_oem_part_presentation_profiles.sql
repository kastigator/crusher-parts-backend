CREATE TABLE IF NOT EXISTS oem_part_presentation_profiles (
  id INT NOT NULL AUTO_INCREMENT,
  oem_part_id INT NOT NULL,
  internal_part_number VARCHAR(100) NULL,
  internal_part_name VARCHAR(255) NULL,
  supplier_visible_part_number VARCHAR(100) NULL,
  supplier_visible_description TEXT NULL,
  drawing_code VARCHAR(100) NULL,
  use_by_default_in_supplier_rfq TINYINT(1) NOT NULL DEFAULT 0,
  note TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_oem_part_presentation_profile (oem_part_id),
  KEY idx_oem_part_presentation_profile_supplier_number (supplier_visible_part_number),
  CONSTRAINT fk_oem_part_presentation_profile_oem_part
    FOREIGN KEY (oem_part_id) REFERENCES oem_parts (id)
    ON DELETE CASCADE
);

ALTER TABLE rfq_supplier_line_selections
  ADD COLUMN presentation_profile_id INT NULL AFTER alt_oem_part_id,
  ADD KEY idx_rsls_presentation_profile (presentation_profile_id),
  ADD CONSTRAINT fk_rsls_presentation_profile
    FOREIGN KEY (presentation_profile_id) REFERENCES oem_part_presentation_profiles (id);

ALTER TABLE rfq_supplier_line_selections
  DROP INDEX uq_supplier_line_new,
  ADD UNIQUE KEY uq_supplier_line_new
    (rfq_supplier_id, rfq_item_id, line_type, oem_part_id, alt_oem_part_id, presentation_profile_id, bundle_item_id);

ALTER TABLE rfq_response_lines
  ADD COLUMN presentation_profile_id INT NULL AFTER requested_standard_part_id,
  ADD KEY idx_rrl_presentation_profile (presentation_profile_id),
  ADD CONSTRAINT fk_rrl_presentation_profile
    FOREIGN KEY (presentation_profile_id) REFERENCES oem_part_presentation_profiles (id);
