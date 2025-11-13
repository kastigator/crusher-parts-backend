// backend/routes/supplierBundles.js
const express = require('express');
const router = express.Router();

const db = require('../utils/db');
const auth = require('../middleware/authMiddleware');
const adminOnly = require('../middleware/adminOnly');
const checkTabAccess = require('../middleware/requireTabAccess');
const logActivity = require('../utils/logActivity');

const TAB_PATH = '/original-parts';

// -------------------- helpers --------------------
const toId  = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
const nz    = (v) => (v === undefined || v === null ? null : ('' + v).trim() || null);
const toQty = (v, def = 1) => {
  if (v === '' || v === undefined || v === null) return def;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : def;
};

// guards
async function originalExists(id) {
  const [[row]] = await db.execute('SELECT id FROM original_parts WHERE id=?', [id]);
  return !!row;
}
async function supplierPartExists(id) {
  const [[row]] = await db.execute('SELECT id FROM supplier_parts WHERE id=?', [id]);
  return !!row;
}
async function bundleExists(id) {
  const [[row]] = await db.execute('SELECT id FROM supplier_bundles WHERE id=?', [id]);
  return !!row;
}

// -------------------- latest price fallback (MySQL 8) --------------------
async function getLatestPricesForPartIds(partIds) {
  if (!partIds.length) return [];
  const placeholders = partIds.map(() => '?').join(',');
  const [rows] = await db.execute(
    `
    WITH latest AS (
      SELECT
        p.*,
        ROW_NUMBER() OVER (PARTITION BY p.supplier_part_id ORDER BY p.date DESC, p.id DESC) AS rn
      FROM supplier_part_prices p
      WHERE p.supplier_part_id IN (${placeholders})
    )
    SELECT supplier_part_id, price, currency, date AS last_price_date
    FROM latest
    WHERE rn = 1
    `,
    partIds
  );
  return rows;
}

/* ====================================================================== */
/*                                BUNDLES                                  */
/* ====================================================================== */

