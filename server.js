// Обновление через Cloud Shell 13.07.2025

const express = require('express')
const cors = require('cors')
const dotenv = require('dotenv')
const path = require('path')
const cookieParser = require('cookie-parser')
const db = require('./utils/db') // для /test-db

// ✅ Поддержка NODE_ENV и загрузка нужного .env файла
const NODE_ENV = process.env.NODE_ENV || 'local'
dotenv.config({ path: path.resolve(process.cwd(), `.env.${NODE_ENV}`) })

// (опционально — для отладки, можешь удалить потом)
console.log('✅ ENV loaded:', `.env.${NODE_ENV}`)
console.log('📡 DB_HOST:', process.env.DB_HOST)

const app = express()
const port = process.env.PORT || 5050

async function checkDbConnection({ retries = 5, delayMs = 1000 } = {}) {
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      await db.execute('SELECT 1')
      console.log('✅ DB connection ok')
      return true
    } catch (err) {
      const isLast = attempt === retries
      console.error(`❌ DB connection failed (attempt ${attempt}/${retries}):`, err.message)
      if (isLast) return false
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }
  return false
}

// Включить отладку импорта материалов (можно выставить в .env или оставить по умолчанию = 0)
process.env.DEBUG_MATERIALS_IMPORT = process.env.DEBUG_MATERIALS_IMPORT || '1'
// ✅ Разрешённые источники CORS — можно указать через запятую в .env
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

// ✅ Парсинг JSON, форм и cookie (увеличили лимит для импорта материалов)
app.use(express.json({ limit: '50mb' }))
app.use(express.urlencoded({ extended: true, limit: '50mb' }))
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
  if (NODE_ENV === 'local') {
    checkDbConnection()
  }
})
