const number = (value, fallback = 0) => {
  if (value === null || value === undefined || value === '') return fallback
  const parsed = Number(String(value).replace(',', '.'))
  return Number.isFinite(parsed) ? parsed : fallback
}

const round2 = (value) => Math.round((number(value) + Number.EPSILON) * 100) / 100

const defaultCalculatorGlobals = {
  cost_dost_hki_eur: 0,
  cost_port_eur: 0,
  cost_warehouse_fin_eur: 0,
  cost_dost_rk_eur: 0,
  cost_dost_spb_eur: 0,
  cost_dost_client_eur: 0,
  cost_certification_eur: 0,
  cost_declaration_eur: 0,
  cost_customs_fees_eur: 0,
  cost_warehouse2_eur: 0,
  nadcen_rk: 0.05,
  fin_poteri: 0.05,
  nds: 0.2,
}

const normalizeCalculatorGlobals = (globals = {}) =>
  Object.fromEntries(
    Object.entries(defaultCalculatorGlobals).map(([key, fallback]) => [
      key,
      number(globals?.[key], fallback),
    ])
  )

const calculateCommercialQuote = (payload = {}) => {
  const sourceItems = Array.isArray(payload.items) ? payload.items : []
  const globals = normalizeCalculatorGlobals(payload.globals || {})
  const items = sourceItems.map((item) => ({
    ...item,
    quantity: Math.max(number(item.quantity), 0),
    purchase_price_eur_per_unit: Math.max(number(item.purchase_price_eur_per_unit), 0),
    weight_per_unit_kg: Math.max(number(item.weight_per_unit_kg), 0),
    nadcen_fin_pct: number(item.nadcen_fin_pct, 0.15),
    nadcen_rf_pct: number(item.nadcen_rf_pct, 0.15),
    customs_pct: number(item.customs_pct, 0.05),
  }))

  const totalPurchase = items.reduce(
    (sum, item) => sum + item.purchase_price_eur_per_unit * item.quantity,
    0
  )
  const totalQuantity = items.reduce((sum, item) => sum + item.quantity, 0)

  const proportionalPerUnit = (totalExpense, item) => {
    if (!item.quantity) return 0
    if (totalPurchase > 0) {
      const itemTotal = item.purchase_price_eur_per_unit * item.quantity
      return (number(totalExpense) * (itemTotal / totalPurchase)) / item.quantity
    }
    return totalQuantity ? (number(totalExpense) * (item.quantity / totalQuantity)) / item.quantity : 0
  }

  const firstLegBeforeMarkup =
    number(globals.cost_dost_hki_eur) +
    number(globals.cost_port_eur) +
    number(globals.cost_warehouse_fin_eur)
  const certificationAndDeclaration =
    number(globals.cost_certification_eur) +
    number(globals.cost_declaration_eur)

  const calculatedItems = items.map((item) => {
    const quantity = item.quantity
    const purchase = item.purchase_price_eur_per_unit
    const purchaseTotal = purchase * quantity
    const firstLegPerUnit = round2(proportionalPerUnit(firstLegBeforeMarkup, item))
    const baseBeforeFinMarkup = round2(purchase + firstLegPerUnit)
    const finMarkup = round2(baseBeforeFinMarkup * item.nadcen_fin_pct)
    const deliveryRk = round2(proportionalPerUnit(globals.cost_dost_rk_eur, item))
    const finalFinRk = round2(baseBeforeFinMarkup + finMarkup + deliveryRk)
    const rkMarkup = round2(finalFinRk * globals.nadcen_rk)
    const customs = round2(finalFinRk * item.customs_pct)
    const customsFees = round2(proportionalPerUnit(globals.cost_customs_fees_eur, item))
    const certDecl = round2(proportionalPerUnit(certificationAndDeclaration, item))
    const deliverySpb = round2(proportionalPerUnit(globals.cost_dost_spb_eur, item))
    const calcPrice = round2(
      finalFinRk + rkMarkup + customs + customsFees + certDecl + deliverySpb
    )
    const withFinLoss = round2(calcPrice * (1 + globals.fin_poteri))
    const rfMarkup = round2(withFinLoss * item.nadcen_rf_pct)
    const withoutClientDelivery = round2(withFinLoss + rfMarkup)
    const clientDelivery = round2(proportionalPerUnit(globals.cost_dost_client_eur, item))
    const withoutVat = round2(withoutClientDelivery + clientDelivery)
    const withVat = round2(withoutVat * (1 + globals.nds))

    return {
      ...item,
      purchase_total_eur: round2(purchaseTotal),
      fin_markup_per_unit: round2(finMarkup),
      final_price_fin_rk_eur: round2(finalFinRk),
      final_price_fin_rk_total: round2(finalFinRk * quantity),
      nadcen_rk_per_unit: round2(rkMarkup),
      customs_duty_per_unit: round2(customs),
      customs_fees_per_unit: round2(customsFees),
      cert_decl_per_unit: round2(certDecl),
      dost_spb_per_unit: round2(deliverySpb),
      calc_price_eur_per_unit: round2(calcPrice),
      price_with_fin_loss_per_unit: round2(withFinLoss),
      nadcen_rf_per_unit: round2(rfMarkup),
      total_without_nds_pre_client_per_unit: round2(withoutClientDelivery),
      dost_client_per_unit: round2(clientDelivery),
      total_without_nds_per_unit: round2(withoutVat),
      total_without_nds_total: round2(withoutVat * quantity),
      total_with_nds_per_unit: round2(withVat),
      total_with_nds_total: round2(withVat * quantity),
    }
  })

  const total = (key) =>
    round2(calculatedItems.reduce((sum, item) => sum + number(item[key]), 0))
  const totalWithoutVat = total('total_without_nds_total')
  const margin = round2(totalWithoutVat - totalPurchase)
  const marginRatio = totalPurchase > 0 ? round2(margin / totalPurchase) : 0

  return {
    items: calculatedItems,
    totals: {
      total_purchase_eur: round2(totalPurchase),
      total_with_naceka_fin_eur: total('final_price_fin_rk_total'),
      total_dap_rk_eur: total('final_price_fin_rk_total'),
      total_without_nds_eur: totalWithoutVat,
      total_with_nds_eur: total('total_with_nds_total'),
      total_weight_kg: round2(
        items.reduce((sum, item) => sum + item.weight_per_unit_kg * item.quantity, 0)
      ),
      margin_eur: margin,
      margin_ratio: marginRatio,
      margin_pct: round2(marginRatio * 100),
    },
  }
}

module.exports = {
  calculateCommercialQuote,
  defaultCalculatorGlobals,
  normalizeCalculatorGlobals,
  round2,
}
