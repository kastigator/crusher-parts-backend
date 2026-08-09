const express=require('express')
const requireCapability=require('../middleware/requireCapability')
const {sendDomainError}=require('../services/financialOperations/domainError')
const commands=require('../services/financialOperations/commandService')
const reads=require('../services/financialOperations/readModel')
const router=express.Router()
const handler=(fn)=>async(req,res)=>{try{await fn(req,res)}catch(error){if(sendDomainError(res,error))return;console.error('Financial Operations route error:',error);res.status(500).json({message:'Ошибка Financial Operations'})}}

router.get('/overview',requireCapability('financial_operations.access'),handler(async(req,res)=>res.json(await reads.getOverview())))
router.get('/workspace',requireCapability('financial_operations.access'),handler(async(req,res)=>res.json(await reads.getWorkspace())))
router.get('/purchase-orders/:id/summary',requireCapability('financial_operations.access'),handler(async(req,res)=>res.json(await reads.getPoFinancialSummary(req.params.id))))
router.get('/completion-readiness',requireCapability('financial_operations.completion.view'),handler(async(req,res)=>res.json(await reads.getCompletionReadiness())))
router.post('/ap/from-accepted-confirmations/:id',requireCapability('financial_operations.ap.manage'),handler(async(req,res)=>res.status(201).json(await commands.materializeApFromAcceptedConfirmation(req.params.id,req.user?.id))))
router.post('/triggers',requireCapability('financial_operations.ap.manage'),handler(async(req,res)=>res.status(201).json(await commands.applyTrigger(req.body,req.user?.id))))
router.post('/supplier-invoices',requireCapability('financial_operations.ap.invoices'),handler(async(req,res)=>res.status(201).json(await commands.registerSupplierInvoice(req.body,req.user?.id))))
router.post('/supplier-credit-notes',requireCapability('financial_operations.ap.invoices'),handler(async(req,res)=>res.status(201).json(await commands.registerCreditNote(req.body,req.user?.id))))
router.post('/payment-plans',requireCapability('financial_operations.ap.payments'),handler(async(req,res)=>res.status(201).json(await commands.createPaymentPlan(req.body,req.user?.id))))
router.post('/supplier-payments',requireCapability('financial_operations.ap.payments'),handler(async(req,res)=>res.status(201).json(await commands.registerSupplierPayment(req.body,req.user?.id))))
router.post('/disputes',requireCapability('financial_operations.ap.disputes'),handler(async(req,res)=>res.status(201).json(await commands.openDispute(req.body,req.user?.id))))
router.post('/receivables/from-contract-commitments/:id',requireCapability('financial_operations.ar.manage'),handler(async(req,res)=>res.status(201).json(await commands.materializeReceivable(req.params.id,req.user?.id))))
router.post('/customer-payments',requireCapability('financial_operations.ar.payments'),handler(async(req,res)=>res.status(201).json(await commands.registerCustomerPayment(req.body,req.user?.id))))
router.post('/customer-credit-adjustments',requireCapability('financial_operations.adjustments'),handler(async(req,res)=>res.status(201).json(await commands.registerCustomerCreditAdjustment(req.body,req.user?.id))))

module.exports=router
