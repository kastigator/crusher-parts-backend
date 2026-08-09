const { FinancialOperationsError } = require('./domainError')

const SCALE = 10000n
function toMinor(value, field = 'amount') {
  const text = String(value ?? '').trim()
  const match = text.match(/^(-?)(\d+)(?:\.(\d{1,4}))?$/)
  if (!match) throw new FinancialOperationsError('INVALID_MONEY', `${field} должен иметь не более 4 знаков после запятой`, 400, { field, value })
  const minor = BigInt(match[2]) * SCALE + BigInt((match[3] || '').padEnd(4, '0'))
  return match[1] ? -minor : minor
}
function fromMinor(minor) {
  const negative = minor < 0n
  const value = negative ? -minor : minor
  return `${negative ? '-' : ''}${value / SCALE}.${String(value % SCALE).padStart(4, '0')}`
}
function percentMinor(total, value) {
  const text = String(value ?? '').trim()
  const match = text.match(/^(\d+)(?:\.(\d{1,6}))?$/)
  if (!match) throw new FinancialOperationsError('INVALID_PERCENT', 'Процент должен быть неотрицательным числом с точностью до 6 знаков')
  const denominator = 1000000n
  const percent = BigInt(match[1]) * denominator + BigInt((match[2] || '').padEnd(6, '0'))
  if (percent > 100n * denominator) throw new FinancialOperationsError('INVALID_PERCENT', 'Процент не может превышать 100')
  const divisor = 100n * denominator
  return (total * percent + divisor / 2n) / divisor
}
function materializeSchedule(totalValue, stages) {
  const total = toMinor(totalValue, 'total_amount')
  if (total < 0n) throw new FinancialOperationsError('INVALID_MONEY', 'total_amount не может быть отрицательным')
  if (!Array.isArray(stages) || !stages.length) throw new FinancialOperationsError('STRUCTURED_PAYMENT_POLICY_REQUIRED', 'Structured payment schedule отсутствует', 409)
  let used = 0n
  let remainderCount = 0
  const materialized = stages.map((stage, index) => {
    const calculationType = String(stage.calculation_type || '').toUpperCase()
    let amount
    if (calculationType === 'FIXED') amount = toMinor(stage.value, `stages[${index}].value`)
    else if (calculationType === 'PERCENT') amount = percentMinor(total, stage.value)
    else if (calculationType === 'REMAINDER') {
      remainderCount += 1
      if (index !== stages.length - 1 || remainderCount > 1) throw new FinancialOperationsError('INVALID_PAYMENT_POLICY', 'REMAINDER допускается один раз и только последней стадией')
      amount = total - used
    } else throw new FinancialOperationsError('INVALID_PAYMENT_POLICY', 'calculation_type должен быть PERCENT, FIXED или REMAINDER')
    if (amount < 0n || used + amount > total) throw new FinancialOperationsError('PAYMENT_SCHEDULE_TOTAL_MISMATCH', 'Сумма стадий превышает обязательство')
    used += amount
    return { ...stage, calculation_type: calculationType, amount: fromMinor(amount) }
  })
  if (used !== total) throw new FinancialOperationsError('PAYMENT_SCHEDULE_TOTAL_MISMATCH', 'Сумма стадий должна точно совпадать с обязательством', 409, { total: fromMinor(total), stages_total: fromMinor(used) })
  return materialized
}

module.exports = { SCALE, fromMinor, materializeSchedule, percentMinor, toMinor }
