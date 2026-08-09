const crypto=require('crypto')
const {DispatchDeliveryError}=require('./domainError')
const stable=(value)=>{if(Array.isArray(value))return value.map(stable);if(value&&typeof value==='object')return Object.keys(value).sort().reduce((out,k)=>{out[k]=stable(value[k]);return out},{});return value}
const sha256=(value)=>crypto.createHash('sha256').update(typeof value==='string'?value:JSON.stringify(stable(value))).digest('hex')
const json=(value)=>JSON.stringify(value??{})
const parseJson=(value,fallback={})=>{if(value==null)return fallback;if(typeof value==='object')return value;try{return JSON.parse(value)}catch{return fallback}}
const toId=(value)=>{const n=Number(value);return Number.isSafeInteger(n)&&n>0?n:null}
const id=(value,field)=>{const n=toId(value);if(!n)throw new DispatchDeliveryError('INVALID_ID',`Некорректный ${field}`);return n}
const actor=(value)=>toId(value)
const key=(value)=>{const s=String(value||'').trim();if(!s||s.length>128)throw new DispatchDeliveryError('IDEMPOTENCY_KEY_REQUIRED','Требуется idempotency_key до 128 символов');return s}
const text=(value,field,max=1000)=>{const s=String(value||'').trim();if(!s)throw new DispatchDeliveryError('REQUIRED_FIELD',`Требуется ${field}`);return s.slice(0,max)}
const qty=(value,field='quantity')=>{const n=Number(value);if(!Number.isFinite(n)||n<=0)throw new DispatchDeliveryError('INVALID_QUANTITY',`${field} должен быть больше нуля`);return Number(n.toFixed(3))}
const event=async(conn,type,aggregateType,aggregateId,user,payload={},source={})=>conn.execute(`INSERT INTO dispatch_events(event_type,aggregate_type,aggregate_id,source_domain,source_entity_type,source_entity_id,actor_user_id,payload_json,event_hash) VALUES(?,?,?,?,?,?,?,?,?)`,[type,aggregateType,aggregateId||null,source.domain||null,source.entity_type||null,source.entity_id||null,actor(user),json(payload),sha256({type,aggregateType,aggregateId,payload,source})])
module.exports={actor,event,id,json,key,parseJson,qty,sha256,text,toId}
