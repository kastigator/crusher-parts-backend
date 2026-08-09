const crypto=require('crypto')
const { ProcurementExecutionError }=require('./domainError')
const toId=(value)=>{ const n=Number(value);return Number.isInteger(n)&&n>0?n:null }
const cleanText=(value)=>{ const v=String(value??'').trim();return v||null }
const parseJson=(value,fallback={})=>{ if(value==null)return fallback;if(typeof value==='object')return value;try{return JSON.parse(value)}catch{return fallback} }
const stable=(value)=>Array.isArray(value)?value.map(stable):(value&&typeof value==='object'?Object.keys(value).sort().reduce((o,k)=>(o[k]=stable(value[k]),o),{}):value)
const sha256=(value)=>crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex')
const actor=(value)=>{ const id=toId(value);if(!id)throw new ProcurementExecutionError('ACTOR_REQUIRED','Не определён пользователь операции',401);return id }
const requestKey=(value)=>{ const key=cleanText(value);if(!key||key.length>128)throw new ProcurementExecutionError('IDEMPOTENCY_KEY_REQUIRED','Требуется request_key длиной до 128 символов');return key }
async function event(executor,caseId,type,entityType,entityId,userId,payload={}){
  await executor.execute('INSERT INTO procurement_execution_events (procurement_execution_case_id,event_type,entity_type,entity_id,actor_user_id,payload_json) VALUES (?,?,?,?,?,?)',[caseId,type,entityType,entityId||null,userId||null,JSON.stringify(payload)])
}
module.exports={ actor,cleanText,event,parseJson,requestKey,sha256,stable,toId }
