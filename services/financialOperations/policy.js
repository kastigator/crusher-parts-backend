const { FinancialOperationsError } = require('./domainError')
const { isoDate, parseJson } = require('./helpers')
const { materializeSchedule } = require('./money')

const TRIGGERS = new Set(['CONFIRMED','INVOICE_DATE','FAT_PASSED','GOODS_READY','READY_FOR_SHIPMENT','SHIPPED','ARRIVED','ACCEPTED','FIXED_DATE','MANUAL_ESTIMATE'])
function findStructuredStages(paymentValue, legalValue) {
  const payment = parseJson(paymentValue, {})
  const legal = parseJson(legalValue, {})
  const candidates = [payment.schedule_stages, payment.policy?.schedule_stages, legal.payment_template_stages, legal.policy?.payment_template_stages]
  return candidates.find(Array.isArray) || null
}
function normalizePolicy(total, paymentValue, legalValue) {
  const sourceStages = findStructuredStages(paymentValue, legalValue)
  if (!sourceStages) throw new FinancialOperationsError(
    'STRUCTURED_PAYMENT_POLICY_REQUIRED',
    'Accepted confirmation найден, но authoritative structured payment policy отсутствует; свободный текст не интерпретируется',
    409
  )
  const stages = sourceStages.map((stage, index) => {
    const trigger = String(stage.trigger_type || '').toUpperCase()
    if (!TRIGGERS.has(trigger)) throw new FinancialOperationsError('INVALID_PAYMENT_TRIGGER', `Неизвестный trigger ${trigger || '(empty)'}`)
    const eventDate = stage.explicit_event_date ? isoDate(stage.explicit_event_date, `stage ${index + 1} explicit_event_date`) : null
    if (trigger === 'FIXED_DATE' && !eventDate) throw new FinancialOperationsError('FIXED_DATE_REQUIRED', 'FIXED_DATE требует explicit_event_date')
    const offset = Number(stage.trigger_offset_days || 0)
    if (!Number.isInteger(offset) || Math.abs(offset) > 3650) throw new FinancialOperationsError('INVALID_TRIGGER_OFFSET', 'trigger_offset_days должен быть целым в диапазоне ±3650')
    return {
      stage_code: String(stage.stage_code || `STAGE_${index + 1}`).trim().toUpperCase(),
      calculation_type: String(stage.calculation_type || '').toUpperCase(),
      value: stage.value,
      trigger_type: trigger,
      trigger_offset_days: offset,
      invoice_required: Boolean(stage.invoice_required),
      explicit_event_date: eventDate,
      contractual_due_date: stage.contractual_due_date ? isoDate(stage.contractual_due_date, `stage ${index + 1} contractual_due_date`) : null,
      planned_payment_date: stage.planned_payment_date ? isoDate(stage.planned_payment_date, `stage ${index + 1} planned_payment_date`) : null,
      scope: stage.scope && typeof stage.scope === 'object' ? stage.scope : {},
      blocking_effect: stage.blocking_effect ? String(stage.blocking_effect).slice(0, 80) : null,
      source: stage,
    }
  })
  return { stages: materializeSchedule(total, stages), source: { payment: parseJson(paymentValue, {}), legal: parseJson(legalValue, {}) } }
}

module.exports = { TRIGGERS, findStructuredStages, normalizePolicy }
