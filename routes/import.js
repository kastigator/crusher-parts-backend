// routes/import.js
const express = require("express")
const router = express.Router()

const importSchemas = require("../utils/entitySchemas")
const { validateImportRows } = require("../utils/importValidator")
const db = require("../utils/db")

const toId = (v) => {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}

// GET /import/schema/:type
router.get("/schema/:type", (req, res) => {
  const schema = importSchemas[req.params.type]
  if (!schema) return res.status(404).json({ message: "Схема не найдена" })
  res.json(schema)
})

// POST /import/:type
router.post("/:type", async (req, res) => {
  try {
    const type = req.params.type
    const schema = importSchemas[type]
    if (!schema) {
      return res.status(400).json({ message: "Схема импорта не найдена" })
    }

    let rows = Array.isArray(req.body)
      ? req.body
      : Array.isArray(req.body?.rows)
      ? req.body.rows
      : []

    if (!rows.length) {
      return res.status(400).json({ message: "Нет данных для импорта" })
    }

    const MAX_ROWS = 10000
    if (rows.length > MAX_ROWS) {
      return res.status(413).json({
        message: `Слишком много строк для импорта (>${MAX_ROWS})`,
      })
    }

    const rawModelId =
      req.query?.equipment_model_id ??
      req.body?.context?.equipment_model_id ??
      null
    const equipment_model_id = rawModelId != null ? toId(rawModelId) : null

    const ctx = { db, req, equipment_model_id }

    if (typeof schema.serverTransform === "function") {
      try {
        rows = await schema.serverTransform(rows, ctx)
      } catch (e) {
        if (
          e &&
          (e.message === "MISSING_EQUIPMENT_MODEL_ID" ||
            e.code === "MISSING_EQUIPMENT_MODEL_ID")
        ) {
          return res
            .status(400)
            .json({ message: "Не передан equipment_model_id в контексте импорта" })
        }
        if (
          e &&
          (e.message === "EQUIPMENT_MODEL_NOT_FOUND" ||
            e.code === "EQUIPMENT_MODEL_NOT_FOUND")
        ) {
          return res
            .status(400)
            .json({ message: "Указанная модель оборудования не найдена" })
        }
        throw e
      }
    }

    const logType = type === "part_suppliers" ? "suppliers" : type

    const result = await validateImportRows(rows, {
      table: schema.table,
      uniqueBy: schema.uniqueBy,
      uniqueField: schema.uniqueField,
      requiredFields: schema.requiredFields || [],
      req,
      logType,
    })

    return res.status(200).json(result)
  } catch (err) {
    console.error("Ошибка импорта:", err)
    const status = err.status || 500

    if (
      err &&
      (err.message === "MISSING_EQUIPMENT_MODEL_ID" ||
        err.code === "MISSING_EQUIPMENT_MODEL_ID")
    ) {
      return res
        .status(400)
        .json({ message: "Не передан equipment_model_id в контексте импорта" })
    }
    if (
      err &&
      (err.message === "EQUIPMENT_MODEL_NOT_FOUND" ||
        err.code === "EQUIPMENT_MODEL_NOT_FOUND")
    ) {
      return res
        .status(400)
        .json({ message: "Указанная модель оборудования не найдена" })
    }

    return res.status(status).json({ message: "Ошибка сервера при импорте" })
  }
})

module.exports = router
