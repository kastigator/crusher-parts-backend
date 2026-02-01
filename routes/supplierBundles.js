const express = require('express')
const router = express.Router()

const db = require('../utils/db')
const logActivity = require('../utils/logActivity')

const toId = (v) => {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}
const nz = (v) =>
  v === undefined || v === null ? null : ('' + v).trim() || null
const toQty = (v, def = 1) => {
  if (v === '' || v === undefined || v === null) return def
  const n = Number(String(v).replace(',', '.'))
  return Number.isFinite(n) && n > 0 ? n : def
}

async function originalExists(id) {
  const [[row]] = await db.execute('SELECT id FROM original_parts WHERE id=?', [id])
  return !!row
}
async function bundleExists(id) {
  const [[row]] = await db.execute('SELECT id FROM supplier_bundles WHERE id=?', [id])
  return !!row
}
async function itemExists(id) {
  const [[row]] = await db.execute('SELECT id FROM supplier_bundle_items WHERE id=?', [id])
  return !!row
}

const latestPriceJoin = `
  LEFT JOIN (
    SELECT spp1.*
    FROM supplier_part_prices spp1
    JOIN (
      SELECT supplier_part_id, MAX(id) AS max_id
      FROM supplier_part_prices
      GROUP BY supplier_part_id
    ) latest
      ON latest.supplier_part_id = spp1.supplier_part_id
     AND latest.max_id = spp1.id
  ) spp ON spp.supplier_part_id = sp.id
`

