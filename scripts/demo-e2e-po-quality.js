#!/usr/bin/env node
const fs = require('fs')
const path = require('path')
const axios = require('axios')
const jwt = require('jsonwebtoken')
const dotenv = require('dotenv')

dotenv.config({ path: path.resolve(__dirname, '..', '.env.local') })

const summaryPath = process.argv[2]
if (!summaryPath) {
  console.error('Usage: node scripts/demo-e2e-po-quality.js /path/to/demo-summary.json')
  process.exit(1)
}

const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'))
const API_BASE_URL = process.env.API_BASE_URL || `http://127.0.0.1:${process.env.PORT || 5050}/api`
const JWT_SECRET = process.env.JWT_SECRET
const token = jwt.sign(
  { id: 4, username: 'admin', role: 'admin', role_id: 1, is_admin: true },
  JWT_SECRET,
  { expiresIn: '8h' }
)

const api = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  },
  validateStatus: () => true,
})

const expect2xx = (label, response) => {
  if (!response || response.status < 200 || response.status >= 300) {
    throw new Error(`${label} failed: ${JSON.stringify(response?.data || response)}`)
  }
  return response.data
}

async function main() {
  const selectionId = Number(summary.selection_id)
  const supplierId = Number(summary.supplier_ids?.whole_supplier)
  if (!selectionId || !supplierId) throw new Error('selection_id / whole_supplier missing in summary')

  const selectionLines = expect2xx(
    'load selection lines',
    await api.get(`/selection/${selectionId}/lines`)
  )
  const supplierLines = selectionLines.filter((line) => Number(line?.supplier_id) === supplierId)
  const shipmentGroupIds = Array.from(
    new Set(
      supplierLines.map((line) => Number(line?.shipment_group_id || 0)).filter(Boolean)
    )
  )
  if (!shipmentGroupIds.length) {
    throw new Error('No shipment_group_id found for supplier lines in selection')
  }
  const shipmentGroupId = shipmentGroupIds[0]

  const po = expect2xx(
    'create po',
    await api.post('/purchase-orders', {
      supplier_id: supplierId,
      selection_id: selectionId,
      shipment_group_id: shipmentGroupId,
      status: 'draft',
      supplier_reference: `${summary.demo_code}-PO-01`,
      autofill_from_selection: true,
    })
  )

  const poLines = expect2xx('get po lines', await api.get(`/purchase-orders/${po.id}/lines`))
  if (!poLines.length) throw new Error('PO lines not created')
  const firstLine = poLines[0]

  const event = expect2xx(
    'create supplier quality event',
    await api.post(`/suppliers/${supplierId}/quality-events`, {
      event_type: 'COMPLAINT',
      severity: 3,
      status: 'open',
      occurred_at: '2026-03-21',
      note: `Демо рекламация по PO ${po.id}`,
      supplier_purchase_order_id: po.id,
      supplier_purchase_order_line_id: firstLine.id,
      rfq_response_line_id: firstLine.rfq_response_line_id,
      selection_id: selectionId,
      selection_line_id: firstLine.selection_line_id,
      sales_quote_id: summary.sales_quote_id,
      oem_part_id: firstLine.original_part_id,
      qty_affected: 1,
    })
  )

  const out = {
    ...summary,
    supplier_purchase_order_id: po.id,
    supplier_purchase_order_line_id: firstLine.id,
    supplier_quality_event_id: event.id,
  }

  fs.writeFileSync(summaryPath, JSON.stringify(out, null, 2))
  console.log(JSON.stringify(out, null, 2))
}

main().catch((err) => {
  console.error(err.message || err)
  process.exit(1)
})
