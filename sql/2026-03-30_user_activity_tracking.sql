ALTER TABLE user_sessions
  ADD COLUMN started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP AFTER user_id,
  ADD COLUMN last_path VARCHAR(255) DEFAULT NULL AFTER user_agent,
  ADD COLUMN ended_at DATETIME DEFAULT NULL AFTER last_seen_at,
  ADD COLUMN last_ping_at DATETIME DEFAULT NULL AFTER ended_at,
  ADD COLUMN last_action_at DATETIME DEFAULT NULL AFTER last_ping_at,
  ADD COLUMN is_visible TINYINT(1) NOT NULL DEFAULT 1 AFTER last_action_at,
  ADD COLUMN closed_reason VARCHAR(32) DEFAULT NULL AFTER status;

CREATE INDEX idx_user_started_at ON user_sessions (user_id, started_at);
CREATE INDEX idx_status_last_seen ON user_sessions (status, last_seen_at);

UPDATE user_sessions
SET started_at = created_at
WHERE started_at IS NULL OR started_at > created_at;

CREATE TABLE IF NOT EXISTS user_activity_events (
  id BIGINT NOT NULL AUTO_INCREMENT,
  session_id VARCHAR(64) NOT NULL,
  user_id INT NOT NULL,
  event_type VARCHAR(32) NOT NULL,
  event_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  path VARCHAR(255) DEFAULT NULL,
  entity_type VARCHAR(64) DEFAULT NULL,
  entity_id INT DEFAULT NULL,
  meta_json JSON DEFAULT NULL,
  ip VARCHAR(45) DEFAULT NULL,
  user_agent VARCHAR(255) DEFAULT NULL,
  PRIMARY KEY (id),
  KEY idx_uae_user_time (user_id, event_time),
  KEY idx_uae_session_time (session_id, event_time),
  KEY idx_uae_type_time (event_type, event_time),
  CONSTRAINT fk_uae_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
