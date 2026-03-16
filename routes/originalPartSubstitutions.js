// routes/originalPartSubstitutions.js
const express = require('express')
const router = express.Router()

const legacySubstitutionsRemoved = {
  message:
    'Legacy-группы замен больше не поддерживаются: substitutions были удалены после перехода на OEM-модель.',
}

/* ----------------------------------------------
   Legacy compatibility shim
   ---------------------------------------------- */

router.get('/', async (_req, res) => {
  res.json([])
})

router.get('/:id/resolve', async (_req, res) => {
  res.json({ mode: 'ANY', options: [] })
})

router.post('/', async (_req, res) => {
  res.status(409).json(legacySubstitutionsRemoved)
})

router.put('/:id', async (_req, res) => {
  res.status(409).json(legacySubstitutionsRemoved)
})

router.delete('/:id', async (_req, res) => {
  res.status(409).json(legacySubstitutionsRemoved)
})

router.post('/:id/items', async (_req, res) => {
  res.status(409).json(legacySubstitutionsRemoved)
})

router.put('/:id/items', async (_req, res) => {
  res.status(409).json(legacySubstitutionsRemoved)
})

router.delete('/:id/items', async (_req, res) => {
  res.status(409).json(legacySubstitutionsRemoved)
})

module.exports = router
