const express = require('express')
const { buildReleaseInfo } = require('../utils/releaseInfo')

const router = express.Router()

router.get('/', (req, res) => {
  res.set('Cache-Control', 'no-store')
  res.json(buildReleaseInfo())
})

module.exports = router
