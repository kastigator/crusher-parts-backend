const db = require("../utils/db")

async function getClassByCode(code) {
  const [[row]] = await db.execute(
    "SELECT id, code, name, parent_id FROM standard_part_classes WHERE code = ? LIMIT 1",
    [code]
  )
  return row || null
}

async function createClass({ parentId = null, code, name, description = null, sortOrder = 0 }) {
  const existing = await getClassByCode(code)
  if (existing) return existing

  const [result] = await db.execute(
    `
    INSERT INTO standard_part_classes
      (parent_id, code, name, description, sort_order, is_active)
    VALUES (?, ?, ?, ?, ?, 1)
    `,
    [parentId, code, name, description, sortOrder]
  )

  return getClassByCode(code) || { id: result.insertId, code, name, parent_id: parentId }
}

async function getField(classId, code) {
  const [[row]] = await db.execute(
    `
    SELECT id, class_id, code, label, field_type
      FROM standard_part_class_fields
     WHERE class_id = ? AND code = ?
     LIMIT 1
    `,
    [classId, code]
  )
  return row || null
}

async function createField(classId, payload) {
  const existing = await getField(classId, payload.code)
  if (existing) return existing

  const [result] = await db.execute(
    `
    INSERT INTO standard_part_class_fields
      (
        class_id, code, label, field_type, sort_order, is_required, is_active,
        is_in_title, is_in_list, is_in_filters, is_searchable, unit, placeholder, help_text
      )
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      classId,
      payload.code,
      payload.label,
      payload.field_type,
      payload.sort_order || 0,
      payload.is_required ? 1 : 0,
      payload.is_in_title ? 1 : 0,
      payload.is_in_list ? 1 : 0,
      payload.is_in_filters ? 1 : 0,
      payload.is_searchable ? 1 : 0,
      payload.unit || null,
      payload.placeholder || null,
      payload.help_text || null,
    ]
  )

  return getField(classId, payload.code) || { id: result.insertId, class_id: classId, code: payload.code }
}

async function createOption(fieldId, payload) {
  const [[existing]] = await db.execute(
    `
    SELECT id
      FROM standard_part_field_options
     WHERE field_id = ? AND value_code = ?
     LIMIT 1
    `,
    [fieldId, payload.value_code]
  )
  if (existing) return existing

  const [result] = await db.execute(
    `
    INSERT INTO standard_part_field_options
      (field_id, value_code, value_label, sort_order, is_active)
    VALUES (?, ?, ?, ?, 1)
    `,
    [fieldId, payload.value_code, payload.value_label, payload.sort_order || 0]
  )
  return { id: result.insertId }
}

async function main() {
  const electrical = await createClass({
    code: "electrical_equipment",
    name: "Электрооборудование",
    description: "Группа стандартных электротехнических изделий и узлов.",
    sortOrder: 20,
  })

  const motors = await createClass({
    parentId: electrical.id,
    code: "electric_motors",
    name: "Электродвигатели",
    description: "Асинхронные и специальные электродвигатели общего применения.",
    sortOrder: 10,
  })

  await createField(motors.id, {
    code: "power_kw",
    label: "Мощность",
    field_type: "number",
    sort_order: 10,
    is_required: true,
    is_in_title: true,
    is_in_list: true,
    is_in_filters: true,
    unit: "кВт",
    placeholder: "Например: 7.5",
  })

  await createField(motors.id, {
    code: "voltage_v",
    label: "Напряжение",
    field_type: "number",
    sort_order: 20,
    is_required: true,
    is_in_title: true,
    is_in_list: true,
    is_in_filters: true,
    unit: "В",
    placeholder: "Например: 380",
  })

  await createField(motors.id, {
    code: "rpm",
    label: "Обороты",
    field_type: "number",
    sort_order: 30,
    is_required: true,
    is_in_title: true,
    is_in_list: true,
    is_in_filters: true,
    unit: "об/мин",
  })

  const protection = await createField(motors.id, {
    code: "protection_rating",
    label: "Степень защиты",
    field_type: "select",
    sort_order: 40,
    is_in_title: true,
    is_in_list: true,
    is_in_filters: true,
    is_searchable: true,
  })

  await createOption(protection.id, { value_code: "ip55", value_label: "IP55", sort_order: 10 })
  await createOption(protection.id, { value_code: "ip56", value_label: "IP56", sort_order: 20 })
  await createOption(protection.id, { value_code: "ip65", value_label: "IP65", sort_order: 30 })

  const mounting = await createField(motors.id, {
    code: "mounting_type",
    label: "Монтажное исполнение",
    field_type: "select",
    sort_order: 50,
    is_in_title: true,
    is_in_list: true,
    is_in_filters: true,
    is_searchable: true,
  })

  await createOption(mounting.id, { value_code: "b3", value_label: "B3", sort_order: 10 })
  await createOption(mounting.id, { value_code: "b5", value_label: "B5", sort_order: 20 })
  await createOption(mounting.id, { value_code: "b35", value_label: "B35", sort_order: 30 })

  await createField(motors.id, {
    code: "frame_size",
    label: "Типоразмер рамы",
    field_type: "text",
    sort_order: 60,
    is_in_title: true,
    is_in_list: true,
    is_in_filters: true,
    is_searchable: true,
    placeholder: "Например: 132S",
  })

  await createField(motors.id, {
    code: "frequency_hz",
    label: "Частота",
    field_type: "number",
    sort_order: 70,
    is_in_list: true,
    is_in_filters: true,
    unit: "Гц",
  })

  await createField(motors.id, {
    code: "standard",
    label: "Стандарт",
    field_type: "text",
    sort_order: 80,
    is_in_list: true,
    is_in_filters: true,
    is_searchable: true,
    placeholder: "Например: IEC 60034",
  })

  console.log(
    JSON.stringify(
      {
        ok: true,
        classes: {
          electrical_equipment: electrical.id,
          electric_motors: motors.id,
        },
      },
      null,
      2
    )
  )
}

main()
  .catch((err) => {
    console.error("seed-standard-parts-electric-motors failed:", err)
    process.exitCode = 1
  })
  .finally(async () => {
    await db.end()
  })
