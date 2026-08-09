const express = require('express')
const db = require('../utils/db')
const requireCapability = require('../middleware/requireCapability')
const { createProcurementRelease } = require('../services/clientRequests/procurementReleaseService')
const { ClientRequestDomainError, sendDomainError } = require('../services/clientRequests/domainError')

const router = express.Router()

router.post('/', requireCapability('client_requests.release_to_procurement'), async (req, res) => {
  try {
    const result = await createProcurementRelease(req.body, req.user?.id)
    res.status(result.idempotent_replay ? 200 : 201).json(result)
  } catch (error) {
    if (sendDomainError(res, error)) return
    console.error('POST /procurement-releases error:', error)
    res.status(500).json({ message: 'Ошибка создания Procurement Release' })
  }
})

router.get('/:id', requireCapability('client_requests.access'), async (req, res) => {
  try {
    const releaseId = Number(req.params.id)
    if (!Number.isInteger(releaseId) || releaseId <= 0) {
      throw new ClientRequestDomainError('VALIDATION_ERROR', 'Некорректный Procurement Release')
    }
    const [[release]] = await db.execute('SELECT * FROM procurement_releases WHERE id = ?', [releaseId])
    if (!release) {
      throw new ClientRequestDomainError('PROCUREMENT_RELEASE_NOT_FOUND', 'Procurement Release не найден', 404)
    }
    const [items] = await db.execute(
      'SELECT * FROM procurement_release_items WHERE procurement_release_id = ? ORDER BY line_number_snapshot',
      [releaseId]
    )
    res.json({ release, items })
  } catch (error) {
    if (sendDomainError(res, error)) return
    console.error('GET /procurement-releases/:id error:', error)
    res.status(500).json({ message: 'Ошибка чтения Procurement Release' })
  }
})

module.exports = router