/** GET /supplier-bundles?original_part_id=:id */
router.get('/', auth, checkTabAccess(TAB_PATH), async (req, res) => {
  try {
    const original_part_id = toId(req.query.original_part_id);
    if (!original_part_id) return res.status(400).json({ message: 'original_part_id обязателен' });

    const [rows] = await db.execute(
      `SELECT b.id, b.original_part_id, b.title, b.note,
              COUNT(i.id) AS items_count
         FROM supplier_bundles b
         LEFT JOIN supplier_bundle_items i ON i.bundle_id = b.id
        WHERE b.original_part_id = ?
        GROUP BY b.id
        ORDER BY b.id DESC`,
      [original_part_id]
    );
    res.json(rows);
  } catch (e) {
    console.error('GET /supplier-bundles error:', e);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

/** POST /supplier-bundles */
router.post('/', auth, checkTabAccess(TAB_PATH), adminOnly, async (req, res) => {
  try {
    const original_part_id = toId(req.body.original_part_id);
    const title = nz(req.body.title);
    const note  = nz(req.body.note);

    if (!original_part_id) return res.status(400).json({ message: 'original_part_id обязателен' });
    if (!(await originalExists(original_part_id))) {
      return res.status(404).json({ message: 'Оригинальная деталь не найдена' });
    }

    const safeTitle = title || `Комплект для OP#${original_part_id}`;
    const name = safeTitle;

    const [ins] = await db.execute(
      'INSERT INTO supplier_bundles (original_part_id, title, note, name) VALUES (?,?,?,?)',
      [original_part_id, safeTitle, note, name]
    );

    await logActivity({
      req,
      action: 'create',
      entity_type: 'supplier_bundles',
      entity_id: ins.insertId,
      comment: `Создан комплект для original_part_id=${original_part_id}`
    });

    res.status(201).json({ id: ins.insertId });
  } catch (e) {
    console.error('POST /supplier-bundles error:', e);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

/** PUT /supplier-bundles/:id */
router.put('/:id', auth, checkTabAccess(TAB_PATH), adminOnly, async (req, res) => {
  try {
    const id = toId(req.params.id);
    if (!id) return res.status(400).json({ message: 'Некорректный id' });

    const title = nz(req.body.title);
    const note  = nz(req.body.note);

    const [upd] = await db.execute(
      'UPDATE supplier_bundles SET title=COALESCE(?, title), note=COALESCE(?, note), name=COALESCE(?, name) WHERE id=?',
      [title, note, title, id]
    );
    if (upd.affectedRows === 0) return res.status(404).json({ message: 'Комплект не найден' });

    await logActivity({
      req,
      action: 'update',
      entity_type: 'supplier_bundles',
      entity_id: id,
      comment: 'Обновление комплекта (title/note/name)'
    });

    res.json({ message: 'Обновлено' });
  } catch (e) {
    console.error('PUT /supplier-bundles/:id error:', e);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

/** DELETE /supplier-bundles/:id */
router.delete('/:id', auth, checkTabAccess(TAB_PATH), adminOnly, async (req, res) => {
  try {
    const id = toId(req.params.id);
    if (!id) return res.status(400).json({ message: 'Некорректный id' });

    const [del] = await db.execute('DELETE FROM supplier_bundles WHERE id=?', [id]);
    if (del.affectedRows === 0) return res.status(404).json({ message: 'Комплект не найден' });

    await logActivity({
      req,
      action: 'delete',
      entity_type: 'supplier_bundles',
      entity_id: id,
      comment: 'Удалён комплект'
    });

    res.json({ message: 'Удалено' });
  } catch (e) {
    console.error('DELETE /supplier-bundles/:id error:', e);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

/* ====================================================================== */
/*                     USAGE (ПЕРЕД параметрическими роутами!)            */
/* ====================================================================== */

router.get('/usage', auth, checkTabAccess(TAB_PATH), async (req, res) => {
  try {
    const raw = nz(req.query.part_ids) || '';
    const ids = raw.split(',').map(s => toId(s)).filter(Boolean);
    if (!ids.length) return res.json([]);

    const placeholders = ids.map(() => '?').join(',');
    const [rows] = await db.execute(
      `SELECT l.supplier_part_id, COUNT(*) AS uses
         FROM supplier_bundle_item_links l
         JOIN supplier_bundle_items i ON i.id = l.item_id
        WHERE l.supplier_part_id IN (${placeholders})
        GROUP BY l.supplier_part_id`,
      ids
    );
    res.json(rows);
  } catch (e) {
    console.error('GET /supplier-bundles/usage error:', e);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

/* ====================================================================== */
/*                                 ITEMS                                  */
/* ====================================================================== */

router.get('/:bundleId/items', auth, checkTabAccess(TAB_PATH), async (req, res) => {
  try {
    const bundleId = toId(req.params.bundleId);
    if (!bundleId) return res.status(400).json({ message: 'Некорректный bundleId' });

    const [rows] = await db.execute(
      `SELECT id, bundle_id, role_label, qty
         FROM supplier_bundle_items
        WHERE bundle_id=?
        ORDER BY id`,
      [bundleId]
    );
    res.json(rows);
  } catch (e) {
    console.error('GET /supplier-bundles/:bundleId/items error:', e);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

router.post('/items', auth, checkTabAccess(TAB_PATH), adminOnly, async (req, res) => {
  try {
    const bundle_id  = toId(req.body.bundle_id);
    if (!bundle_id) return res.status(400).json({ message: 'bundle_id обязателен' });

    if (!(await bundleExists(bundle_id))) {
      return res.status(404).json({ message: 'Комплект не найден' });
    }

    const role_label = nz(req.body.role_label) || 'Позиция';
    const qty        = toQty(req.body.qty, 1);

    let insertId;
    try {
      const [ins] = await db.execute(
        'INSERT INTO supplier_bundle_items (bundle_id, role_label, qty) VALUES (?,?,?)',
        [bundle_id, role_label, qty]
      );
      insertId = ins.insertId;
    } catch (e) {
      if (e && e.errno === 1452) {
        return res.status(409).json({ type: 'fk_constraint', message: 'Неверный bundle_id' });
      }
      throw e;
    }

    await logActivity({
      req,
      action: 'create',
      entity_type: 'supplier_bundle_items',
      entity_id: insertId,
      comment: `Добавлена роль в комплект bundle_id=${bundle_id}`
    });

    res.status(201).json({ id: insertId });
  } catch (e) {
    console.error('POST /supplier-bundles/items error:', e);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

router.put('/items/:id', auth, checkTabAccess(TAB_PATH), adminOnly, async (req, res) => {
  try {
    const id = toId(req.params.id);
    if (!id) return res.status(400).json({ message: 'Некорректный id' });

    const role_label = nz(req.body.role_label);
    const qty = req.body.qty !== undefined ? toQty(req.body.qty, NaN) : undefined;
    if (qty !== undefined && !(qty > 0)) {
      return res.status(400).json({ message: 'qty должен быть положительным' });
    }

    const [upd] = await db.execute(
      'UPDATE supplier_bundle_items SET role_label = COALESCE(?, role_label), qty = COALESCE(?, qty) WHERE id=?',
      [role_label, qty, id]
    );
    if (upd.affectedRows === 0) return res.status(404).json({ message: 'Позиция не найдена' });

    await logActivity({
      req,
      action: 'update',
      entity_type: 'supplier_bundle_items',
      entity_id: id,
      comment: 'Обновление роли/количества'
    });

    res.json({ message: 'Обновлено' });
  } catch (e) {
    console.error('PUT /supplier-bundles/items/:id error:', e);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

router.delete('/items/:id', auth, checkTabAccess(TAB_PATH), adminOnly, async (req, res) => {
  try {
    const id = toId(req.params.id);
    if (!id) return res.status(400).json({ message: 'Некорректный id' });

    const [del] = await db.execute('DELETE FROM supplier_bundle_items WHERE id=?', [id]);
    if (del.affectedRows === 0) return res.status(404).json({ message: 'Позиция не найдена' });

    await logActivity({
      req,
      action: 'delete',
      entity_type: 'supplier_bundle_items',
      entity_id: id,
      comment: 'Удалена позиция комплекта'
    });

    res.json({ message: 'Удалено' });
  } catch (e) {
    console.error('DELETE /supplier-bundles/items/:id error:', e);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

/* ====================================================================== */
/*                                 LINKS                                  */
/* ====================================================================== */

router.get('/:bundleId/options', auth, checkTabAccess(TAB_PATH), async (req, res) => {
  try {
    const bundleId = toId(req.params.bundleId);
    if (!bundleId) return res.status(400).json({ message: 'Некорректный bundleId' });

    // Пытаемся через view
    try {
      const [rows] = await db.execute(
        `
        SELECT 
          v.*,
          s.name AS supplier_name
        FROM v_bundle_item_options v
        LEFT JOIN part_suppliers s ON s.id = v.supplier_id
        WHERE v.bundle_id = ?
        ORDER BY v.item_id, v.link_id ASC
        `,
        [bundleId]
      );
      return res.json(rows);
    } catch {
      // Фолбэк
      const [links] = await db.execute(
        `
        SELECT
          l.id AS link_id,
          l.item_id,
          l.supplier_part_id,
          l.is_default,
          l.note,
          i.bundle_id,
          i.role_label,
          i.qty,
          sp.supplier_id,
          s.name AS supplier_name,
          sp.supplier_part_number,
          sp.description AS supplier_part_description
        FROM supplier_bundle_item_links l
        JOIN supplier_bundle_items i ON i.id = l.item_id
        JOIN supplier_parts sp       ON sp.id = l.supplier_part_id
        JOIN part_suppliers s        ON s.id = sp.supplier_id
        WHERE i.bundle_id = ?
        ORDER BY i.id, l.id ASC
        `,
        [bundleId]
      );

      const partIds = Array.from(new Set(links.map(r => r.supplier_part_id)));
      const latest = await getLatestPricesForPartIds(partIds);
      const map = new Map(latest.map(r => [r.supplier_part_id, r]));

      const rows = links.map(r => {
        const lp = map.get(r.supplier_part_id);
        return {
          bundle_id: r.bundle_id,
          item_id: r.item_id,
          role_label: r.role_label,
          qty: Number(r.qty || 1),
          link_id: r.link_id,
          supplier_id: r.supplier_id,
          supplier_name: r.supplier_name,
          supplier_part_id: r.supplier_part_id,
          supplier_part_number: r.supplier_part_number,
          description: r.supplier_part_description,
          is_default: !!r.is_default,
          last_price: lp?.price ?? null,
          last_currency: lp?.currency ?? null,
          last_price_date: lp?.last_price_date ?? null,
          note: r.note || null,
        };
      });
      return res.json(rows);
    }
  } catch (e) {
    console.error('GET /supplier-bundles/:bundleId/options error:', e);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

router.post('/links', auth, checkTabAccess(TAB_PATH), adminOnly, async (req, res) => {
  try {
    const item_id = toId(req.body.item_id);
    const supplier_part_id = toId(req.body.supplier_part_id);
    const make_default = req.body.is_default ? 1 : null; // НЕ-дефолт = NULL
    const note = nz(req.body.note);

    if (!item_id || !supplier_part_id) {
      return res.status(400).json({ message: 'item_id и supplier_part_id обязательны' });
    }
    if (!(await supplierPartExists(supplier_part_id))) {
      return res.status(404).json({ message: 'Деталь поставщика не найдена' });
    }

    const conn = await db.getConnection();
    let linkId = null;
    try {
      await conn.beginTransaction();

      if (make_default === 1) {
        await conn.execute('UPDATE supplier_bundle_item_links SET is_default = NULL WHERE item_id = ?', [item_id]);
      }

      const [ins] = await conn.execute(
        `INSERT INTO supplier_bundle_item_links (item_id, supplier_part_id, is_default, note)
         VALUES (?,?,?,?)`,
        [item_id, supplier_part_id, make_default, note]
      );
      linkId = ins.insertId;

      await conn.commit();
    } catch (e) {
      await conn.rollback();
      if (e && e.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ message: 'Такой вариант уже добавлен в эту роль' });
      }
      if (e && e.errno === 1452) {
        return res.status(409).json({ type: 'fk_constraint', message: 'Неверный item_id или supplier_part_id' });
      }
      throw e;
    } finally {
      conn.release();
    }

    await logActivity({
      req,
      action: 'create',
      entity_type: 'supplier_bundle_item_links',
      entity_id: linkId,
      comment: `Добавлен вариант supplier_part_id=${supplier_part_id} в item_id=${item_id}${make_default ? ' (default)' : ''}`
    });

    res.status(201).json({ id: linkId, message: 'Вариант добавлен' });
  } catch (e) {
    console.error('POST /supplier-bundles/links error:', e);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

/** PUT /supplier-bundles/links/:id — назначить default (остальным: NULL), вернуть свежий блок по item с ценами */
router.put('/links/:id', auth, checkTabAccess(TAB_PATH), adminOnly, async (req, res) => {
  try {
    const id = toId(req.params.id);
    if (!id) return res.status(400).json({ message: 'Некорректный id' });

    const [[link]] = await db.execute(
      'SELECT id, item_id FROM supplier_bundle_item_links WHERE id=?',
      [id]
    );
    if (!link) return res.status(404).json({ message: 'Ссылка не найдена' });

    const makeDefault = req.body.is_default === true || req.body.is_default === 1;
    const note = nz(req.body.note);

    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();

      if (makeDefault) {
        await conn.execute('UPDATE supplier_bundle_item_links SET is_default = NULL WHERE item_id = ?', [link.item_id]);
        await conn.execute('UPDATE supplier_bundle_item_links SET is_default = 1 WHERE id = ?', [id]);
      }

      if (note !== null) {
        await conn.execute('UPDATE supplier_bundle_item_links SET note = ? WHERE id = ?', [note, id]);
      }

      const [rows] = await conn.execute(
        `
        SELECT
          l.id AS link_id,
          l.item_id,
          i.bundle_id,
          i.role_label,
          i.qty,
          sp.supplier_id,
          s.name AS supplier_name,
          sp.id  AS supplier_part_id,
          sp.supplier_part_number,
          sp.description AS supplier_part_description,
          l.is_default,
          l.note
        FROM supplier_bundle_item_links l
        JOIN supplier_bundle_items i ON i.id = l.item_id
        JOIN supplier_parts sp       ON sp.id = l.supplier_part_id
        JOIN part_suppliers s        ON s.id = sp.supplier_id
        WHERE l.item_id = ?
        ORDER BY l.id ASC
        `,
        [link.item_id]
      );

      await conn.commit();

      // обогащаем последними ценами
      const partIds = Array.from(new Set(rows.map(r => r.supplier_part_id)));
      const latest = await getLatestPricesForPartIds(partIds);
      const map = new Map(latest.map(r => [r.supplier_part_id, r]));

      await logActivity({
        req,
        action: 'update',
        entity_type: 'supplier_bundle_item_links',
        entity_id: id,
        comment: makeDefault ? 'Установлен default для роли' : 'Обновление ссылки (note)'
      });

      return res.json({
        ok: true,
        item_id: link.item_id,
        options: rows.map(r => {
          const lp = map.get(r.supplier_part_id);
          return {
            bundle_id: r.bundle_id,
            item_id: r.item_id,
            role_label: r.role_label,
            qty: Number(r.qty || 1),
            link_id: r.link_id,
            supplier_id: r.supplier_id,
            supplier_name: r.supplier_name,
            supplier_part_id: r.supplier_part_id,
            supplier_part_number: r.supplier_part_number,
            supplier_part_description: r.supplier_part_description,
            is_default: !!r.is_default,
            last_price: lp?.price ?? null,
            last_currency: lp?.currency ?? null,
            last_price_date: lp?.last_price_date ?? null,
            note: r.note || null,
          };
        }),
      });
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  } catch (e) {
    console.error('PUT /supplier-bundles/links/:id error:', e);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

router.delete('/links/:id', auth, checkTabAccess(TAB_PATH), adminOnly, async (req, res) => {
  try {
    const id = toId(req.params.id);
    if (!id) return res.status(400).json({ message: 'Некорректный id' });

    const [del] = await db.execute('DELETE FROM supplier_bundle_item_links WHERE id=?', [id]);
    if (del.affectedRows === 0) return res.status(404).json({ message: 'Ссылка не найдена' });

    await logActivity({
      req,
      action: 'delete',
      entity_type: 'supplier_bundle_item_links',
      entity_id: id,
      comment: 'Удалён вариант поставщика из роли'
    });

    res.json({ message: 'Удалено' });
  } catch (e) {
    console.error('DELETE /supplier-bundles/links/:id error:', e);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

/* ====================================================================== */
/*                            SUMMARY / TOTALS                             */
/* ====================================================================== */

router.get('/:bundleId/totals', auth, checkTabAccess(TAB_PATH), async (req, res) => {
  try {
    const bundleId = toId(req.params.bundleId);
    if (!bundleId) return res.status(400).json({ message: 'Некорректный bundleId' });

    try {
      const [rows] = await db.execute(
        `SELECT bundle_id, currency_iso3, total_price
           FROM v_bundle_totals_by_currency
          WHERE bundle_id=?`,
        [bundleId]
      );
      return res.json(rows.map(r => ({
        bundle_id: r.bundle_id,
        currency_iso3: r.currency_iso3,
        total_price: Number(r.total_price || 0)
      })));
    } catch {
      const [links] = await db.execute(
        `
        SELECT i.qty, l.supplier_part_id
        FROM supplier_bundle_item_links l
        JOIN supplier_bundle_items i ON i.id=l.item_id
        WHERE i.bundle_id=?
        `,
        [bundleId]
      );
      if (!links.length) return res.json([]);

      const partIds = Array.from(new Set(links.map(r => r.supplier_part_id)));
      const latest = await getLatestPricesForPartIds(partIds);
      const map = new Map(latest.map(r => [r.supplier_part_id, r]));

      const totals = new Map();
      for (const r of links) {
        const lp = map.get(r.supplier_part_id);
        if (lp?.price != null && lp?.currency) {
          const add = Number(lp.price) * Number(r.qty || 1);
          totals.set(lp.currency, (totals.get(lp.currency) || 0) + add);
        }
      }
      return res.json(Array.from(totals, ([currency_iso3, total_price]) => ({
        bundle_id: bundleId,
        currency_iso3,
        total_price: Number(total_price.toFixed(2)),
      })));
    }
  } catch (e) {
    console.error('GET /supplier-bundles/:bundleId/totals error:', e);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

router.get('/:bundleId/summary', auth, checkTabAccess(TAB_PATH), async (req, res) => {
  try {
    const bundleId = toId(req.params.bundleId);
    if (!bundleId) return res.status(400).json({ message: 'Некорректный bundleId' });

    const [items] = await db.execute(
      `SELECT id, bundle_id, role_label, qty
         FROM supplier_bundle_items
        WHERE bundle_id=?
        ORDER BY id`,
      [bundleId]
    );

    // options
    let options;
    try {
      const [rows] = await db.execute(
        `
        SELECT 
          v.*,
          s.name AS supplier_name
        FROM v_bundle_item_options v
        LEFT JOIN part_suppliers s ON s.id = v.supplier_id
        WHERE v.bundle_id = ?
        ORDER BY v.item_id, v.link_id ASC
        `,
        [bundleId]
      );
      options = rows;
    } catch {
      const [rows] = await db.execute(
        `
        SELECT
          l.id AS link_id,
          i.id AS item_id,
          i.bundle_id,
          i.role_label,
          i.qty,
          sp.supplier_id,
          s.name AS supplier_name,
          sp.id  AS supplier_part_id,
          sp.supplier_part_number,
          sp.description AS supplier_part_description,
          l.is_default,
          l.note
        FROM supplier_bundle_item_links l
        JOIN supplier_bundle_items i ON i.id = l.item_id
        JOIN supplier_parts sp       ON sp.id = l.supplier_part_id
        JOIN part_suppliers s        ON s.id = sp.supplier_id
        WHERE i.bundle_id = ?
        ORDER BY i.id, l.id ASC
        `,
        [bundleId]
      );

      const partIds = Array.from(new Set(rows.map(r => r.supplier_part_id)));
      const latest = await getLatestPricesForPartIds(partIds);
      const map = new Map(latest.map(r => [r.supplier_part_id, r]));

      options = rows.map(r => {
        const lp = map.get(r.supplier_part_id);
        return {
          bundle_id: r.bundle_id,
          item_id: r.item_id,
          role_label: r.role_label,
          qty: Number(r.qty || 1),
          link_id: r.link_id,
          supplier_id: r.supplier_id,
          supplier_name: r.supplier_name,
          supplier_part_id: r.supplier_part_id,
          supplier_part_number: r.supplier_part_number,
          description: r.supplier_part_description,
          is_default: !!r.is_default,
          last_price: lp?.price ?? null,
          last_currency: lp?.currency ?? null,
          last_price_date: lp?.last_price_date ?? null,
          note: r.note || null,
        };
      });
    }

    // totals
    let totals;
    try {
      const [rows] = await db.execute(
        `SELECT bundle_id, currency_iso3, total_price
           FROM v_bundle_totals_by_currency
          WHERE bundle_id=?`,
        [bundleId]
      );
      totals = rows.map(r => ({
        bundle_id: r.bundle_id,
        currency_iso3: r.currency_iso3,
        total_price: Number(r.total_price || 0),
      }));
    } catch {
      const partIds = Array.from(new Set(options.map(o => o.supplier_part_id)));
      const latest = await getLatestPricesForPartIds(partIds);
      const map = new Map(latest.map(r => [r.supplier_part_id, r]));
      const sums = new Map();
      for (const o of options) {
        if (!o.is_default) continue;
        const lp = map.get(o.supplier_part_id);
        if (lp?.price != null && lp?.currency) {
          const add = Number(lp.price) * Number(o.qty || 1);
          sums.set(lp.currency, (sums.get(lp.currency) || 0) + add);
        }
      }
      totals = Array.from(sums, ([currency_iso3, total_price]) => ({
        bundle_id: bundleId,
        currency_iso3,
        total_price: Number(total_price.toFixed(2)),
      }));
    }

    res.json({ items, options, totals });
  } catch (e) {
    console.error('GET /supplier-bundles/:bundleId/summary error:', e);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

router.get('/:bundleId/order-plan', auth, checkTabAccess(TAB_PATH), async (req, res) => {
  try {
    const bundleId = Number(req.params.bundleId) || 0;
    if (!bundleId) return res.status(400).json({ message: 'Некорректный bundleId' });

    let rows;
    try {
      const [viaView] = await db.execute(
        `
        SELECT
          o.bundle_id,
          o.item_id,
          o.role_label,
          o.qty,
          o.supplier_id,
          s.name AS supplier_name,
          o.supplier_part_id,
          o.supplier_part_number,
          o.supplier_part_description AS description,
          o.last_price,
          o.last_currency,
          o.last_price_date
        FROM v_bundle_item_options o
        LEFT JOIN part_suppliers s ON s.id = o.supplier_id
        WHERE o.bundle_id = ? AND o.is_default = 1
        ORDER BY o.item_id
        `,
        [bundleId]
      );
      rows = viaView;
    } catch {
      const [opt] = await db.execute(
        `
        SELECT
          i.bundle_id,
          i.id AS item_id,
          i.role_label,
          i.qty,
          sp.supplier_id,
          s.name AS supplier_name,
          sp.id  AS supplier_part_id,
          sp.supplier_part_number,
          sp.description AS supplier_part_description
        FROM supplier_bundle_item_links l
        JOIN supplier_bundle_items i ON i.id = l.item_id
        JOIN supplier_parts sp       ON sp.id = l.supplier_part_id
        JOIN part_suppliers s        ON s.id = sp.supplier_id
        WHERE i.bundle_id = ? AND l.is_default = 1
        ORDER BY i.id
        `,
        [bundleId]
      );
      const partIds = Array.from(new Set(opt.map(r => r.supplier_part_id)));
      const latest = await getLatestPricesForPartIds(partIds);
      const map = new Map(latest.map(r => [r.supplier_part_id, r]));
      rows = opt.map(r => {
        const lp = map.get(r.supplier_part_id);
        return {
          ...r,
          last_price: lp?.price ?? null,
          last_currency: lp?.currency ?? null,
          last_price_date: lp?.last_price_date ?? null,
        };
      });
    }

    const perSupplier = new Map();
    for (const r of rows) {
      const key = r.supplier_id || 0;
      if (!perSupplier.has(key)) {
        perSupplier.set(key, {
          supplier_id: r.supplier_id,
          supplier_name: r.supplier_name,
          items: [],
          totalsByCurrency: new Map(),
        });
      }
      const bucket = perSupplier.get(key);
      const need_qty = Number(r.qty || 0);

      bucket.items.push({
        item_id: r.item_id,
        role_label: r.role_label,
        supplier_part_id: r.supplier_part_id,
        supplier_part_number: r.supplier_part_number,
        description: r.description || r.supplier_part_description,
        need_qty,
        last_price: r.last_price,
        last_currency: r.last_currency,
        last_price_date: r.last_price_date,
      });

      if (r.last_price && r.last_currency) {
        const add = Number(r.last_price) * need_qty;
        bucket.totalsByCurrency.set(r.last_currency, (bucket.totalsByCurrency.get(r.last_currency) || 0) + add);
      }
    }

    const suppliers = Array.from(perSupplier.values()).map(s => ({
      supplier_id: s.supplier_id,
      supplier_name: s.supplier_name,
      items: s.items,
      totals: Array.from(s.totalsByCurrency, ([currency, total]) => ({ currency, total: Number(total.toFixed(2)) })),
    }));

    res.json({ bundle_id: bundleId, suppliers });
  } catch (e) {
    console.error('GET /supplier-bundles/:bundleId/order-plan error:', e);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

module.exports = router;
