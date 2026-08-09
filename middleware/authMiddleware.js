const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-key';

module.exports = function authMiddleware(req, res, next) {
  if (req.authorizationResolved && req.user) {
    return next()
  }

  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Токен не передан' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ message: 'Неверный или просроченный токен' });
  }
};
