// utils/entitySchemas.js
const db = require('./db')

module.exports = {
  // === ТН ВЭД ===
  tnved_codes: {
    table: "tnved_codes",
    uniqueField: "code",
    requiredFields: ["code"],
    templateUrl: "https://storage.googleapis.com/shared-parts-bucket/templates/tnved_codes_template.xlsx",
    headerMap: {
      "Код": "code",
      "Описание": "description",
      "Ставка пошлины (%)": "duty_rate",
      "Примечания": "notes"
    },
    transform: (row) => ({
      code: String(row["code"] || "").trim(),
      description: row["description"]?.trim() || null,
      duty_rate: row["duty_rate"] ?? null,
      notes: row["notes"]?.trim() || null
    })
  },

  // === Поставщики ===
  part_suppliers: {
    table: "part_suppliers",
    uniqueField: "vat_number", // единообразно с БД
    requiredFields: ["name"],
    templateUrl: "https://storage.googleapis.com/shared-parts-bucket/templates/suppliers_template.xlsx",
    headerMap: {
      "Название (обязательно)": "name",
      "VAT / ИНН": "vat_number",
      "Страна (ISO2)": "country",
      "Сайт": "website",
      "Контактное лицо": "contact_person",
      "Email": "email",
      "Телефон": "phone",
      // "Адрес (строкой)" — удалено
      "Условия оплаты": "payment_terms",
      "Валюта (ISO3)": "preferred_currency",
      "Инкотермс": "incoterms",
      "Срок поставки, дни": "default_lead_time_days",
      "Примечания": "notes"
    },
    transform: (row) => {
      const trim = (v) => (typeof v === "string" ? v.trim() : v)
      const nz = (v) => (v === "" || v === undefined ? null : v)
      const up = (v, n) =>
        typeof v === "string" ? v.trim().toUpperCase().slice(0, n || v.length) : v ?? null

      return {
        name: trim(row.name || ""),
        vat_number: nz(trim(row.vat_number)),
        country: nz(up(row.country, 2)),
        website: nz(trim(row.website)),
        contact_person: nz(trim(row.contact_person)),
        email: nz(trim(row.email)),
        phone: nz(trim(row.phone)),
        // address — удалено
        payment_terms: nz(up(row.payment_terms)),
        preferred_currency: nz(up(row.preferred_currency, 3)),
        incoterms: nz(up(row.incoterms)),
        default_lead_time_days:
          row.default_lead_time_days === "" || row.default_lead_time_days === undefined
            ? null
            : Number(row.default_lead_time_days),
        notes: nz(trim(row.notes))
      }
    }
  },

  // === ОРИГИНАЛЬНЫЕ ДЕТАЛИ ===
  original_parts: {
    table: "original_parts",
    uniqueField: "cat_number",
    requiredFields: ["cat_number"],

    // Твой файл в бакете (шаблон без ТН ВЭД, с техописанием):
    templateUrl: "https://storage.googleapis.com/shared-parts-bucket/templates/original_parts_template.xlsx",

    // Заголовки из шаблона → поля БД
    headerMap: {
      "Артикул (cat_number)*": "cat_number",
      "Описание EN": "description_en",
      "Описание RU": "description_ru",
      "Техническое описание (tech_description)": "tech_description",
      "Вес, кг": "weight_kg"
    },

    // Нормализация
    transform: (row) => {
      const trim = (v) => (typeof v === 'string' ? v.trim() : v)
      const nz = (v) => (v === '' || v === undefined ? null : v)
      const num = (v) => (v === '' || v === undefined || v === null ? null : Number(v))

      return {
        cat_number: trim(row.cat_number || ''),
        description_en: nz(trim(row.description_en)),
        description_ru: nz(trim(row.description_ru)),
        tech_description: nz(trim(row.tech_description)),
        weight_kg: num(row.weight_kg),
        // equipment_model_id проставим на сервере из контекста
      }
    },

    /**
     * Серверная трансформация:
     * - подставляем equipment_model_id из контекста импорта
     * - tnved_code_id оставляем NULL (привяжешь позже из карточки детали)
     */
    serverTransform: async (rows, ctx) => {
      const modelId = Number(
        ctx?.equipment_model_id ??
        ctx?.req?.query?.equipment_model_id ??
        ctx?.req?.body?.context?.equipment_model_id
      )
      if (!Number.isFinite(modelId)) {
        const err = new Error('MISSING_EQUIPMENT_MODEL_ID')
        err.status = 400
        throw err
      }

      // проверим существование модели
      const [m] = await db.execute('SELECT id FROM equipment_models WHERE id=?', [modelId])
      if (!m.length) {
        const err = new Error('EQUIPMENT_MODEL_NOT_FOUND')
        err.status = 400
        throw err
      }

      return rows.map(r => ({
        ...r,
        equipment_model_id: modelId,
        tnved_code_id: null
      }))
    }
  }
}
