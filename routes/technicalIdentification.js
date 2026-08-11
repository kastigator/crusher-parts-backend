const express = require('express')
const requireCapability = require('../middleware/requireCapability')
const { sendDomainError } = require('../services/clientRequests/domainError')
const { validateBatch } = require('../services/technicalIdentification/matchService')
const { getTaskDetail, listTasks } = require('../services/technicalIdentification/readModel')
const {
  createTasksBatch,
  reopenTask,
  resolveTask,
  runTaskCommand,
} = require('../services/technicalIdentification/taskService')

const router = express.Router()

const handler = (fn) => async (req, res) => {
  try {
    await fn(req, res)
  } catch (error) {
    if (sendDomainError(res, error)) return
    console.error('Technical Identification route error:', error)
    res.status(500).json({ message: 'Ошибка технической идентификации' })
  }
}

router.get(
  '/tasks',
  requireCapability('technical_identification.access'),
  handler(async (req, res) => res.json(await listTasks({ ...req.query, user_id: req.query.user_id || req.user?.id })))
)

router.get(
  '/tasks/:id',
  requireCapability('technical_identification.access'),
  handler(async (req, res) => res.json(await getTaskDetail(req.params.id)))
)

router.post(
  '/match-candidates',
  requireCapability('technical_identification.access'),
  handler(async (req, res) => res.json(await validateBatch(req.body || {})))
)

router.post(
  '/tasks/batch',
  requireCapability('client_requests.identify_items'),
  handler(async (req, res) => res.status(201).json(await createTasksBatch(req.body || {}, req.user?.id)))
)

router.post(
  '/tasks/:id/claim',
  requireCapability('technical_identification.manage'),
  handler(async (req, res) => res.json(await runTaskCommand(req.params.id, req.body || {}, req.user?.id, 'claim')))
)

router.post(
  '/tasks/:id/assign',
  requireCapability('technical_identification.assign'),
  handler(async (req, res) => res.json(await runTaskCommand(req.params.id, req.body || {}, req.user?.id, 'assign')))
)

router.post(
  '/tasks/:id/wait-for-client',
  requireCapability('technical_identification.manage'),
  handler(async (req, res) => res.json(await runTaskCommand(req.params.id, req.body || {}, req.user?.id, 'wait_for_client')))
)

router.post(
  '/tasks/:id/resume',
  requireCapability('technical_identification.manage'),
  handler(async (req, res) => res.json(await runTaskCommand(req.params.id, req.body || {}, req.user?.id, 'resume')))
)

router.post(
  '/tasks/:id/cancel',
  requireCapability('technical_identification.manage'),
  handler(async (req, res) => res.json(await runTaskCommand(req.params.id, req.body || {}, req.user?.id, 'cancel')))
)

router.post(
  '/tasks/:id/resolve',
  requireCapability('technical_identification.resolve'),
  handler(async (req, res) => res.json(await resolveTask(req.params.id, req.body || {}, req.user?.id)))
)

router.post(
  '/tasks/:id/reopen',
  requireCapability('technical_identification.resolve'),
  handler(async (req, res) => res.status(201).json(await reopenTask(req.params.id, req.body || {}, req.user?.id)))
)

module.exports = router
