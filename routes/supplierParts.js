const express = require('express');
const router = express.Router();
const db = require('../utils/db');
const auth = require('../middleware/authMiddleware');
const adminOnly = require('../middleware/adminOnly');

// history utils
const logActivity   = require('../utils/logActivity');
const logFieldDiffs = require('../utils/logFieldDiffs');

// helpers
const nz = (v) => (v === undefined || v === null ? null : ('' + v).trim() || null);
const toId = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
const numOrNull = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

// --- резолвер оригинальной детали (id | cat_number + model_id) ---
async function resolveOriginalPartId({ original_part_id, original_part_cat_number, equipment_model_id }) {
  if (original_part_id !== undefined && original_part_id !== null) {
    const id = toId(original_part_id);
    if (!id) throw new Error('ORIGINAL_ID_INVALID');
    const [[row]] = await db.execute('SELECT id FROM original_parts WHERE id = ?', [id]);
    if (!row) throw new Error('ORIGINAL_NOT_FOUND');
    return id;
  }

  const cat = nz(original_part_cat_number);
  if (!cat) throw new Error('ORIGINAL_CAT_REQUIRED');

  const [rows] = await db.execute(
    'SELECT id, equipment_model_id FROM original_parts WHERE cat_number = ?',
    [cat]
  );
  if (!rows.length) throw new Error('ORIGINAL_NOT_FOUND');

  if (rows.length === 1) return rows[0].id;

  const emid = toId(equipment_model_id);
  if (!emid) throw new Error('ORIGINAL_AMBIGUOUS');
  const hit = rows.find(r => r.equipment_model_id === emid);
  if (!hit) throw new Error('ORIGINAL_NOT_FOUND_IN_MODEL');
  return hit.id;
}

/* =========================================================================
   LIST (постранично)
   GET /supplier-parts?supplier_id=&q=&page=&page_size=
   Ответ: { items, page, page_size, total }
   ========================================================================= */
