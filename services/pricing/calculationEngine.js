const BigNumber = require('bignumber.js')
const { PricingDomainError } = require('./domainError')

BigNumber.config({ DECIMAL_PLACES: 16, ROUNDING_MODE: BigNumber.ROUND_HALF_UP })

const bn = (value, fallback = 0) => {
  const number = new BigNumber(value == null || value === '' ? fallback : value)
  return number.isFinite() ? number : new BigNumber(fallback)
}
const decimal = (value, places = 8) => bn(value).decimalPlaces(places, BigNumber.ROUND_HALF_UP).toFixed(places)
const money = (value) => decimal(value, 4)

function roundToIncrement(value, increment) {
  const step = bn(increment, 0.01)
  if (step.lte(0)) throw new PricingDomainError('INVALID_ROUNDING_INCREMENT', 'Шаг округления должен быть больше нуля')
  return bn(value).div(step).integerValue(BigNumber.ROUND_HALF_UP).times(step)
}

function calculateRouteCost(definition, parameters) {
  const model = String(definition.pricing_model || 'fixed')
  const weight = bn(parameters.TOTAL_WEIGHT_KG)
  const volume = bn(parameters.TOTAL_VOLUME_CBM)
  const fixed = bn(definition.fixed_cost)
  const perKg = bn(definition.rate_per_kg)
  const perCbm = bn(definition.rate_per_cbm)
  const minimum = bn(definition.min_cost)
  let base
  if (model === 'per_kg') base = perKg.times(weight)
  else if (model === 'per_cbm') base = perCbm.times(volume)
  else if (model === 'per_kg_or_cbm_max') base = BigNumber.max(perKg.times(weight), perCbm.times(volume))
  else if (model === 'hybrid') base = fixed.plus(perKg.times(weight)).plus(perCbm.times(volume))
  else base = fixed
  return BigNumber.max(base, minimum)
    .times(bn(1).plus(bn(definition.markup_pct).div(100)))
    .plus(bn(definition.markup_fixed))
}

function allocate(totalInput, lines, method, weightKey) {
  const total = bn(totalInput)
  if (!lines.length) return []
  if (total.eq(0)) return lines.map((line) => ({ input_line_id: line.id, raw: bn(0), rounded: bn(0), residual: bn(0) }))
  const weights = lines.map((line) => {
    if (method === 'EQUAL') return bn(1)
    if (method === 'BY_QUANTITY') return bn(line.purchase_quantity)
    if (method === 'BY_WEIGHT') return bn(line.parameters?.WEIGHT_KG).times(line.purchase_quantity)
    if (method === 'MANUAL') return bn(line.parameters?.[weightKey])
    return bn(line.goods_amount)
  })
  const weightTotal = weights.reduce((sum, value) => sum.plus(value), bn(0))
  if (weightTotal.lte(0)) throw new PricingDomainError('ALLOCATION_BASIS_MISSING', `Невозможно распределить ${weightKey}`, 409, { method })
  let roundedSum = bn(0)
  return lines.map((line, index) => {
    const raw = total.times(weights[index]).div(weightTotal)
    const rounded = index === lines.length - 1 ? total.minus(roundedSum) : raw.decimalPlaces(8, BigNumber.ROUND_HALF_UP)
    roundedSum = roundedSum.plus(rounded)
    return { input_line_id: line.id, raw, rounded, residual: rounded.minus(raw) }
  })
}

