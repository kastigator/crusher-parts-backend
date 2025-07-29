module.exports = {
  tnved_codes: {
    table: "tnved_codes",
    uniqueField: "code",
    requiredFields: ["code"],
    templateUrl: "https://storage.googleapis.com/shared-parts-bucket/templates/tnved_codes_template.xlsx",

    // 👇 Связь между заголовками в Excel и полями в базе
    headerMap: {
      "Код": "code",
      "Описание": "description",
      "Ставка пошлины (%)": "duty_rate",
      "Примечания": "notes"
    },

    // 👇 Преобразование уже по техническим названиям (после маппинга на фронте)
    transform: (row) => ({
      code: String(row["code"] || "").trim(),
      description: row["description"]?.trim() || null,
      duty_rate: row["duty_rate"] || null,
      notes: row["notes"]?.trim() || null
    })
  }

  // сюда добавишь другие таблицы
}
