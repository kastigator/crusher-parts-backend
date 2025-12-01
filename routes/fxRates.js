const express = require('express')
const router = express.Router()

const { getRate, convertAmount } = require('../utils/fxRatesService')

const normCode = (v) =>
  v ? String(v).trim().toUpperCase().slice(0, 3) : null

// GET /fx/convert?from=USD&to=EUR&amount=10
router.get('/convert', async (req, res) => {
  try {
    const from = normCode(req.query.from)
    const to = normCode(req.query.to)
    const amount =
      req.query.amount !== undefined ? Number(req.query.amount) : null
    if (!from || !to) {
      return res.status(400).json({ message: 'Укажите from и to (ISO3)' })
    }
    if (amount !== null && !Number.isFinite(amount)) {
      return res.status(400).json({ message: 'amount должен быть числом' })
    }
    const result = await convertAmount(amount, from, to)
    res.json({
      rate: result.rate,
      converted: result.value,
      source: result.source,
      fetched_at: result.fetchedAt,
    })
  } catch (err) {
    console.error('GET /fx/convert error:', err)
    res.status(500).json({ message: 'Не удалось получить курс' })
  }
})

// GET /fx/rates?base=USD&symbols=EUR,GBP
router.get('/rates', async (req, res) => {
  try {
    const base = normCode(req.query.base)
    const symbols = String(req.query.symbols || '')
      .split(',')
      .map(normCode)
      .filter(Boolean)

    if (!base) {
      return res.status(400).json({ message: 'Укажите base (ISO3)' })
    }
    if (!symbols.length) {
      return res.status(400).json({ message: 'Укажите symbols через запятую' })
    }

    const result = {}
    for (const sym of symbols) {
      if (sym === base) {
        result[sym] = { rate: 1, source: 'same', fetched_at: new Date() }
        continue
      }
      try {
        const r = await getRate(base, sym)
        result[sym] = {
          rate: r.rate,
          source: r.source,
          fetched_at: r.fetchedAt,
        }
      } catch (err) {
        result[sym] = { error: err.message || 'Не удалось получить курс' }
      }
    }

    res.json({ base, rates: result })
  } catch (err) {
    console.error('GET /fx/rates error:', err)
    res.status(500).json({ message: 'Не удалось получить курсы' })
  }
})

module.exports = router
