CREATE TABLE IF NOT EXISTS catalog_position_relations (
  id INT AUTO_INCREMENT PRIMARY KEY,
  primary_catalog_position_id INT NOT NULL,
  related_catalog_position_id INT NOT NULL,
  relationship_type ENUM('analog', 'replacement', 'kit_component', 'related') NOT NULL DEFAULT 'analog',
  note TEXT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_catalog_position_relation_pair (
    primary_catalog_position_id,
    related_catalog_position_id,
    relationship_type
  ),
  KEY idx_catalog_position_relations_related (related_catalog_position_id, relationship_type),
  CONSTRAINT fk_catalog_position_relations_primary
    FOREIGN KEY (primary_catalog_position_id) REFERENCES catalog_positions (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_catalog_position_relations_related
    FOREIGN KEY (related_catalog_position_id) REFERENCES catalog_positions (id)
    ON DELETE CASCADE ON UPDATE CASCADE
);
