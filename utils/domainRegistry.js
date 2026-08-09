const entity = ({ key, label_ru, purpose, table, api_route, frontend_sections, user_words = [], guidance }) => ({
  key,
  label_ru,
  purpose,
  canonical: { table, api_route, frontend_sections },
  legacy_or_compatibility: { tables: [], api_routes: [], words: [] },
  user_words,
  status: 'canonical_target_domain',
  guidance,
})

const DOMAIN_ENTITIES = [
  entity({ key:'equipment_classifier',label_ru:'Классификатор и инженерная структура',purpose:'Защищённое дерево оборудования, модели, BOM и карточки Catalog Position.',table:'equipment_classifier_nodes',api_route:'/equipment-classifier-nodes',frontend_sections:['Классификатор оборудования'],user_words:['классификатор','модель оборудования','BOM','инженерная структура'],guidance:'Classifier & Engineering владеет инженерной структурой; downstream domains используют только catalog_position_id и snapshots.' }),
  entity({ key:'catalog_position',label_ru:'Позиция каталога',purpose:'Единая инженерная identity детали, сборки, материала, услуги или документа.',table:'catalog_positions',api_route:'/catalog-positions',frontend_sections:['Классификатор -> карточка позиции'],user_words:['позиция каталога','карточка позиции','каталожный номер','part number'],guidance:'Во всех новых связях используй только catalog_position_id; original_part_id/oem_part_id не являются новыми aliases.' }),
  entity({ key:'supplier_part',label_ru:'Деталь поставщика',purpose:'Номенклатурная позиция конкретного поставщика и её связи с Catalog Position.',table:'supplier_parts',api_route:'/supplier-parts',frontend_sections:['Детали поставщиков'],user_words:['деталь поставщика','артикул поставщика','аналог'],guidance:'Supplier Part и Catalog Position имеют разную ownership; связь хранится отдельно.' }),
  entity({ key:'client_request',label_ru:'Заявка клиента',purpose:'Версионируемая потребность клиента до immutable Procurement Release.',table:'client_requests',api_route:'/client-requests',frontend_sections:['Заявки клиентов'],user_words:['заявка','запрос клиента','потребность клиента'],guidance:'После релиза не создавай legacy RFQ: передавай Procurement Release в Sourcing.' }),
  entity({ key:'procurement_release',label_ru:'Procurement Release',purpose:'Неизменяемый снимок готовой клиентской ревизии для закупки.',table:'procurement_releases',api_route:'/procurement-releases',frontend_sections:['Заявки клиентов','Sourcing'],user_words:['релиз в закупку','procurement release'],guidance:'Это единственная target handoff-точка Client Request -> Sourcing.' }),
  entity({ key:'sourcing_case',label_ru:'Sourcing Case',purpose:'Supplier inquiries, offers, coverage options и immutable Sourcing Decision.',table:'sourcing_cases',api_route:'/sourcing',frontend_sections:['Sourcing'],user_words:['sourcing','опрос поставщиков','ответ поставщика','покрытие','выбор поставщика','RFQ'],guidance:'RFQ — исторический термин; новые операции выполняются через Sourcing Case, Inquiry, Offer и Decision.' }),
  entity({ key:'pricing_case',label_ru:'Pricing Case',purpose:'Calculation Groups, route variants, immutable calculation revisions и Pricing Decision.',table:'pricing_cases',api_route:'/pricing',frontend_sections:['Pricing'],user_words:['pricing','экономика','себестоимость','цена клиента','маржа'],guidance:'Legacy economics/selection не являются канонической системой расчёта.' }),
  entity({ key:'commercial_offer',label_ru:'Commercial Offer',purpose:'Версионируемое предложение клиенту из fixed Pricing Decision.',table:'commercial_offers',api_route:'/commercial-offers',frontend_sections:['Commercial Offer'],user_words:['КП','коммерческое предложение','offer клиенту'],guidance:'Новые КП создаются только в Commercial Offer; sales_quotes остаётся historical read model.' }),
  entity({ key:'contract_case',label_ru:'Contract Case',purpose:'Legal review, approvals, documents, signature и effective commitments.',table:'contract_cases',api_route:'/contract-domain',frontend_sections:['Contract'],user_words:['контракт','договор','подписание'],guidance:'client_contracts не является target write model.' }),
  entity({ key:'procurement_execution',label_ru:'Procurement Execution',purpose:'Readiness, PO revisions, issue evidence и accepted supplier confirmations.',table:'procurement_execution_cases',api_route:'/procurement-execution',frontend_sections:['Procurement Execution'],user_words:['заказ поставщику','PO','подтверждение поставщика'],guidance:'Новые PO создаются в procurement_purchase_orders; supplier_purchase_orders — legacy.' }),
  entity({ key:'financial_operations',label_ru:'Financial Operations',purpose:'Operational AP/AR, invoices, payments, allocations, disputes и forecast.',table:'financial_ap_cases',api_route:'/financial-operations',frontend_sections:['Financial Operations'],user_words:['AP','AR','счёт поставщика','платёж','дебиторка','кредиторка'],guidance:'Финансовый домен не изменяет upstream commitments.' }),
  entity({ key:'warehouse_inventory',label_ru:'Warehouse & Inventory',purpose:'Expected inbound, receiving, Stock Unit lineage, movements, reservations и counts.',table:'warehouse_stock_units',api_route:'/warehouse-inventory',frontend_sections:['Warehouse & Inventory'],user_words:['склад','остаток','приёмка','резерв','stock unit'],guidance:'Classifier читает target availability; legacy warehouse documents не используются для новых операций.' }),
  entity({ key:'dispatch_delivery',label_ru:'Dispatch & Delivery',purpose:'Dispatch Orders, picking, packages, shipments и POD confirmation.',table:'dispatch_orders',api_route:'/dispatch-delivery',frontend_sections:['Dispatch & Delivery'],user_words:['отгрузка','доставка','shipment','POD'],guidance:'Delivery Confirmation, а не сам dispatch, подтверждает исполнение.' }),
  entity({ key:'completion_lifecycle',label_ru:'Completion & Lifecycle',purpose:'Policy-based readiness, immutable closure snapshot, close и audited reopen.',table:'completion_cases',api_route:'/completion-lifecycle',frontend_sections:['Completion & Lifecycle'],user_words:['завершение','закрытие','completion','readiness','reopen'],guidance:'Закрытие всегда явная команда после deterministic readiness evaluation.' }),
  entity({ key:'after_sales',label_ru:'After Sales & Traceability',purpose:'Claims, evidence, investigation, resolution, close/reopen и end-to-end lineage.',table:'after_sales_claims',api_route:'/after-sales',frontend_sections:['After Sales & Traceability'],user_words:['рекламация','claim','гарантия','traceability','послепродажный сервис'],guidance:'Новые претензии и traceability ведутся здесь, а не через legacy Supplier Quality -> PO связи.' }),
]

