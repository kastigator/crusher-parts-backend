const express = require('express');
const cors = require('cors');
require('dotenv').config();

const db = require('./utils/db');
const authRoutes = require('./routes/auth'); // Импорт маршрутов для авторизации

const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.send('API is running 🚀');
});

// Подключаем маршруты для авторизации
app.use('/api/auth', authRoutes); // Эта строка подключает маршруты для /api/auth

const PORT = process.env.PORT || 5000;
app.listen(PORT, async () => {
  try {
    const connection = await db.getConnection();
    await connection.ping(); // проверка соединения с базой
    console.log('✅ MySQL подключение установлено');
    connection.release();
  } catch (err) {
    console.error('❌ Ошибка подключения к MySQL:', err.message);
  }

  console.log(`Server started on port ${PORT}`);
});
