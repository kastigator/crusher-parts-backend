const express = require('express')
const db = require('../utils/db')
const router = express.Router()
const auth = require('../middleware/authMiddleware')

const logActivity = require('../utils/logActivity')
const logFieldDiffs = require('../utils/logFieldDiffs')

const nz = (v) => (v === '' || v === undefined ? null : v)
const up = (v, n) => (typeof v === 'string' ? v.trim().toUpperCase().slice(0, n || v.length) : v ?? null)
const trimIfStr = (v) => (typeof v === 'string' ? v.trim() : v)

/* ======================
   LIST
   ====================== */
router.get('/', async (req, res) => {
  try {
    const { supplier_id } = req.query
    const params = []
    let sql = 'SELECT * FROM supplier_bank_details'
    if (supplier_id) { sql += ' WHERE supplier_id=?'; params.push(Number(supplier_id)) }
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
    const [rows] = await db.execute('SELECT * FROM supplier_bank_details WHERE id=?', [req.params.id])
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
router.post('/', auth, async (req, res) => {
  const {
    supplier_id, bank_name, account_number, iban, bic, currency,
    correspondent_account, bank_address, additional_info, is_primary_for_currency
  } = req.body

  if (!supplier_id) return res.status(400).json({ message: 'supplier_id обязателен' })
  if (!bank_name || !account_number) return res.status(400).json({ message: 'bank_name и account_number обязательны' })

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()

    const ccy = nz(up(currency, 3))

    // нельзя делать primary без валюты
    if (is_primary_for_currency && !ccy) {
      await conn.rollback()
      return res.status(400).json({ message: 'Для пометки основного счёта укажите валюту (ISO3)' })
    }

    const [ins] = await conn.execute(
      `INSERT INTO supplier_bank_details
       (supplier_id,bank_name,account_number,iban,bic,currency,correspondent_account,bank_address,additional_info,is_primary_for_currency)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [
        Number(supplier_id), bank_name.trim(), account_number.trim(), nz(iban), nz(bic),
        ccy, nz(correspondent_account), nz(bank_address), nz(additional_info),
        is_primary_for_currency ? 1 : 0
      ]
    )

    // если пометили как основной для валюты — снимем флаг у остальных той же валюты
    if (is_primary_for_currency && ccy) {
      await conn.execute(
        `UPDATE supplier_bank_details
         SET is_primary_for_currency=0
         WHERE supplier_id=? AND currency=? AND id<>?`,
        [Number(supplier_id), ccy, ins.insertId]
      )
    }

    const [row] = await conn.execute('SELECT * FROM supplier_bank_details WHERE id=?', [ins.insertId])

    await logActivity({
      req,
      action: 'create',
      entity_type: 'suppliers',
      entity_id: Number(supplier_id),
      comment: 'Добавлены банковские реквизиты поставщика',
      diff: row[0],
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
router.put('/:id', auth, async (req, res) => {
  const id = Number(req.params.id)
  const { version } = req.body || {}

  if (!Number.isInteger(id)) return res.status(400).json({ message: 'Некорректный id' })
  if (version == null) return res.status(400).json({ message: 'Отсутствует version для проверки конфликтов' })

  const fields = [
    'bank_name','account_number','iban','bic','currency',
    'correspondent_account','bank_address','additional_info','is_primary_for_currency'
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

  // если нет пользовательских полей — нет изменений
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

    // финальные целевые значения после апдейта (для валидации и последующей синхронизации primary)
    const finalCurrency =
      Object.prototype.hasOwnProperty.call(req.body, 'currency')
        ? nz(up(req.body.currency, 3))
        : oldData.currency
    const finalPrimary =
      Object.prototype.hasOwnProperty.call(req.body, 'is_primary_for_currency')
        ? (req.body.is_primary_for_currency ? 1 : 0)
        : oldData.is_primary_for_currency

    // нельзя иметь primary=1 без валюты
    if (finalPrimary && !finalCurrency) {
      await conn.rollback()
      return res.status(400).json({ message: 'Для пометки основного счёта укажите валюту (ISO3)' })
    }

    // техполя
    set.push('version = version + 1')
    set.push('updated_at = NOW()')

    // optimistic по version
    const [upd] = await conn.execute(
      `UPDATE supplier_bank_details SET ${set.join(', ')} WHERE id=? AND version=?`,
      [...vals, id, version]
    )

    if (!upd.affectedRows) {
      await conn.rollback()
      const [currentRows] = await db.execute('SELECT * FROM supplier_bank_details WHERE id=?', [id])
      return res.status(409).json({
        message: 'Появились новые изменения. Обновите данные.',
        current: currentRows[0],
      })
    }

    // если после апдейта primary=1 — снимем у остальных той же валюты
    if (finalPrimary && finalCurrency) {
      await conn.execute(
        `UPDATE supplier_bank_details
         SET is_primary_for_currency=0
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
    res.status(500).json({ message: 'Ошибка обновления реквизитов' })
  } finally {
    conn.release()
  }
})

/* ======================
   DELETE
   ====================== */
router.delete('/:id', auth, async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id)) return res.status(400).json({ message: 'Некорректный id' })

  try {
    const [old] = await db.execute('SELECT * FROM supplier_bank_details WHERE id=?', [id])
    if (!old.length) return res.status(404).json({ message: 'Реквизиты не найдены' })

    await db.execute('DELETE FROM supplier_bank_details WHERE id=?', [id])

    await logActivity({
      req,
      action: 'delete',
      entity_type: 'suppliers',
      entity_id: Number(old[0].supplier_id),
      comment: 'Удалены банковские реквизиты поставщика'
    })

    res.json({ message: 'Реквизиты удалены' })
  } catch (e) {
    console.error('DELETE /supplier-bank-details/:id error', e)
    res.status(500).json({ message: 'Ошибка удаления реквизитов' })
  }
})

module.exports = router
