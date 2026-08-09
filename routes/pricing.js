const express = require('express')
const requireCapability = require('../middleware/requireCapability')
const { createCaseFromSourcingDecision, createGroup, createReworkSignal, createVariant, fixInput, reviseVariantParameters } = require('../services/pricing/caseService')
const { approveClientPrices, calculateVariant, finalizePricingDecision, requestPriceOverride, reviewPriceOverride, selectVariant } = require('../services/pricing/calculationService')
const { getWorkspace, listCases, listRouteTemplates, listSourcingDecisionIntake, revealSupplierIdentity } = require('../services/pricing/readModel')
const { sendDomainError } = require('../services/pricing/domainError')

const router = express.Router()
const handler = (fn) => async (req, res) => {
  try { await fn(req, res) } catch (error) {
    if (sendDomainError(res, error)) return
    console.error('Pricing route error:', error)
    res.status(500).json({ message: 'Ошибка Pricing Domain' })
  }
}

router.get('/cases', requireCapability('pricing.access'), handler(async (req, res) => res.json(await listCases(req.query))))
router.get('/route-templates', requireCapability('pricing.groups.manage'), handler(async (req, res) => res.json(await listRouteTemplates())))
router.get('/intake/sourcing-decisions', requireCapability('pricing.access'), handler(async (req, res) => res.json(await listSourcingDecisionIntake())))
router.post('/cases/from-sourcing-decision', requireCapability('pricing.cases.manage'), handler(async (req, res) => res.status(201).json(await createCaseFromSourcingDecision(req.body, req.user?.id))))
router.get('/cases/:id', requireCapability('pricing.access'), handler(async (req, res) => res.json(await getWorkspace(req.params.id, req.user))))
router.post('/cases/:id/fix-input', requireCapability('pricing.cases.manage'), handler(async (req, res) => res.json(await fixInput(req.params.id, req.user?.id))))
router.post('/cases/:id/groups', requireCapability('pricing.groups.manage'), handler(async (req, res) => res.status(201).json(await createGroup(req.params.id, req.body, req.user?.id))))
router.post('/cases/:id/rework-signals', requireCapability('pricing.cases.manage'), handler(async (req, res) => res.status(201).json(await createReworkSignal(req.params.id, req.body, req.user?.id))))
router.post('/groups/:id/variants', requireCapability('pricing.groups.manage'), handler(async (req, res) => res.status(201).json(await createVariant(req.params.id, req.body, req.user?.id))))
router.post('/variants/:id/parameters', requireCapability('pricing.groups.manage'), handler(async (req, res) => res.status(201).json(await reviseVariantParameters(req.params.id, req.body, req.user?.id))))
router.post('/variants/:id/calculate', requireCapability('pricing.calculate'), handler(async (req, res) => res.status(201).json(await calculateVariant(req.params.id, req.user?.id))))
router.post('/variants/:id/select', requireCapability('pricing.calculate'), handler(async (req, res) => res.json(await selectVariant(req.params.id, req.user?.id))))
router.post('/cases/:id/client-prices/approve', requireCapability('pricing.client_prices.manage'), handler(async (req, res) => res.json(await approveClientPrices(req.params.id, req.body, req.user?.id))))
router.post('/client-price-lines/:id/override-requests', requireCapability('pricing.client_prices.manage'), handler(async (req, res) => res.status(201).json(await requestPriceOverride(req.params.id, req.body, req.user?.id))))
router.post('/price-overrides/:id/review', requireCapability('pricing.overrides.approve'), handler(async (req, res) => res.json(await reviewPriceOverride(req.params.id, req.body, req.user?.id))))
router.post('/cases/:id/decisions/finalize', requireCapability('pricing.decisions.finalize'), handler(async (req, res) => res.status(201).json(await finalizePricingDecision(req.params.id, req.body, req.user?.id))))
router.get('/input-lines/:id/supplier-identity', requireCapability('pricing.supplier_identity.reveal'), handler(async (req, res) => res.json(await revealSupplierIdentity(req.params.id, req.user))))

module.exports = router
