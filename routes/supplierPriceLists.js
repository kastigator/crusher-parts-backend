const express = require('express')
const multer = require('multer')
const XLSX = require('xlsx')
const db = require('../utils/db')

const router = express.Router()
const upload = multer({ storage: multer.memoryStorage() })

const toId = (v) => {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}

const nz = (v) => {
  if (v === undefined || v === null) return null
  const s = String(v).trim()
  return s === '' ? null : s
}

const numOrNull = (v) => {
  if (v === undefined || v === null || v === '') return null
  const n = Number(String(v).replace(',', '.'))
  return Number.isFinite(n) ? n : null
}

const intOrNull = (v) => {
  if (v === undefined || v === null || v === '') return null
  const n = Number(String(v).replace(',', '.'))
  return Number.isInteger(n) ? n : null
}

const parseDateOnly = (v) => {
  if (v === undefined || v === null || v === '') return null
  if (typeof v === 'string') {
    const s = v.trim()
    if (!s) return null
    const ru = s.match(/^(\d{2})\.(\d{2})\.(\d{4})$/)
    if (ru) return `${ru[3]}-${ru[2]}-${ru[1]}`
  }
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return null
  const iso = d.toISOString()
  return iso.slice(0, 10)
}

const normCurrency = (v) => {
  const s = nz(v)
  return s ? s.toUpperCase().slice(0, 3) : null
}

const normOfferType = (v) => {
  const s = nz(v)
  if (!s) return 'UNKNOWN'
  const up = s.toUpperCase()
  if (up === 'OEM' || up === 'ANALOG' || up === 'UNKNOWN') return up
  return 'UNKNOWN'
}

const canonicalPartNumber = (v) => {
  const s = nz(v)
  if (!s) return null
  return s
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/[-_./\\]/g, '')
}

