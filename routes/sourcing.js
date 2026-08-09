const express = require('express')
const requireCapability = require('../middleware/requireCapability')
const { acceptCase, archiveCase, createCaseFromRelease } = require('../services/sourcing/caseService')
const { createInquiry, dispatchInquiry, finalizeInquiryRevision } = require('../services/sourcing/inquiryService')
const { createOffer, finalizeOffer } = require('../services/sourcing/offerService')
const { createCoverageOption, finalizeDecision, validateDecision } = require('../services/sourcing/coverageDecisionService')
const { requestMasterDataPromotion } = require('../services/sourcing/promotionService')
const { getWorkspace, listCases, listReleaseIntake, listSuppliers } = require('../services/sourcing/readModel')
const { sendDomainError } = require('../services/sourcing/domainError')

const router = express.Router()
const handler = (fn) => async (req, res) => {
  try { await fn(req, res) } catch (error) {
    if (sendDomainError(res, error)) return
    console.error('Sourcing route error:', error)
    res.status(500).json({ message: 'Ошибка Sourcing Domain' })
  }
}

router.get('/cases', requireCapability('sourcing.access'), handler(async (req, res) => res.json(await listCases(req.query))))
router.get('/intake/procurement-releases', requireCapability('sourcing.access'), handler(async (req, res) => res.json(await listReleaseIntake())))
router.get('/reference/suppliers', requireCapability('sourcing.access'), handler(async (req, res) => res.json(await listSuppliers())))
router.post('/cases/from-release', requireCapability('sourcing.cases.manage'), handler(async (req, res) => res.status(201).json(await createCaseFromRelease(req.body, req.user?.id))))
router.get('/cases/:id', requireCapability('sourcing.access'), handler(async (req, res) => res.json(await getWorkspace(req.params.id))))
router.post('/cases/:id/accept', requireCapability('sourcing.cases.manage'), handler(async (req, res) => res.json(await acceptCase(req.params.id, req.user?.id))))
router.post('/cases/:id/archive', requireCapability('sourcing.cases.manage'), handler(async (req, res) => res.json(await archiveCase(req.params.id, req.body, req.user?.id))))
router.post('/cases/:id/inquiries', requireCapability('sourcing.inquiries.manage'), handler(async (req, res) => res.status(201).json(await createInquiry(req.params.id, req.body, req.user?.id))))
router.post('/inquiries/:id/finalize', requireCapability('sourcing.inquiries.manage'), handler(async (req, res) => res.json(await finalizeInquiryRevision(req.params.id, req.user?.id))))
router.post('/inquiries/:id/dispatches', requireCapability('sourcing.inquiries.manage'), handler(async (req, res) => res.status(201).json(await dispatchInquiry(req.params.id, req.body, req.user?.id))))
router.post('/cases/:id/offers', requireCapability('sourcing.offers.manage'), handler(async (req, res) => res.status(201).json(await createOffer(req.params.id, req.body, req.user?.id))))
router.post('/offers/:id/finalize', requireCapability('sourcing.offers.manage'), handler(async (req, res) => res.json(await finalizeOffer(req.params.id, req.user?.id))))
router.post('/cases/:id/coverage-options', requireCapability('sourcing.coverage.manage'), handler(async (req, res) => res.status(201).json(await createCoverageOption(req.params.id, req.body, req.user?.id))))
router.post('/cases/:id/decisions/validate', requireCapability('sourcing.access'), handler(async (req, res) => res.json(await validateDecision(req.params.id, req.body.option_ids))))
router.post('/cases/:id/decisions/finalize', requireCapability('sourcing.decisions.finalize'), handler(async (req, res) => res.status(201).json(await finalizeDecision(req.params.id, req.body, req.user?.id))))
router.post('/offer-lines/:id/master-data-promotion-requests', requireCapability('sourcing.master_data_promotion.request'), handler(async (req, res) => res.status(201).json(await requestMasterDataPromotion(req.params.id, req.body, req.user?.id))))

module.exports = router
