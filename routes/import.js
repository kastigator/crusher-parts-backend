// routes/import.js
//
// Универсальный импорт:
//   POST /import/:type
//
// Где :type — ключ из utils/entitySchemas.js (например, "tnved_codes").
//
// Алгоритм:
//   1) Берём схему importSchemas[type].
//   2) Проверяем размер и базовые ошибки.
//   3) Если есть schema.serverTransform → прогоняем rows через неё.
//   4) Передаём всё в validateImportRows, который уже:
//      - проверяет обязательные поля,
//      - ищет/создаёт/обновляет записи в БД,
//      - пишет логи.
//
// Чтобы добавить новый импорт, достаточно:
//   - описать его в utils/entitySchemas.js,
//   - на фронте использовать type = "<ключ_схемы>".
//

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
// Возвращает описание схемы (headerMap, requiredFields, templateUrl и т.п.)
// Используется фронтом для построения ImportModal.
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

    // rows могут прийти как [ ... ] или { rows: [ ... ] }
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

    // Специфичный контекст (например, equipment_model_id) — для serverTransform
    const rawModelId =
      req.query?.equipment_model_id ??
      req.body?.context?.equipment_model_id ??
      null
    const equipment_model_id = rawModelId != null ? toId(rawModelId) : null

    const ctx = { db, req, equipment_model_id }

    // Если schema.serverTransform определён — даём схеме возможность
    // дополнительно обработать строки: проставить foreign keys, искусственные ключи и т.п.
    if (typeof schema.serverTransform === "function") {
      try {
        rows = await schema.serverTransform(rows, ctx)
      } catch (e) {
        if (
          e &&
          (e.message === "MISSING_EQUIPMENT_MODEL_ID" ||
            e.code === "MISSING_EQUIPMENT_MODEL_ID")
        ) {
          return res.status(400).json({
            message: "Не передан equipment_model_id в контексте импорта",
          })
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
        if (
          e &&
          (e.message === "MISSING_SUPPLIER_ID" ||
            e.code === "MISSING_SUPPLIER_ID")
        ) {
          return res
            .status(400)
            .json({ message: "Не передан supplier_id в контексте импорта" })
        }
        if (
          e &&
          (e.message === "SUPPLIER_NOT_FOUND" ||
            e.code === "SUPPLIER_NOT_FOUND")
        ) {
          return res
            .status(400)
            .json({ message: "Указанный поставщик не найден" })
        }
        throw e
      }
    }

    // Для логирования: иногда удобнее логировать не "part_suppliers", а "suppliers"
    const logType = type === "part_suppliers" ? "suppliers" : type

    // Режимы и флаги берём из схемы, но задаём дефолты
    const mode = schema.mode || "upsert" // по умолчанию — upsert
    const disableExistingCheck = !!schema.disableExistingCheck

    const result = await validateImportRows(rows, {
      table: schema.table,
      uniqueBy: schema.uniqueBy,
      uniqueField: schema.uniqueField,
      requiredFields: schema.requiredFields || [],
      req,
      logType,
      mode,
      disableExistingCheck,
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
    if (
      err &&
      (err.message === "MISSING_SUPPLIER_ID" ||
        err.code === "MISSING_SUPPLIER_ID")
    ) {
      return res
        .status(400)
        .json({ message: "Не передан supplier_id в контексте импорта" })
    }
    if (
      err &&
      (err.message === "SUPPLIER_NOT_FOUND" ||
        err.code === "SUPPLIER_NOT_FOUND")
    ) {
      return res
        .status(400)
        .json({ message: "Указанный поставщик не найден" })
    }

    return res.status(status).json({ message: "Ошибка сервера при импорте" })
  }
})

module.exports = router
