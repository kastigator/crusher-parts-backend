CREATE TABLE IF NOT EXISTS trash_entries (
  id BIGINT NOT NULL AUTO_INCREMENT,
  entity_type VARCHAR(100) NOT NULL,
  entity_id BIGINT NOT NULL,
  root_entity_type VARCHAR(100) NOT NULL,
  root_entity_id BIGINT NOT NULL,
  delete_mode ENUM('trash', 'relation_delete', 'aggregate_delete') NOT NULL DEFAULT 'trash',
  title VARCHAR(255) NOT NULL,
  subtitle VARCHAR(255) DEFAULT NULL,
  snapshot_json JSON DEFAULT NULL,
  context_json JSON DEFAULT NULL,
  deleted_by_user_id INT DEFAULT NULL,
  deleted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  purge_after_at DATETIME DEFAULT NULL,
  restore_status ENUM('pending', 'restored', 'restore_failed', 'purged') NOT NULL DEFAULT 'pending',
  restored_at DATETIME DEFAULT NULL,
  restored_by_user_id INT DEFAULT NULL,
  purged_at DATETIME DEFAULT NULL,
  purged_by_user_id INT DEFAULT NULL,
  PRIMARY KEY (id),
  KEY idx_trash_entity (entity_type, entity_id),
  KEY idx_trash_root_entity (root_entity_type, root_entity_id),
  KEY idx_trash_deleted_at (deleted_at),
  KEY idx_trash_restore_status (restore_status),
  CONSTRAINT fk_trash_entries_deleted_by_user
    FOREIGN KEY (deleted_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_trash_entries_restored_by_user
    FOREIGN KEY (restored_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_trash_entries_purged_by_user
    FOREIGN KEY (purged_by_user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS trash_entry_items (
  id BIGINT NOT NULL AUTO_INCREMENT,
  trash_entry_id BIGINT NOT NULL,
  item_type VARCHAR(100) NOT NULL,
  item_id BIGINT DEFAULT NULL,
  item_role VARCHAR(100) DEFAULT NULL,
  title VARCHAR(255) DEFAULT NULL,
  snapshot_json JSON DEFAULT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY idx_trash_entry_items_entry (trash_entry_id, sort_order, id),
  KEY idx_trash_entry_items_type (item_type, item_id),
  CONSTRAINT fk_trash_entry_items_entry
    FOREIGN KEY (trash_entry_id) REFERENCES trash_entries(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