const fetchBundleOptions = async ({ bundleId, itemId }) => {
  if (!bundleId && !itemId) return []
  const where = []
  const params = []
  if (bundleId) {
    where.push('i.bundle_id = ?')
    params.push(bundleId)
  }
  if (itemId) {
    where.push('i.id = ?')
    params.push(itemId)
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

  const [rows] = await db.execute(
    `
      SELECT
        l.id AS link_id,
        l.item_id,
        i.bundle_id,
        i.role_label,
        i.qty,
        l.supplier_part_id,
        l.is_default,
        l.note,
        l.default_one,
        sp.supplier_id,
        sp.supplier_part_number,
        sp.description_ru,
        sp.description_en,
        COALESCE(sp.description_ru, sp.description_en) AS description,
        COALESCE(sp.description_ru, sp.description_en) AS supplier_part_description,
        ps.name AS supplier_name,
        ps.public_code AS supplier_public_code,
        spp.price AS last_price,
        spp.currency AS last_currency,
        spp.date AS last_price_date
      FROM supplier_bundle_item_links l
      JOIN supplier_bundle_items i ON i.id = l.item_id
      JOIN supplier_parts sp ON sp.id = l.supplier_part_id
      LEFT JOIN part_suppliers ps ON ps.id = sp.supplier_id
      ${latestPriceJoin}
      ${whereSql}
      ORDER BY l.is_default DESC, l.id ASC
    `,
    params
  )

  return rows
}

const computeTotals = (options = []) => {
  const totals = new Map()
  for (const opt of options) {
    if (!opt?.is_default) continue
    const price = Number(opt.last_price)
    if (!Number.isFinite(price)) continue
    const currency = String(opt.last_currency || '').trim().toUpperCase()
    if (!currency) continue
    const qty = Number(opt.qty) > 0 ? Number(opt.qty) : 1
    const prev = totals.get(currency) || 0
    totals.set(currency, prev + price * qty)
  }
  return Array.from(totals.entries()).map(([currency_iso3, total_price]) => ({
    currency_iso3,
    total_price: Number(total_price.toFixed(2)),
  }))
}

const insertBundleItem = async ({ bundleId, role_label, qty, sort_order }) => {
  const [ins] = await db.execute(
    'INSERT INTO supplier_bundle_items (bundle_id, role_label, qty, sort_order) VALUES (?,?,?,?)',
    [bundleId, role_label, qty, sort_order]
  )
  return ins.insertId
}

const insertBundleLink = async ({ item_id, supplier_part_id, is_default, note, default_one }) => {
  if (is_default) {
    await db.execute(
      'UPDATE supplier_bundle_item_links SET is_default=0 WHERE item_id=?',
      [item_id]
    )
  }

  const [ins] = await db.execute(
    'INSERT INTO supplier_bundle_item_links (item_id, supplier_part_id, is_default, note, default_one) VALUES (?,?,?,?,?)',
    [item_id, supplier_part_id, is_default, note, default_one]
  )
  return ins.insertId
}

router.get('/', async (req, res) => {
  try {
    const original_part_id = toId(req.query.original_part_id)
    if (!original_part_id) {
      return res.status(400).json({ message: 'original_part_id обязателен' })
    }

    const [rows] = await db.execute(
      `SELECT b.id, b.original_part_id, b.title, b.note,
              COUNT(i.id) AS items_count
         FROM supplier_bundles b
         LEFT JOIN supplier_bundle_items i ON i.bundle_id = b.id
        WHERE b.original_part_id = ?
        GROUP BY b.id
        ORDER BY b.id DESC`,
      [original_part_id]
    )
    res.json(rows)
  } catch (e) {
    console.error('GET /supplier-bundles error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.get('/:id/items', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный id' })
    if (!(await bundleExists(id))) return res.status(404).json({ message: 'Комплект не найден' })

    const [items] = await db.execute(
      `SELECT id, bundle_id, role_label, qty, sort_order
         FROM supplier_bundle_items
        WHERE bundle_id = ?
        ORDER BY sort_order, id`,
      [id]
    )

    const itemIds = items.map((i) => i.id)
    let links = []
    if (itemIds.length) {
      const [rows] = await db.execute(
        `SELECT l.id, l.item_id, l.supplier_part_id, l.is_default, l.note, l.default_one,
                sp.supplier_part_number,
                ps.name AS supplier_name
           FROM supplier_bundle_item_links l
           JOIN supplier_parts sp ON sp.id = l.supplier_part_id
           JOIN part_suppliers ps ON ps.id = sp.supplier_id
          WHERE l.item_id IN (${itemIds.map(() => '?').join(',')})
          ORDER BY l.item_id, l.id`,
        itemIds
      )
      links = rows
    }

    const linksByItem = links.reduce((acc, row) => {
      if (!acc[row.item_id]) acc[row.item_id] = []
      acc[row.item_id].push(row)
      return acc
    }, {})

    const payload = items.map((item) => ({
      ...item,
      links: linksByItem[item.id] || [],
    }))

    res.json(payload)
  } catch (e) {
    console.error('GET /supplier-bundles/:id/items error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})
router.get('/:id/options', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный id' })
    if (!(await bundleExists(id))) return res.status(404).json({ message: 'Комплект не найден' })

    const rows = await fetchBundleOptions({ bundleId: id })
    res.json(rows)
  } catch (e) {
    console.error('GET /supplier-bundles/:id/options error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.get('/:id/totals', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный id' })
    if (!(await bundleExists(id))) return res.status(404).json({ message: 'Комплект не найден' })

    const options = await fetchBundleOptions({ bundleId: id })
    res.json(computeTotals(options))
  } catch (e) {
    console.error('GET /supplier-bundles/:id/totals error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.get('/:id/summary', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный id' })

    const [[bundle]] = await db.execute(
      'SELECT id, original_part_id, title, note FROM supplier_bundles WHERE id=?',
      [id]
    )
    if (!bundle) return res.status(404).json({ message: 'Комплект не найден' })

    const options = await fetchBundleOptions({ bundleId: id })
    const totals = computeTotals(options)

    res.json({ ...bundle, options, totals })
  } catch (e) {
    console.error('GET /supplier-bundles/:id/summary error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})



router.post('/', async (req, res) => {
  try {
    const original_part_id = toId(req.body.original_part_id)
    const title = nz(req.body.title)
    const note = nz(req.body.note)

    if (!original_part_id) {
      return res.status(400).json({ message: 'original_part_id обязателен' })
    }
    if (!(await originalExists(original_part_id))) {
      return res.status(404).json({ message: 'Оригинальная деталь не найдена' })
    }

    const safeTitle = title || `Комплект для OP#${original_part_id}`
    const name = safeTitle

    const [ins] = await db.execute(
      'INSERT INTO supplier_bundles (original_part_id, title, note, name) VALUES (?,?,?,?)',
      [original_part_id, safeTitle, note, name]
    )

    await logActivity({
      req,
      action: 'create',
      entity_type: 'supplier_bundles',
      entity_id: ins.insertId,
      comment: `Создан комплект для original_part_id=${original_part_id}`,
    })

    res.status(201).json({ id: ins.insertId })
  } catch (e) {
    console.error('POST /supplier-bundles error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.put('/:id', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный id' })

    const title = nz(req.body.title)
    const note = nz(req.body.note)

    const [upd] = await db.execute(
      'UPDATE supplier_bundles SET title=COALESCE(?, title), note=COALESCE(?, note), name=COALESCE(?, name) WHERE id=?',
      [title, note, title, id]
    )
    if (!upd.affectedRows) return res.status(404).json({ message: 'Комплект не найден' })

    await logActivity({
      req,
      action: 'update',
      entity_type: 'supplier_bundles',
      entity_id: id,
      comment: 'Обновление комплекта',
    })

    res.json({ message: 'Обновлено' })
  } catch (e) {
    console.error('PUT /supplier-bundles/:id error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.delete('/:id', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный id' })

    const [del] = await db.execute('DELETE FROM supplier_bundles WHERE id=?', [id])
    if (!del.affectedRows) return res.status(404).json({ message: 'Комплект не найден' })

    await logActivity({
      req,
      action: 'delete',
      entity_type: 'supplier_bundles',
      entity_id: id,
      comment: 'Удалён комплект',
    })

    res.json({ message: 'Удалено' })
  } catch (e) {
    console.error('DELETE /supplier-bundles/:id error:', e)
    // MySQL FK constraint: bundle is referenced from RFQ/selection tables
    if (e?.code === 'ER_ROW_IS_REFERENCED_2' || e?.errno === 1451) {
      return res.status(409).json({
        message: 'Нельзя удалить: комплект используется в заявках/ответах. Удалите/замените использование или архивируйте комплект.',
      })
    }
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.post('/:id/items', async (req, res) => {
  try {
    const bundle_id = toId(req.params.id)
    if (!bundle_id) return res.status(400).json({ message: 'Некорректный id' })
    if (!(await bundleExists(bundle_id))) return res.status(404).json({ message: 'Комплект не найден' })

    const role_label = nz(req.body.role_label)
    const qty = toQty(req.body.qty, 1)
    const sort_order = toId(req.body.sort_order) || 0

    if (!role_label) return res.status(400).json({ message: 'role_label обязателен' })

    const id = await insertBundleItem({ bundleId: bundle_id, role_label, qty, sort_order })
    res.status(201).json({ id })
  } catch (e) {
    console.error('POST /supplier-bundles/:id/items error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.post('/items', async (req, res) => {
  try {
    const bundle_id = toId(req.body.bundle_id)
    if (!bundle_id) return res.status(400).json({ message: 'bundle_id обязателен' })
    if (!(await bundleExists(bundle_id))) return res.status(404).json({ message: 'Комплект не найден' })

    const role_label = nz(req.body.role_label)
    const qty = toQty(req.body.qty, 1)
    const sort_order = toId(req.body.sort_order) || 0

    if (!role_label) return res.status(400).json({ message: 'role_label обязателен' })

    const id = await insertBundleItem({ bundleId: bundle_id, role_label, qty, sort_order })
    res.status(201).json({ id })
  } catch (e) {
    console.error('POST /supplier-bundles/items error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.put('/items/:item_id', async (req, res) => {
  try {
    const item_id = toId(req.params.item_id)
    if (!item_id) return res.status(400).json({ message: 'Некорректный id' })
    if (!(await itemExists(item_id))) return res.status(404).json({ message: 'Элемент не найден' })

    const fields = []
    const params = []

    if (req.body.qty !== undefined) {
      const qty = toQty(req.body.qty, 1)
      fields.push('qty=?')
      params.push(qty)
    }
    if (req.body.role_label !== undefined) {
      const role_label = nz(req.body.role_label)
      fields.push('role_label=?')
      params.push(role_label)
    }
    if (req.body.sort_order !== undefined) {
      const sort_order = toId(req.body.sort_order) || 0
      fields.push('sort_order=?')
      params.push(sort_order)
    }

    if (!fields.length) {
      return res.status(400).json({ message: 'Нет данных для обновления' })
    }

    params.push(item_id)
    await db.execute(
      `UPDATE supplier_bundle_items SET ${fields.join(', ')} WHERE id=?`,
      params
    )

    res.json({ message: 'Обновлено' })
  } catch (e) {
    console.error('PUT /supplier-bundles/items/:item_id error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.delete('/items/:item_id', async (req, res) => {
  try {
    const item_id = toId(req.params.item_id)
    if (!item_id) return res.status(400).json({ message: 'Некорректный id' })

    const [del] = await db.execute('DELETE FROM supplier_bundle_items WHERE id=?', [item_id])
    if (!del.affectedRows) return res.status(404).json({ message: 'Элемент не найден' })

    res.json({ message: 'Удалено' })
  } catch (e) {
    console.error('DELETE /supplier-bundles/items/:item_id error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.post('/items/:item_id/links', async (req, res) => {
  try {
    const item_id = toId(req.params.item_id)
    if (!item_id) return res.status(400).json({ message: 'Некорректный id' })
    if (!(await itemExists(item_id))) return res.status(404).json({ message: 'Элемент не найден' })

    const supplier_part_id = toId(req.body.supplier_part_id)
    if (!supplier_part_id) return res.status(400).json({ message: 'supplier_part_id обязателен' })

    const is_default = req.body.is_default ? 1 : 0
    const note = nz(req.body.note)
    const default_one = req.body.default_one ? 1 : 0

    const id = await insertBundleLink({ item_id, supplier_part_id, is_default, note, default_one })
    res.status(201).json({ id })
  } catch (e) {
    console.error('POST /supplier-bundles/items/:item_id/links error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.post('/links', async (req, res) => {
  try {
    const item_id = toId(req.body.item_id)
    if (!item_id) return res.status(400).json({ message: 'item_id обязателен' })
    if (!(await itemExists(item_id))) return res.status(404).json({ message: 'Элемент не найден' })

    const supplier_part_id = toId(req.body.supplier_part_id)
    if (!supplier_part_id) return res.status(400).json({ message: 'supplier_part_id обязателен' })

    const is_default = req.body.is_default ? 1 : 0
    const note = nz(req.body.note)
    const default_one = req.body.default_one ? 1 : 0

    const id = await insertBundleLink({ item_id, supplier_part_id, is_default, note, default_one })
    res.status(201).json({ id })
  } catch (e) {
    console.error('POST /supplier-bundles/links error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.put('/links/:id', async (req, res) => {
  try {
    const linkId = toId(req.params.id)
    if (!linkId) return res.status(400).json({ message: 'Некорректный id' })

    const [[link]] = await db.execute(
      'SELECT id, item_id FROM supplier_bundle_item_links WHERE id=?',
      [linkId]
    )
    if (!link) return res.status(404).json({ message: 'Связь не найдена' })

    const conn = await db.getConnection()
    try {
      await conn.beginTransaction()
      await conn.execute(
        'UPDATE supplier_bundle_item_links SET is_default=0 WHERE item_id=?',
        [link.item_id]
      )
      await conn.execute(
        'UPDATE supplier_bundle_item_links SET is_default=1 WHERE id=?',
        [linkId]
      )
      await conn.commit()
    } catch (err) {
      await conn.rollback()
      throw err
    } finally {
      conn.release()
    }

    const options = await fetchBundleOptions({ itemId: link.item_id })
    res.json({ item_id: link.item_id, options })
  } catch (e) {
    console.error('PUT /supplier-bundles/links/:id error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.delete('/links/:id', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный id' })

    const [del] = await db.execute('DELETE FROM supplier_bundle_item_links WHERE id=?', [id])
    if (!del.affectedRows) return res.status(404).json({ message: 'Связь не найдена' })

    res.json({ message: 'Удалено' })
  } catch (e) {
    console.error('DELETE /supplier-bundles/links/:id error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.delete('/item-links/:id', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный id' })

    const [del] = await db.execute('DELETE FROM supplier_bundle_item_links WHERE id=?', [id])
    if (!del.affectedRows) return res.status(404).json({ message: 'Связь не найдена' })

    res.json({ message: 'Удалено' })
  } catch (e) {
    console.error('DELETE /supplier-bundles/item-links/:id error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

module.exports = router
