// Обновление через Cloud Shell 13.07.2025

const express = require('express')
const cors = require('cors')
const dotenv = require('dotenv')
const path = require('path')
const cookieParser = require('cookie-parser')
const db = require('./utils/db') // для /test-db

dotenv.config()

const app = express()
const port = process.env.PORT || 5050

// ✅ Разрешённые источники CORS — можно указать несколько через запятую в .env
const allowedOrigins = [
  'http://localhost:5173',
  'https://storage.googleapis.com',
  ...(process.env.CORS_ORIGIN?.split(',') || [])
]

// ✅ Настройка CORS с поддержкой credentials
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true)
    } else {
      callback(new Error(`Not allowed by CORS: ${origin}`))
    }
  },
  credentials: true
}))

// ✅ Парсинг JSON, форм и cookie
app.use(express.json())
app.use(express.urlencoded({ extended: true }))
app.use(cookieParser())

// ✅ Статические файлы
app.use('/uploads', express.static(path.join(__dirname, 'uploads')))
app.use('/static', express.static(path.join(__dirname, 'public')))

// ✅ Основной роутинг
const routerIndex = require('./routes/routerIndex')
app.use('/api', routerIndex)

app.use('/api/tabs', require('./routes/tabs'))
app.use('/api/role-permissions', require('./routes/rolePermissions'))

// ✅ Тестовый маршрут для проверки соединения с базой
app.get('/test-db', async (req, res) => {
  try {
    const [rows] = await db.execute('SELECT 1')
    res.json({ status: 'ok', result: rows })
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message })
  }
})

// ✅ Обработка 404 — если маршрут не найден
app.use((req, res) => {
  res.status(404).json({ message: 'Маршрут не найден' })
})

// ✅ Запуск сервера
app.listen(port, () => {
  console.log(`✅ Server running on port ${port}`)
})
