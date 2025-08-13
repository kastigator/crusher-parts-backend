const express = require('express')
const db = require('../utils/db')
const router = express.Router()
const auth = require('../middleware/authMiddleware')

const logActivity = require('../utils/logActivity')
const logFieldDiffs = require('../utils/logFieldDiffs')

const nz = (v) => (v === '' || v === undefined ? null : v)
const up = (v, n) => (typeof v === 'string' ? v.trim().toUpperCase().slice(0, n || v.length) : v ?? null)

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

router.get('/:id', async (req, res) => {
  const [rows] = await db.execute('SELECT * FROM supplier_bank_details WHERE id=?', [req.params.id])
  if (!rows.length) return res.status(404).json({ message: 'Реквизиты не найдены' })
  res.json(rows[0])
})

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

    const [ins] = await conn.execute(
      `INSERT INTO supplier_bank_details
       (supplier_id,bank_name,account_number,iban,bic,currency,correspondent_account,bank_address,additional_info,is_primary_for_currency)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [
        Number(supplier_id), bank_name.trim(), account_number.trim(), nz(iban), nz(bic),
        nz(up(currency,3)), nz(correspondent_account), nz(bank_address), nz(additional_info),
        is_primary_for_currency ? 1 : 0
      ]
    )

    // если пометили как основной для валюты — снимем флаг у остальных той же валюты
    if (is_primary_for_currency && currency) {
      await conn.execute(
        `UPDATE supplier_bank_details
         SET is_primary_for_currency=0
         WHERE supplier_id=? AND currency=? AND id<>?`,
        [Number(supplier_id), up(currency,3), ins.insertId]
      )
    }

    await logActivity({ req, action: 'create', entity_type: 'supplier_bank_details', entity_id: ins.insertId })
    await conn.commit()

    const [row] = await db.execute('SELECT * FROM supplier_bank_details WHERE id=?', [ins.insertId])
    res.status(201).json(row[0])
  } catch (e) {
    await conn.rollback()
    console.error('POST /supplier-bank-details error', e)
    res.status(500).json({ message: 'Ошибка добавления реквизитов' })
  } finally {
    conn.release()
  }
})

router.put('/:id', auth, async (req, res) => {
  const { updated_at } = req.body
  if (!updated_at) return res.status(400).json({ message: 'Отсутствует updated_at' })

  const fields = [
    'bank_name','account_number','iban','bic','currency',
    'correspondent_account','bank_address','additional_info','is_primary_for_currency'
  ]
  const set = []
  const vals = []
  for (const f of fields) {
    if (req.body[f] !== undefined) {
      let v = req.body[f]
      if (f === 'is_primary_for_currency') v = v ? 1 : 0
      if (f === 'currency') v = nz(up(v,3))
      v = f !== 'is_primary_for_currency' && f !== 'currency' ? nz(v) : v
      set.push(`\`${f}\`=?`)
      vals.push(v)
    }
  }
  if (!set.length) return res.json({ message: 'Нет изменений' })

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()

    const [oldRows] = await conn.execute('SELECT * FROM supplier_bank_details WHERE id=?', [req.params.id])
    if (!oldRows.length) {
      await conn.rollback()
      return res.status(404).json({ message: 'Реквизиты не найдены' })
    }
    const oldData = oldRows[0]

    const [upd] = await conn.execute(
      `UPDATE supplier_bank_details SET ${set.join(', ')} WHERE id=? AND updated_at=?`,
      [...vals, req.params.id, updated_at]
    )
    if (!upd.affectedRows) {
      await conn.rollback()
      return res.status(409).json({ message: 'Появились новые изменения. Обновите данные.' })
    }

    // если выставили primary=1 — снимем у остальных той же валюты
    const newCurrency = req.body.currency ? up(req.body.currency,3) : oldData.currency
    const newPrimary = req.body.is_primary_for_currency ? 1 : 0
    if (newPrimary && newCurrency) {
      await conn.execute(
        `UPDATE supplier_bank_details
         SET is_primary_for_currency=0
         WHERE supplier_id=? AND currency=? AND id<>?`,
        [oldData.supplier_id, newCurrency, req.params.id]
      )
    }

    const [fresh] = await conn.execute('SELECT * FROM supplier_bank_details WHERE id=?', [req.params.id])

    await logFieldDiffs({
      req,
      oldData,
      newData: fresh[0],
      entity_type: 'supplier_bank_details',
      entity_id: Number(req.params.id)
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

router.delete('/:id', auth, async (req, res) => {
  try {
    const [old] = await db.execute('SELECT * FROM supplier_bank_details WHERE id=?', [req.params.id])
    if (!old.length) return res.status(404).json({ message: 'Реквизиты не найдены' })

    await db.execute('DELETE FROM supplier_bank_details WHERE id=?', [req.params.id])
    await logActivity({ req, action: 'delete', entity_type: 'supplier_bank_details', entity_id: Number(req.params.id) })
    res.json({ message: 'Реквизиты удалены' })
  } catch (e) {
    console.error('DELETE /supplier-bank-details/:id error', e)
    res.status(500).json({ message: 'Ошибка удаления реквизитов' })
  }
})

module.exports = router
