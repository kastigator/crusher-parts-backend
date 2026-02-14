// routes/clientOrders.js
const express = require('express')
const router = express.Router()

const db = require('../utils/db')
const logActivity = require('../utils/logActivity')
const logFieldDiffs = require('../utils/logFieldDiffs')
const multer = require('multer')
const os = require('os')
const path = require('path')
const fs = require('fs/promises')
const { bucket, bucketName } = require('../utils/gcsClient')
const PDFDocument = require('pdfkit')
const FONT_REGULAR = path.join(__dirname, '..', 'assets', 'fonts', 'NotoSans-Regular.ttf')
const FONT_BOLD = path.join(__dirname, '..', 'assets', 'fonts', 'NotoSans-Bold.ttf')
const { convertAmount } = require('../utils/fxRatesService')

// ---------------- helpers ----------------
const toId = (v) => {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}

const nz = (v) => {
  if (v === undefined || v === null) return ''
  const s = String(v).trim()
  return s
}

const toNull = (v) => {
  const s = nz(v)
  return s === '' ? null : s
}

const numOrNull = (v) => {
  if (v === undefined || v === null || v === '') return null
  const n = Number(String(v).replace(',', '.'))
  return Number.isFinite(n) ? n : null
}

const formatMoney = (value, currency = null) => {
  const n = numOrNull(value)
  if (n === null) return '—'
  const amount = n.toFixed(2)
  const cur = normCurrency(currency)
  return cur ? `${amount} ${cur}` : amount
}

const boolOrNull = (v) => {
  if (v === undefined) return null
  return v ? 1 : 0
}

const normalizeRole = (user) =>
  String(user?.role_slug || user?.role || '')
    .trim()
    .toLowerCase()

const isAdmin = (user) =>
  !!(
    user &&
    (normalizeRole(user) === 'admin' ||
      user.role === 'admin' ||
      user.role_id === 1 ||
      user.is_admin === true)
  )

const isBuyer = (user) => {
  const role = normalizeRole(user)
  const buyerSet = new Set([
    'buyer',
    'procurement',
    'purchase',
    'комплектовщик',
    'закупщик',
    'закупка',
    'покупатель',
    'komplektovshchik',
    'komplektovщик', // на всякий случай
    'zakupshchik',
    'zakupka',
  ])
  return buyerSet.has(role)
}

const canViewSupplierDetails = (user) => isAdmin(user) || isBuyer(user)

const CONTRACT_STATUSES = new Set([
  'draft',
  'sent',
  'signed',
  'cancelled',
])

const normalizeContractStatus = (value) => {
  const s = nz(value).toLowerCase()
  return CONTRACT_STATUSES.has(s) ? s : 'draft'
}

const normCurrency = (v) => {
  if (!v) return null
  const s = String(v).trim().toUpperCase()
  return s.length ? s.slice(0, 3) : null
}

const convertSafe = async (amount, fromCur, toCur) => {
  const from = normCurrency(fromCur)
  const to = normCurrency(toCur)
  if (!Number.isFinite(amount) || amount === null || amount === undefined) {
    return { value: null, rate: null, base: from, quote: to, source: null }
  }
  if (!from || !to || from === to) {
    return { value: Number(amount), rate: 1, base: from || to, quote: to || from, source: 'same' }
  }
  try {
    const res = await convertAmount(amount, from, to)
    return { value: Number(res.value), rate: Number(res.rate), base: from, quote: to, source: res.source || 'db' }
  } catch (err) {
    console.error('FX convert failed, fallback to 1', err?.message || err)
    return { value: Number(amount), rate: 1, base: from, quote: to, source: 'fallback' }
  }
}

const PRICING_MODELS = new Set([
  'fixed',
  'per_kg',
  'per_cbm',
  'per_kg_or_cbm_max',
])

const normPricingModel = (v) => {
  const s = nz(v).toLowerCase()
  return PRICING_MODELS.has(s) ? s : null
}

const roundUp = (value, step) => {
  const base = numOrNull(value)
  const stepNum = numOrNull(step)
  if (base == null) return null
  if (!stepNum || stepNum <= 0) return base
  return Math.ceil(base / stepNum) * stepNum
}

const computeItemMetrics = (item) => {
  const qty = numOrNull(item?.requested_qty ?? item?.item_requested_qty) ?? 1
  const unitWeight = numOrNull(item?.weight_kg ?? item?.op_weight_kg)
  const weightKg = unitWeight != null && unitWeight > 0 ? unitWeight * qty : null
  const length = numOrNull(item?.length_cm ?? item?.op_length_cm)
  const width = numOrNull(item?.width_cm ?? item?.op_width_cm)
  const height = numOrNull(item?.height_cm ?? item?.op_height_cm)
  const unitVolumeCbm =
    length != null && width != null && height != null && length > 0 && width > 0 && height > 0
      ? (length * width * height) / 1e6
      : null
  const volumeCbm = unitVolumeCbm != null ? unitVolumeCbm * qty : null
  return {
    qty,
    unit_weight_kg: unitWeight,
    weight_kg: weightKg,
    unit_volume_cbm: unitVolumeCbm,
    volume_cbm: volumeCbm,
  }
}

const computeLogisticsFromRoute = (route, metrics = {}) => {
  if (!route) return { cost: null, currency: null, meta: null }
  const model = normPricingModel(route.pricing_model) || 'fixed'
  const ratePerKg = numOrNull(route.rate_per_kg)
  const ratePerCbm = numOrNull(route.rate_per_cbm)
  const minCost = numOrNull(route.min_cost)
  const volCoef = numOrNull(route.volumetric_kg_per_cbm) ?? 167
  const roundKg = numOrNull(route.round_step_kg)
  const roundCbm = numOrNull(route.round_step_cbm)

  const weightTotal = numOrNull(metrics.weight_kg)
  const volumeTotal = numOrNull(metrics.volume_cbm)
  const roundedWeight = weightTotal != null ? roundUp(weightTotal, roundKg) : null
  const roundedVolume = volumeTotal != null ? roundUp(volumeTotal, roundCbm) : null

  let baseCost = null
  let chargeableKg = null
  let chargeableCbm = null
  let volumetricWeight = null

  if (model === 'fixed') {
    baseCost = numOrNull(route.cost)
  } else if (model === 'per_kg') {
    chargeableKg = roundedWeight
    baseCost = chargeableKg != null && ratePerKg != null ? chargeableKg * ratePerKg : null
  } else if (model === 'per_cbm') {
    chargeableCbm = roundedVolume
    baseCost = chargeableCbm != null && ratePerCbm != null ? chargeableCbm * ratePerCbm : null
  } else if (model === 'per_kg_or_cbm_max') {
    volumetricWeight = roundedVolume != null ? roundedVolume * volCoef : null
    if (roundedWeight != null && volumetricWeight != null) {
      chargeableKg = Math.max(roundedWeight, volumetricWeight)
    } else {
      chargeableKg = roundedWeight != null ? roundedWeight : volumetricWeight
    }
    if (chargeableKg != null && ratePerKg != null) {
      baseCost = chargeableKg * ratePerKg
    } else if (roundedVolume != null && ratePerCbm != null) {
      baseCost = roundedVolume * ratePerCbm
    }
  }

  let minApplied = false
  if (baseCost != null && minCost != null && baseCost < minCost) {
    baseCost = minCost
    minApplied = true
  }

  return {
    cost: baseCost,
    currency: normCurrency(route.currency),
    meta: {
      pricing_model: model,
      rate_per_kg: ratePerKg,
      rate_per_cbm: ratePerCbm,
      min_cost: minCost,
      volumetric_kg_per_cbm: volCoef,
      round_step_kg: roundKg,
      round_step_cbm: roundCbm,
      qty: numOrNull(metrics.qty),
      unit_weight_kg: numOrNull(metrics.unit_weight_kg),
      weight_kg: weightTotal,
      unit_volume_cbm: numOrNull(metrics.unit_volume_cbm),
      volume_cbm: volumeTotal,
      chargeable_kg: chargeableKg,
      chargeable_cbm: chargeableCbm,
      volumetric_weight_kg: volumetricWeight,
      base_cost: baseCost,
      min_applied: minApplied,
    },
  }
}

const computeOfferPricing = async ({
  supplier_price,
  supplier_currency,
  logistics_cost,
  logistics_currency,
  logistics_route = null,
  logistics_meta = null,
  markup_pct,
  markup_abs,
  client_currency,
  order_currency,
  duty_rate,
  client_price_input,
}) => {
  const targetCurrency =
    normCurrency(client_currency) ||
    normCurrency(order_currency) ||
    normCurrency(supplier_currency) ||
    normCurrency(logistics_currency)

  // логистика с наценками маршрута
  const surchargePct = logistics_route?.surcharge_pct != null ? Number(logistics_route.surcharge_pct) : null
  const surchargeAbs = logistics_route?.surcharge_abs != null ? Number(logistics_route.surcharge_abs) : null

  const rawLogi = Number.isFinite(logistics_cost) ? Number(logistics_cost) : null
  let logiWithSurcharge = rawLogi
  if (logiWithSurcharge != null) {
    if (surchargePct != null) logiWithSurcharge = logiWithSurcharge * (1 + surchargePct / 100)
    if (surchargeAbs != null) logiWithSurcharge += surchargeAbs
  } else if (surchargeAbs != null) {
    logiWithSurcharge = surchargeAbs
  }

  // конвертация цен в целевую валюту
  const supplierConv = await convertSafe(supplier_price ?? null, supplier_currency, targetCurrency)
  const logisticsConv = await convertSafe(logiWithSurcharge ?? null, logistics_currency, targetCurrency)

  const supplierAmount = supplierConv.value
  const logisticsAmount = logisticsConv.value

  const dutyAmount =
    duty_rate != null && (supplierAmount != null || logisticsAmount != null)
      ? ((supplierAmount || 0) + (logisticsAmount || 0)) * Number(duty_rate) * 0.01
      : null

  const landedCost =
    supplierAmount != null || logisticsAmount != null || dutyAmount != null
      ? (supplierAmount || 0) + (logisticsAmount || 0) + (dutyAmount || 0)
      : null

  const mp = markup_pct != null ? Number(markup_pct) : 0
  const ma = markup_abs != null ? Number(markup_abs) : 0
  const computedClientPrice = landedCost != null ? landedCost * (1 + mp / 100) + ma : null
  const finalClientPrice = client_price_input != null ? numOrNull(client_price_input) : computedClientPrice

  const price_breakdown = {
    target_currency: targetCurrency,
    supplier: {
      amount: supplier_price ?? null,
      currency: normCurrency(supplier_currency),
      converted: supplierAmount,
      fx_rate: supplierConv.rate,
      fx_base: supplierConv.base,
      fx_quote: supplierConv.quote,
      fx_source: supplierConv.source,
    },
    logistics: {
      amount: rawLogi,
      currency: normCurrency(logistics_currency),
      surcharge_pct: surchargePct,
      surcharge_abs: surchargeAbs,
      with_surcharge: logiWithSurcharge,
      converted: logisticsAmount,
      fx_rate: logisticsConv.rate,
      fx_base: logisticsConv.base,
      fx_quote: logisticsConv.quote,
      fx_source: logisticsConv.source,
      pricing: logistics_meta || null,
    },
    duty: {
      rate_pct: duty_rate != null ? Number(duty_rate) : null,
      amount: dutyAmount,
    },
    landed_cost: landedCost,
    markup_pct: markup_pct != null ? Number(markup_pct) : null,
    markup_abs: markup_abs != null ? Number(markup_abs) : null,
    computed_client_price: computedClientPrice,
  }

  return {
    client_price: finalClientPrice,
    client_currency: targetCurrency,
    fx_rate: supplierConv.rate,
    fx_base_currency: supplierConv.base,
    fx_quote_currency: supplierConv.quote,
    logistics_surcharge_pct: surchargePct,
    logistics_surcharge_abs: surchargeAbs,
    duty_amount: dutyAmount,
    landed_cost: landedCost,
    price_breakdown,
  }
}

