const express = require('express')
const router = express.Router()

router.get('/', (_req, res) => {
  res.json({ items: [], message: 'Coverage matrix will be implemented on top of RFQ data.' })
})

module.exports = router
