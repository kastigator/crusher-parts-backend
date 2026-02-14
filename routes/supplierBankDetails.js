// routes/supplierBankDetails.js
const express = require('express')
const db = require('../utils/db')
const router = express.Router()

const logActivity = require('../utils/logActivity')
const logFieldDiffs = require('../utils/logFieldDiffs')

// helpers
const nz = (v) => (v === '' || v === undefined ? null : v)
const up = (v, n) =>
  (typeof v === 'string' ? v.trim().toUpperCase().slice(0, n || v.length) : v ?? null)
const trimIfStr = (v) => (typeof v === 'string' ? v.trim() : v)

/* ======================
   ETAG (для баннера изменений)
   ====================== */
// ⚠️ этот маршрут должен быть ДО '/:id'
router.get('/etag', async (req, res) => {
  try {
    const supplierId = req.query.supplier_id !== undefined ? Number(req.query.supplier_id) : null
    if (supplierId !== null && !Number.isFinite(supplierId)) {
      return res.status(400).json({ message: 'Некорректный идентификатор поставщика' })
    }

    const base = `SELECT COUNT(*) AS cnt, COALESCE(SUM(version),0) AS sum_ver FROM supplier_bank_details`
    const sql = supplierId === null ? base : `${base} WHERE supplier_id=?`
    const params = supplierId === null ? [] : [supplierId]

    const [rows] = await db.execute(sql, params)
    const { cnt, sum_ver } = rows[0] || { cnt: 0, sum_ver: 0 }
    res.json({ etag: `${cnt}:${sum_ver}`, cnt, sum_ver })
  } catch (e) {
    console.error('GET /supplier-bank-details/etag error', e)
    res.status(500).json({ message: 'Ошибка получения etag' })
  }
})

/* ======================
   LIST
   ====================== */
router.get('/', async (req, res) => {
  try {
    const { supplier_id } = req.query
    const params = []
    let sql = 'SELECT * FROM supplier_bank_details'

    if (supplier_id !== undefined) {
      const sid = Number(supplier_id)
      if (!Number.isFinite(sid)) {
        return res.status(400).json({ message: 'Некорректный идентификатор поставщика' })
      }
      sql += ' WHERE supplier_id=?'
      params.push(sid)
    }

    sql += ' ORDER BY created_at DESC, id DESC'
    const [rows] = await db.execute(sql, params)
    res.json(rows)
  } catch (e) {
    console.error('GET /supplier-bank-details error', e)
    res.status(500).json({ message: 'Ошибка получения реквизитов' })
  }
})

/* ======================
   GET ONE
   ====================== */
router.get('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id)
    if (!Number.isFinite(id)) return res.status(400).json({ message: 'Некорректный идентификатор записи' })

    const [rows] = await db.execute('SELECT * FROM supplier_bank_details WHERE id=?', [id])
    if (!rows.length) return res.status(404).json({ message: 'Реквизиты не найдены' })
    res.json(rows[0])
  } catch (e) {
    console.error('GET /supplier-bank-details/:id error', e)
    res.status(500).json({ message: 'Ошибка получения реквизитов' })
  }
})

/* ======================
   CREATE
   ====================== */
