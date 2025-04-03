const express = require('express');
const router = express.Router();
const { register, login } = require('../controllers/authController');
const authenticateToken = require('../middleware/authMiddleware'); // Импортируем middleware

// Регистрация
router.post('/register', register);

// Логин
router.post('/login', login);

// Пример защищённого маршрута
// Этот маршрут будет доступен только авторизованным пользователям
router.get('/profile', authenticateToken, (req, res) => {
  // Доступ к данным пользователя, которые могут быть в req.user
  res.json({ message: 'Профиль пользователя', user: req.user });
});

module.exports = router;
