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
  const fasteners = await createClass({
    code: "fasteners",
    name: "Крепеж",
    description: "Группа типовых крепежных изделий: болты, гайки, шайбы и сопутствующие позиции.",
    sortOrder: 10,
  })

  const bolts = await createClass({
    parentId: fasteners.id,
    code: "bolts",
    name: "Болты",
    description: "Болты и винты общего применения.",
    sortOrder: 10,
  })

  const nuts = await createClass({
    parentId: fasteners.id,
    code: "nuts",
    name: "Гайки",
    description: "Шестигранные и специальные гайки.",
    sortOrder: 20,
  })

  const washers = await createClass({
    parentId: fasteners.id,
    code: "washers",
    name: "Шайбы",
    description: "Плоские, пружинные и специальные шайбы.",
    sortOrder: 30,
  })

  const boltStrength = await createField(bolts.id, {
    code: "strength_class",
    label: "Класс прочности",
    field_type: "select",
    sort_order: 30,
    is_in_title: true,
    is_in_list: true,
    is_in_filters: true,
    is_searchable: true,
  })

  await createField(bolts.id, {
    code: "thread_size",
    label: "Размер резьбы",
    field_type: "text",
    sort_order: 10,
    is_required: true,
    is_in_title: true,
    is_in_list: true,
    is_in_filters: true,
    is_searchable: true,
    placeholder: "Например: M8",
    help_text: "Указывайте типоразмер резьбы в формате M8, M10, M12.",
  })
  await createField(bolts.id, {
    code: "length_mm",
    label: "Длина",
    field_type: "number",
    sort_order: 20,
    is_required: true,
    is_in_title: true,
    is_in_list: true,
    is_in_filters: true,
    unit: "мм",
    placeholder: "Например: 16",
  })
  await createField(bolts.id, {
    code: "coating",
    label: "Покрытие",
    field_type: "text",
    sort_order: 40,
    is_in_list: true,
    is_in_filters: true,
    is_searchable: true,
  })
  await createField(bolts.id, {
    code: "standard",
    label: "Стандарт",
    field_type: "text",
    sort_order: 50,
    is_in_list: true,
    is_in_filters: true,
    is_searchable: true,
  })

  await createOption(boltStrength.id, { value_code: "5_8", value_label: "5.8", sort_order: 10 })
  await createOption(boltStrength.id, { value_code: "8_8", value_label: "8.8", sort_order: 20 })
  await createOption(boltStrength.id, { value_code: "10_9", value_label: "10.9", sort_order: 30 })
  await createOption(boltStrength.id, { value_code: "a2_70", value_label: "A2-70", sort_order: 40 })

  const nutStrength = await createField(nuts.id, {
    code: "strength_class",
    label: "Класс прочности",
    field_type: "select",
    sort_order: 20,
    is_in_title: true,
    is_in_list: true,
    is_in_filters: true,
    is_searchable: true,
  })

  await createField(nuts.id, {
    code: "thread_size",
    label: "Размер резьбы",
    field_type: "text",
    sort_order: 10,
    is_required: true,
    is_in_title: true,
    is_in_list: true,
    is_in_filters: true,
    is_searchable: true,
    placeholder: "Например: M8",
  })
  await createField(nuts.id, {
    code: "standard",
    label: "Стандарт",
    field_type: "text",
    sort_order: 30,
    is_in_list: true,
    is_in_filters: true,
    is_searchable: true,
  })
  await createField(nuts.id, {
    code: "coating",
    label: "Покрытие",
    field_type: "text",
    sort_order: 40,
    is_in_list: true,
    is_in_filters: true,
    is_searchable: true,
  })

  await createOption(nutStrength.id, { value_code: "5", value_label: "5", sort_order: 10 })
  await createOption(nutStrength.id, { value_code: "8", value_label: "8", sort_order: 20 })
  await createOption(nutStrength.id, { value_code: "10", value_label: "10", sort_order: 30 })

  await createField(washers.id, {
    code: "inner_diameter_mm",
    label: "Внутренний диаметр",
    field_type: "number",
    sort_order: 10,
    is_required: true,
    is_in_title: true,
    is_in_list: true,
    is_in_filters: true,
    unit: "мм",
  })
  await createField(washers.id, {
    code: "outer_diameter_mm",
    label: "Наружный диаметр",
    field_type: "number",
    sort_order: 20,
    is_in_title: true,
    is_in_list: true,
    is_in_filters: true,
    unit: "мм",
  })
  await createField(washers.id, {
    code: "thickness_mm",
    label: "Толщина",
    field_type: "number",
    sort_order: 30,
    is_in_list: true,
    is_in_filters: true,
    unit: "мм",
  })
  await createField(washers.id, {
    code: "standard",
    label: "Стандарт",
    field_type: "text",
    sort_order: 40,
    is_in_list: true,
    is_in_filters: true,
    is_searchable: true,
  })

  console.log(
    JSON.stringify(
      {
        ok: true,
        classes: {
          fasteners: fasteners.id,
          bolts: bolts.id,
          nuts: nuts.id,
          washers: washers.id,
        },
      },
      null,
      2
    )
  )
}

main()
  .catch((err) => {
    console.error("seed-standard-parts-fasteners failed:", err)
    process.exitCode = 1
  })
  .finally(async () => {
    await db.end()
  })
