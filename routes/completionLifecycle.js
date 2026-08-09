const express=require('express')
const requireCapability=require('../middleware/requireCapability')
const commands=require('../services/completionLifecycle/commandService')
const reads=require('../services/completionLifecycle/readModel')
const {sendDomainError}=require('../services/completionLifecycle/domainError')
const router=express.Router(),handler=fn=>async(req,res)=>{try{await fn(req,res)}catch(error){if(sendDomainError(res,error))return;console.error('Completion & Lifecycle route error:',error);res.status(500).json({message:'Ошибка Completion & Lifecycle'})}}
router.get('/overview',requireCapability('completion.access'),handler(async(req,res)=>res.json(await reads.overview())))
router.get('/cases/:id',requireCapability('completion.access'),handler(async(req,res)=>res.json(await reads.getCase(req.params.id,{live:req.query.live!=='false'}))))
router.get('/history',requireCapability('completion.history.view'),handler(async(req,res)=>res.json(await reads.history(req.query))))
router.post('/cases/from-contracts/:contractCaseId',requireCapability('completion.readiness.evaluate'),handler(async(req,res)=>res.status(201).json(await commands.materializeCase(req.params.contractCaseId,req.user?.id))))
router.post('/cases/:id/evaluations',requireCapability('completion.readiness.evaluate'),handler(async(req,res)=>res.status(201).json(await commands.evaluateCase(req.params.id,req.user?.id))))
router.post('/cases/:id/close',requireCapability('completion.close'),handler(async(req,res)=>res.status(201).json(await commands.closeCase(req.params.id,req.body,req.user?.id))))
router.post('/cases/:id/reopen',requireCapability('completion.reopen'),handler(async(req,res)=>res.status(201).json(await commands.reopenCase(req.params.id,req.body,req.user?.id))))
module.exports=router
