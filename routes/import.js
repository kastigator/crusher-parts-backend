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
const XLSX = require("xlsx")

const importSchemas = require("../utils/entitySchemas")
const { validateImportRows } = require("../utils/importValidator")
const db = require("../utils/db")

const toId = (v) => {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}

const resolveImportSchema = (type) =>
  importSchemas[type] ||
  (type === "suppliers" ? importSchemas.part_suppliers : undefined)

const buildTemplateRows = (schema) => {
  const headers = Object.keys(schema?.headerMap || {})
  const fieldByHeader = schema?.headerMap || {}
  const examples = Array.isArray(schema?.templateExampleRows)
    ? schema.templateExampleRows
    : []

  const dataRows = examples.map((row) =>
    headers.map((header) => {
      const field = fieldByHeader[header]
      return row?.[field] ?? ""
    })
  )

  return {
    headers,
    dataRows,
  }
}

const buildTemplateWorkbook = ({ type, schema }) => {
  const wb = XLSX.utils.book_new()
  const { headers, dataRows } = buildTemplateRows(schema)
  const ws = XLSX.utils.aoa_to_sheet([headers, ...dataRows])
  XLSX.utils.book_append_sheet(
    wb,
    ws,
    schema.templateSheetName || "import"
  )

  const readmeLines = Array.isArray(schema?.templateReadme)
    ? schema.templateReadme
    : []
  const requiredFields = Array.isArray(schema?.requiredFields)
    ? schema.requiredFields
    : []

  if (readmeLines.length || requiredFields.length) {
    const techToHuman = (tech) =>
      Object.entries(schema.headerMap || {}).find(([, key]) => key === tech)?.[0] ||
      tech

    const readmeRows = [
      ["Сущность", type],
      ["Обязательные поля", requiredFields.map(techToHuman).join(", ") || "—"],
      [],
      ["Памятка"],
      ...readmeLines.map((line) => [line]),
    ]
    const readme = XLSX.utils.aoa_to_sheet(readmeRows)
    XLSX.utils.book_append_sheet(wb, readme, "README")
  }

  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" })
}

// GET /import/schema/:type
// Возвращает описание схемы (headerMap, requiredFields и т.п.)
// Используется фронтом для построения ImportModal.
router.get("/schema/:type", (req, res) => {
  const schema = resolveImportSchema(req.params.type)
  if (!schema) return res.status(404).json({ message: "Схема не найдена" })
  res.json(schema)
})

// GET /import/template/:type
// Генерирует актуальный XLSX-шаблон на лету на основе текущей схемы импорта.
router.get("/template/:type", (req, res) => {
  try {
    const type = req.params.type
    const schema = resolveImportSchema(type)
    if (!schema) {
      return res.status(404).json({ message: "Схема не найдена" })
    }

    const buffer = buildTemplateWorkbook({ type, schema })
    const filename =
      schema.templateFileName || `${String(type || "import").trim() || "import"}_template.xlsx`

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    )
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${filename}"`
    )
    return res.send(buffer)
  } catch (err) {
    console.error("GET /import/template/:type error:", err)
    return res.status(500).json({ message: "Ошибка генерации шаблона" })
  }
})

// POST /import/:type
router.post("/:type", async (req, res) => {
  try {
    const type = req.params.type
    // поддерживаем alias suppliers → part_suppliers
    const schema = resolveImportSchema(type)
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
            message: "В контексте импорта не выбрана модель техники",
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
            .json({ message: "В контексте импорта не выбран поставщик" })
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
      findExisting: schema.findExisting,
      afterEachRow: schema.afterEachRow,
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
        .json({ message: "В контексте импорта не выбрана модель техники" })
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
        .json({ message: "В контексте импорта не выбран поставщик" })
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
