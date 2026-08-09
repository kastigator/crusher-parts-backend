ALTER TABLE roles
  ADD COLUMN description VARCHAR(255) NULL AFTER slug,
  ADD COLUMN is_system TINYINT(1) NOT NULL DEFAULT 0 AFTER description,
  ADD COLUMN is_super_admin TINYINT(1) NOT NULL DEFAULT 0 AFTER is_system;

ALTER TABLE users
  ADD COLUMN must_change_password TINYINT(1) NOT NULL DEFAULT 0 AFTER is_active,
  ADD COLUMN disabled_at DATETIME(6) NULL AFTER must_change_password;

ALTER TABLE capabilities
  ADD COLUMN is_legacy TINYINT(1) NOT NULL DEFAULT 0 AFTER is_active;

CREATE TABLE user_roles (
  user_id INT NOT NULL,
  role_id INT NOT NULL,
  is_primary TINYINT(1) NOT NULL DEFAULT 0,
  assigned_by INT NULL,
  assigned_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  primary_user_guard INT
    GENERATED ALWAYS AS (CASE WHEN is_primary = 1 THEN user_id ELSE NULL END) STORED,
  PRIMARY KEY (user_id, role_id),
  UNIQUE KEY uq_user_roles_one_primary (primary_user_guard),
  KEY ix_user_roles_role (role_id, user_id),
  KEY ix_user_roles_assigned_by (assigned_by),
  CONSTRAINT fk_user_roles_user
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_user_roles_role
    FOREIGN KEY (role_id) REFERENCES roles (id) ON DELETE RESTRICT,
  CONSTRAINT fk_user_roles_assigned_by
    FOREIGN KEY (assigned_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT chk_user_roles_primary CHECK (is_primary IN (0, 1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE security_audit_events (
  id BIGINT NOT NULL AUTO_INCREMENT,
  event_type VARCHAR(80) NOT NULL,
  actor_user_id INT NULL,
  target_user_id INT NULL,
  entity_type VARCHAR(80) NULL,
  entity_id VARCHAR(120) NULL,
  before_json JSON NULL,
  after_json JSON NULL,
  metadata_json JSON NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  KEY ix_security_audit_created (created_at, id),
  KEY ix_security_audit_actor (actor_user_id, created_at),
  KEY ix_security_audit_target (target_user_id, created_at),
  KEY ix_security_audit_entity (entity_type, entity_id, created_at),
  CONSTRAINT fk_security_audit_actor
    FOREIGN KEY (actor_user_id) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_security_audit_target
    FOREIGN KEY (target_user_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

UPDATE roles
SET is_system = 1,
    is_super_admin = 1,
    description = COALESCE(description, 'Protected emergency and system administration role')
WHERE slug = 'admin';

UPDATE roles
SET description = CASE slug
  WHEN 'prodavec' THEN 'Client-facing sales and commercial responsibility'
  WHEN 'zakupshchik' THEN 'Supplier market work and procurement execution'
  WHEN 'nachalnik-otdela-zakupok' THEN 'Procurement management and delegated administration'
  WHEN 'specialist-po-katalogam' THEN 'Classifier and technical master-data responsibility'
  WHEN 'nablyudatel' THEN 'Read-only operational visibility'
  ELSE description
END
WHERE description IS NULL;

INSERT INTO user_roles (user_id, role_id, is_primary, assigned_by)
SELECT id, role_id, 1, NULL
FROM users;

INSERT INTO capabilities
  (capability_key, name, description, section, sort_order, is_active, is_legacy)
VALUES
  ('administration.access', 'Доступ к администрированию', 'Просмотр рабочей зоны Administration', 'administration', 800, 1, 0),
  ('administration.users.manage', 'Управление пользователями', 'Создание, изменение, отключение и восстановление учетных записей', 'administration', 810, 1, 0),
  ('administration.roles.manage', 'Управление ролями и полномочиями', 'Настройка ролей и их capability-наборов', 'administration', 820, 1, 0),
  ('administration.audit.view', 'Просмотр аудита безопасности', 'Просмотр событий входа, назначения ролей и изменений доступа', 'administration', 830, 1, 0),
  ('administration.sessions.manage', 'Управление сессиями', 'Просмотр и принудительное завершение пользовательских сессий', 'administration', 840, 1, 0)
ON DUPLICATE KEY UPDATE
  name = VALUES(name),
  description = VALUES(description),
  section = VALUES(section),
  sort_order = VALUES(sort_order),
  is_active = 1,
  is_legacy = 0;

UPDATE capabilities
SET is_legacy = 1
WHERE capability_key = 'admin.users_roles.manage';

INSERT INTO role_capabilities (role_id, capability_id, is_allowed)
SELECT DISTINCT source.role_id, target.id, 1
FROM (
  SELECT r.id AS role_id
  FROM roles r
  WHERE r.is_super_admin = 1
  UNION
  SELECT rc.role_id
  FROM role_capabilities rc
  JOIN capabilities legacy ON legacy.id = rc.capability_id
  WHERE legacy.capability_key = 'admin.users_roles.manage'
    AND rc.is_allowed = 1
) source
JOIN capabilities target
  ON target.capability_key IN (
    'administration.access',
    'administration.users.manage',
    'administration.roles.manage',
    'administration.audit.view',
    'administration.sessions.manage'
  )
ON DUPLICATE KEY UPDATE is_allowed = 1;
