const jwt = require('jsonwebtoken');
require('dotenv').config();

// Middleware для проверки JWT
const authenticateToken = (req, res, next) => {
  // Получаем токен из заголовков авторизации
  const token = req.headers['authorization'] && req.headers['authorization'].split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ message: 'Отсутствует токен авторизации' });
  }

  // Проверяем токен
  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ message: 'Неверный или истёкший токен' });
    }

    // Сохраняем информацию о пользователе в запросе
    req.user = user;
    next(); // Переходим к следующему обработчику
  });
};

module.exports = authenticateToken;
