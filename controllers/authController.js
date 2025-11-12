// controllers/authController.js
const db = require('../utils/db');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-key';
const REFRESH_SECRET = process.env.REFRESH_SECRET || 'refresh-secret-key';

const ACCESS_EXPIRES_IN = '8h';
const REFRESH_EXPIRES_IN = '7d';

function signAccess(userPayload) {
  return jwt.sign(userPayload, JWT_SECRET, { expiresIn: ACCESS_EXPIRES_IN });
}
function signRefresh(userPayload) {
  // в refresh можно хранить только id/role, но оставим тот же payload для простоты
  return jwt.sign(userPayload, REFRESH_SECRET, { expiresIn: REFRESH_EXPIRES_IN });
}

async function fetchUserByUsername(username) {
  const [rows] = await db.execute(
    `SELECT u.*, r.slug AS role_slug, r.name AS role_name
       FROM users u
       LEFT JOIN roles r ON r.id = u.role_id
      WHERE u.username = ?
      LIMIT 1`,
    [username]
  );
  return rows[0] || null;
}

async function fetchRolePermissions(roleId) {
  const [rows] = await db.execute(
    `SELECT tab_id
       FROM role_permissions
      WHERE role_id = ? AND can_view = 1`,
    [roleId]
  );
  return rows.map(r => r.tab_id);
}

function buildUserPayload(dbUser, permissions) {
  return {
    id: dbUser.id,
    username: dbUser.username,
    full_name: dbUser.full_name,
    role_id: dbUser.role_id,
    role: (dbUser.role_slug || '').toLowerCase(), // <-- именно это читает adminOnly и TabsContext
    permissions: Array.isArray(permissions) ? permissions : [],
  };
}

/* =======================
   POST /auth/login
   body: { username, password }
   ======================= */
exports.login = async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ message: 'Укажите username и password' });
    }

    const user = await fetchUserByUsername(username);
    if (!user) return res.status(401).json({ message: 'Неверный логин или пароль' });
    if (!user.is_active) return res.status(403).json({ message: 'Пользователь деактивирован' });

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ message: 'Неверный логин или пароль' });

    // для не-админа подтягиваем разрешённые вкладки; админ видит всё и может игнорировать permissions
    const isAdmin = (user.role_slug || '').toLowerCase() === 'admin';
    const permissions = isAdmin ? [] : await fetchRolePermissions(user.role_id);

    const payload = buildUserPayload(user, permissions);

    const token = signAccess(payload);
    const refreshToken = signRefresh({ id: payload.id, role: payload.role });

    return res.json({
      token,
      refreshToken,
      user: payload,
    });
  } catch (err) {
    console.error('POST /auth/login error', err);
    res.status(500).json({ message: 'Ошибка сервера при логине' });
  }
};

/* =======================
   POST /auth/refresh
   body: { refreshToken }
   ======================= */
exports.refreshToken = async (req, res) => {
  try {
    const { refreshToken } = req.body || {};
    if (!refreshToken) return res.status(400).json({ message: 'refreshToken обязателен' });

    let decoded;
    try {
      decoded = jwt.verify(refreshToken, REFRESH_SECRET);
    } catch {
      return res.status(401).json({ message: 'Некорректный или просроченный refreshToken' });
    }

    // подтянем актуальные данные пользователя (роль/permissions могли поменяться)
    const user = await db
      .execute(
        `SELECT u.*, r.slug AS role_slug, r.name AS role_name
           FROM users u
           LEFT JOIN roles r ON r.id = u.role_id
          WHERE u.id = ?
          LIMIT 1`,
        [decoded.id]
      )
      .then(r => r[0][0]);

    if (!user || !user.is_active) {
      return res.status(403).json({ message: 'Пользователь недоступен' });
    }

    const isAdmin = (user.role_slug || '').toLowerCase() === 'admin';
    const permissions = isAdmin ? [] : await fetchRolePermissions(user.role_id);
    const payload = buildUserPayload(user, permissions);

    const token = signAccess(payload);
    const newRefresh = signRefresh({ id: payload.id, role: payload.role });

    return res.json({
      token,
      refreshToken: newRefresh,
      user: payload,
    });
  } catch (err) {
    console.error('POST /auth/refresh error', err);
    res.status(500).json({ message: 'Ошибка сервера при обновлении токена' });
  }
};

/* ===== заглушки, если нужны сейчас, но ты их не используешь ===== */

exports.register = async (_req, res) => {
  return res.status(501).json({ message: 'Регистрация выключена' });
};

exports.forgotPassword = async (_req, res) => {
  return res.status(501).json({ message: 'Сброс пароля через e-mail не настроен' });
};

exports.resetPassword = async (_req, res) => {
  return res.status(501).json({ message: 'Сброс пароля не настроен' });
};

exports.logout = async (_req, res) => {
  // на JWT-стеке обычно stateless: делаем no-op
  return res.json({ success: true });
};
