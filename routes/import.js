// routes/import.js

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

// Загрузить данные
router.post("/:type", async (req, res) => {
  const type = req.params.type
  const schema = importSchemas[type]
  if (!schema) return res.status(400).json({ message: "Схема импорта не найдена" })

  const rows = Array.isArray(req.body) ? req.body : []
  if (!rows.length) return res.status(400).json({ message: "Нет данных для импорта" })

  // Преобразовать строки
  const transformed = rows.map(schema.transform)

  const { inserted, errors } = await validateImportRows(transformed, {
    table: schema.table,
    uniqueField: schema.uniqueField,
    requiredFields: schema.requiredFields,
    req,
    logType: type
  })

  res.status(200).json({ inserted, errors })
})

module.exports = router
