// utils/entitySchemas.js

module.exports = {
  tnved_codes: {
    table: "tnved_codes",
    uniqueField: "code",
    requiredFields: ["code"],
    templateUrl: "https://storage.googleapis.com/shared-parts-bucket/templates/tnved_codes_template.xlsx",
    fields: ["Код", "Описание", "Ставка пошлины (%)", "Примечания"],
    transform: (row) => ({
      code: String(row["Код"] || "").trim(),
      description: row["Описание"]?.trim() || null,
      duty_rate: row["Ставка пошлины (%)"] || null,
      notes: row["Примечания"]?.trim() || null
    })
  }

  // сюда добавишь другие таблицы
}