const maskOfferForUser = (offer, user) => {
  if (canViewSupplierDetails(user)) return offer
  // Продавец/клиент — оставляем только публичный код поставщика
  return {
    ...offer,
    supplier_id: null,
    supplier_name: null,
  }
}

const fetchOffersByItem = async (itemIds, user) => {
  if (!Array.isArray(itemIds) || !itemIds.length) return []
  const [offers] = await db.query(
    `
      SELECT
        o.*,
        COALESCE(o.supplier_public_code, ps.public_code) AS supplier_public_code,
        ps.name AS supplier_name,
        sa.country AS supplier_country,
        sp.supplier_part_number,
        COALESCE(sp.description_ru, sp.description_en) AS supplier_part_description
      FROM client_order_line_offers o
      LEFT JOIN supplier_parts sp ON o.supplier_part_id = sp.id
      LEFT JOIN part_suppliers ps ON o.supplier_id = ps.id
      LEFT JOIN (
        SELECT
          sa1.*,
          ROW_NUMBER() OVER (
            PARTITION BY supplier_id
            ORDER BY is_primary DESC, created_at DESC, id DESC
          ) AS rn
        FROM supplier_addresses sa1
      ) sa ON sa.supplier_id = ps.id AND sa.rn = 1
      WHERE o.order_item_id IN (${itemIds.map(() => '?').join(',')})
      ORDER BY o.client_visible DESC, o.created_at ASC, o.id ASC
    `,
    itemIds,
  )
  return offers.map((o) => maskOfferForUser(o, user))
}
// загрузка proposal PDF
const uploadProposal = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
})

const generateOrderNumber = () => {
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const datePart =
    now.getFullYear().toString() +
    pad(now.getMonth() + 1) +
    pad(now.getDate())
  const timePart =
    pad(now.getHours()) +
    pad(now.getMinutes()) +
    pad(now.getSeconds())
  return `CO${datePart}-${timePart}-${Math.floor(Math.random() * 1000)
    .toString()
    .padStart(3, '0')}`
}



const buildProposalPdf = (order = {}, items = []) =>
  new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 36 })
    const chunks = []

    doc.on('data', (c) => chunks.push(c))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)

    const textSafe = (v) => (v === null || v === undefined ? '' : String(v))
    const margin = doc.page.margins.left
    const pageWidth = doc.page.width - margin * 2
    const colWidths = [18, 22, 100, 180, 50, 32, 70, 40]
    const gap = 4

    const maxRowHeight = (vals, fontSize = 10) => {
      let maxH = 0
      vals.forEach((val, idx) => {
        const w = colWidths[idx]
        const h = doc.heightOfString(textSafe(val), {
          width: w,
          align: 'left',
          lineGap: 2,
          characterSpacing: 0,
          continued: false,
        })
        maxH = Math.max(maxH, h)
      })
      return maxH || fontSize + 2
    }

    const ensureSpace = (rowHeight = 18, needHeader = false, headerFn = null) => {
      const bottom = doc.page.height - doc.page.margins.bottom - rowHeight
      if (doc.y > bottom) {
        doc.addPage()
        doc.font(FONT_REGULAR).fontSize(10)
        if (needHeader && typeof headerFn === 'function') headerFn()
      }
    }

    const drawTableHeader = () => {
      const startY = doc.y
      let x = margin
      doc.font(FONT_BOLD).fontSize(10)
      const titles = ['№', 'Вар.', 'Cat# пост.', 'Описание у поставщика', 'Кол-во', 'Ед.', 'Цена', 'ETA']
      titles.forEach((t, idx) => {
        doc.text(t, x, startY, { width: colWidths[idx], continued: false })
        x += colWidths[idx] + gap
      })
      const headerHeight = maxRowHeight(titles, 10)
      doc.moveTo(margin, startY + headerHeight + 2).lineTo(margin + colWidths.reduce((a, b) => a + b, 0) + gap * (titles.length - 1), startY + headerHeight + 2).stroke()
      doc.y = startY + headerHeight + 6
      doc.font(FONT_REGULAR).fontSize(10)
    }

    const drawRow = (vals) => {
      const rowH = maxRowHeight(vals, 10)
      ensureSpace(rowH + 6, true, drawTableHeader)
      const y = doc.y
      let x = margin
      vals.forEach((val, idx) => {
        doc.text(textSafe(val), x, y, { width: colWidths[idx], continued: false })
        x += colWidths[idx] + gap
      })
      doc.y = y + rowH + 4
    }

    const title = `Предложение по заказу ${order.order_number || `#${order.id || ''}`}`
    doc.font(FONT_BOLD).fontSize(16).text(title, { align: 'left', width: pageWidth })
    doc.moveDown(0.6)
    doc.font(FONT_REGULAR).fontSize(11)
    doc.text(`Клиент: ${textSafe(order.client_company_name || order.client_name)}`)
    doc.text(`Контакт: ${textSafe(order.contact_name || '')}`)
    doc.text(`Телефон: ${textSafe(order.contact_phone || '')}`)
    doc.text(`Email: ${textSafe(order.contact_email || '')}`)
    doc.text(`Заказ клиента: ${textSafe(order.client_po_number || '—')}`)
    doc.text(`Валюта: ${textSafe(order.currency || '—')}`)
    doc.text(`Инкотермс: ${textSafe(order.incoterms || '—')}`)
    doc.text(`Оплата: ${textSafe(order.payment_terms || '—')}`)
    doc.text(`Желаемая дата: ${textSafe(order.requested_delivery_date || '—')}`)
    doc.moveDown(0.4)
    doc
      .font(FONT_BOLD)
      .text('Внимание: это временная болванка. Реквизиты, логотип и финальный текст будут добавлены позже.', {
        width: pageWidth,
      })
    doc.font(FONT_REGULAR)

    doc.moveDown(0.8)
    doc.font(FONT_BOLD).fontSize(13).text('Позиции', { underline: true })
    doc.moveDown(0.2)

    let total = 0
    items.forEach((it, idx) => {
      ensureSpace(40, true, drawTableHeader)
      const lineTitle = `Позиция ${it.line_number || idx + 1}: ${textSafe(it.cat_number || it.original_part_number || '—')} — ${textSafe(it.description_ru || it.description_en || '')}`
      doc.font(FONT_BOLD).fontSize(11).text(lineTitle, { width: pageWidth })
      const modelLine = [it.manufacturer_name, it.model_name].filter(Boolean).join(' ')
      if (modelLine) {
        doc.font(FONT_REGULAR).fontSize(10).text(modelLine, { width: pageWidth })
      }
      doc.moveDown(0.2)
      drawTableHeader()

      const offers = Array.isArray(it.offers) ? it.offers : []
      const visible = offers.filter((o) => o.client_visible)
      const hasApprovedVisible = visible.some((o) => o.status === 'approved')
      const fallbackChosen = offers.find((o) => o.status === 'approved') || offers.find((o) => o.status === 'proposed') || offers[0]
      const displayOffers = visible.length > 0 ? visible : fallbackChosen ? [fallbackChosen] : []

      if (!displayOffers.length) {
        drawRow([
          it.line_number || idx + 1,
          '',
          it.cat_number || it.original_part_number || '—',
          it.description_ru || it.description_en || '',
          it.requested_qty || 1,
          it.uom || 'pcs',
          '—',
          '—',
        ])
        return
      }

      displayOffers.forEach((offer, offerIdx) => {
        const variantLabel = displayOffers.length > 1 ? String.fromCharCode(65 + offerIdx) : ''
        const priceStr = formatMoney(offer?.client_price, offer?.client_currency || order.currency || null)
        const etaStr = offer?.eta_days_effective != null
          ? `${offer.eta_days_effective} дн.`
          : offer?.lead_time_days != null
            ? `${offer.lead_time_days} дн.`
            : '—'

        drawRow([
          it.line_number || idx + 1,
          variantLabel,
          offer?.supplier_part_number || it.cat_number || it.original_part_number || '—',
          offer?.supplier_part_description || it.description_ru || it.description_en || '',
          it.requested_qty || 1,
          it.uom || 'pcs',
          priceStr,
          etaStr,
        ])

        const numericPrice = numOrNull(offer?.client_price)
        const hasApproved = hasApprovedVisible || offers.some((o) => o.status === 'approved')
        const shouldCount = (hasApproved && offer.status === 'approved') || (!hasApproved && offerIdx === 0)
        if (shouldCount && !Number.isNaN(numericPrice)) total += numericPrice
      })

      doc.moveDown(0.6)
    })

    doc.moveDown(0.8)
    doc
      .fontSize(12)
      .font(FONT_BOLD)
      .text(`Итог (утверждённые или первый видимый вариант): ${total ? formatMoney(total, order.currency || null) : '—'}`, {
        width: pageWidth,
      })
    if (order.comment_client) {
      doc.moveDown(0.4)
      doc.fontSize(11).font(FONT_REGULAR).text(`Комментарий клиента: ${order.comment_client}`, { width: pageWidth })
    }

    doc.end()
  })

const buildContractPdf = (contract = {}, order = {}, items = []) =>
  new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 36 })
    const chunks = []

    doc.on('data', (c) => chunks.push(c))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)

    const textSafe = (v) => (v === null || v === undefined ? '' : String(v))
    const margin = doc.page.margins.left
    const pageWidth = doc.page.width - margin * 2

    const title = `Договор поставки (шаблон)`
    const contractNumber = contract.contract_number || '—'
    const contractDate = contract.contract_date || '—'
    const orderLabel = order.order_number ? `№${order.order_number}` : `#${order.id || ''}`
    const amountLabel = formatMoney(contract.amount, contract.currency || order.currency || null)

    doc.font(FONT_BOLD).fontSize(16).text(title, { align: 'left', width: pageWidth })
    doc.moveDown(0.6)
    doc.font(FONT_REGULAR).fontSize(11)
    doc.text(`Договор № ${textSafe(contractNumber)} от ${textSafe(contractDate)}`)
    doc.text(`Заказ: ${textSafe(orderLabel)}`)
    doc.text(`Клиент: ${textSafe(order.client_company_name || order.client_name)}`)
    doc.text(`Сумма договора: ${textSafe(amountLabel)}`)
    if (contract.status) {
      doc.text(`Статус: ${textSafe(contract.status)}`)
    }

    doc.moveDown(0.6)
    doc
      .font(FONT_BOLD)
      .text('Важно: это временная болванка. Реквизиты, логотип и финальный текст будут добавлены позже.', {
        width: pageWidth,
      })
    doc.moveDown(0.6)
    doc.font(FONT_REGULAR)
    doc.text('Состав поставки (предварительно):', { width: pageWidth })

    const approvedOffers = items.flatMap((it) => {
      const offers = Array.isArray(it.offers) ? it.offers : []
      const chosen =
        offers.find((o) => o.id === it.decision_offer_id) ||
        offers.find((o) => o.status === 'approved') ||
        null
      if (!chosen) return []
      return [{
        line: it.line_number || '',
        part: it.cat_number || it.original_part_number || '—',
        qty: it.requested_qty || 1,
        uom: it.uom || 'pcs',
        price: formatMoney(chosen.client_price, chosen.client_currency || order.currency || null),
      }]
    })

    if (!approvedOffers.length) {
      doc.text('Нет утверждённых позиций. Добавьте выбор оффера, затем обновите договор.', { width: pageWidth })
    } else {
      approvedOffers.forEach((row) => {
        doc.text(
          `• Позиция ${textSafe(row.line)}: ${textSafe(row.part)} — ${textSafe(row.qty)} ${textSafe(row.uom)} — ${textSafe(row.price)}`,
          { width: pageWidth },
        )
      })
    }

    if (contract.comment) {
      doc.moveDown(0.6)
      doc.text(`Комментарий: ${textSafe(contract.comment)}`, { width: pageWidth })
    }

    doc.moveDown(1.2)
    doc.text('Стороны:', { width: pageWidth })
    doc.text('Поставщик: ____________________', { width: pageWidth })
    doc.text('Покупатель: ____________________', { width: pageWidth })

    doc.end()
  })

