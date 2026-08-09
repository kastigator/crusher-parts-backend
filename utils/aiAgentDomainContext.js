const { getDomainRegistry, resolveDomainTerm } = require('./domainRegistry')

const SYSTEM_MAP = {
  purpose:'ERP ведёт traceable lifecycle от Client Request и protected Classifier identity до After Sales.',
  interface_sections:[
    ['Client Request','/client-request-workspace','Ревизии потребности и immutable Procurement Release'],
    ['Sourcing','/sourcing','Supplier Inquiry, Supplier Offer, coverage и Sourcing Decision'],
    ['Pricing','/pricing','Расчётные группы, route variants и Pricing Decision'],
    ['Commercial Offer','/commercial-offers','Версии, approvals, issue и принятие предложения'],
    ['Contract','/contracts','Legal review, документы, signature и effective commitments'],
    ['Procurement Execution','/purchase-orders','Readiness, Supplier PO и accepted confirmations'],
    ['Financial Operations','/financial-operations','Operational AP/AR, payments и forecast'],
    ['Warehouse & Inventory','/warehouse','Expected inbound, Stock Units, movements и reservations'],
    ['Dispatch & Delivery','/dispatch-delivery','Picking, packages, shipments и POD'],
    ['Completion & Lifecycle','/completion-lifecycle','Readiness policy, closure snapshot, close/reopen'],
    ['After Sales & Traceability','/after-sales','Claims, evidence, resolution и lineage'],
    ['Classifier & Engineering','/equipment-classifier','Защищённые модели, BOM и Catalog Position identity'],
  ].map(([section,route,purpose])=>({section,route,purpose})),
  legacy_policy:'RFQ Workspace, supplier responses, coverage, legacy economics, sales_quotes, client_contracts, supplier_purchase_orders и legacy warehouse не являются каноническими write surfaces.',
}

const BUSINESS_PROCESS = {
  stages:[
    ['1. Client Request',['client_requests','client_request_revisions','procurement_releases'],'Идентифицировать catalog_position_id и выпустить immutable Procurement Release.'],
    ['2. Sourcing',['sourcing_cases','supplier_inquiries','supplier_offers','sourcing_decisions'],'Получить и зафиксировать supplier evidence и immutable decision.'],
    ['3. Pricing',['pricing_cases','calculation_revisions','pricing_decisions'],'Рассчитать landed/internal cost и утвердить client prices.'],
    ['4. Commercial Offer',['commercial_offers','commercial_offer_revisions'],'Выпустить и зафиксировать принятое предложение.'],
    ['5. Contract',['contract_cases','contract_revisions','contract_commitments'],'Подписать и создать effective commitments.'],
    ['6. Procurement Execution',['procurement_execution_cases','procurement_purchase_orders','supplier_confirmation_acceptances'],'Выпустить PO и принять confirmation evidence.'],
    ['7. Financial Operations',['financial_ap_cases','financial_customer_receivables'],'Вести operational AP/AR независимо.'],
    ['8. Warehouse & Inventory',['warehouse_inbound_expectations','warehouse_stock_units','warehouse_inventory_movements'],'Принять физический товар с lineage и availability.'],
    ['9. Dispatch & Delivery',['dispatch_orders','dispatch_shipments','dispatch_delivery_confirmations'],'Отгрузить и подтвердить POD.'],
    ['10. Completion & Lifecycle',['completion_cases','completion_snapshots'],'Явно закрыть case после readiness evaluation.'],
    ['11. After Sales',['after_sales_claims','after_sales_claim_events'],'Вести claims и end-to-end traceability.'],
  ].map(([name,entities,user_actions])=>({name,entities,user_actions})),
  data_principles:[
    'Classifier & Engineering владеет Catalog Position identity и не изменяется downstream domains.',
    'Новые ссылки используют только catalog_position_id.',
    'Каждый bounded context пишет только в собственные таблицы и принимает immutable upstream evidence.',
    'Legacy process tables используются только как historical read model до отдельной managed retirement migration.',
    'GET/read операции не должны изменять данные.',
  ],
}

const ACTION_POLICY = {
  read_mode:'Чтение разрешено только из target read models; historical legacy данные должны быть явно помечены как legacy.',
  write_mode:'Запись выполняется только явной command-операцией в owning bounded context и после capability-проверки.',
  delete_mode:'Не скрывай удаление или cleanup внутри GET. Physical drop требует отдельной managed migration и доказанного zero-caller state.',
  ambiguity:'Если пользователь использует RFQ/КП/PO как старый термин, сопоставь его с Sourcing/Commercial Offer/Procurement Execution и уточни target object.',
}

const AGENT_CONFIGURATION_GUIDE = {
  goal:'Использовать target domain registry и capability-safe tools.',
  principles:[
    'Не рекламировать legacy routes/tables как канонические.',
    'Не раскрывать Supplier identity в seller-safe проекциях без capability.',
    'Не создавать aliases для Catalog Position identity.',
    'Не выполнять mutation при чтении.',
  ],
  playbooks:[
    {intent:'process_state',meaning:'Найти target case соответствующего bounded context.',answer_style:'Покажи owner domain, status, blockers и next action.'},
    {intent:'legacy_rfq_term',meaning:'Понимать RFQ как исторический термин закупочного контура.',answer_style:'Для новой работы направь в Sourcing; legacy данные пометь read-only.'},
    {intent:'claim_or_quality',meaning:'Новая рекламация или traceability request.',answer_style:'Используй After Sales, не legacy Supplier Quality -> PO связи.'},
  ],
}

const getSystemMap=()=>SYSTEM_MAP
const getBusinessProcessGuide=()=>BUSINESS_PROCESS
const getAgentActionPolicy=()=>ACTION_POLICY
const getAgentConfigurationGuide=()=>AGENT_CONFIGURATION_GUIDE

module.exports={getSystemMap,getBusinessProcessGuide,getAgentActionPolicy,getAgentConfigurationGuide,getDomainRegistry,resolveDomainTerm}
