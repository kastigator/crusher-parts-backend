const express = require('express');
const db = require('../utils/db');
const authMiddleware = require('../middleware/authMiddleware');
const adminOnly = require('../middleware/adminOnly');
const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const [rows] = await db.execute(
      'SELECT id, name, tab_name, path, icon, type, config, is_active, `order` FROM tabs WHERE is_active = 1 ORDER BY `order` ASC'
    );
    res.json(rows);
  } catch (err) {
    console.error('Ошибка при получении вкладок:', err);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

router.post('/', authMiddleware, adminOnly, async (req, res) => {
  const { name, tab_name, path, icon, type, config, is_active = 1, order = 0 } = req.body;

  if (
    typeof name !== 'string' ||
    typeof tab_name !== 'string' ||
    typeof path !== 'string'
  ) {
    return res.status(400).json({ message: 'Обязательные поля: name, tab_name, path (строки)' });
  }

  try {
    await db.execute(
      'INSERT INTO tabs (name, tab_name, path, icon, type, config, is_active, `order`) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [name, tab_name, path, icon || null, type || null, config || null, is_active, order]
    );
    res.status(201).json({ message: 'Вкладка добавлена' });
  } catch (err) {
    console.error('Ошибка при добавлении вкладки:', err);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

router.put('/order', authMiddleware, adminOnly, async (req, res) => {
  const tabsOrder = req.body;
  if (!Array.isArray(tabsOrder)) {
    return res.status(400).json({ message: 'Ожидается массив объектов с id и order' });
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    for (const item of tabsOrder) {
      const { id, order } = item;
      if (typeof id !== 'number' || typeof order !== 'number') {
        await conn.rollback();
        return res.status(400).json({ message: 'Неверный формат данных: id и order должны быть числами' });
      }
      await conn.execute('UPDATE tabs SET `order` = ? WHERE id = ?', [order, id]);
    }
    await conn.commit();
    res.json({ message: 'Порядок вкладок обновлён' });
  } catch (err) {
    await conn.rollback();
    console.error('Ошибка при обновлении порядка вкладок:', err);
    res.status(500).json({ message: 'Ошибка сервера' });
  } finally {
    conn.release();
  }
});

router.put('/:id', authMiddleware, adminOnly, async (req, res) => {
  const { id } = req.params;
  const { name, tab_name, path, icon, type, config, is_active = 1, order = 0 } = req.body;

  if (
    typeof name !== 'string' ||
    typeof tab_name !== 'string' ||
    typeof path !== 'string'
  ) {
    return res.status(400).json({ message: 'Обязательные поля: name, tab_name, path (строки)' });
  }

  try {
    const [result] = await db.execute(
      'UPDATE tabs SET name=?, tab_name=?, path=?, icon=?, type=?, config=?, is_active=?, `order`=? WHERE id=?',
      [name, tab_name, path, icon || null, type || null, config || null, is_active, order, id]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Вкладка не найдена' });
    }
    res.json({ message: 'Вкладка обновлена' });
  } catch (err) {
    console.error('Ошибка при обновлении вкладки:', err);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

router.delete('/:id', authMiddleware, adminOnly, async (req, res) => {
  const { id } = req.params;
  try {
    const [result] = await db.execute('DELETE FROM tabs WHERE id = ?', [id]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Вкладка не найдена' });
    }
    res.json({ message: 'Вкладка удалена' });
  } catch (err) {
    console.error('Ошибка при удалении вкладки:', err);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

module.exports = router;