router.get('/', auth, async (req, res) => {
  try {
    const supplierId = req.query.supplier_id !== undefined ? toId(req.query.supplier_id) : undefined;
    if (!supplierId) return res.status(400).json({ message: 'supplier_id должен быть числом' });

    const q = nz(req.query.q);

    const pageSize = Math.min(100, Math.max(1, Number(req.query.page_size) || 20)) | 0;
    const page     = Math.max(1, Number(req.query.page) || 1) | 0;
    const offset   = Math.max(0, (page - 1) * pageSize) | 0;

    const where = ['sp.supplier_id = ?'];
    const params = [supplierId];

    if (q) {
      where.push('(sp.supplier_part_number LIKE ? OR sp.description LIKE ?)');
      params.push(`%${q}%`, `%${q}%`);
    }

    const whereSql = 'WHERE ' + where.join(' AND ');

    const [[{ total }]] = await db.execute(
      `SELECT COUNT(*) AS total FROM supplier_parts sp ${whereSql}`,
      params
    );

    const sql = `
      SELECT
        sp.*,
        agg.original_cat_numbers,
        (SELECT spp.price FROM supplier_part_prices spp
          WHERE spp.supplier_part_id = sp.id
          ORDER BY spp.date DESC
          LIMIT 1) AS latest_price,
        (SELECT spp.date FROM supplier_part_prices spp
          WHERE spp.supplier_part_id = sp.id
          ORDER BY spp.date DESC
          LIMIT 1) AS latest_price_date
      FROM supplier_parts sp
      LEFT JOIN (
        SELECT spo.supplier_part_id,
               GROUP_CONCAT(op.cat_number ORDER BY op.cat_number SEPARATOR ',') AS original_cat_numbers
          FROM supplier_part_originals spo
          JOIN original_parts op ON op.id = spo.original_part_id
         GROUP BY spo.supplier_part_id
      ) agg ON agg.supplier_part_id = sp.id
      ${whereSql}
      ORDER BY sp.id DESC
      LIMIT ${pageSize} OFFSET ${offset}
    `;
    const [rows] = await db.execute(sql, params);

    res.json({ items: rows, page, page_size: pageSize, total });
  } catch (err) {
    console.error('GET /supplier-parts error:', err);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

/* =========================================================================
   GET ONE
   GET /supplier-parts/:id
   ========================================================================= */
router.get('/:id', auth, async (req, res) => {
  try {
    const id = toId(req.params.id);
    if (!id) return res.status(400).json({ message: 'Некорректный id' });

    const [rows] = await db.execute(
      `
      SELECT sp.*,
             agg.original_ids,
             agg.original_cat_numbers,
             (SELECT spp.price FROM supplier_part_prices spp
               WHERE spp.supplier_part_id = sp.id
               ORDER BY spp.date DESC LIMIT 1) AS latest_price,
             (SELECT spp.date FROM supplier_part_prices spp
               WHERE spp.supplier_part_id = sp.id
               ORDER BY spp.date DESC LIMIT 1) AS latest_price_date
        FROM supplier_parts sp
        LEFT JOIN (
          SELECT spo.supplier_part_id,
                 GROUP_CONCAT(op.id ORDER BY op.id) AS original_ids,
                 GROUP_CONCAT(op.cat_number ORDER BY op.cat_number SEPARATOR ',') AS original_cat_numbers
            FROM supplier_part_originals spo
            JOIN original_parts op ON op.id = spo.original_part_id
           WHERE spo.supplier_part_id = ?
           GROUP BY spo.supplier_part_id
        ) agg ON agg.supplier_part_id = sp.id
       WHERE sp.id = ?
      `,
      [id, id]
    );
    if (!rows.length) return res.status(404).json({ message: 'Деталь не найдена' });
    res.json(rows[0]);
  } catch (err) {
    console.error('GET /supplier-parts/:id error:', err);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

/* =========================================================================
   CREATE
   POST /supplier-parts
   body: { supplier_id, supplier_part_number, description?,
           [original_part_id | original_part_cat_number + equipment_model_id]?,
           price?, price_date? }
   ========================================================================= */
router.post('/', auth, adminOnly, async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const supplier_id = toId(req.body.supplier_id);
    const supplier_part_number = nz(req.body.supplier_part_number);
    const description = nz(req.body.description);

    if (!supplier_id) throw new Error('SUPPLIER_ID_REQUIRED');
    if (!supplier_part_number) throw new Error('SUPPLIER_PART_NUMBER_REQUIRED');

    let spInsert;
    try {
      const [ins] = await conn.execute(
        'INSERT INTO supplier_parts (supplier_id, supplier_part_number, description) VALUES (?,?,?)',
        [supplier_id, supplier_part_number, description]
      );
      spInsert = ins;
    } catch (e) {
      if (e && e.code === 'ER_DUP_ENTRY') throw new Error('SUPPLIER_PART_DUP');
      throw e;
    }
    const supplier_part_id = spInsert.insertId;

    // опциональная привязка к оригиналу
    let createdOriginalId = null;
    const hasOriginalPayload =
      req.body.original_part_id !== undefined ||
      req.body.original_part_cat_number !== undefined;

    if (hasOriginalPayload) {
      let original_part_id;
      try {
        original_part_id = await resolveOriginalPartId({
          original_part_id: req.body.original_part_id,
          original_part_cat_number: req.body.original_part_cat_number,
          equipment_model_id: req.body.equipment_model_id
        });
      } catch (e) {
        if (e.message === 'ORIGINAL_ID_INVALID')       return res.status(400).json({ message: 'Некорректный original_part_id' });
        if (e.message === 'ORIGINAL_AMBIGUOUS')         return res.status(400).json({ message: 'Найдено несколько деталей с таким cat_number. Укажите equipment_model_id.' });
        if (e.message === 'ORIGINAL_NOT_FOUND')         return res.status(400).json({ message: 'Оригинальная деталь не найдена' });
        if (e.message === 'ORIGINAL_NOT_FOUND_IN_MODEL')return res.status(400).json({ message: 'В указанной модели такая деталь не найдена' });
        throw e;
      }

      try {
        await conn.execute(
          'INSERT INTO supplier_part_originals (supplier_part_id, original_part_id) VALUES (?, ?)',
          [supplier_part_id, original_part_id]
        );
        createdOriginalId = original_part_id;
      } catch (e) {
        if (e && e.code === 'ER_DUP_ENTRY') throw new Error('LINK_DUP');
        if (e && e.errno === 1452)          throw new Error('LINK_FK_FAIL');
        throw e;
      }
    }

    // опционально — первая цена
    let createdPrice = null;
    const price = numOrNull(req.body.price);
    if (price !== null) {
      const price_date = req.body.price_date ? new Date(req.body.price_date) : new Date();
      await conn.execute(
        'INSERT INTO supplier_part_prices (supplier_part_id, price, date) VALUES (?, ?, ?)',
        [supplier_part_id, price, price_date]
      );
      createdPrice = { price, date: price_date.toISOString() };
    }

    await conn.commit();

    // === ЛОГИ ===
    await logActivity({
      req,
      action: 'create',
      entity_type: 'supplier_parts',
      entity_id: supplier_part_id,
      comment: `Создана деталь поставщика`
    });

    if (createdOriginalId != null) {
      await logActivity({
        req,
        action: 'update',
        entity_type: 'supplier_parts',
        entity_id: supplier_part_id,
        field_changed: 'original_link_added',
        old_value: '',
        new_value: String(createdOriginalId),
        comment: 'Добавлена привязка к оригинальной детали'
      });
    }

    if (createdPrice) {
      await logActivity({
        req,
        action: 'update',
        entity_type: 'supplier_parts',
        entity_id: supplier_part_id,
        field_changed: 'price_entry',
        old_value: '',
        new_value: JSON.stringify(createdPrice),
        comment: 'Добавлена запись цены'
      });
    }

    res.status(201).json({ id: supplier_part_id, message: 'Деталь поставщика добавлена' });
  } catch (err) {
    await conn.rollback();

    if (err.message === 'SUPPLIER_ID_REQUIRED')
      return res.status(400).json({ message: 'supplier_id обязателен и должен быть числом' });
    if (err.message === 'SUPPLIER_PART_NUMBER_REQUIRED')
      return res.status(400).json({ message: 'supplier_part_number обязателен' });
    if (err.message === 'SUPPLIER_PART_DUP')
      return res.status(409).json({ type: 'duplicate', fields: ['supplier_id','supplier_part_number'], message: 'У этого поставщика такой номер уже есть' });
    if (err.message === 'LINK_DUP')
      return res.status(409).json({ type: 'duplicate', message: 'Связь поставщик ↔ оригинал уже существует' });
    if (err.message === 'LINK_FK_FAIL')
      return res.status(409).json({ type: 'fk_constraint', message: 'Нарушение ссылочной целостности при создании связи' });

    console.error('POST /supplier-parts error:', err);
    res.status(500).json({ message: 'Ошибка сервера' });
  } finally {
    conn.release();
  }
});

/* =========================================================================
   UPDATE (номер/описание + новая цена)
   PUT /supplier-parts/:id
   ========================================================================= */
router.put('/:id', auth, adminOnly, async (req, res) => {
  const id = toId(req.params.id);
  if (!id) return res.status(400).json({ message: 'Некорректный id' });

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [[exists]] = await conn.execute('SELECT * FROM supplier_parts WHERE id=?', [id]);
    if (!exists) {
      await conn.rollback();
      return res.status(404).json({ message: 'Деталь не найдена' });
    }
    const oldRow = exists;

    const supplier_part_number = nz(req.body.supplier_part_number);
    const description = nz(req.body.description);

    if (supplier_part_number !== null || description !== null) {
      try {
        await conn.execute(
          'UPDATE supplier_parts SET ' +
          'supplier_part_number = COALESCE(?, supplier_part_number), ' +
          'description = COALESCE(?, description) ' +
          'WHERE id = ?',
          [supplier_part_number, description, id]
        );
      } catch (e) {
        if (e && e.code === 'ER_DUP_ENTRY') {
          await conn.rollback();
          return res.status(409).json({ type: 'duplicate', fields: ['supplier_id','supplier_part_number'], message: 'Такой номер у этого поставщика уже есть' });
        }
        throw e;
      }
    }

    // новая цена (опционально)
    let appendedPrice = null;
    const price = numOrNull(req.body.price);
    if (price !== null) {
      const price_date = req.body.price_date ? new Date(req.body.price_date) : new Date();
      await conn.execute(
        'INSERT INTO supplier_part_prices (supplier_part_id, price, date) VALUES (?, ?, ?)',
        [id, price, price_date]
      );
      appendedPrice = { price, date: price_date.toISOString() };
    }

    const [[fresh]] = await conn.execute('SELECT * FROM supplier_parts WHERE id=?', [id]);

    await conn.commit();

    // === ЛОГИ ===
    await logFieldDiffs({
      req,
      oldData: oldRow,
      newData: fresh,
      entity_type: 'supplier_parts',
      entity_id: id,
      exclude: ['id', 'supplier_id', 'created_at', 'updated_at']
    });

    if (appendedPrice) {
      await logActivity({
        req,
        action: 'update',
        entity_type: 'supplier_parts',
        entity_id: id,
        field_changed: 'price_entry',
        old_value: '',
        new_value: JSON.stringify(appendedPrice),
        comment: 'Добавлена запись цены'
      });
    }

    res.json({ message: 'Деталь обновлена' });
  } catch (err) {
    await conn.rollback();
    console.error('PUT /supplier-parts/:id error:', err);
    res.status(500).json({ message: 'Ошибка сервера' });
  } finally {
    conn.release();
  }
});

/* =========================================================================
   DELETE
   ========================================================================= */
router.delete('/:id', auth, adminOnly, async (req, res) => {
  const id = toId(req.params.id);
  if (!id) return res.status(400).json({ message: 'Некорректный id' });

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [[oldRow]] = await conn.execute('SELECT * FROM supplier_parts WHERE id=?', [id]);
    if (!oldRow) {
      await conn.rollback();
      return res.status(404).json({ message: 'Деталь не найдена' });
    }

    // чистим «хвосты»
    await conn.execute('DELETE FROM supplier_part_originals WHERE supplier_part_id = ?', [id]);
    await conn.execute('DELETE FROM supplier_part_prices    WHERE supplier_part_id = ?', [id]);

    const [del] = await conn.execute('DELETE FROM supplier_parts WHERE id = ?', [id]);
    if (del.affectedRows === 0) {
      await conn.rollback();
      return res.status(404).json({ message: 'Деталь не найдена' });
    }

    await conn.commit();

    // === ЛОГ ===
    await logActivity({
      req,
      action: 'delete',
      entity_type: 'supplier_parts',
      entity_id: id,
      comment: `Удалена деталь поставщика ${oldRow.supplier_part_number || ''}`.trim()
    });

    res.json({ message: 'Деталь удалена' });
  } catch (err) {
    await conn.rollback();
    console.error('DELETE /supplier-parts/:id error:', err);
    res.status(500).json({ message: 'Ошибка сервера' });
  } finally {
    conn.release();
  }
});

module.exports = router;