const logEvent = async ({
  order_id,
  order_item_id = null,
  offer_id = null,
  type,
  from_status = null,
  to_status = null,
  payload = null,
  user_id = null,
  conn = null, // если передали соединение транзакции — используем его, чтобы избежать ожидания блокировок
}) => {
  try {
    const executor =
      conn && typeof conn.execute === 'function'
        ? conn
        : db

    await executor.execute(
      `
        INSERT INTO client_order_events
          (order_id, order_item_id, offer_id, type, from_status, to_status, payload, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        order_id,
        order_item_id,
        offer_id,
        nz(type),
        toNull(from_status),
        toNull(to_status),
        payload ? JSON.stringify(payload) : null,
        user_id || null,
      ],
    )
  } catch (err) {
    // не блокируем бизнес-операции на логах: 1205/1213 игнорируем
    const code = err?.code || err?.errno
    if (code === 1205 || code === 1213) return
    console.error('logEvent error', err?.sqlMessage || err?.message || err)
  }
}

const fetchOrder = async (orderId) => {
  const [[order]] = await db.query(
    `
      SELECT
        co.*,
        c.company_name AS client_company_name,
        sa.formatted_address AS shipping_address_label,
        ba.formatted_address AS billing_address_label,
        COALESCE(u.full_name, u.username) AS responsible_name,
        u.username AS responsible_login
      FROM client_orders co
      JOIN clients c ON co.client_id = c.id
      LEFT JOIN client_shipping_addresses sa ON sa.id = co.shipping_address_id
      LEFT JOIN client_billing_addresses ba ON ba.id = co.billing_address_id
      LEFT JOIN users u ON co.responsible_user_id = u.id
      WHERE co.id = ?
    `,
    [orderId],
  )
  return order || null
}

const fetchItemsWithOffers = async (orderId, user) => {
  const [items] = await db.query(
    `
      SELECT
        i.*,
        op.cat_number,
        op.description_en,
        op.description_ru,
        op.weight_kg AS op_weight_kg,
        op.length_cm AS op_length_cm,
        op.width_cm AS op_width_cm,
        op.height_cm AS op_height_cm,
        op.description_ru AS original_description_ru,
        op.description_en AS original_description_en,
        COALESCE(op.tnved_code, t.code) AS tnved_code_value,
        t.duty_rate AS tnved_duty_rate,
        em.model_name,
        mf.name AS manufacturer_name
      FROM client_order_items i
      LEFT JOIN original_parts op ON i.original_part_id = op.id
      LEFT JOIN equipment_models em ON COALESCE(i.equipment_model_id, op.equipment_model_id) = em.id
      LEFT JOIN equipment_manufacturers mf ON em.manufacturer_id = mf.id
      LEFT JOIN tnved_codes t ON op.tnved_code_id = t.id
      WHERE i.order_id = ?
      ORDER BY i.line_number ASC, i.id ASC
    `,
    [orderId],
  )

  if (!items.length) return []

  const ids = items.map((it) => it.id)
  const offers = await fetchOffersByItem(ids, user)
  const offersByItem = new Map()
  offers.forEach((o) => {
    const arr = offersByItem.get(o.order_item_id) || []
    arr.push(maskOfferForUser(o, user))
    offersByItem.set(o.order_item_id, arr)
  })

  return items.map((it) => ({
    ...it,
    offers: offersByItem.get(it.id) || [],
  }))
}

const fetchEvents = async (orderId) => {
  const [rows] = await db.query(
    `
      SELECT e.*, u.full_name AS user_name
      FROM client_order_events e
      LEFT JOIN users u ON u.id = e.created_by
      WHERE e.order_id = ?
      ORDER BY e.created_at ASC, e.id ASC
    `,
    [orderId],
  )
  return rows
}

const fetchContracts = async (orderId) => {
  const [rows] = await db.query(
    `
      SELECT *
      FROM client_order_contracts
      WHERE order_id = ?
      ORDER BY contract_date DESC, id DESC
    `,
    [orderId],
  )
  return rows
}

// -------------------------------------------------------------
// GET /client-orders — список заказов (с фильтрами и пагинацией)
// -------------------------------------------------------------
router.get('/', async (req, res) => {
  try {
    const page = Math.max(Number(req.query.page) || 1, 1)
    const pageSize = Math.min(Math.max(Number(req.query.pageSize) || 20, 1), 100)

    const clientId = toId(req.query.client_id)
    const status = nz(req.query.status)
    const search = nz(req.query.search)
    const responsibleId = toId(req.query.responsible_user_id)
    const createdFrom = nz(req.query.created_from)
    const createdTo = nz(req.query.created_to)

    const where = []
    const params = []

    if (clientId) {
      where.push('co.client_id = ?')
      params.push(clientId)
    }

    if (status) {
      where.push('co.status = ?')
      params.push(status)
    }

    if (responsibleId) {
      where.push('co.responsible_user_id = ?')
      params.push(responsibleId)
    }

    if (createdFrom) {
      where.push('co.created_at >= ?')
      params.push(`${createdFrom} 00:00:00`)
    }

    if (createdTo) {
      where.push('co.created_at <= ?')
      params.push(`${createdTo} 23:59:59`)
    }

    if (search) {
      where.push(
        '(co.order_number LIKE ? OR c.company_name LIKE ? OR co.comment_client LIKE ? OR co.comment_internal LIKE ? OR co.client_po_number LIKE ?)',
      )
      const like = `%${search}%`
      params.push(like, like, like, like, like)
    }

    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : ''
    const offset = (page - 1) * pageSize

    const [rows] = await db.query(
      `
      SELECT
        co.*,
        c.company_name AS client_company_name,
        COALESCE(u.full_name, u.username) AS responsible_name,
        u.username AS responsible_login
      FROM client_orders co
      JOIN clients c ON co.client_id = c.id
      LEFT JOIN users u ON co.responsible_user_id = u.id
      ${whereSql}
      ORDER BY co.created_at DESC, co.id DESC
      LIMIT ? OFFSET ?
    `,
      [...params, pageSize, offset],
    )

    const [[{ total }]] = await db.query(
      `
      SELECT COUNT(*) AS total
      FROM client_orders co
      JOIN clients c ON co.client_id = c.id
      ${whereSql}
    `,
      params,
    )

    res.json({
      data: rows,
      pagination: {
        page,
        pageSize,
        total,
      },
    })
  } catch (e) {
    console.error('GET /client-orders error:', e)
    res.status(500).json({ message: 'Ошибка загрузки заказов' })
  }
})

// -------------------------------------------------------------
// GET /client-orders/responsible-users — краткий список пользователей
// -------------------------------------------------------------
router.get('/responsible-users', async (req, res) => {
  try {
    const [rows] = await db.query(
      `
        SELECT id, username, full_name, role_id, phone, email
        FROM users
        ORDER BY COALESCE(NULLIF(full_name,''), username) ASC
      `,
    )
    res.json(rows)
  } catch (e) {
    console.error('GET /client-orders/responsible-users error:', e)
    res.status(500).json({ message: 'Ошибка загрузки пользователей' })
  }
})

// -------------------------------------------------------------
// GET /client-orders/:id — один заказ + позиции + офферы + события
// -------------------------------------------------------------
router.get('/:id', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) {
      return res.status(400).json({ message: 'Некорректный идентификатор заказа' })
    }

    const order = await fetchOrder(id)
    if (!order) {
      return res.status(404).json({ message: 'Заказ не найден' })
    }

    const items = await fetchItemsWithOffers(id, req.user)
    const events = await fetchEvents(id)

    res.json({ order, items, events })
  } catch (e) {
    console.error('GET /client-orders/:id error:', e)
    res.status(500).json({ message: 'Ошибка загрузки заказа' })
  }
})

// -------------------------------------------------------------
// POST /client-orders — создание заказа с позициями
// -------------------------------------------------------------
router.post('/', async (req, res) => {
  let conn
  try {
    const {
      client_id,
      order_number,
      status,
      source_type,
      source, // алиас
      contact_name,
      contact_email,
      contact_phone,
      billing_address_id,
      shipping_address_id,
      client_po_number,
      currency,
      incoterms,
      payment_terms,
      comment_internal,
      comment_client,
      requested_delivery_date,
      assigned_to_user_id,
      responsible_user_id,
      items = [],
    } = req.body || {}

    const clientId = toId(client_id)
    const createdBy = toId(req.user?.id)

    if (!createdBy) {
      return res.status(401).json({ message: 'Нет пользователя в токене' })
    }

    if (!clientId) {
      return res.status(400).json({ message: 'Не выбран клиент' })
    }

    if (items && !Array.isArray(items)) {
      return res
        .status(400)
        .json({ message: 'items должен быть массивом' })
    }

    const orderNumber = nz(order_number)
    if (!orderNumber) {
      return res.status(400).json({ message: 'order_number обязателен' })
    }

    const allowedStatuses = new Set([
      'draft',
      'new',
      'submitted',
      'confirmed',
      'rework',
      'cancelled',
    ])
    const orderStatus = allowedStatuses.has(status) ? status : 'draft'

    conn = await db.getConnection()
    await conn.beginTransaction()

    const [orderResult] = await conn.execute(
      `
      INSERT INTO client_orders (
        order_number,
        client_id,
        status,
        source_type,
        created_by_user_id,
        responsible_user_id,
        billing_address_id,
        shipping_address_id,
        client_po_number,
        currency,
        incoterms,
        payment_terms,
        contact_name,
        contact_email,
        contact_phone,
        comment_internal,
        comment_client,
        requested_delivery_date
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      [
        orderNumber,
        clientId,
        orderStatus,
        nz(source_type || source || 'manual'),
        createdBy,
        toId(responsible_user_id || assigned_to_user_id),
        toId(billing_address_id),
        toId(shipping_address_id),
        toNull(client_po_number),
        toNull(currency),
        toNull(incoterms),
        toNull(payment_terms),
        toNull(contact_name),
        toNull(contact_email),
        toNull(contact_phone),
        toNull(comment_internal),
        toNull(comment_client),
        requested_delivery_date || null,
      ],
    )

    const orderId = orderResult.insertId

    const itemsList = Array.isArray(items) ? items : []
    let lineNo = 1
    for (const item of itemsList) {
      const originalPartId = toId(item.original_part_id)
      const equipmentModelId = toId(item.equipment_model_id)
      const qty = numOrNull(item.requested_qty ?? item.qty_requested)
      let unit = item.uom ?? item.qty_unit ?? null

      if (!originalPartId || !qty || qty <= 0) {
        throw new Error(
          `Некорректная позиция заказа (original_part_id / qty): ${JSON.stringify(
            item,
          )}`,
        )
      }

      if (!unit && originalPartId) {
        const [[op]] = await conn.execute(
          'SELECT uom FROM original_parts WHERE id = ?',
          [originalPartId],
        )
        unit = op?.uom || null
      }
      unit = toNull(unit ?? 'pcs')

      await conn.execute(
        `
        INSERT INTO client_order_items (
          order_id,
          line_number,
          original_part_id,
          equipment_model_id,
          client_part_number,
          client_description,
          client_line_text,
          requested_qty,
          uom,
          required_date,
          priority,
          status,
          internal_comment,
          client_comment
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)
      `,
        [
          orderId,
          lineNo++,
          originalPartId,
          equipmentModelId,
          toNull(item.client_part_number),
          toNull(item.client_description),
          toNull(item.client_line_text),
          qty,
          unit,
          item.required_date || item.requested_delivery_date || null,
          toNull(item.priority),
          toNull(item.internal_comment),
          toNull(item.client_comment),
        ],
      )
    }

    await logActivity({
      req,
      action: 'create',
      entity_type: 'client_orders',
      entity_id: orderId,
      client_id: clientId,
      comment: `Создан заказ ${orderNumber} (${orderStatus})`,
    })

    await logEvent({
      order_id: orderId,
      type: 'order_created',
      to_status: orderStatus,
      payload: { order_number: orderNumber, items: itemsList.length },
      user_id: createdBy,
      conn,
    })

    await conn.commit()
    conn.release()

    const order = await fetchOrder(orderId)
    const itemsWithOffers = await fetchItemsWithOffers(orderId, req.user)
    const events = await fetchEvents(orderId)

    res.status(201).json({ order, items: itemsWithOffers, events })
  } catch (e) {
    if (e?.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ message: 'Заказ с таким номером уже существует' })
    }
    console.error('POST /client-orders error:', e)
    try {
      if (conn) await conn.rollback()
    } catch {}
    if (conn) conn.release?.()
    res.status(500).json({ message: 'Ошибка создания заказа' })
  }
})