const LEGACY_SURFACES = [
  { surface:'RFQ Workspace / supplier responses / coverage / selection',tables:['rfqs','rfq_supplier_responses','rfq_coverage_options','selections'],api_routes:['/rfqs','/supplier-responses','/coverage','/selection','/scorecard'],replacement:'Sourcing',mode:'historical_read_only' },
  { surface:'Legacy economics',tables:['rfq_scenarios','rfq_shipment_groups'],api_routes:['/economics'],replacement:'Pricing',mode:'historical_read_only' },
  { surface:'Legacy sales quotes',tables:['sales_quotes'],api_routes:['/sales-quotes'],replacement:'Commercial Offer',mode:'historical_read_only' },
  { surface:'Legacy client contracts',tables:['client_contracts'],api_routes:['/contracts'],replacement:'Contract',mode:'historical_read_only' },
  { surface:'Legacy supplier purchase orders',tables:['supplier_purchase_orders'],api_routes:['/purchase-orders'],replacement:'Procurement Execution',mode:'historical_read_only' },
  { surface:'Legacy warehouse',tables:['warehouse_documents','warehouse_document_lines'],api_routes:['/warehouse'],replacement:'Warehouse & Inventory',mode:'historical_read_only' },
]

const NAMING_AUDIT = [
  { area:'Process ownership',risk:'high',current_state:'Target bounded contexts through Wave 12 are active.',decision:'Advertise only target domains; legacy process surfaces are historical read-only.' },
  { area:'Catalog identity',risk:'high',current_state:'Catalog Position is the protected canonical identity.',decision:'New paths accept catalog_position_id only; do not introduce OEM/original aliases.' },
]

const normalize = (value) => String(value || '').trim().toLowerCase().replace(/ё/g,'е').replace(/[_/.-]+/g,' ').replace(/\s+/g,' ')
const terms = (item) => [item.key,item.label_ru,item.purpose,item.canonical?.table,item.canonical?.api_route,...(item.canonical?.frontend_sections||[]),...(item.user_words||[])]
const score = (term, item) => { const needle=normalize(term);if(!needle)return 0;return terms(item).reduce((out,value)=>{const candidate=normalize(value);if(candidate===needle)return out+100;if(needle.length>2&&candidate.includes(needle))return out+35;if(candidate.length>2&&needle.includes(candidate))return out+20;return out},0) }

const getDomainRegistry = () => ({ entities:DOMAIN_ENTITIES, legacy_surfaces:LEGACY_SURFACES, naming_audit:NAMING_AUDIT })
const resolveDomainTerm = ({ term,limit=5 }={}) => ({
  term:term||'',
  matches:DOMAIN_ENTITIES.map((item)=>({...item,match_score:score(term,item)})).filter((item)=>item.match_score>0).sort((a,b)=>b.match_score-a.match_score).slice(0,Math.max(1,Math.min(Number(limit)||5,10))),
  note:'Используй target canonical route и guidance; legacy_surfaces допустимы только для исторического чтения.',
})

module.exports={DOMAIN_ENTITIES,LEGACY_SURFACES,NAMING_AUDIT,getDomainRegistry,resolveDomainTerm}
