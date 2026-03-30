CREATE TABLE IF NOT EXISTS user_sessions (
  id BIGINT NOT NULL AUTO_INCREMENT,
  session_id VARCHAR(64) NOT NULL,
  user_id INT NOT NULL,
  started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ip VARCHAR(45) DEFAULT NULL,
  user_agent VARCHAR(255) DEFAULT NULL,
  last_path VARCHAR(255) DEFAULT NULL,
  last_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ended_at DATETIME DEFAULT NULL,
  last_ping_at DATETIME DEFAULT NULL,
  last_action_at DATETIME DEFAULT NULL,
  is_visible TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  status VARCHAR(16) DEFAULT 'active',
  closed_reason VARCHAR(32) DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_session_id (session_id),
  KEY idx_user_last_seen (user_id, last_seen_at),
  KEY idx_user_started_at (user_id, started_at),
  KEY idx_status_last_seen (status, last_seen_at),
  CONSTRAINT fk_user_sessions_user
    FOREIGN KEY (user_id) REFERENCES users(id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