// -------------------------------------------------------------
// PUT /client-orders/:id — обновление шапки заказа
// -------------------------------------------------------------
router.put('/:id', async (req, res) => {
  let conn
  try {
    const id = toId(req.params.id)
    if (!id) {
      return res.status(400).json({ message: 'Некорректный идентификатор заказа' })
    }

    const {
      status,
      contact_name,
      contact_phone,
      contact_email,
      billing_address_id,
      shipping_address_id,
      comment_internal,
      comment_client,
      requested_delivery_date,
      responsible_user_id,
      currency,
      incoterms,
      payment_terms,
      client_po_number,
      order_number,
    } = req.body || {}

    conn = await db.getConnection()
    await conn.beginTransaction()

    const [beforeRows] = await conn.execute(
      'SELECT * FROM client_orders WHERE id = ?',
      [id],
    )
    const before = beforeRows[0]
    if (!before) {
      await conn.rollback()
      conn.release()
      return res.status(404).json({ message: 'Заказ не найден' })
    }

    const clientId = before.client_id

      await conn.execute(
        `
      UPDATE client_orders
      SET
        status = COALESCE(?, status),
        order_number = COALESCE(?, order_number),
        contact_name = ?,
        contact_phone = ?,
        contact_email = ?,
        billing_address_id = ?,
        shipping_address_id = ?,
        comment_internal = ?,
        comment_client = ?,
        requested_delivery_date = ?,
        responsible_user_id = ?,
        currency = COALESCE(?, currency),
        incoterms = COALESCE(?, incoterms),
        payment_terms = COALESCE(?, payment_terms),
        client_po_number = COALESCE(?, client_po_number)
      WHERE id = ?
    `,
        [
          toNull(status) || before.status,
          toNull(order_number) || before.order_number,
          toNull(contact_name ?? before.contact_name),
          toNull(contact_phone ?? before.contact_phone),
          toNull(contact_email ?? before.contact_email),
          toId(billing_address_id ?? before.billing_address_id),
          toId(shipping_address_id ?? before.shipping_address_id),
          toNull(comment_internal ?? before.comment_internal),
          toNull(comment_client ?? before.comment_client),
          requested_delivery_date ?? before.requested_delivery_date,
          toId(responsible_user_id ?? before.responsible_user_id),
          toNull(currency),
          toNull(incoterms),
          toNull(payment_terms),
          toNull(client_po_number),
          id,
        ],
      )

    const [afterRows] = await conn.execute(
      'SELECT * FROM client_orders WHERE id = ?',
      [id],
    )
    const after = afterRows[0]

    await logFieldDiffs(conn, {
      req,
      entity_type: 'client_orders',
      entity_id: id,
      client_id: clientId,
      before,
      after,
      fields: [
        'status',
        'order_number',
        'contact_name',
        'contact_phone',
        'contact_email',
        'billing_address_id',
        'shipping_address_id',
        'comment_internal',
        'comment_client',
        'requested_delivery_date',
        'responsible_user_id',
        'currency',
        'incoterms',
        'payment_terms',
        'client_po_number',
      ],
    })

    if (before.status !== after.status) {
      await logEvent({
        order_id: id,
        type: 'order_status_change',
        from_status: before.status,
        to_status: after.status,
        user_id: req.user?.id || null,
        conn,
      })
    }

    await conn.commit()
    conn.release()

    res.json(after)
  } catch (e) {
    console.error('PUT /client-orders/:id error:', e)
    try {
      if (conn) await conn.rollback()
    } catch {}
    if (conn) conn.release?.()
    res.status(500).json({ message: 'Ошибка обновления заказа' })
  }
})

// -------------------------------------------------------------
// POST /client-orders/:id/items — добавить позицию
// -------------------------------------------------------------
router.post('/:id/items', async (req, res) => {
  let conn
  try {
    const orderId = toId(req.params.id)
    if (!orderId) {
      return res.status(400).json({ message: 'Некорректный идентификатор заказа' })
    }

    const {
      original_part_id,
      equipment_model_id,
      requested_qty,
      qty_requested,
      uom,
      qty_unit,
      required_date,
      requested_delivery_date,
      client_part_number,
      client_description,
      client_line_text,
      priority,
      internal_comment,
      client_comment,
    } = req.body || {}

    const originalPartId = toId(original_part_id)
    const qty = numOrNull(requested_qty ?? qty_requested)
    if (!originalPartId || !qty || qty <= 0) {
      return res
        .status(400)
        .json({ message: 'Нужно выбрать оригинальную деталь и указать количество > 0' })
    }

    conn = await db.getConnection()
    await conn.beginTransaction()

    const [[order]] = await conn.execute(
      'SELECT * FROM client_orders WHERE id = ?',
      [orderId],
    )
    if (!order) {
      await conn.rollback()
      conn.release()
      return res.status(404).json({ message: 'Заказ не найден' })
    }

    const [[{ maxLine }]] = await conn.execute(
      'SELECT COALESCE(MAX(line_number), 0) AS maxLine FROM client_order_items WHERE order_id = ?',
      [orderId],
    )
    const nextLine = (maxLine || 0) + 1

    // Попробуем взять модель из оригинальной детали, если не пришла явно
    let modelId = toId(equipment_model_id)
    let resolvedUom = uom ?? qty_unit ?? null
    if (!modelId && originalPartId) {
      const [[op]] = await conn.execute(
        'SELECT equipment_model_id, uom FROM original_parts WHERE id = ?',
        [originalPartId],
      )
      modelId = op?.equipment_model_id ? Number(op.equipment_model_id) : null
      if (!resolvedUom) resolvedUom = op?.uom || null
    }

    const [ins] = await conn.execute(
      `
      INSERT INTO client_order_items (
        order_id,
        line_number,
        original_part_id,
        equipment_model_id,
        client_part_number,
        client_description,
        client_line_text,
        requested_qty,
        uom,
        required_date,
        priority,
        status,
        internal_comment,
        client_comment
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)
    `,
      [
        orderId,
        nextLine,
        originalPartId,
        modelId,
        toNull(client_part_number),
        toNull(client_description),
        toNull(client_line_text),
        qty,
        toNull(resolvedUom ?? 'pcs'),
        required_date || requested_delivery_date || null,
        toNull(priority),
        toNull(internal_comment),
        toNull(client_comment),
      ],
    )

    const itemId = ins.insertId

    await logActivity({
      req,
      action: 'create',
      entity_type: 'client_order_items',
      entity_id: itemId,
      client_id: order.client_id,
      comment: `Добавлена позиция №${nextLine} в заказ ${order.order_number}`,
    })

    await logEvent({
      order_id: orderId,
      order_item_id: itemId,
      type: 'item_added',
      to_status: 'open',
      payload: { line_number: nextLine, qty },
      user_id: req.user?.id || null,
      conn,
    })

    await conn.commit()
    conn.release()

    const [[created]] = await db.query(
      `
      SELECT
        i.*,
        op.cat_number,
        op.description_en,
        op.description_ru,
        em.model_name
      FROM client_order_items i
      LEFT JOIN original_parts op ON i.original_part_id = op.id
      LEFT JOIN equipment_models em ON i.equipment_model_id = em.id
      WHERE i.id = ?
    `,
      [itemId],
    )

    res.status(201).json(created)
  } catch (e) {
    console.error('POST /client-orders/:id/items error:', e)
    try {
      if (conn) await conn.rollback()
    } catch {}
    if (conn) conn.release?.()
    res.status(500).json({ message: 'Ошибка добавления позиции' })
  }
})

// -------------------------------------------------------------
// PUT /client-orders/items/:itemId — обновление позиции
// -------------------------------------------------------------
router.put('/items/:itemId', async (req, res) => {
  let conn
  try {
    const itemId = toId(req.params.itemId)
    if (!itemId) {
      return res.status(400).json({ message: 'Некорректный идентификатор позиции' })
    }

    const {
      original_part_id,
      equipment_model_id,
      requested_qty,
      qty_requested,
      uom,
      qty_unit,
      required_date,
      requested_delivery_date,
      client_part_number,
      client_description,
      client_line_text,
      priority,
      internal_comment,
      client_comment,
      status,
    } = req.body || {}

    conn = await db.getConnection()
    await conn.beginTransaction()

    const [beforeRows] = await conn.execute(
      'SELECT * FROM client_order_items WHERE id = ?',
      [itemId],
    )
    const before = beforeRows[0]
    if (!before) {
      await conn.rollback()
      conn.release()
      return res.status(404).json({ message: 'Позиция не найдена' })
    }

    const [[order]] = await conn.execute(
      'SELECT client_id, order_number FROM client_orders WHERE id = ?',
      [before.order_id],
    )

    const newQty =
      requested_qty !== undefined || qty_requested !== undefined
        ? numOrNull(requested_qty ?? qty_requested)
        : before.requested_qty
    if (newQty !== null && newQty <= 0) {
      return res.status(400).json({ message: 'requested_qty должен быть > 0' })
    }

    await conn.execute(
      `
      UPDATE client_order_items
      SET
        original_part_id = ?,
        equipment_model_id = ?,
        client_part_number = ?,
        client_description = ?,
        client_line_text = ?,
        requested_qty = ?,
        uom = ?,
        required_date = ?,
        priority = ?,
        status = ?,
        internal_comment = ?,
        client_comment = ?
      WHERE id = ?
    `,
      [
        toId(original_part_id ?? before.original_part_id),
        toId(equipment_model_id ?? before.equipment_model_id),
        toNull(client_part_number ?? before.client_part_number),
        toNull(client_description ?? before.client_description),
        toNull(client_line_text ?? before.client_line_text),
        newQty ?? before.requested_qty,
        toNull(uom ?? qty_unit ?? before.uom),
        required_date ?? requested_delivery_date ?? before.required_date,
        toNull(priority ?? before.priority),
        toNull(status ?? before.status),
        toNull(internal_comment ?? before.internal_comment),
        toNull(client_comment ?? before.client_comment),
        itemId,
      ],
    )

    const [afterRows] = await conn.execute(
      'SELECT * FROM client_order_items WHERE id = ?',
      [itemId],
    )
    const after = afterRows[0]

    await logFieldDiffs(conn, {
      req,
      entity_type: 'client_order_items',
      entity_id: itemId,
      client_id: order?.client_id,
      before,
      after,
      fields: [
        'original_part_id',
        'equipment_model_id',
        'client_part_number',
        'client_description',
        'client_line_text',
        'requested_qty',
        'uom',
        'required_date',
        'priority',
        'status',
        'internal_comment',
        'client_comment',
      ],
    })

    if (before.status !== after.status) {
      await logEvent({
        order_id: before.order_id,
        order_item_id: itemId,
        type: 'item_status_change',
        from_status: before.status,
        to_status: after.status,
        user_id: req.user?.id || null,
        conn,
      })
    }

    await conn.commit()
    conn.release()

    res.json(after)
  } catch (e) {
    console.error('PUT /client-orders/items/:itemId error:', e)
    try {
      if (conn) await conn.rollback()
    } catch {}
    if (conn) conn.release?.()
    res.status(500).json({ message: 'Ошибка обновления позиции' })
  }
})

