const express = require('express')
const requireCapability = require('../middleware/requireCapability')
const { sendDomainError } = require('../services/contracts/domainError')
const {
  addClause,analyzeImpact,createFromAcceptedCommercial,createRevision,decideApproval,generateDocument,makeEffective,
  markReadyForSignature,patchClause,patchRevision,registerDocument,registerSignature,requestApproval,sendRevision,submitReview,upsertTerm,
} = require('../services/contracts/commandService')
const { buildPreview,compareRevisions,evaluateReadiness,getWorkspace,listAcceptedCommercialIntake,listCases,listCommitments } = require('../services/contracts/readModel')

const router = express.Router()
const handler = (fn) => async (req,res) => {
  try { await fn(req,res) } catch (error) {
    if (sendDomainError(res,error)) return
    console.error('Contract Domain route error:',error)
    res.status(500).json({ message:'Ошибка Contract Domain' })
  }
}

router.get('/cases',requireCapability('contracts.access'),handler(async (req,res) => res.json(await listCases(req.query))))
router.get('/accepted-commercial-results',requireCapability('contracts.access'),handler(async (req,res) => res.json(await listAcceptedCommercialIntake())))
router.post('/cases/from-accepted-commercial',requireCapability('contracts.manage'),handler(async (req,res) => res.status(201).json(await createFromAcceptedCommercial(req.body,req.user?.id))))
router.get('/cases/:id',requireCapability('contracts.access'),handler(async (req,res) => res.json(await getWorkspace(req.params.id))))
router.post('/cases/:id/revisions',requireCapability('contracts.manage'),handler(async (req,res) => res.status(201).json(await createRevision(req.params.id,req.body,req.user?.id))))
router.get('/cases/:id/revisions/:from/compare/:to',requireCapability('contracts.access'),handler(async (req,res) => res.json(await compareRevisions(req.params.id,req.params.from,req.params.to))))
router.get('/cases/:id/commitments',requireCapability('contracts.access'),handler(async (req,res) => res.json(await listCommitments(req.params.id))))
router.patch('/revisions/:id',requireCapability('contracts.manage'),handler(async (req,res) => res.json(await patchRevision(req.params.id,req.body,req.user?.id))))
router.put('/revisions/:id/terms',requireCapability('contracts.legal_review'),handler(async (req,res) => res.json(await upsertTerm(req.params.id,req.body,req.user?.id))))
router.post('/revisions/:id/clauses',requireCapability('contracts.legal_review'),handler(async (req,res) => res.status(201).json(await addClause(req.params.id,req.body,req.user?.id))))
router.patch('/clauses/:id',requireCapability('contracts.legal_review'),handler(async (req,res) => res.json(await patchClause(req.params.id,req.body,req.user?.id))))
router.post('/revisions/:id/analyze-impact',requireCapability('contracts.legal_review'),handler(async (req,res) => res.status(201).json(await analyzeImpact(req.params.id,req.body,req.user?.id))))
router.post('/revisions/:id/approvals',requireCapability('contracts.approvals.request'),handler(async (req,res) => res.status(201).json(await requestApproval(req.params.id,req.body,req.user?.id))))
router.post('/approvals/:id/decision',requireCapability('contracts.approvals.decide'),handler(async (req,res) => res.json(await decideApproval(req.params.id,req.body,req.user?.id))))
router.get('/revisions/:id/readiness',requireCapability('contracts.access'),handler(async (req,res) => res.json(await evaluateReadiness(req.params.id))))
router.get('/revisions/:id/preview',requireCapability('contracts.access'),handler(async (req,res) => { const preview=await buildPreview(req.params.id);res.json({ payload:preview.payload,content_hash:preview.content_hash }) }))
router.post('/revisions/:id/submit-review',requireCapability('contracts.manage'),handler(async (req,res) => res.json(await submitReview(req.params.id,req.user?.id))))
router.post('/revisions/:id/documents/generate',requireCapability('contracts.documents.manage'),handler(async (req,res) => res.status(201).json(await generateDocument(req.params.id,req.body,req.user?.id))))
router.post('/revisions/:id/documents/register',requireCapability('contracts.documents.manage'),handler(async (req,res) => res.status(201).json(await registerDocument(req.params.id,req.body,req.user?.id))))
router.post('/revisions/:id/send',requireCapability('contracts.send_external'),handler(async (req,res) => res.status(201).json(await sendRevision(req.params.id,req.body,req.user?.id))))
router.post('/revisions/:id/ready-for-signature',requireCapability('contracts.sign'),handler(async (req,res) => res.json(await markReadyForSignature(req.params.id,req.user?.id))))
router.post('/revisions/:id/signatures',requireCapability('contracts.sign'),handler(async (req,res) => res.status(201).json(await registerSignature(req.params.id,req.body,req.user?.id))))
router.post('/revisions/:id/make-effective',requireCapability('contracts.make_effective'),handler(async (req,res) => res.json(await makeEffective(req.params.id,req.body,req.user?.id))))

module.exports = router
