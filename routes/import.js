const express = require("express")
const router = express.Router()
const importSchemas = require("../utils/entitySchemas")
const { validateImportRows } = require("../utils/importValidator")

// Получить схему импорта по типу
router.get("/schema/:type", (req, res) => {
  const schema = importSchemas[req.params.type]
  if (!schema) return res.status(404).json({ message: "Схема не найдена" })
  res.json(schema)
})

// Загрузить данные (rows уже трансформированы на фронте)
router.post("/:type", async (req, res) => {
  const type = req.params.type
  const schema = importSchemas[type]
  if (!schema) return res.status(400).json({ message: "Схема импорта не найдена" })

  const rows = Array.isArray(req.body) ? req.body : []
  if (!rows.length) {
    return res.status(400).json({ message: "Нет данных для импорта" })
  }

  // Логи хотим видеть в едином журнале поставщика
  const logType = type === "part_suppliers" ? "suppliers" : type

  const result = await validateImportRows(rows, {
    table: schema.table,
    uniqueBy: schema.uniqueBy,           // если где-то используешь массив уникальных — поддерживается
    uniqueField: schema.uniqueField,     // для совместимости (у нас vat_number)
    requiredFields: schema.requiredFields || [],
    req,
    logType                                // <= важное изменение для поставщиков
    // mode: "upsert"                      // по умолчанию и так upsert
  })

  // Вернём всё, что даёт валидатор: inserted, updated, errors
  res.status(200).json(result)
})

module.exports = router