// -------------------------------------------------------------
// DELETE /client-orders/items/:itemId — удаление позиции
// -------------------------------------------------------------
router.delete('/items/:itemId', async (req, res) => {
  let conn
  try {
    const itemId = toId(req.params.itemId)
    if (!itemId) {
      return res.status(400).json({ message: 'Некорректный идентификатор позиции' })
    }

    conn = await db.getConnection()
    await conn.beginTransaction()

    const [beforeRows] = await conn.execute(
      'SELECT * FROM client_order_items WHERE id = ?',
      [itemId],
    )
    const before = beforeRows[0]
    if (!before) {
      await conn.rollback()
      conn.release()
      return res.status(404).json({ message: 'Позиция не найдена' })
    }

    const [[order]] = await conn.execute(
      'SELECT client_id, order_number FROM client_orders WHERE id = ?',
      [before.order_id],
    )

    await conn.execute('DELETE FROM client_order_items WHERE id = ?', [itemId])

    await logActivity({
      req,
      action: 'delete',
      entity_type: 'client_order_items',
      entity_id: itemId,
      client_id: order?.client_id,
      comment: 'Удалено пользователем',
    })

    await logEvent({
      order_id: before.order_id,
      order_item_id: itemId,
      type: 'item_deleted',
      payload: { line_number: before.line_number },
      user_id: req.user?.id || null,
      conn,
    })

    await conn.commit()
    conn.release()

    res.json({ success: true })
  } catch (e) {
    console.error('DELETE /client-orders/items/:itemId error:', e)
    try {
      if (conn) await conn.rollback()
    } catch {}
    if (conn) conn.release?.()
    res.status(500).json({ message: 'Ошибка удаления позиции' })
  }
})