router.post('/', async (req, res) => {
  const {
    supplier_id,
    bank_name,
    account_number,
    iban,
    bic,
    currency,
    correspondent_account,
    bank_address,
    additional_info,
    is_primary_for_currency
  } = req.body || {}

  const sid = Number(supplier_id)
  if (!Number.isFinite(sid)) {
    return res.status(400).json({ message: 'Некорректный идентификатор поставщика' })
  }
  if (!bank_name?.trim() || !account_number?.trim()) {
    return res.status(400).json({ message: 'bank_name и account_number обязательны' })
  }

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()

    const ccy = nz(up(currency, 3))

    // нельзя помечать primary без валюты
    if (is_primary_for_currency && !ccy) {
      await conn.rollback()
      return res.status(400).json({ message: 'Для пометки основного счёта укажите валюту (ISO3)' })
    }

    let insertId
    try {
      const [ins] = await conn.execute(
        `INSERT INTO supplier_bank_details
         (supplier_id,bank_name,account_number,iban,bic,currency,
          correspondent_account,bank_address,additional_info,is_primary_for_currency)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [
          sid,
          bank_name.trim(),
          account_number.trim(),
          nz(trimIfStr(iban)),
          nz(trimIfStr(bic)),
          ccy,
          nz(trimIfStr(correspondent_account)),
          nz(trimIfStr(bank_address)),
          nz(trimIfStr(additional_info)),
          is_primary_for_currency ? 1 : 0
        ]
      )
      insertId = ins.insertId
    } catch (e) {
      if (e && e.errno === 1452) {
        await conn.rollback()
        return res.status(409).json({
          type: 'fk_constraint',
          message: 'Поставщик не найден или связь с поставщиком нарушена.'
        })
      }
      if (e && e.code === 'ER_DUP_ENTRY') {
        await conn.rollback()
        return res.status(409).json({
          type: 'duplicate',
          message: 'Конфликт уникальности по банковским реквизитам'
        })
      }
      throw e
    }

    // если primary по валюте — снимем флаги у остальных в этой валюте (и поднимем техполя)
    if (is_primary_for_currency && ccy) {
      await conn.execute(
        `UPDATE supplier_bank_details
         SET is_primary_for_currency=0, version=version+1, updated_at=NOW()
         WHERE supplier_id=? AND currency=? AND id<>?`,
        [sid, ccy, insertId]
      )
    }

    const [row] = await conn.execute('SELECT * FROM supplier_bank_details WHERE id=?', [insertId])

    await logActivity({
      req,
      action: 'create',
      entity_type: 'suppliers',
      entity_id: sid,
      comment: 'Добавлены банковские реквизиты поставщика'
    })

    await conn.commit()
    res.status(201).json(row[0])
  } catch (e) {
    await conn.rollback()
    console.error('POST /supplier-bank-details error', e)
    res.status(500).json({ message: 'Ошибка добавления реквизитов' })
  } finally {
    conn.release()
  }
})

/* ======================
   UPDATE (optimistic by version)
   ====================== */
router.put('/:id', async (req, res) => {
  const id = Number(req.params.id)
  const { version } = req.body || {}

  if (!Number.isFinite(id)) {
    return res.status(400).json({ message: 'Некорректный идентификатор' })
  }
  if (!Number.isFinite(Number(version))) {
    return res.status(400).json({ message: 'Отсутствует или некорректен version' })
  }

  const fields = [
    'bank_name',
    'account_number',
    'iban',
    'bic',
    'currency',
    'correspondent_account',
    'bank_address',
    'additional_info',
    'is_primary_for_currency'
  ]

  const set = []
  const vals = []

  for (const f of fields) {
    if (Object.prototype.hasOwnProperty.call(req.body, f)) {
      let v = req.body[f]
      if (f === 'is_primary_for_currency') v = v ? 1 : 0
      else if (f === 'currency') v = nz(up(v, 3))
      else v = nz(trimIfStr(v))
      set.push(`\`${f}\`=?`)
      vals.push(v)
    }
  }

  if (!set.length) return res.json({ message: 'Нет изменений' })

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()

    const [oldRows] = await conn.execute('SELECT * FROM supplier_bank_details WHERE id=?', [id])
    if (!oldRows.length) {
      await conn.rollback()
      return res.status(404).json({ message: 'Реквизиты не найдены' })
    }
    const oldData = oldRows[0]

    // финальные значения после апдейта (для валидации)
    const finalCurrency = Object.prototype.hasOwnProperty.call(req.body, 'currency')
      ? nz(up(req.body.currency, 3))
      : oldData.currency

    const finalPrimary = Object.prototype.hasOwnProperty.call(req.body, 'is_primary_for_currency')
      ? (req.body.is_primary_for_currency ? 1 : 0)
      : oldData.is_primary_for_currency

    const finalBankName = Object.prototype.hasOwnProperty.call(req.body, 'bank_name')
      ? (req.body.bank_name || '').trim()
      : (oldData.bank_name || '').trim()

    const finalAccount = Object.prototype.hasOwnProperty.call(req.body, 'account_number')
      ? (req.body.account_number || '').trim()
      : (oldData.account_number || '').trim()

    if (!finalBankName || !finalAccount) {
      await conn.rollback()
      return res.status(400).json({ message: 'bank_name и account_number обязательны' })
    }

    if (finalPrimary && !finalCurrency) {
      await conn.rollback()
      return res.status(400).json({ message: 'Для пометки основного счёта укажите валюту (ISO3)' })
    }

    // техполя текущей строки
    set.push('version = version + 1')
    set.push('updated_at = NOW()')

    // optimistic по version
    const [upd] = await conn.execute(
      `UPDATE supplier_bank_details SET ${set.join(', ')} WHERE id=? AND version=?`,
      [...vals, id, Number(version)]
    )

    if (!upd.affectedRows) {
      await conn.rollback()
      const [currentRows] = await db.execute('SELECT * FROM supplier_bank_details WHERE id=?', [id])
      return res.status(409).json({
        type: 'version_conflict',
        message: 'Появились новые изменения. Обновите данные.',
        current: currentRows[0] || null
      })
    }

    // если итогово primary=1 — снимаем флаги у остальных этой валюты + поднимаем их техполя
    if (finalPrimary && finalCurrency) {
      await conn.execute(
        `UPDATE supplier_bank_details
         SET is_primary_for_currency=0, version=version+1, updated_at=NOW()
         WHERE supplier_id=? AND currency=? AND id<>?`,
        [oldData.supplier_id, finalCurrency, id]
      )
    }

    const [fresh] = await conn.execute('SELECT * FROM supplier_bank_details WHERE id=?', [id])

    await logFieldDiffs({
      req,
      oldData,
      newData: fresh[0],
      entity_type: 'suppliers',
      entity_id: Number(fresh[0].supplier_id)
    })

    await conn.commit()
    res.json(fresh[0])
  } catch (e) {
    await conn.rollback()
    console.error('PUT /supplier-bank-details/:id error', e)
    if (e && e.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({
        type: 'duplicate',
        message: 'Конфликт уникальности по банковским реквизитам'
      })
    }
    res.status(500).json({ message: 'Ошибка обновления реквизитов' })
  } finally {
    conn.release()
  }
})

