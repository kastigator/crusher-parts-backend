// routes/import.js
const express = require("express")
const router = express.Router()
const importSchemas = require("../utils/entitySchemas")
const { validateImportRows } = require("../utils/importValidator")
const db = require("../utils/db") // 👈 нужно для serverTransform

// Получить схему импорта по типу (templateUrl, headerMap и т.д.)
router.get("/schema/:type", (req, res) => {
  const schema = importSchemas[req.params.type]
  if (!schema) return res.status(404).json({ message: "Схема не найдена" })
  res.json(schema)
})

// Универсальная загрузка данных (rows уже распарсены фронтом из Excel по headerMap)
router.post("/:type", async (req, res) => {
  try {
    const type = req.params.type
    const schema = importSchemas[type]
    if (!schema) return res.status(400).json({ message: "Схема импорта не найдена" })

    // Поддержим и body=Array, и body={ rows: [...] }
    let rows = Array.isArray(req.body) ? req.body : (Array.isArray(req.body?.rows) ? req.body.rows : [])
    if (!rows.length) {
      return res.status(400).json({ message: "Нет данных для импорта" })
    }

    // Контекст (для original_parts сюда прилетит выбранная модель)
    const ctx = {
      db,
      req,
      equipment_model_id: Number(req.query?.equipment_model_id ?? req.body?.context?.equipment_model_id)
    }

    // Если схема определяет serverTransform — применим (напр., подставить equipment_model_id)
    if (typeof schema.serverTransform === "function") {
      rows = await schema.serverTransform(rows, ctx)
    }

    // Логи хотим видеть в едином журнале поставщика
    const logType = type === "part_suppliers" ? "suppliers" : type

    // Импорт с валидацией (upsert по uniqueField / uniqueBy)
    const result = await validateImportRows(rows, {
      table: schema.table,
      uniqueBy: schema.uniqueBy,           // если где-то используется массив уникальных — поддерживается
      uniqueField: schema.uniqueField,     // для совместимости
      requiredFields: schema.requiredFields || [],
      req,
      logType
      // mode: "upsert" по умолчанию
    })

    return res.status(200).json(result)
  } catch (err) {
    console.error("Ошибка импорта:", err)
    const status = err.status || 500

    // Дружественные сообщения для частых кейсов серверной трансформации
    if (err.message === "MISSING_EQUIPMENT_MODEL_ID") {
      return res.status(400).json({ message: "Не передан equipment_model_id в контексте импорта" })
    }
    if (err.message === "EQUIPMENT_MODEL_NOT_FOUND") {
      return res.status(400).json({ message: "Указанная модель оборудования не найдена" })
    }

    return res.status(status).json({ message: "Ошибка сервера при импорте" })
  }
})

module.exports = router
