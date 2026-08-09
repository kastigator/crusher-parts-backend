const crypto=require('crypto')
const {CompletionLifecycleError}=require('./domainError')
const stable=value=>{if(Array.isArray(value))return value.map(stable);if(value&&typeof value==='object')return Object.keys(value).sort().reduce((out,key)=>{out[key]=stable(value[key]);return out},{});return value}
const sha256=value=>crypto.createHash('sha256').update(typeof value==='string'?value:JSON.stringify(stable(value))).digest('hex')
const parseJson=(value,fallback={})=>{if(value==null)return fallback;if(typeof value==='object')return value;try{return JSON.parse(value)}catch{return fallback}}
const toId=value=>{const number=Number(value);return Number.isSafeInteger(number)&&number>0?number:null}
const id=(value,field)=>{const number=toId(value);if(!number)throw new CompletionLifecycleError('INVALID_ID',`Некорректный ${field}`);return number}
const actor=toId
const text=(value,field,max=1000)=>{const result=String(value||'').trim();if(!result)throw new CompletionLifecycleError('REQUIRED_FIELD',`Требуется ${field}`);return result.slice(0,max)}
const key=value=>{const result=String(value||'').trim();if(!result||result.length>128)throw new CompletionLifecycleError('IDEMPOTENCY_KEY_REQUIRED','Требуется idempotency_key до 128 символов');return result}
const version=value=>{const number=Number(value);if(!Number.isSafeInteger(number)||number<1)throw new CompletionLifecycleError('ROW_VERSION_REQUIRED','Требуется корректный row_version');return number}
const json=value=>JSON.stringify(value??{})
module.exports={actor,id,json,key,parseJson,sha256,stable,text,toId,version}