const normalizeHeader = (v) => {
  const s = nz(v)
  if (!s) return ''
  return s
    .toLowerCase()
    .replace(/[№#]/g, 'number')
    .replace(/\s+/g, '')
    .replace(/[^a-zа-я0-9_]/gi, '')
}

const extractByAliases = (normalizedRow, aliases) => {
  for (const key of aliases) {
    if (normalizedRow[key] !== undefined && normalizedRow[key] !== null && normalizedRow[key] !== '') {
      return normalizedRow[key]
    }
  }
  return null
}

const buildNormalizedRow = (row) => {
  const out = {}
  Object.entries(row || {}).forEach(([k, v]) => {
    const nk = normalizeHeader(k)
    if (!nk) return
    out[nk] = v
  })
  return out
}

const headerAliases = {
  supplier_part_number_raw: [
    'номерупоставщика',
    'номеркаталожный',
    'номердетали',
    'катномер',
    'катномерпоставщика',
    'supplier_part_number',
    'supplierpartnumber',
    'supplierpn',
    'partnumber',
    'number',
    'pn',
  ],
  description_raw: ['описание', 'description', 'descriptionru', 'descriptionen'],
  material_code_raw: ['кодматериала', 'материал', 'material', 'materialcode'],
  price: ['price', 'цена', 'стоимость'],
  currency: ['currency', 'валюта', 'iso3'],
  offer_type: ['типпредложения', 'тип', 'offertype'],
  lead_time_days: ['срокпоставкидн', 'срокдн', 'срок', 'leadtime', 'leadtimedays'],
  min_order_qty: ['минимальнаяпартия', 'минимальныйзаказ', 'минзаказ', 'moq', 'minorderqty'],
  packaging: ['pack', 'packaging', 'упаковка'],
  validity_days: ['срокдействиядн', 'validity', 'validitydays'],
  valid_from: ['действуетс', 'датаначала', 'validfrom'],
  valid_to: ['действуетдо', 'датаокончания', 'validto'],
  comment: ['comment', 'комментарий', 'note'],
}

const fetchPartMaps = async (conn, supplierId) => {
  const [parts] = await conn.execute(
    `SELECT id, supplier_part_number, canonical_part_number
       FROM supplier_parts
      WHERE supplier_id = ?`,
    [supplierId]
  )
  const partMap = new Map()
  parts.forEach((p) => {
    const key = canonicalPartNumber(p.canonical_part_number || p.supplier_part_number)
    if (!key) return
    const list = partMap.get(key) || []
    list.push(p.id)
    partMap.set(key, list)
  })

  let aliasMap = new Map()
  try {
    const [aliases] = await conn.execute(
      `SELECT alias_canonical_part_number, supplier_part_id
         FROM supplier_part_aliases
        WHERE supplier_id = ? AND is_active = 1`,
      [supplierId]
    )
    aliases.forEach((a) => {
      const key = canonicalPartNumber(a.alias_canonical_part_number)
      if (!key) return
      const list = aliasMap.get(key) || []
      list.push(a.supplier_part_id)
      aliasMap.set(key, list)
    })
  } catch (_e) {
    aliasMap = new Map()
  }

  const [materials] = await conn.execute(
    `SELECT id, code
       FROM materials
      WHERE code IS NOT NULL AND code <> ''`
  )
  const materialMap = new Map()
  materials.forEach((m) => {
    materialMap.set(String(m.code).trim().toUpperCase(), m.id)
  })

  return { partMap, aliasMap, materialMap }
}

const resolveMatch = ({ canonical, partMap, aliasMap }) => {
  if (!canonical) {
    return { status: 'error', partId: null, method: null, note: 'Пустой номер детали' }
  }
  const exact = partMap.get(canonical) || []
  if (exact.length === 1) {
    return { status: 'matched', partId: exact[0], method: 'exact_canonical', note: null }
  }

  const alias = aliasMap.get(canonical) || []
  const uniq = [...new Set([...exact, ...alias])]
  if (uniq.length === 1) {
    return { status: 'matched', partId: uniq[0], method: 'alias', note: null }
  }
  if (uniq.length > 1) {
    return { status: 'ambiguous', partId: null, method: 'ambiguous', note: 'Найдено несколько кандидатов' }
  }
  return { status: 'new_part_required', partId: null, method: 'none', note: 'Совпадения не найдены' }
}

router.get('/template', async (_req, res) => {
  try {
    const wb = XLSX.utils.book_new()
    const header = [[
      'Номер у поставщика',
      'Описание',
      'Код материала',
      'Цена',
      'Валюта (ISO3)',
      'Тип предложения (OEM/ANALOG)',
      'Срок поставки, дн',
      'MOQ (мин. партия)',
      'Упаковка',
      'Срок действия, дн',
      'Действует с (YYYY-MM-DD или DD.MM.YYYY)',
      'Действует до (YYYY-MM-DD или DD.MM.YYYY)',
      'Комментарий',
    ]]
    const example = [[
      'HT195-27-33111',
      'Mainshaft step',
      '45',
      442.87,
      'USD',
      'ANALOG',
      30,
      1,
      'Box',
      30,
      '2026-02-01',
      '2026-02-28',
      'Example row',
    ]]
    const ws = XLSX.utils.aoa_to_sheet([...header, ...example])
    XLSX.utils.book_append_sheet(wb, ws, 'price_list')
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', 'attachment; filename="price_list_template_ru.xlsx"')
    res.send(buffer)
  } catch (e) {
    console.error('GET /supplier-price-lists/template error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.get('/', async (req, res) => {
  try {
    const supplierId = toId(req.query.supplier_id)
    const params = []
    const where = []
    if (supplierId) {
      where.push('spl.supplier_id = ?')
      params.push(supplierId)
    }
    const [rows] = await db.execute(
      `SELECT spl.*,
              ps.name AS supplier_name,
              COUNT(spll.id) AS lines_count,
              SUM(CASE WHEN spll.line_status = 'matched' THEN 1 ELSE 0 END) AS matched_count,
              SUM(CASE WHEN spll.line_status IN ('error', 'ambiguous', 'new_part_required') THEN 1 ELSE 0 END) AS issues_count
         FROM supplier_price_lists spl
         JOIN part_suppliers ps ON ps.id = spl.supplier_id
         LEFT JOIN supplier_price_list_lines spll ON spll.supplier_price_list_id = spl.id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        GROUP BY spl.id
        ORDER BY spl.created_at DESC, spl.id DESC`,
      params
    )
    res.json(rows)
  } catch (e) {
    console.error('GET /supplier-price-lists error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.post('/', async (req, res) => {
  try {
    const supplierId = toId(req.body.supplier_id)
    if (!supplierId) return res.status(400).json({ message: 'Не выбран поставщик' })
    const listCode = nz(req.body.list_code)
    const listName = nz(req.body.list_name)
    const currencyDefault = normCurrency(req.body.currency_default)
    const validFrom = parseDateOnly(req.body.valid_from)
    const validTo = parseDateOnly(req.body.valid_to)
    const note = nz(req.body.note)
    const uploadedBy = toId(req.user?.id)

    const [ins] = await db.execute(
      `INSERT INTO supplier_price_lists
        (supplier_id, list_code, list_name, status, currency_default, valid_from, valid_to, note, uploaded_by_user_id)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [supplierId, listCode, listName, 'draft', currencyDefault, validFrom, validTo, note, uploadedBy]
    )
    const [[row]] = await db.execute('SELECT * FROM supplier_price_lists WHERE id = ?', [ins.insertId])
    res.status(201).json(row)
  } catch (e) {
    console.error('POST /supplier-price-lists error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.get('/:id', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })
    const [[row]] = await db.execute('SELECT * FROM supplier_price_lists WHERE id = ?', [id])
    if (!row) return res.status(404).json({ message: 'Прайс-лист не найден' })
    res.json(row)
  } catch (e) {
    console.error('GET /supplier-price-lists/:id error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.put('/:id', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })
    const listCode = nz(req.body.list_code)
    const listName = nz(req.body.list_name)
    const currencyDefault = req.body.currency_default !== undefined ? normCurrency(req.body.currency_default) : undefined
    const validFrom = req.body.valid_from !== undefined ? parseDateOnly(req.body.valid_from) : undefined
    const validTo = req.body.valid_to !== undefined ? parseDateOnly(req.body.valid_to) : undefined
    const note = req.body.note !== undefined ? nz(req.body.note) : undefined

    await db.execute(
      `UPDATE supplier_price_lists
          SET list_code = COALESCE(?, list_code),
              list_name = COALESCE(?, list_name),
              currency_default = COALESCE(?, currency_default),
              valid_from = COALESCE(?, valid_from),
              valid_to = COALESCE(?, valid_to),
              note = COALESCE(?, note)
        WHERE id = ?`,
      [listCode, listName, currencyDefault, validFrom, validTo, note, id]
    )
    const [[row]] = await db.execute('SELECT * FROM supplier_price_lists WHERE id = ?', [id])
    if (!row) return res.status(404).json({ message: 'Прайс-лист не найден' })
    res.json(row)
  } catch (e) {
    console.error('PUT /supplier-price-lists/:id error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.delete('/:id', async (req, res) => {
  const conn = await db.getConnection()
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })

    await conn.beginTransaction()
    const [[list]] = await conn.execute('SELECT * FROM supplier_price_lists WHERE id = ? FOR UPDATE', [id])
    if (!list) {
      await conn.rollback()
      return res.status(404).json({ message: 'Прайс-лист не найден' })
    }

    if (list.status === 'active') {
      await conn.rollback()
      return res.status(409).json({ message: 'Нельзя удалить активный прайс-лист. Сначала активируйте другой.' })
    }

    await conn.execute(
      `DELETE spp
         FROM supplier_part_prices spp
         JOIN supplier_price_list_lines spll ON spll.id = spp.source_id
        WHERE spll.supplier_price_list_id = ?
          AND spp.source_type = 'PRICE_LIST'`,
      [id]
    )
    await conn.execute('DELETE FROM supplier_price_lists WHERE id = ?', [id])
    await conn.commit()
    res.json({ success: true })
  } catch (e) {
    try {
      await conn.rollback()
    } catch {}
    console.error('DELETE /supplier-price-lists/:id error:', e)
    res.status(500).json({ message: 'Ошибка удаления прайс-листа' })
  } finally {
    conn.release()
  }
})

router.get('/:id/lines', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })
    const [rows] = await db.execute(
      `SELECT spll.*,
              sp.supplier_part_number,
              m.code AS material_code,
              m.name AS material_name
         FROM supplier_price_list_lines spll
         LEFT JOIN supplier_parts sp ON sp.id = spll.matched_supplier_part_id
         LEFT JOIN materials m ON m.id = spll.matched_material_id
        WHERE spll.supplier_price_list_id = ?
        ORDER BY COALESCE(spll.source_row_no, 999999), spll.id`,
      [id]
    )
    res.json(rows)
  } catch (e) {
    console.error('GET /supplier-price-lists/:id/lines error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.post('/:id/lines', async (req, res) => {
  const conn = await db.getConnection()
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })
    const [[list]] = await conn.execute('SELECT * FROM supplier_price_lists WHERE id = ?', [id])
    if (!list) return res.status(404).json({ message: 'Прайс-лист не найден' })

    const rawPart = nz(req.body.supplier_part_number_raw)
    const canonical = canonicalPartNumber(rawPart)
    const { partMap, aliasMap, materialMap } = await fetchPartMaps(conn, list.supplier_id)
    const matched = resolveMatch({ canonical, partMap, aliasMap })
    const materialCode = nz(req.body.material_code_raw)
    const matchedMaterialId = materialCode ? materialMap.get(materialCode.toUpperCase()) || null : null

    const [ins] = await conn.execute(
      `INSERT INTO supplier_price_list_lines
        (supplier_price_list_id, source_row_no, line_status, supplier_part_number_raw, supplier_part_number_canonical,
         description_raw, material_code_raw, price, currency, offer_type, lead_time_days, min_order_qty, packaging,
         validity_days, valid_from, valid_to, comment, matched_supplier_part_id, matched_material_id,
         match_confidence, match_method, match_note, imported_by_user_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id,
        intOrNull(req.body.source_row_no),
        matched.status,
        rawPart,
        canonical,
        nz(req.body.description_raw),
        materialCode,
        numOrNull(req.body.price),
        normCurrency(req.body.currency),
        normOfferType(req.body.offer_type),
        intOrNull(req.body.lead_time_days),
        intOrNull(req.body.min_order_qty),
        nz(req.body.packaging),
        intOrNull(req.body.validity_days),
        parseDateOnly(req.body.valid_from),
        parseDateOnly(req.body.valid_to),
        nz(req.body.comment),
        matched.partId,
        matchedMaterialId,
        matched.status === 'matched' ? 100 : null,
        matched.method,
        matched.note,
        toId(req.user?.id),
      ]
    )

    const [[row]] = await conn.execute('SELECT * FROM supplier_price_list_lines WHERE id = ?', [ins.insertId])
    res.status(201).json(row)
  } catch (e) {
    console.error('POST /supplier-price-lists/:id/lines error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  } finally {
    conn.release()
  }
})

router.put('/lines/:lineId', async (req, res) => {
  try {
    const lineId = toId(req.params.lineId)
    if (!lineId) return res.status(400).json({ message: 'Некорректный идентификатор' })
    const [[line]] = await db.execute(
      `SELECT spll.*, spl.supplier_id
         FROM supplier_price_list_lines spll
         JOIN supplier_price_lists spl ON spl.id = spll.supplier_price_list_id
        WHERE spll.id = ?`,
      [lineId]
    )
    if (!line) return res.status(404).json({ message: 'Строка не найдена' })

    const partRaw = req.body.supplier_part_number_raw !== undefined ? nz(req.body.supplier_part_number_raw) : line.supplier_part_number_raw
    const canonical = canonicalPartNumber(partRaw)
    const conn = await db.getConnection()
    try {
      const { partMap, aliasMap, materialMap } = await fetchPartMaps(conn, line.supplier_id)
      const matched = resolveMatch({ canonical, partMap, aliasMap })
      const materialCode = req.body.material_code_raw !== undefined ? nz(req.body.material_code_raw) : line.material_code_raw
      const matchedMaterialId = materialCode ? materialMap.get(String(materialCode).toUpperCase()) || null : null

      await conn.execute(
        `UPDATE supplier_price_list_lines
            SET source_row_no = COALESCE(?, source_row_no),
                line_status = ?,
                supplier_part_number_raw = ?,
                supplier_part_number_canonical = ?,
                description_raw = COALESCE(?, description_raw),
                material_code_raw = ?,
                price = COALESCE(?, price),
                currency = COALESCE(?, currency),
                offer_type = COALESCE(?, offer_type),
                lead_time_days = COALESCE(?, lead_time_days),
                min_order_qty = COALESCE(?, min_order_qty),
                packaging = COALESCE(?, packaging),
                validity_days = COALESCE(?, validity_days),
                valid_from = COALESCE(?, valid_from),
                valid_to = COALESCE(?, valid_to),
                comment = COALESCE(?, comment),
                matched_supplier_part_id = ?,
                matched_material_id = ?,
                match_confidence = ?,
                match_method = ?,
                match_note = ?
          WHERE id = ?`,
        [
          req.body.source_row_no !== undefined ? intOrNull(req.body.source_row_no) : null,
          matched.status,
          partRaw,
          canonical,
          req.body.description_raw !== undefined ? nz(req.body.description_raw) : null,
          materialCode,
          req.body.price !== undefined ? numOrNull(req.body.price) : null,
          req.body.currency !== undefined ? normCurrency(req.body.currency) : null,
          req.body.offer_type !== undefined ? normOfferType(req.body.offer_type) : null,
          req.body.lead_time_days !== undefined ? intOrNull(req.body.lead_time_days) : null,
          req.body.min_order_qty !== undefined ? intOrNull(req.body.min_order_qty) : null,
          req.body.packaging !== undefined ? nz(req.body.packaging) : null,
          req.body.validity_days !== undefined ? intOrNull(req.body.validity_days) : null,
          req.body.valid_from !== undefined ? parseDateOnly(req.body.valid_from) : null,
          req.body.valid_to !== undefined ? parseDateOnly(req.body.valid_to) : null,
          req.body.comment !== undefined ? nz(req.body.comment) : null,
          matched.partId,
          matchedMaterialId,
          matched.status === 'matched' ? 100 : null,
          matched.method,
          matched.note,
          lineId,
        ]
      )
    } finally {
      conn.release()
    }

    const [[row]] = await db.execute('SELECT * FROM supplier_price_list_lines WHERE id = ?', [lineId])
    res.json(row)
  } catch (e) {
    console.error('PUT /supplier-price-lists/lines/:lineId error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.delete('/lines/:lineId', async (req, res) => {
  try {
    const lineId = toId(req.params.lineId)
    if (!lineId) return res.status(400).json({ message: 'Некорректный идентификатор' })
    await db.execute('DELETE FROM supplier_price_list_lines WHERE id = ?', [lineId])
    res.json({ success: true })
  } catch (e) {
    console.error('DELETE /supplier-price-lists/lines/:lineId error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.post('/:id/import', upload.single('file'), async (req, res) => {
  const conn = await db.getConnection()
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })
    const replace = req.body?.replace !== 'false'
    if (!req.file?.buffer) return res.status(400).json({ message: 'Файл обязателен' })

    const [[list]] = await conn.execute('SELECT * FROM supplier_price_lists WHERE id = ?', [id])
    if (!list) return res.status(404).json({ message: 'Прайс-лист не найден' })

    const wb = XLSX.read(req.file.buffer, { type: 'buffer' })
    const sheet = wb.Sheets[wb.SheetNames[0]]
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: null, raw: false })
    if (!Array.isArray(rows) || !rows.length) {
      return res.status(400).json({ message: 'Файл не содержит строк' })
    }

    const { partMap, aliasMap, materialMap } = await fetchPartMaps(conn, list.supplier_id)
    const userId = toId(req.user?.id)

    await conn.beginTransaction()
    if (replace) {
      await conn.execute('DELETE FROM supplier_price_list_lines WHERE supplier_price_list_id = ?', [id])
    }

    let inserted = 0
    let matchedCount = 0
    let issuesCount = 0
    for (let i = 0; i < rows.length; i += 1) {
      const normalized = buildNormalizedRow(rows[i])
      const rawPart = nz(extractByAliases(normalized, headerAliases.supplier_part_number_raw))
      const canonical = canonicalPartNumber(rawPart)
      const price = numOrNull(extractByAliases(normalized, headerAliases.price))
      const currency = normCurrency(extractByAliases(normalized, headerAliases.currency))

      let status = 'pending'
      let partId = null
      let method = null
      let matchNote = null

      if (!rawPart && price === null && !currency) {
        status = 'ignored'
      } else {
        const matched = resolveMatch({ canonical, partMap, aliasMap })
        status = matched.status
        partId = matched.partId
        method = matched.method
        matchNote = matched.note
      }

      const materialCode = nz(extractByAliases(normalized, headerAliases.material_code_raw))
      const matchedMaterialId = materialCode ? materialMap.get(materialCode.toUpperCase()) || null : null
      const offerType = normOfferType(extractByAliases(normalized, headerAliases.offer_type))

      await conn.execute(
        `INSERT INTO supplier_price_list_lines
          (supplier_price_list_id, source_row_no, line_status, supplier_part_number_raw, supplier_part_number_canonical,
           description_raw, material_code_raw, price, currency, offer_type, lead_time_days, min_order_qty, packaging,
           validity_days, valid_from, valid_to, comment, matched_supplier_part_id, matched_material_id,
           match_confidence, match_method, match_note, source_row_hash, imported_by_user_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          id,
          i + 2,
          status,
          rawPart,
          canonical,
          nz(extractByAliases(normalized, headerAliases.description_raw)),
          materialCode,
          price,
          currency,
          offerType,
          intOrNull(extractByAliases(normalized, headerAliases.lead_time_days)),
          intOrNull(extractByAliases(normalized, headerAliases.min_order_qty)),
          nz(extractByAliases(normalized, headerAliases.packaging)),
          intOrNull(extractByAliases(normalized, headerAliases.validity_days)),
          parseDateOnly(extractByAliases(normalized, headerAliases.valid_from)),
          parseDateOnly(extractByAliases(normalized, headerAliases.valid_to)),
          nz(extractByAliases(normalized, headerAliases.comment)),
          partId,
          matchedMaterialId,
          status === 'matched' ? 100 : null,
          method,
          matchNote,
          null,
          userId,
        ]
      )

      inserted += 1
      if (status === 'matched') matchedCount += 1
      if (status === 'error' || status === 'ambiguous' || status === 'new_part_required') issuesCount += 1
    }

    await conn.execute(
      `UPDATE supplier_price_lists
          SET source_file_name = COALESCE(?, source_file_name),
              uploaded_by_user_id = ?,
              updated_at = NOW()
        WHERE id = ?`,
      [req.file.originalname || null, userId, id]
    )

    await conn.commit()
    res.json({ success: true, inserted, matched: matchedCount, issues: issuesCount })
  } catch (e) {
    try {
      await conn.rollback()
    } catch {}
    console.error('POST /supplier-price-lists/:id/import error:', e)
    res.status(500).json({ message: 'Ошибка импорта прайс-листа' })
  } finally {
    conn.release()
  }
})

router.post('/:id/fill-from-catalog', async (req, res) => {
  const conn = await db.getConnection()
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const onlyWithoutActualPrice = req.body?.only_without_actual_price === true || req.body?.only_without_actual_price === 'true'
    const userId = toId(req.user?.id)

    const [[list]] = await conn.execute('SELECT * FROM supplier_price_lists WHERE id = ?', [id])
    if (!list) return res.status(404).json({ message: 'Прайс-лист не найден' })

    const wherePrice = onlyWithoutActualPrice
      ? `AND (
            lp.id IS NULL
            OR (
              lp.validity_days IS NOT NULL
              AND lp.validity_days > 0
              AND DATE_ADD(DATE(lp.date), INTERVAL lp.validity_days DAY) < CURDATE()
            )
          )`
      : ''

    await conn.beginTransaction()
    const [ins] = await conn.execute(
      `
      INSERT INTO supplier_price_list_lines
        (supplier_price_list_id, source_row_no, line_status, supplier_part_number_raw, supplier_part_number_canonical,
         description_raw, material_code_raw, price, currency, offer_type, lead_time_days, min_order_qty, packaging,
         validity_days, valid_from, valid_to, comment, matched_supplier_part_id, matched_material_id,
         match_confidence, match_method, match_note, imported_by_user_id)
      SELECT
        ? AS supplier_price_list_id,
        NULL AS source_row_no,
        'matched' AS line_status,
        sp.supplier_part_number AS supplier_part_number_raw,
        COALESCE(
          sp.canonical_part_number,
          REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(UPPER(sp.supplier_part_number), ' ', ''), '-', ''), '_', ''), '.', ''), '/', ''), '\\\\', '')
        ) AS supplier_part_number_canonical,
        COALESCE(NULLIF(sp.description_ru, ''), NULLIF(sp.description_en, '')) AS description_raw,
        m.code AS material_code_raw,
        NULL AS price,
        ? AS currency,
        COALESCE(NULLIF(sp.part_type, ''), 'UNKNOWN') AS offer_type,
        sp.lead_time_days AS lead_time_days,
        sp.min_order_qty AS min_order_qty,
        sp.packaging AS packaging,
        NULL AS validity_days,
        ? AS valid_from,
        ? AS valid_to,
        NULL AS comment,
        sp.id AS matched_supplier_part_id,
        sp.default_material_id AS matched_material_id,
        100 AS match_confidence,
        'catalog_seed' AS match_method,
        'Добавлено из каталога поставщика' AS match_note,
        ? AS imported_by_user_id
      FROM supplier_parts sp
      LEFT JOIN materials m ON m.id = sp.default_material_id
      LEFT JOIN supplier_price_list_lines existing
        ON existing.supplier_price_list_id = ?
       AND existing.matched_supplier_part_id = sp.id
      LEFT JOIN (
        SELECT spp1.*
          FROM supplier_part_prices spp1
          JOIN (
            SELECT supplier_part_id, MAX(id) AS max_id
              FROM supplier_part_prices
             GROUP BY supplier_part_id
          ) latest ON latest.max_id = spp1.id
      ) lp ON lp.supplier_part_id = sp.id
      WHERE sp.supplier_id = ?
        AND existing.id IS NULL
        ${wherePrice}
      `,
      [
        id,
        list.currency_default || null,
        list.valid_from || null,
        list.valid_to || null,
        userId,
        id,
        list.supplier_id,
      ]
    )
    await conn.commit()
    res.json({ success: true, inserted: Number(ins.affectedRows || 0) })
  } catch (e) {
    try {
      await conn.rollback()
    } catch {}
    console.error('POST /supplier-price-lists/:id/fill-from-catalog error:', e)
    res.status(500).json({ message: 'Ошибка заполнения из каталога' })
  } finally {
    conn.release()
  }
})

router.post('/:id/activate', async (req, res) => {
  const conn = await db.getConnection()
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })
    const userId = toId(req.user?.id)

    await conn.beginTransaction()
    const [[list]] = await conn.execute('SELECT * FROM supplier_price_lists WHERE id = ? FOR UPDATE', [id])
    if (!list) {
      await conn.rollback()
      return res.status(404).json({ message: 'Прайс-лист не найден' })
    }

    const [[stats]] = await conn.execute(
      `SELECT
          SUM(CASE WHEN line_status = 'matched' THEN 1 ELSE 0 END) AS matched_count,
          SUM(CASE WHEN line_status IN ('error', 'ambiguous', 'new_part_required') THEN 1 ELSE 0 END) AS issues_count
       FROM supplier_price_list_lines
       WHERE supplier_price_list_id = ?`,
      [id]
    )
    if (!stats?.matched_count) {
      await conn.rollback()
      return res.status(409).json({ message: 'Нет сопоставленных строк для активации' })
    }
    if (Number(stats.issues_count || 0) > 0) {
      await conn.rollback()
      return res.status(409).json({ message: 'Исправьте проблемные строки перед активацией' })
    }

    await conn.execute(
      `UPDATE supplier_price_lists
          SET status = 'superseded'
        WHERE supplier_id = ?
          AND status = 'active'
          AND id <> ?`,
      [list.supplier_id, id]
    )

    await conn.execute(
      `UPDATE supplier_price_lists
          SET status = 'active',
              activated_by_user_id = ?,
              activated_at = NOW()
        WHERE id = ?`,
      [userId, id]
    )

    const [lines] = await conn.execute(
      `SELECT *
         FROM supplier_price_list_lines
        WHERE supplier_price_list_id = ?
          AND line_status = 'matched'
          AND matched_supplier_part_id IS NOT NULL
          AND price IS NOT NULL
          AND currency IS NOT NULL`,
      [id]
    )

    let insertedPrices = 0
    for (const line of lines) {
      const dateForPrice = line.valid_from || list.valid_from || new Date()
      await conn.execute(
        `INSERT INTO supplier_part_prices
           (supplier_part_id, material_id, price, currency, date, comment,
            offer_type, lead_time_days, min_order_qty, packaging, validity_days,
            source_type, source_id, created_by_user_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          line.matched_supplier_part_id,
          line.matched_material_id || null,
          line.price,
          line.currency,
          dateForPrice,
          line.comment || list.list_name || list.list_code || null,
          line.offer_type || 'UNKNOWN',
          line.lead_time_days,
          line.min_order_qty,
          line.packaging,
          line.validity_days,
          'PRICE_LIST',
          line.id,
          userId,
        ]
      )
      insertedPrices += 1
    }

    await conn.commit()
    res.json({ success: true, inserted_prices: insertedPrices, matched_lines: lines.length })
  } catch (e) {
    try {
      await conn.rollback()
    } catch {}
    console.error('POST /supplier-price-lists/:id/activate error:', e)
    res.status(500).json({ message: 'Ошибка активации прайс-листа' })
  } finally {
    conn.release()
  }
})

module.exports = router