// -------------------------------------------------------------
// POST /client-orders/items/:itemId/offers — добавить оффер
// -------------------------------------------------------------
router.post('/items/:itemId/offers', async (req, res) => {
  let conn
  try {
    const itemId = toId(req.params.itemId)
    if (!itemId) {
      return res.status(400).json({ message: 'Некорректный идентификатор позиции' })
    }

    const {
      supplier_part_id,
      supplier_id,
      supplier_price,
      supplier_currency,
      material_id,
      lead_time_days,
      moq,
      packaging,
      logistics_route_id,
      logistics_cost,
      logistics_currency,
      markup_pct,
      markup_abs,
      fx_rate,
      client_price,
      client_currency,
      status,
      comment_internal,
      comment_client,
      original_part_id,
      bundle_id,
      client_visible,
    } = req.body || {}

    conn = await db.getConnection()
    await conn.beginTransaction()

    const [[item]] = await conn.execute(
      `
        SELECT
          i.*,
          op.weight_kg AS op_weight_kg,
          op.length_cm AS op_length_cm,
          op.width_cm AS op_width_cm,
          op.height_cm AS op_height_cm
        FROM client_order_items i
        LEFT JOIN original_parts op ON i.original_part_id = op.id
        WHERE i.id = ?
      `,
      [itemId],
    )
    if (!item) {
      await conn.rollback()
      conn.release()
      return res.status(404).json({ message: 'Позиция не найдена' })
    }

    const [[order]] = await conn.execute(
      'SELECT id, client_id, currency FROM client_orders WHERE id = ?',
      [item.order_id],
    )

    // справочная информация по оригиналу (для пошлины)
    let dutyRate = null
    const originalId = toId(original_part_id) || toId(item.original_part_id)
    if (originalId) {
      const [[orig]] = await conn.execute(
        `
          SELECT op.tnved_code_id, t.duty_rate
          FROM original_parts op
          LEFT JOIN tnved_codes t ON t.id = op.tnved_code_id
          WHERE op.id = ?
        `,
        [originalId],
      )
      dutyRate = orig?.duty_rate != null ? Number(orig.duty_rate) : null
    }

    // справочная информация по детали поставщика
    let supplierDefaults = null
    if (supplier_part_id) {
      const [[sp]] = await conn.execute(
        `
          SELECT
            sp.id,
            sp.supplier_id,
            sp.supplier_part_number,
            sp.price,
            sp.currency AS price_currency,
            sp.lead_time_days,
            sp.default_material_id,
            sp.default_markup_pct,
            sp.default_markup_abs,
            sp.default_logistics_route_id,
            sp.default_fx_currency,
            ps.public_code,
            ps.preferred_currency,
            ps.default_lead_time_days
          FROM supplier_parts sp
          JOIN part_suppliers ps ON ps.id = sp.supplier_id
          WHERE sp.id = ?
        `,
        [supplier_part_id],
      )
      if (!sp) {
        throw new Error('supplier_part_id не найден')
      }
      supplierDefaults = sp
    }

    const supplierId = toId(supplier_id) || supplierDefaults?.supplier_id || null
    let supplierPublicCode = supplierDefaults?.public_code || null
    const supplierPartNumber = supplierDefaults?.supplier_part_number || null
    const leadTime =
      numOrNull(lead_time_days) ??
      numOrNull(supplierDefaults?.lead_time_days) ??
      numOrNull(supplierDefaults?.default_lead_time_days)

    const itemMetrics = computeItemMetrics(item)

    const routeId = toId(logistics_route_id) || toId(supplierDefaults?.default_logistics_route_id)
    let routeData = null
    let logisticsCost = numOrNull(logistics_cost)
    let logisticsMeta = null
    let etaEffective = leadTime != null ? leadTime : null
    if (routeId) {
      const [[route]] = await conn.execute(
        `
          SELECT
            id,
            eta_days,
            cost,
            currency,
            surcharge_pct,
            surcharge_abs,
            pricing_model,
            rate_per_kg,
            rate_per_cbm,
            min_cost,
            volumetric_kg_per_cbm,
            round_step_kg,
            round_step_cbm
          FROM logistics_routes
          WHERE id = ?
        `,
        [routeId],
      )
      if (route) {
        routeData = route
        const computed = computeLogisticsFromRoute(route, itemMetrics)
        if (computed.meta) {
          logisticsMeta = {
            ...computed.meta,
            manual_override: logistics_cost !== undefined,
          }
        }
        if (logisticsCost == null && computed.cost != null) logisticsCost = computed.cost
        if (route.eta_days != null) {
          etaEffective = (etaEffective != null ? etaEffective : 0) + Number(route.eta_days)
        }
      }
    }

    const supplierCurrency =
      toNull(supplier_currency) ||
      supplierDefaults?.default_fx_currency ||
      supplierDefaults?.price_currency ||
      supplierDefaults?.preferred_currency ||
      order?.currency ||
      null
    const supplierPrice =
      numOrNull(supplier_price) ??
      numOrNull(supplierDefaults?.price) ??
      null

    const logisticsCurrency =
      toNull(logistics_currency) || routeData?.currency || null

    const resolvedMarkupPct =
      numOrNull(markup_pct) ??
      numOrNull(supplierDefaults?.default_markup_pct) ??
      null
    const resolvedMarkupAbs =
      numOrNull(markup_abs) ??
      numOrNull(supplierDefaults?.default_markup_abs) ??
      null

    const resolvedClientCurrency =
      toNull(client_currency) ||
      order?.currency ||
      supplierDefaults?.default_fx_currency ||
      null

    const resolvedMaterialId =
      toId(material_id) || toId(supplierDefaults?.default_material_id)

    if (!supplierPublicCode && supplierId) {
      const [[ps]] = await conn.execute('SELECT public_code FROM part_suppliers WHERE id = ?', [supplierId])
      supplierPublicCode = ps?.public_code || null
    }

    // расчёт цены и доп. полей
    const pricing = await computeOfferPricing({
      supplier_price: supplierPrice,
      supplier_currency: supplierCurrency,
      logistics_cost: logisticsCost,
      logistics_currency: logisticsCurrency,
      logistics_route: routeData,
      logistics_meta: logisticsMeta,
      markup_pct: resolvedMarkupPct,
      markup_abs: resolvedMarkupAbs,
      client_currency: resolvedClientCurrency,
      order_currency: order?.currency,
      duty_rate: dutyRate,
      client_price_input: client_price,
    })

    const statusRaw = toNull(status)
    let offerStatus = statusRaw ? String(statusRaw).toLowerCase() : null
    let clientVisible = boolOrNull(client_visible)
    if (!offerStatus) {
      if (clientVisible !== null) {
        offerStatus = clientVisible ? 'proposed' : 'draft'
      } else {
        offerStatus = 'draft'
      }
    }
    if (offerStatus === 'proposed' || offerStatus === 'approved') {
      clientVisible = 1
    } else if (offerStatus === 'draft' || offerStatus === 'rejected') {
      clientVisible = 0
    } else if (clientVisible == null) {
      clientVisible = 0
    }

    const now = new Date()
    let proposedAt = null
    let approvedAt = null
    if (offerStatus === 'approved') {
      approvedAt = now
      proposedAt = now
    } else if (offerStatus === 'proposed' || clientVisible) {
      proposedAt = now
    }

    const [ins] = await conn.execute(
      `
        INSERT INTO client_order_line_offers (
          order_item_id,
          supplier_part_id,
          supplier_id,
          supplier_public_code,
          original_part_id,
          material_id,
          bundle_id,
          client_visible,
          logistics_route_id,
          logistics_cost,
          logistics_currency,
          logistics_surcharge_pct,
          logistics_surcharge_abs,
          supplier_price,
          supplier_currency,
          lead_time_days,
          eta_days_effective,
          moq,
          packaging,
          markup_pct,
          markup_abs,
          fx_rate,
          fx_base_currency,
          fx_quote_currency,
          client_price,
          client_currency,
          duty_amount,
          landed_cost,
          status,
          comment_internal,
          comment_client,
          price_breakdown,
          proposed_at,
          approved_at,
          created_by_user_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        itemId,
        toId(supplier_part_id),
        supplierId,
        supplierPublicCode,
        toId(original_part_id),
        resolvedMaterialId,
        toId(bundle_id),
        clientVisible,
        routeId,
        logisticsCost,
        logisticsCurrency,
        pricing.logistics_surcharge_pct,
        pricing.logistics_surcharge_abs,
        supplierPrice,
        supplierCurrency,
        leadTime,
        etaEffective,
        numOrNull(moq),
        toNull(packaging),
        resolvedMarkupPct,
        resolvedMarkupAbs,
        pricing.fx_rate,
        pricing.fx_base_currency,
        pricing.fx_quote_currency,
        pricing.client_price,
        pricing.client_currency,
        pricing.duty_amount,
        pricing.landed_cost,
        offerStatus,
        toNull(comment_internal),
        toNull(comment_client),
        pricing.price_breakdown ? JSON.stringify(pricing.price_breakdown) : null,
        proposedAt,
        approvedAt,
        toId(req.user?.id),
      ],
    )

    const offerId = ins.insertId

    if (!['approved', 'rework', 'rejected'].includes(item.status)) {
      let nextItemStatus = null
      if (clientVisible || offerStatus === 'proposed') {
        nextItemStatus = 'proposed'
      } else if (item.status === 'open') {
        nextItemStatus = 'sourcing'
      }
      if (nextItemStatus && nextItemStatus !== item.status) {
        await conn.execute(
          'UPDATE client_order_items SET status = ? WHERE id = ?',
          [nextItemStatus, itemId],
        )
        await logEvent({
          order_id: item.order_id,
          order_item_id: itemId,
          type: 'item_status_change',
          from_status: item.status,
          to_status: nextItemStatus,
          user_id: req.user?.id || null,
          conn,
        })
      }
    }

    await logEvent({
      order_id: item.order_id,
      order_item_id: itemId,
      offer_id: offerId,
      type: 'offer_added',
      to_status: offerStatus,
      payload: { supplier_public_code: supplierPublicCode, supplier_part_number: supplierPartNumber },
      user_id: req.user?.id || null,
      conn,
    })

    await conn.commit()
    conn.release()

    const [[created]] = await db.query(
      `
      SELECT
        o.*,
        COALESCE(o.supplier_public_code, ps.public_code) AS supplier_public_code,
        ps.name AS supplier_name,
        sa.country AS supplier_country,
        sp.supplier_part_number
      FROM client_order_line_offers o
      LEFT JOIN supplier_parts sp ON o.supplier_part_id = sp.id
      LEFT JOIN part_suppliers ps ON o.supplier_id = ps.id
      LEFT JOIN (
        SELECT
          sa1.*,
          ROW_NUMBER() OVER (
            PARTITION BY supplier_id
            ORDER BY is_primary DESC, created_at DESC, id DESC
          ) AS rn
        FROM supplier_addresses sa1
      ) sa ON sa.supplier_id = ps.id AND sa.rn = 1
      WHERE o.id = ?
    `,
      [offerId],
    )

    res.status(201).json(maskOfferForUser(created, req.user))
  } catch (e) {
    console.error('POST /client-orders/items/:itemId/offers error:', e)
    try {
      if (conn) await conn.rollback()
    } catch {}
    if (conn) conn.release?.()
    res.status(500).json({ message: e.message || 'Ошибка добавления оффера' })
  }
})

// -------------------------------------------------------------
// PUT /client-orders/offers/:offerId — обновление оффера
// -------------------------------------------------------------
router.put('/offers/:offerId', async (req, res) => {
  let conn
  try {
    const offerId = toId(req.params.offerId)
    if (!offerId) {
      return res.status(400).json({ message: 'Некорректный идентификатор оффера' })
    }

    const {
      supplier_price,
      supplier_currency,
      material_id,
      lead_time_days,
      moq,
      packaging,
      logistics_route_id,
      logistics_cost,
      logistics_currency,
      markup_pct,
      markup_abs,
      fx_rate, // оставляем для обратной совместимости, но расчёт будем вести по актуальному курсу
      client_price,
      client_currency,
      status,
      comment_internal,
      comment_client,
      client_visible,
    } = req.body || {}

    conn = await db.getConnection()
    await conn.beginTransaction()

    const [beforeRows] = await conn.execute(
      `
      SELECT
        o.*,
        i.order_id,
        i.status AS item_status,
        co.currency AS order_currency,
        i.original_part_id AS item_original_part_id,
        i.requested_qty AS item_requested_qty,
        op.weight_kg AS op_weight_kg,
        op.length_cm AS op_length_cm,
        op.width_cm AS op_width_cm,
        op.height_cm AS op_height_cm
      FROM client_order_line_offers o
      JOIN client_order_items i ON i.id = o.order_item_id
      JOIN client_orders co ON co.id = i.order_id
      LEFT JOIN original_parts op ON i.original_part_id = op.id
      WHERE o.id = ?
    `,
      [offerId],
    )
    const before = beforeRows[0]
    if (!before) {
      await conn.rollback()
      conn.release()
      return res.status(404).json({ message: 'Оффер не найден' })
    }

    const statusInput = toNull(status)
    const visibleInput = boolOrNull(client_visible)
    let statusParam = statusInput ? String(statusInput).toLowerCase() : null
    let visibleParam = visibleInput
    if (statusParam) {
      if (statusParam === 'proposed' || statusParam === 'approved') {
        visibleParam = 1
      } else if (statusParam === 'draft' || statusParam === 'rejected') {
        visibleParam = 0
      }
    } else if (visibleInput !== null) {
      if (before.status === 'approved' && visibleInput === 0) {
        visibleParam = 1
      } else {
        statusParam = visibleInput ? 'proposed' : 'draft'
        visibleParam = visibleInput
      }
    }

    const now = new Date()
    let proposedAtParam = null
    let approvedAtParam = null
    if (statusParam === 'approved') {
      if (!before.approved_at) approvedAtParam = now
      if (!before.proposed_at) proposedAtParam = now
    } else if (statusParam === 'proposed' || visibleParam === 1) {
      if (!before.proposed_at) proposedAtParam = now
    }

    // справка по оригиналу — для пошлины
    let dutyRate = null
    const origId = toId(before.original_part_id || before.item_original_part_id)
    if (origId) {
      const [[orig]] = await conn.execute(
        `
          SELECT op.tnved_code_id, t.duty_rate
          FROM original_parts op
          LEFT JOIN tnved_codes t ON t.id = op.tnved_code_id
          WHERE op.id = ?
        `,
        [origId],
      )
      dutyRate = orig?.duty_rate != null ? Number(orig.duty_rate) : null
    }

    // пересчёт
    const leadTime =
      lead_time_days !== undefined ? numOrNull(lead_time_days) : before.lead_time_days
    const itemMetrics = computeItemMetrics(before)
    let logisticsCost =
      logistics_cost !== undefined ? numOrNull(logistics_cost) : before.logistics_cost
    const routeId =
      logistics_route_id !== undefined ? toId(logistics_route_id) : before.logistics_route_id
    let routeData = null
    let logisticsMeta = null
    let etaEffective = before.eta_days_effective
    if (routeId) {
      const [[route]] = await conn.execute(
        `
          SELECT
            id,
            eta_days,
            cost,
            currency,
            surcharge_pct,
            surcharge_abs,
            pricing_model,
            rate_per_kg,
            rate_per_cbm,
            min_cost,
            volumetric_kg_per_cbm,
            round_step_kg,
            round_step_cbm
          FROM logistics_routes
          WHERE id = ?
        `,
        [routeId],
      )
      if (route) {
        routeData = route
        const computed = computeLogisticsFromRoute(route, itemMetrics)
        if (computed.meta) {
          logisticsMeta = {
            ...computed.meta,
            manual_override: logistics_cost !== undefined,
          }
        }
        if (logistics_cost === undefined && computed.cost != null) logisticsCost = computed.cost
        if (route.eta_days != null) {
          etaEffective = (leadTime != null ? leadTime : 0) + Number(route.eta_days)
        }
      }
    }
    const supplierPrice =
      supplier_price !== undefined ? numOrNull(supplier_price) : before.supplier_price
    const supplierCurrency =
      supplier_currency !== undefined ? toNull(supplier_currency) : before.supplier_currency
    const logisticsCurrency =
      logistics_currency !== undefined ? toNull(logistics_currency) : before.logistics_currency || routeData?.currency
    const resolvedMarkupPct =
      markup_pct !== undefined ? numOrNull(markup_pct) : before.markup_pct
    const resolvedMarkupAbs =
      markup_abs !== undefined ? numOrNull(markup_abs) : before.markup_abs
    const resolvedClientCurrency =
      client_currency !== undefined ? toNull(client_currency) : before.client_currency || before.order_currency

    const pricing = await computeOfferPricing({
      supplier_price: supplierPrice,
      supplier_currency: supplierCurrency,
      logistics_cost: logisticsCost,
      logistics_currency: logisticsCurrency,
      logistics_route: routeData,
      logistics_meta: logisticsMeta,
      markup_pct: resolvedMarkupPct,
      markup_abs: resolvedMarkupAbs,
      client_currency: resolvedClientCurrency,
      order_currency: before.order_currency,
      duty_rate: dutyRate,
      client_price_input: client_price !== undefined ? client_price : before.client_price,
    })

    const materialParam = material_id !== undefined ? toId(material_id) : null
    const routeParam = routeId || null
    const logisticsCostParam = logisticsCost == null ? null : logisticsCost
    const logisticsCurrencyParam = logisticsCurrency || null
    const surchargePctParam =
      pricing.logistics_surcharge_pct === undefined ? null : pricing.logistics_surcharge_pct
    const surchargeAbsParam =
      pricing.logistics_surcharge_abs === undefined ? null : pricing.logistics_surcharge_abs
    const fxRateParam = pricing.fx_rate === undefined ? null : pricing.fx_rate
    const fxBaseParam = pricing.fx_base_currency || null
    const fxQuoteParam = pricing.fx_quote_currency || null
    const clientPriceParam = pricing.client_price === undefined ? null : pricing.client_price
    const clientCurrencyParam = pricing.client_currency || null
    const dutyAmountParam = pricing.duty_amount === undefined ? null : pricing.duty_amount
    const landedParam = pricing.landed_cost === undefined ? null : pricing.landed_cost
    const etaParam = etaEffective === undefined ? null : etaEffective
    const priceBreakdownParam = pricing.price_breakdown
      ? JSON.stringify(pricing.price_breakdown)
      : null

    await conn.execute(
      `
        UPDATE client_order_line_offers
        SET
          supplier_price = COALESCE(?, supplier_price),
          supplier_currency = COALESCE(?, supplier_currency),
          material_id = COALESCE(?, material_id),
          lead_time_days = COALESCE(?, lead_time_days),
          moq = COALESCE(?, moq),
          packaging = COALESCE(?, packaging),
          logistics_route_id = COALESCE(?, logistics_route_id),
          logistics_cost = COALESCE(?, logistics_cost),
          logistics_currency = COALESCE(?, logistics_currency),
          logistics_surcharge_pct = ?,
          logistics_surcharge_abs = ?,
          markup_pct = COALESCE(?, markup_pct),
          markup_abs = COALESCE(?, markup_abs),
          fx_rate = ?,
          fx_base_currency = ?,
          fx_quote_currency = ?,
          client_price = ?,
          client_currency = ?,
          duty_amount = ?,
          landed_cost = ?,
          proposed_at = COALESCE(?, proposed_at),
          approved_at = COALESCE(?, approved_at),
          status = COALESCE(?, status),
          comment_internal = COALESCE(?, comment_internal),
          comment_client = COALESCE(?, comment_client),
          client_visible = COALESCE(?, client_visible),
          eta_days_effective = ?,
          price_breakdown = ?
        WHERE id = ?
      `,
      [
        numOrNull(supplier_price),
        toNull(supplier_currency),
        materialParam,
        numOrNull(lead_time_days),
        numOrNull(moq),
        toNull(packaging),
        routeParam,
        logisticsCostParam,
        logisticsCurrencyParam,
        surchargePctParam,
        surchargeAbsParam,
        numOrNull(markup_pct),
        numOrNull(markup_abs),
        fxRateParam,
        fxBaseParam,
        fxQuoteParam,
        clientPriceParam,
        clientCurrencyParam,
        dutyAmountParam,
        landedParam,
        proposedAtParam,
        approvedAtParam,
        toNull(statusParam),
        toNull(comment_internal),
        toNull(comment_client),
        visibleParam,
        etaParam,
        priceBreakdownParam,
        offerId,
      ],
    )

    const [afterRows] = await conn.execute(
      'SELECT * FROM client_order_line_offers WHERE id = ?',
      [offerId],
    )
    const after = afterRows[0]

    if (before.status !== after.status) {
      await logEvent({
        order_id: before.order_id,
        order_item_id: before.order_item_id,
        offer_id: offerId,
        type: 'offer_status_change',
        from_status: before.status,
        to_status: after.status,
        user_id: req.user?.id || null,
        conn,
      })
    }

    if (!['approved', 'rework', 'rejected'].includes(before.item_status)) {
      const [[counts]] = await conn.execute(
        `
          SELECT
            COUNT(*) AS total,
            SUM(client_visible = 1) AS visible
          FROM client_order_line_offers
          WHERE order_item_id = ?
        `,
        [before.order_item_id],
      )
      const total = Number(counts?.total || 0)
      const visible = Number(counts?.visible || 0)
      let nextItemStatus = before.item_status
      if (visible > 0) {
        nextItemStatus = 'proposed'
      } else if (total > 0) {
        nextItemStatus = 'sourcing'
      } else {
        nextItemStatus = 'open'
      }
      if (nextItemStatus !== before.item_status) {
        await conn.execute(
          'UPDATE client_order_items SET status = ? WHERE id = ?',
          [nextItemStatus, before.order_item_id],
        )
        await logEvent({
          order_id: before.order_id,
          order_item_id: before.order_item_id,
          type: 'item_status_change',
          from_status: before.item_status,
          to_status: nextItemStatus,
          user_id: req.user?.id || null,
          conn,
        })
      }
    }

    await conn.commit()
    conn.release()

    const [[fresh]] = await db.query(
      `
      SELECT
        o.*,
        COALESCE(o.supplier_public_code, ps.public_code) AS supplier_public_code,
        ps.name AS supplier_name,
        sa.country AS supplier_country,
        sp.supplier_part_number
      FROM client_order_line_offers o
      LEFT JOIN supplier_parts sp ON o.supplier_part_id = sp.id
      LEFT JOIN part_suppliers ps ON o.supplier_id = ps.id
      LEFT JOIN (
        SELECT
          sa1.*,
          ROW_NUMBER() OVER (
            PARTITION BY supplier_id
            ORDER BY is_primary DESC, created_at DESC, id DESC
          ) AS rn
        FROM supplier_addresses sa1
      ) sa ON sa.supplier_id = ps.id AND sa.rn = 1
      WHERE o.id = ?
    `,
      [offerId],
    )

    res.json(maskOfferForUser(fresh, req.user))
  } catch (e) {
    console.error('PUT /client-orders/offers/:offerId error:', e)
    try {
      if (conn) await conn.rollback()
    } catch {}
    if (conn) conn.release?.()
    res.status(500).json({ message: e.message || 'Ошибка обновления оффера' })
  }
})

// -------------------------------------------------------------
// POST /client-orders/items/:itemId/decision — выбор оффера по позиции
// -------------------------------------------------------------
router.post('/items/:itemId/decision', async (req, res) => {
  let conn
  try {
    const itemId = toId(req.params.itemId)
    const offerId = toId(req.body.offer_id)
    if (!itemId || !offerId) {
      return res.status(400).json({ message: 'Нужно выбрать позицию и оффер' })
    }

    conn = await db.getConnection()
    await conn.beginTransaction()

    const [itemRows] = await conn.execute(
      'SELECT * FROM client_order_items WHERE id = ?',
      [itemId],
    )
    const item = itemRows[0]
    if (!item) {
      await conn.rollback()
      conn.release()
      return res.status(404).json({ message: 'Позиция не найдена' })
    }

    const [offerRows] = await conn.execute(
      'SELECT * FROM client_order_line_offers WHERE id = ? AND order_item_id = ?',
      [offerId, itemId],
    )
    const offer = offerRows[0]
    if (!offer) {
      await conn.rollback()
      conn.release()
      return res.status(404).json({ message: 'Оффер не найден для этой позиции' })
    }

    await conn.execute(
      'UPDATE client_order_items SET decision_offer_id = ?, status = ? WHERE id = ?',
      [offerId, 'approved', itemId],
    )

    await conn.execute(
      `
        UPDATE client_order_line_offers
        SET
          client_visible = 1,
          status = ?,
          approved_by_user_id = ?,
          approved_at = COALESCE(approved_at, NOW()),
          proposed_at = COALESCE(proposed_at, NOW())
        WHERE id = ?
      `,
      ['approved', toId(req.user?.id), offerId],
    )

    await logEvent({
      order_id: item.order_id,
      order_item_id: itemId,
      offer_id: offerId,
      type: 'offer_selected',
      from_status: item.status,
      to_status: 'approved',
      payload: { offer_id: offerId },
      user_id: req.user?.id || null,
      conn,
    })

    await conn.commit()
    conn.release()

    const offers = await fetchOffersByItem([itemId], req.user)
    res.json({ success: true, offers: offers.filter((o) => o.order_item_id === itemId) })
  } catch (e) {
    console.error('POST /client-orders/items/:itemId/decision error:', e)
    try {
      if (conn) await conn.rollback()
    } catch {}
    if (conn) conn.release?.()
    res.status(500).json({ message: 'Ошибка выбора оффера' })
  }
})

// -------------------------------------------------------------
// GET /client-orders/items/:itemId/offers — получить офферы по позиции
// -------------------------------------------------------------
router.get('/items/:itemId/offers', async (req, res) => {
  try {
    const itemId = toId(req.params.itemId)
    if (!itemId) {
      return res.status(400).json({ message: 'Некорректный идентификатор позиции' })
    }
    const offers = await fetchOffersByItem([itemId], req.user)
    res.json(offers)
  } catch (e) {
    console.error('GET /client-orders/items/:itemId/offers error:', e)
    res.status(500).json({ message: 'Не удалось загрузить офферы' })
  }
})

// -------------------------------------------------------------
// GET /client-orders/:id/events — история событий
// -------------------------------------------------------------
router.get('/:id/events', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор заказа' })
    const events = await fetchEvents(id)
    res.json(events)
  } catch (e) {
    console.error('GET /client-orders/:id/events error:', e)
    res.status(500).json({ message: 'Ошибка загрузки событий' })
  }
})

// -------------------------------------------------------------
// GET /client-orders/:id/contracts — контракты по заказу
// -------------------------------------------------------------
router.get('/:id/contracts', async (req, res) => {
  try {
    const orderId = toId(req.params.id)
    if (!orderId) return res.status(400).json({ message: 'Некорректный идентификатор заказа' })
    const contracts = await fetchContracts(orderId)
    res.json(contracts)
  } catch (e) {
    console.error('GET /client-orders/:id/contracts error:', e)
    res.status(500).json({ message: 'Ошибка загрузки контрактов' })
  }
})

// -------------------------------------------------------------
// POST /client-orders/:id/contracts — создать контракт
// -------------------------------------------------------------
router.post('/:id/contracts', async (req, res) => {
  let conn
  try {
    const orderId = toId(req.params.id)
    if (!orderId) return res.status(400).json({ message: 'Некорректный идентификатор заказа' })

    const {
      contract_number,
      contract_date,
      amount,
      currency,
      status,
      comment,
    } = req.body || {}

    const contractNumber = nz(contract_number)
    if (!contractNumber) {
      return res.status(400).json({ message: 'contract_number обязателен' })
    }
    if (!contract_date) {
      return res.status(400).json({ message: 'contract_date обязателен' })
    }

    const [[order]] = await db.execute(
      'SELECT id, client_id, currency, order_number FROM client_orders WHERE id = ?',
      [orderId],
    )
    if (!order) return res.status(404).json({ message: 'Заказ не найден' })

    conn = await db.getConnection()
    await conn.beginTransaction()

    const [ins] = await conn.execute(
      `
        INSERT INTO client_order_contracts (
          order_id,
          contract_number,
          contract_date,
          amount,
          currency,
          status,
          comment
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      [
        orderId,
        contractNumber,
        contract_date,
        numOrNull(amount),
        normCurrency(currency) || order.currency || null,
        toNull(status) ? normalizeContractStatus(status) : 'draft',
        toNull(comment),
      ],
    )

    const contractId = ins.insertId

    await logActivity({
      req,
      action: 'create',
      entity_type: 'client_order_contracts',
      entity_id: contractId,
      client_id: order.client_id,
      comment: `Создан контракт ${contractNumber} по заказу ${order.order_number}`,
    })

    await logEvent({
      order_id: orderId,
      type: 'contract_created',
      payload: { contract_id: contractId, contract_number: contractNumber },
      user_id: req.user?.id || null,
      conn,
    })

    await conn.commit()
    conn.release()

    const [[created]] = await db.query(
      'SELECT * FROM client_order_contracts WHERE id = ?',
      [contractId],
    )
    res.status(201).json(created)
  } catch (e) {
    console.error('POST /client-orders/:id/contracts error:', e)
    try {
      if (conn) await conn.rollback()
    } catch {}
    if (conn) conn.release?.()
    res.status(500).json({ message: 'Ошибка создания контракта' })
  }
})

// -------------------------------------------------------------
// PUT /client-orders/contracts/:contractId — обновить контракт
// -------------------------------------------------------------
router.put('/contracts/:contractId', async (req, res) => {
  let conn
  try {
    const contractId = toId(req.params.contractId)
    if (!contractId) return res.status(400).json({ message: 'Некорректный идентификатор контракта' })

    const {
      contract_number,
      contract_date,
      amount,
      currency,
      status,
      comment,
    } = req.body || {}

    conn = await db.getConnection()
    await conn.beginTransaction()

    const [beforeRows] = await conn.execute(
      'SELECT * FROM client_order_contracts WHERE id = ?',
      [contractId],
    )
    const before = beforeRows[0]
    if (!before) {
      await conn.rollback()
      conn.release()
      return res.status(404).json({ message: 'Контракт не найден' })
    }

    await conn.execute(
      `
        UPDATE client_order_contracts
        SET
          contract_number = COALESCE(?, contract_number),
          contract_date = COALESCE(?, contract_date),
          amount = ?,
          currency = COALESCE(?, currency),
          status = COALESCE(?, status),
          comment = ?
        WHERE id = ?
      `,
      [
        toNull(contract_number),
        contract_date || null,
        amount !== undefined ? numOrNull(amount) : before.amount,
        normCurrency(currency),
        toNull(status) ? normalizeContractStatus(status) : null,
        toNull(comment),
        contractId,
      ],
    )

    const [afterRows] = await conn.execute(
      'SELECT * FROM client_order_contracts WHERE id = ?',
      [contractId],
    )
    const after = afterRows[0]

    await logEvent({
      order_id: before.order_id,
      type: 'contract_updated',
      payload: { contract_id: contractId, contract_number: after.contract_number },
      user_id: req.user?.id || null,
      conn,
    })

    await conn.commit()
    conn.release()
    res.json(after)
  } catch (e) {
    console.error('PUT /client-orders/contracts/:contractId error:', e)
    try {
      if (conn) await conn.rollback()
    } catch {}
    if (conn) conn.release?.()
    res.status(500).json({ message: 'Ошибка обновления контракта' })
  }
})

// -------------------------------------------------------------
// DELETE /client-orders/contracts/:contractId — удалить контракт
// -------------------------------------------------------------
router.delete('/contracts/:contractId', async (req, res) => {
  let conn
  try {
    const contractId = toId(req.params.contractId)
    if (!contractId) return res.status(400).json({ message: 'Некорректный идентификатор контракта' })

    conn = await db.getConnection()
    await conn.beginTransaction()

    const [rows] = await conn.execute(
      'SELECT * FROM client_order_contracts WHERE id = ?',
      [contractId],
    )
    const contract = rows[0]
    if (!contract) {
      await conn.rollback()
      conn.release()
      return res.status(404).json({ message: 'Контракт не найден' })
    }

    await conn.execute('DELETE FROM client_order_contracts WHERE id = ?', [contractId])

    await logEvent({
      order_id: contract.order_id,
      type: 'contract_deleted',
      payload: { contract_id: contractId, contract_number: contract.contract_number },
      user_id: req.user?.id || null,
      conn,
    })

    await conn.commit()
    conn.release()
    res.json({ success: true })
  } catch (e) {
    console.error('DELETE /client-orders/contracts/:contractId error:', e)
    try {
      if (conn) await conn.rollback()
    } catch {}
    if (conn) conn.release?.()
    res.status(500).json({ message: 'Ошибка удаления контракта' })
  }
})

// -------------------------------------------------------------
// Contract PDF generate: POST /client-orders/contracts/:contractId/generate
// -------------------------------------------------------------
router.post('/contracts/:contractId/generate', async (req, res) => {
  let tmpPath
  let conn
  try {
    const contractId = toId(req.params.contractId)
    if (!contractId) return res.status(400).json({ message: 'Некорректный идентификатор контракта' })

    if (!bucket || !bucketName) {
      return res.status(500).json({ message: 'GCS бакет не настроен' })
    }

    const [[contract]] = await db.query(
      'SELECT * FROM client_order_contracts WHERE id = ?',
      [contractId],
    )
    if (!contract) return res.status(404).json({ message: 'Контракт не найден' })

    const order = await fetchOrder(contract.order_id)
    if (!order) return res.status(404).json({ message: 'Заказ не найден' })

    const items = await fetchItemsWithOffers(contract.order_id, req.user)
    const pdfBuffer = await buildContractPdf(contract, order, items)

    const fname = `contract_${contract.order_id}_${contractId}_${Date.now()}.pdf`
    tmpPath = path.join(os.tmpdir(), fname)
    await fs.writeFile(tmpPath, pdfBuffer)

    const destination = `contracts/${fname}`
    await bucket.upload(tmpPath, {
      destination,
      contentType: 'application/pdf',
      metadata: { cacheControl: 'private, max-age=0' },
    })

    const publicUrl = `https://storage.googleapis.com/${bucketName}/${destination}`

    conn = await db.getConnection()
    await conn.beginTransaction()
    await conn.execute(
      `
        UPDATE client_order_contracts
        SET file_url = ?
        WHERE id = ?
      `,
      [publicUrl, contractId],
    )

    await logEvent({
      order_id: contract.order_id,
      type: 'contract_generated',
      payload: { contract_id: contractId, url: publicUrl },
      user_id: req.user?.id || null,
      conn,
    })

    await conn.commit()
    conn.release()
    res.json({ url: publicUrl })
  } catch (e) {
    console.error('POST /client-orders/contracts/:contractId/generate error:', e)
    try {
      if (conn) await conn.rollback()
    } catch {}
    if (conn) conn.release?.()
    res.status(500).json({ message: 'Не удалось сформировать контракт' })
  } finally {
    if (tmpPath) {
      try {
        await fs.unlink(tmpPath)
      } catch {}
    }
  }
})

// -------------------------------------------------------------
// Contract PDF upload: POST /client-orders/contracts/:contractId/file
// form-data: file (application/pdf)
// -------------------------------------------------------------
const uploadContract = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
})