/* ======================
   DELETE (optional ?version=)
   ====================== */
router.delete('/:id', async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isFinite(id)) {
    return res.status(400).json({ message: 'Некорректный идентификатор' })
  }

  const versionParam = req.query.version
  const version = versionParam !== undefined ? Number(versionParam) : undefined
  if (versionParam !== undefined && !Number.isFinite(version)) {
    return res.status(400).json({ message: 'Некорректная версия записи' })
  }

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()

    const [old] = await conn.execute('SELECT * FROM supplier_bank_details WHERE id=?', [id])
    if (!old.length) {
      await conn.rollback()
      return res.status(404).json({ message: 'Реквизиты не найдены' })
    }
    const rec = old[0]

    if (version !== undefined && version !== rec.version) {
      await conn.rollback()
      return res.status(409).json({
        type: 'version_conflict',
        message: 'Запись была изменена и не может быть удалена без обновления',
        current: rec
      })
    }

    await conn.execute('DELETE FROM supplier_bank_details WHERE id=?', [id])

    await logActivity({
      req,
      action: 'delete',
      entity_type: 'suppliers',
      entity_id: Number(rec.supplier_id),
      comment: 'Удалены банковские реквизиты поставщика'
    })

    await conn.commit()
    res.json({ message: 'Реквизиты удалены' })
  } catch (e) {
    await conn.rollback()
    console.error('DELETE /supplier-bank-details/:id error', e)
    res.status(500).json({ message: 'Ошибка удаления реквизитов' })
  } finally {
    conn.release()
  }
})

module.exports = router
