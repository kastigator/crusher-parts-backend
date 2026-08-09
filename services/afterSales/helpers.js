const crypto=require('crypto')
const {AfterSalesError}=require('./domainError')
const stable=value=>{if(Array.isArray(value))return value.map(stable);if(value&&typeof value==='object')return Object.keys(value).sort().reduce((out,key)=>{out[key]=stable(value[key]);return out},{});return value}
const sha256=value=>crypto.createHash('sha256').update(typeof value==='string'?value:JSON.stringify(stable(value))).digest('hex')
const parseJson=(value,fallback={})=>{if(value==null)return fallback;if(typeof value==='object')return value;try{return JSON.parse(value)}catch{return fallback}}
const toId=value=>{const n=Number(value);return Number.isSafeInteger(n)&&n>0?n:null}
const id=(value,field)=>{const n=toId(value);if(!n)throw new AfterSalesError('INVALID_ID',`Некорректный ${field}`);return n}
const actor=toId
const text=(value,field,max=1000)=>{const result=String(value||'').trim();if(!result)throw new AfterSalesError('REQUIRED_FIELD',`Требуется ${field}`);return result.slice(0,max)}
const optionalText=(value,max=1000)=>{const result=String(value||'').trim();return result?result.slice(0,max):null}
const key=value=>{const result=String(value||'').trim();if(!result||result.length>128)throw new AfterSalesError('IDEMPOTENCY_KEY_REQUIRED','Требуется idempotency_key до 128 символов');return result}
const version=value=>{const n=Number(value);if(!Number.isSafeInteger(n)||n<1)throw new AfterSalesError('ROW_VERSION_REQUIRED','Требуется корректный row_version');return n}
const json=value=>JSON.stringify(value??{})
module.exports={actor,id,json,key,optionalText,parseJson,sha256,stable,text,toId,version}