router.post(
  '/contracts/:contractId/file',
  uploadContract.single('file'),
  async (req, res) => {
    let tmpPath
    let conn
    try {
      const contractId = toId(req.params.contractId)
      if (!contractId) return res.status(400).json({ message: 'Некорректный идентификатор контракта' })

      if (!bucket || !bucketName) {
        return res.status(500).json({ message: 'GCS бакет не настроен' })
      }

      const file = req.file
      if (!file) return res.status(400).json({ message: 'Файл не загружен' })
      if (file.mimetype !== 'application/pdf') {
        return res
          .status(415)
          .json({ message: `Ожидается PDF, получено ${file.mimetype}` })
      }

      const [[contract]] = await db.execute(
        'SELECT * FROM client_order_contracts WHERE id = ?',
        [contractId]
      )
      if (!contract) return res.status(404).json({ message: 'Контракт не найден' })

      const fname = `contract_${contract.order_id}_${contractId}_${Date.now()}.pdf`
      tmpPath = path.join(os.tmpdir(), fname)
      await fs.writeFile(tmpPath, file.buffer)

      const destination = `contracts/${fname}`
      await bucket.upload(tmpPath, {
        destination,
        contentType: 'application/pdf',
        metadata: { cacheControl: 'private, max-age=0' },
      })

      const publicUrl = `https://storage.googleapis.com/${bucketName}/${destination}`

      conn = await db.getConnection()
      await conn.beginTransaction()
      await conn.execute(
        `
          UPDATE client_order_contracts
          SET file_url = ?
          WHERE id = ?
        `,
        [publicUrl, contractId]
      )

      await logEvent({
        order_id: contract.order_id,
        type: 'contract_file_uploaded',
        payload: { contract_id: contractId, url: publicUrl },
        user_id: req.user?.id || null,
        conn,
      })

      await conn.commit()
      conn.release()
      res.json({ url: publicUrl })
    } catch (e) {
      console.error('POST /client-orders/contracts/:contractId/file error:', e)
      try {
        if (conn) await conn.rollback()
      } catch {}
      if (conn) conn.release?.()
      res.status(500).json({ message: 'Не удалось сохранить контракт' })
    } finally {
      if (tmpPath) {
        try {
          await fs.unlink(tmpPath)
        } catch {}
      }
    }
  }
)

