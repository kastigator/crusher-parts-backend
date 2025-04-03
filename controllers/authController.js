const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../utils/db');
require('dotenv').config();

// Регистрация пользователя
const register = async (req, res) => {
  const { username, password, role, email } = req.body; // Добавляем email

  try {
    // Проверяем, если пользователь уже существует
    const [existingUser] = await db.execute('SELECT * FROM users WHERE username = ?', [username]);
    if (existingUser.length > 0) {
      return res.status(400).json({ message: 'Пользователь с таким именем уже существует' });
    }

    // Хешируем пароль
    const hashedPassword = await bcrypt.hash(password, 10);

    // Добавляем нового пользователя в базу (включаем email)
    await db.execute(
      'INSERT INTO users (username, password_hash, role, email) VALUES (?, ?, ?, ?)', // Изменено, добавлен email
      [username, hashedPassword, role || 'user', email] // Включаем email в параметры запроса
    );

    res.status(201).json({ message: 'Пользователь успешно зарегистрирован' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Ошибка на сервере' });
  }
};

// Логин пользователя
const login = async (req, res) => {
  const { username, password } = req.body;

  try {
    const [user] = await db.execute('SELECT * FROM users WHERE username = ?', [username]);
    if (user.length === 0) {
      return res.status(400).json({ message: 'Пользователь не найден' });
    }

    // Проверяем пароль (сравниваем с password_hash)
    const isMatch = await bcrypt.compare(password, user[0].password_hash); // Используем password_hash
    if (!isMatch) {
      return res.status(400).json({ message: 'Неверный пароль' });
    }

    // Генерируем JWT токен
    const token = jwt.sign(
      { userId: user[0].id, role: user[0].role },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );

    res.json({ message: 'Успешный вход', token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Ошибка на сервере' });
  }
};

module.exports = { register, login };
