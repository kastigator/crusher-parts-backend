const express = require('express')
const requireCapability = require('../middleware/requireCapability')
const { finalizeRevision } = require('../services/clientRequests/clientRequestService')
const { setIdentification, setRequirements } = require('../services/clientRequests/itemService')
const {
  getRevisionItems,
  getRevisionReadiness,
  getWorkspace,
  listReleases,
} = require('../services/clientRequests/clientRequestReadModel')
const { sendDomainError } = require('../services/clientRequests/domainError')

const router = express.Router()

const handler = (fn) => async (req, res) => {
  try {
    await fn(req, res)
  } catch (error) {
    if (sendDomainError(res, error)) return
    console.error('Client Request domain route error:', error)
    res.status(500).json({ message: 'Ошибка Client Request Domain' })
  }
}

router.get(
  '/:id/domain-workspace',
  requireCapability('client_requests.access'),
  handler(async (req, res) => res.json(await getWorkspace(req.params.id)))
)

router.get(
  '/:id/procurement-releases',
  requireCapability('client_requests.access'),
  handler(async (req, res) => res.json(await listReleases(req.params.id)))
)

router.get(
  '/revisions/:revisionId/identification',
  requireCapability('client_requests.access'),
  handler(async (req, res) => res.json(await getRevisionItems(req.params.revisionId)))
)

router.get(
  '/revisions/:revisionId/readiness',
  requireCapability('client_requests.access'),
  handler(async (req, res) => res.json(await getRevisionReadiness(req.params.revisionId)))
)

router.post(
  '/revisions/:revisionId/finalize',
  requireCapability('client_requests.manage_revisions'),
  handler(async (req, res) => {
    res.json(await finalizeRevision(req.params.revisionId, req.user?.id))
  })
)

router.put(
  '/items/:itemId/identification',
  requireCapability('client_requests.identify_items'),
  handler(async (req, res) => {
    res.json(await setIdentification(req.params.itemId, req.body, req.user?.id))
  })
)

router.put(
  '/items/:itemId/requirements',
  requireCapability('client_requests.manage_requirements'),
  handler(async (req, res) => {
    res.json(await setRequirements(req.params.itemId, req.body, req.user?.id))
  })
)

module.exports = router