// -------------------------------------------------------------
// DELETE /client-orders/offers/:offerId — удалить оффер
// -------------------------------------------------------------
router.delete('/offers/:offerId', async (req, res) => {
  let conn
  try {
    const offerId = toId(req.params.offerId)
    if (!offerId) {
      return res.status(400).json({ message: 'Некорректный идентификатор оффера' })
    }

    conn = await db.getConnection()
    await conn.beginTransaction()

    const [[offer]] = await conn.execute(
      `
      SELECT o.*, i.order_id
      FROM client_order_line_offers o
      JOIN client_order_items i ON i.id = o.order_item_id
      WHERE o.id = ?
    `,
      [offerId]
    )
    if (!offer) {
      await conn.rollback()
      conn.release()
      return res.status(404).json({ message: 'Оффер не найден' })
    }

    await conn.execute('DELETE FROM client_order_line_offers WHERE id = ?', [
      offerId,
    ])

    const [[itemRow]] = await conn.execute(
      'SELECT status FROM client_order_items WHERE id = ?',
      [offer.order_item_id],
    )
    if (itemRow && !['approved', 'rework', 'rejected'].includes(itemRow.status)) {
      const [[counts]] = await conn.execute(
        `
          SELECT
            COUNT(*) AS total,
            SUM(client_visible = 1) AS visible
          FROM client_order_line_offers
          WHERE order_item_id = ?
        `,
        [offer.order_item_id],
      )
      const total = Number(counts?.total || 0)
      const visible = Number(counts?.visible || 0)
      let nextItemStatus = itemRow.status
      if (visible > 0) {
        nextItemStatus = 'proposed'
      } else if (total > 0) {
        nextItemStatus = 'sourcing'
      } else {
        nextItemStatus = 'open'
      }
      if (nextItemStatus !== itemRow.status) {
        await conn.execute(
          'UPDATE client_order_items SET status = ? WHERE id = ?',
          [nextItemStatus, offer.order_item_id],
        )
        await logEvent({
          order_id: offer.order_id,
          order_item_id: offer.order_item_id,
          type: 'item_status_change',
          from_status: itemRow.status,
          to_status: nextItemStatus,
          user_id: req.user?.id || null,
          conn,
        })
      }
    }

    await logEvent({
      order_id: offer.order_id,
      order_item_id: offer.order_item_id,
      offer_id: offerId,
      type: 'offer_deleted',
      user_id: req.user?.id || null,
      conn,
    })

    await conn.commit()
    conn.release()

    res.json({ success: true })
  } catch (e) {
    console.error('DELETE /client-orders/offers/:offerId error:', e)
    try {
      if (conn) await conn.rollback()
    } catch {}
    if (conn) conn.release?.()
    res.status(500).json({ message: 'Ошибка удаления оффера' })
  }
})

// -------------------------------------------------------------
// DELETE /client-orders/:id — удаление заказа (с каскадом позиций)
// -------------------------------------------------------------
router.delete('/:id', async (req, res) => {
  let conn
  try {
    const id = toId(req.params.id)
    if (!id) {
      return res.status(400).json({ message: 'Некорректный идентификатор заказа' })
    }

    conn = await db.getConnection()
    await conn.beginTransaction()

    const [[order]] = await conn.execute(
      'SELECT * FROM client_orders WHERE id = ?',
      [id]
    )
    if (!order) {
      await conn.rollback()
      conn.release()
      return res.status(404).json({ message: 'Заказ не найден' })
    }

    await conn.execute('DELETE FROM client_orders WHERE id = ?', [id])

    await logActivity({
      req,
      action: 'delete',
      entity_type: 'client_orders',
      entity_id: id,
      client_id: order.client_id,
      comment: `Удалён заказ ${order.order_number}`,
    })

    await logEvent({
      order_id: id,
      type: 'order_deleted',
      user_id: req.user?.id || null,
      payload: { order_number: order.order_number },
      conn,
    })

    await conn.commit()
    conn.release()
    res.json({ success: true })
  } catch (e) {
    console.error('DELETE /client-orders/:id error:', e)
    try {
      if (conn) await conn.rollback()
    } catch {}
    if (conn) conn.release?.()
    res.status(500).json({ message: 'Ошибка удаления заказа' })
  }
})

// ------------------------------------------------------
// Proposal PDF upload: POST /client-orders/:id/proposal-file
// form-data: file (application/pdf)
// ------------------------------------------------------
router.post('/:id/proposal-generate', async (req, res) => {
  let tmpPath
  let conn
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })

    if (!bucket || !bucketName) {
      return res.status(500).json({ message: 'GCS бакет не настроен' })
    }

    const order = await fetchOrder(id)
    if (!order) return res.status(404).json({ message: 'Заказ не найден' })

    const items = await fetchItemsWithOffers(id, req.user)
    const pdfBuffer = await buildProposalPdf(order, items)

    const fname = `proposal_${id}_${Date.now()}.pdf`
    tmpPath = path.join(os.tmpdir(), fname)
    await fs.writeFile(tmpPath, pdfBuffer)

    const destination = `proposals/${fname}`
    await bucket.upload(tmpPath, {
      destination,
      contentType: 'application/pdf',
      metadata: { cacheControl: 'private, max-age=0' },
    })

    const publicUrl = `https://storage.googleapis.com/${bucketName}/${destination}`

    conn = await db.getConnection()
    await conn.beginTransaction()
    await conn.execute(
      `
          UPDATE client_orders
          SET proposal_file_url = ?, proposal_generated_at = NOW(), proposal_generated_by = ?
          WHERE id = ?
        `,
      [publicUrl, toId(req.user?.id), id],
    )

    await logEvent({
      order_id: id,
      type: 'proposal_uploaded',
      user_id: req.user?.id || null,
      payload: { url: publicUrl },
      conn,
    })

    await conn.commit()
    conn.release()

    res.json({ url: publicUrl })
  } catch (e) {
    console.error('POST /client-orders/:id/proposal-generate error:', e)
    try {
      if (conn) await conn.rollback()
    } catch {}
    if (conn) conn.release?.()
    res.status(500).json({ message: 'Не удалось сгенерировать предложение' })
  } finally {
    if (tmpPath) {
      try {
        await fs.unlink(tmpPath)
      } catch {}
    }
  }
})

router.post(
  '/:id/proposal-file',
  uploadProposal.single('file'),
  async (req, res) => {
    let tmpPath
    let conn
    try {
      const id = toId(req.params.id)
      if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })

      if (!bucket || !bucketName) {
        return res.status(500).json({ message: 'GCS бакет не настроен' })
      }

      const file = req.file
      if (!file) return res.status(400).json({ message: 'Файл не загружен' })
      if (file.mimetype !== 'application/pdf') {
        return res
          .status(415)
          .json({ message: `Ожидается PDF, получено ${file.mimetype}` })
      }

      // убеждаемся, что заказ есть
      const [[order]] = await db.execute(
        'SELECT id FROM client_orders WHERE id = ?',
        [id]
      )
      if (!order) return res.status(404).json({ message: 'Заказ не найден' })

      // сохраняем во временный файл
      const fname = `proposal_${id}_${Date.now()}.pdf`
      tmpPath = path.join(os.tmpdir(), fname)
      await fs.writeFile(tmpPath, file.buffer)

      const destination = `proposals/${fname}`
      await bucket.upload(tmpPath, {
        destination,
        contentType: 'application/pdf',
        metadata: { cacheControl: 'private, max-age=0' },
      })

      const publicUrl = `https://storage.googleapis.com/${bucketName}/${destination}`

      conn = await db.getConnection()
      await conn.beginTransaction()
      await conn.execute(
        `
          UPDATE client_orders
          SET proposal_file_url = ?, proposal_generated_at = NOW(), proposal_generated_by = ?
          WHERE id = ?
        `,
        [publicUrl, toId(req.user?.id), id]
      )

      await logEvent({
        order_id: id,
        type: 'proposal_uploaded',
        user_id: req.user?.id || null,
        payload: { url: publicUrl },
        conn,
      })

      await conn.commit()
      conn.release()

      res.json({ url: publicUrl })
    } catch (e) {
      console.error('POST /client-orders/:id/proposal-file error:', e)
      try {
        if (conn) await conn.rollback()
      } catch {}
      if (conn) conn.release?.()
      res.status(500).json({ message: 'Не удалось сохранить предложение' })
    } finally {
      if (tmpPath) {
        try {
          await fs.unlink(tmpPath)
        } catch {}
      }
    }
  }
)

module.exports = router
