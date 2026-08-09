const express = require('express')
const requireCapability = require('../middleware/requireCapability')
const {
  acceptFeedback, assessFeedback, compareRevisions, createFromPricingDecision, createRevisionFromPricingDecision,
  createNextRevision, decideApproval, markReady, patchLine, patchRevision,
  registerFeedback, renderDocument, requestApproval, sendRevision, submitReview,
} = require('../services/commercialOffers/commandService')
const {
  buildClientPreview, evaluateReadiness, getAcceptedResult, getWorkspace, listOffers, listPricingDecisionIntake,
} = require('../services/commercialOffers/readModel')
const { sendDomainError } = require('../services/commercialOffers/domainError')

const router = express.Router()
const handler = (fn) => async (req,res) => {
  try { await fn(req,res) } catch (error) {
    if (sendDomainError(res,error)) return
    console.error('Commercial Offer route error:',error)
    res.status(500).json({ message: 'Ошибка Commercial Offer Domain' })
  }
}

router.get('/offers',requireCapability('commercial_offers.access'),handler(async (req,res) => res.json(await listOffers(req.query))))
router.get('/pricing-decisions',requireCapability('commercial_offers.access'),handler(async (req,res) => res.json(await listPricingDecisionIntake())))
router.post('/offers/from-pricing-decision',requireCapability('commercial_offers.manage'),handler(async (req,res) => res.status(201).json(await createFromPricingDecision(req.body,req.user?.id))))
router.get('/offers/:id',requireCapability('commercial_offers.access'),handler(async (req,res) => res.json(await getWorkspace(req.params.id))))
router.post('/offers/:id/revisions/from-pricing-decision',requireCapability('commercial_offers.manage'),handler(async (req,res) => res.status(201).json(await createRevisionFromPricingDecision(req.params.id,req.body,req.user?.id))))
router.patch('/revisions/:id',requireCapability('commercial_offers.manage'),handler(async (req,res) => res.json(await patchRevision(req.params.id,req.body,req.user?.id))))
router.patch('/lines/:id',requireCapability('commercial_offers.manage'),handler(async (req,res) => res.json(await patchLine(req.params.id,req.body,req.user?.id))))
router.get('/revisions/:id/readiness',requireCapability('commercial_offers.access'),handler(async (req,res) => res.json(await evaluateReadiness(req.params.id))))
router.get('/revisions/:id/client-preview',requireCapability('commercial_offers.access'),handler(async (req,res) => {
  const preview = await buildClientPreview(req.params.id)
  res.json({ payload: preview.payload,payload_hash: preview.payload_hash,confidentiality_findings: preview.confidentiality_findings })
}))
router.post('/revisions/:id/submit-review',requireCapability('commercial_offers.manage'),handler(async (req,res) => res.json(await submitReview(req.params.id,req.user?.id))))
router.post('/revisions/:id/approvals',requireCapability('commercial_offers.approvals.request'),handler(async (req,res) => res.status(201).json(await requestApproval(req.params.id,req.body,req.user?.id))))
router.post('/approvals/:id/decision',requireCapability('commercial_offers.approvals.decide'),handler(async (req,res) => res.json(await decideApproval(req.params.id,req.body,req.user?.id))))
router.post('/revisions/:id/ready',requireCapability('commercial_offers.issue'),handler(async (req,res) => res.json(await markReady(req.params.id,req.user?.id))))
router.post('/revisions/:id/render',requireCapability('commercial_offers.issue'),handler(async (req,res) => res.status(201).json(await renderDocument(req.params.id,req.user?.id))))
router.post('/revisions/:id/send',requireCapability('commercial_offers.issue'),handler(async (req,res) => res.status(201).json(await sendRevision(req.params.id,req.body,req.user?.id))))
router.post('/offers/:id/feedback',requireCapability('commercial_offers.feedback.manage'),handler(async (req,res) => res.status(201).json(await registerFeedback(req.params.id,req.body,req.user?.id))))
router.post('/feedback/:id/assess-impact',requireCapability('commercial_offers.feedback.manage'),handler(async (req,res) => res.status(201).json(await assessFeedback(req.params.id,req.user?.id))))
router.post('/feedback/:id/create-next-revision',requireCapability('commercial_offers.manage'),handler(async (req,res) => res.status(201).json(await createNextRevision(req.params.id,req.body,req.user?.id))))
router.post('/offers/:id/acceptance',requireCapability('commercial_offers.accept'),handler(async (req,res) => res.status(201).json(await acceptFeedback(req.params.id,req.body,req.user?.id))))
router.get('/offers/:id/accepted-result',requireCapability('commercial_offers.access'),handler(async (req,res) => res.json(await getAcceptedResult(req.params.id))))
router.get('/offers/:id/revisions/:from/compare/:to',requireCapability('commercial_offers.access'),handler(async (req,res) => res.json(await compareRevisions(req.params.id,req.params.from,req.params.to))))

module.exports = router
