// controllers/authController.js
const db = require('../utils/db');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { resolveEffectiveAccess } = require('../services/authorizationService');
const { recordSecurityEvent } = require('../services/securityAuditService');

const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-key';
const REFRESH_SECRET = process.env.REFRESH_SECRET || 'refresh-secret-key';

const ACCESS_EXPIRES_IN = '8h';
const REFRESH_EXPIRES_IN = '24h';

function signAccess(userPayload) {
  return jwt.sign(userPayload, JWT_SECRET, { expiresIn: ACCESS_EXPIRES_IN });
}
function signRefresh(userPayload) {
  // в refresh можно хранить только id/role, но оставим тот же payload для простоты
  return jwt.sign(userPayload, REFRESH_SECRET, { expiresIn: REFRESH_EXPIRES_IN });
}

async function fetchUserByUsername(username) {
  const [rows] = await db.execute(
    `SELECT u.*
       FROM users u
      WHERE u.username = ?
      LIMIT 1`,
    [username]
  );
  return rows[0] || null;
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

    const payload = await resolveEffectiveAccess(user.id);
    if (!payload?.roles?.length) {
      return res.status(403).json({ message: 'Пользователю не назначена роль' });
    }

    const token = signAccess({ id: payload.id, username: payload.username });
    const refreshToken = signRefresh({ id: payload.id });

    await recordSecurityEvent({
      eventType: 'authentication.login_succeeded',
      actorUserId: payload.id,
      targetUserId: payload.id,
      entityType: 'user',
      entityId: payload.id,
    });

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

    const user = await resolveEffectiveAccess(decoded.id);

    if (!user || !user.is_active) {
      return res.status(403).json({ message: 'Пользователь недоступен' });
    }

    const payload = user;
    const token = signAccess({ id: payload.id, username: payload.username });
    const newRefresh = signRefresh({ id: payload.id });

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
