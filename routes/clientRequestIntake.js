const express = require('express')
const requireCapability = require('../middleware/requireCapability')
const { commitIntake, validateIntake } = require('../services/clientRequests/intakeService')
const { getRegistry } = require('../services/clientRequests/registryReadModel')
const { sendDomainError } = require('../services/clientRequests/domainError')

const router = express.Router()

const handler = (fn) => async (req, res) => {
  try {
    await fn(req, res)
  } catch (error) {
    if (sendDomainError(res, error)) return
    console.error('Client Request intake route error:', error)
    res.status(500).json({ message: 'Ошибка пакетной регистрации заявки' })
  }
}

router.get(
  '/registry',
  requireCapability('client_requests.access'),
  handler(async (req, res) => res.json(await getRegistry(req.query)))
)

router.post(
  '/intake/validate',
  requireCapability('client_requests.create'),
  handler(async (req, res) => res.json(await validateIntake(req.body || {}, req.user?.id)))
)

router.post(
  '/intake/commit',
  requireCapability('client_requests.create'),
  handler(async (req, res) => res.status(201).json(await commitIntake(req.body || {}, req.user?.id)))
)

module.exports = router