function calculatePricingRevision({ lines, parameters = {}, template = {}, allocationMethod = 'BY_VALUE', calculationCurrency }) {
  if (!lines.length) throw new PricingDomainError('GROUP_EMPTY', 'Calculation Group не содержит позиций', 409)
  const blockers = []
  const prepared = lines.map((line) => {
    const lineParameters = parameters.lines?.[line.id] || {}
    const sourceCurrency = String(line.purchase_currency || '').toUpperCase()
    const fxRate = sourceCurrency === calculationCurrency
      ? bn(1)
      : bn(parameters.fx_rates?.[sourceCurrency])
    if (!sourceCurrency || (sourceCurrency !== calculationCurrency && fxRate.lte(0))) {
      blockers.push({ code: 'MISSING_FX_RATE', input_line_id: line.id, currency: sourceCurrency })
    }
    const dutyRate = lineParameters.DUTY_RATE_PCT ?? parameters.DUTY_RATE_PCT
    if (dutyRate == null || bn(dutyRate).lt(0)) blockers.push({ code: 'MISSING_DUTY_RATE', input_line_id: line.id })
    if (allocationMethod === 'BY_WEIGHT' && bn(lineParameters.WEIGHT_KG).lte(0)) {
      blockers.push({ code: 'MISSING_WEIGHT', input_line_id: line.id })
    }
    const goodsSource = bn(line.purchase_unit_price).times(line.purchase_quantity)
    return {
      ...line,
      parameters: lineParameters,
      goods_source_amount: goodsSource,
      fx_rate: fxRate,
      goods_amount: goodsSource.times(fxRate),
      duty_rate_pct: bn(dutyRate),
    }
  })
  if (blockers.length) throw new PricingDomainError('CALCULATION_BLOCKED', 'Расчёт заблокирован отсутствующими параметрами', 409, { blockers })

  const routeCost = parameters.FREIGHT_TOTAL == null
    ? calculateRouteCost(template, parameters)
    : bn(parameters.FREIGHT_TOTAL)
  const routeCurrency = String(parameters.FREIGHT_CURRENCY || template.currency || calculationCurrency).toUpperCase()
  const routeFx = routeCurrency === calculationCurrency ? bn(1) : bn(parameters.fx_rates?.[routeCurrency])
  if (routeCurrency !== calculationCurrency && routeFx.lte(0)) {
    throw new PricingDomainError('CALCULATION_BLOCKED', 'Не задан FX для стоимости маршрута', 409, { blockers: [{ code: 'MISSING_ROUTE_FX_RATE', currency: routeCurrency }] })
  }
  const freightTotal = routeCost.times(routeFx)
  const otherTotal = bn(parameters.OTHER_TOTAL)
  const freightAllocations = allocate(freightTotal, prepared, allocationMethod, 'FREIGHT_ALLOCATION_WEIGHT')
  const otherAllocations = allocate(otherTotal, prepared, allocationMethod, 'OTHER_ALLOCATION_WEIGHT')
  const markup = bn(parameters.TARGET_MARKUP_PCT)
  const roundingIncrement = parameters.ROUNDING_INCREMENT ?? '0.01'

  const results = prepared.map((line) => {
    const freight = freightAllocations.find((item) => Number(item.input_line_id) === Number(line.id))
    const other = otherAllocations.find((item) => Number(item.input_line_id) === Number(line.id))
    const duty = line.goods_amount.times(line.duty_rate_pct).div(100)
    const landed = line.goods_amount.plus(freight.rounded).plus(duty).plus(other.rounded)
    const internalUnit = landed.div(line.client_quantity)
    const calculatedClientUnit = internalUnit.times(bn(1).plus(markup.div(100)))
    const roundedClientUnit = roundToIncrement(calculatedClientUnit, roundingIncrement)
    return {
      input_line_id: line.id,
      goods_source_amount: decimal(line.goods_source_amount),
      fx_rate: decimal(line.fx_rate),
      goods_amount_raw: decimal(line.goods_amount),
      freight_amount_raw: decimal(freight.rounded),
      duty_amount_raw: decimal(duty),
      other_amount_raw: decimal(other.rounded),
      landed_amount_raw: decimal(landed),
      internal_unit_price_raw: decimal(internalUnit),
      calculated_client_unit_price_raw: decimal(calculatedClientUnit),
      rounded_client_unit_price: money(roundedClientUnit),
      allocation_residual: decimal(freight.residual.plus(other.residual)),
      currency: calculationCurrency,
      duty_rate_pct: decimal(line.duty_rate_pct),
    }
  })
  const totals = results.reduce((sum, line) => ({
    goods: sum.goods.plus(line.goods_amount_raw),
    freight: sum.freight.plus(line.freight_amount_raw),
    duty: sum.duty.plus(line.duty_amount_raw),
    other: sum.other.plus(line.other_amount_raw),
    landed: sum.landed.plus(line.landed_amount_raw),
  }), { goods: bn(0), freight: bn(0), duty: bn(0), other: bn(0), landed: bn(0) })
  return {
    route_cost: money(routeCost),
    route_currency: routeCurrency,
    freight_total: decimal(freightTotal),
    results,
    totals: Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, decimal(value)])),
  }
}

module.exports = { allocate, calculatePricingRevision, calculateRouteCost, roundToIncrement }
