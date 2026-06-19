CREATE TABLE IF NOT EXISTS client_part_documents (
  id INT NOT NULL AUTO_INCREMENT,
  client_part_id INT NOT NULL,
  file_url VARCHAR(1000) NOT NULL,
  file_name VARCHAR(255) NULL,
  file_type VARCHAR(120) NULL,
  file_size BIGINT NULL,
  description VARCHAR(500) NULL,
  uploaded_by INT NULL,
  uploaded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_client_part_documents_part (client_part_id, uploaded_at, id),
  CONSTRAINT fk_client_part_documents_part
    FOREIGN KEY (client_part_id) REFERENCES client_parts (id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
