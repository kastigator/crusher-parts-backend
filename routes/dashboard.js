const express = require('express')
const router = express.Router()

router.get('/summary', (_req, res) => {
  res.json({
    totals: {
      orders_total: 0,
      orders_active: 0,
      orders_new: 0,
      orders_draft: 0,
    },
    alerts: {
      unassigned: 0,
      items_no_offers: 0,
      items_await_decision: 0,
      contracts_in_work: 0,
      contracts_no_file: 0,
    },
    recent_orders: [],
    recent_contracts: [],
    orders_without_offers: [],
    orders_awaiting_decision: [],
  })
})

router.get('/events', (_req, res) => {
  res.json([])
})

module.exports = router
