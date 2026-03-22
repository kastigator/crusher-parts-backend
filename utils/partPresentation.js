const normalizeDisplayValue = (value) => {
  if (value === undefined || value === null) return null
  const text = String(value).trim()
  return text || null
}

const getClientFacingPartNumber = (row, fallback = '—') =>
  normalizeDisplayValue(row?.client_display_part_number) ||
  normalizeDisplayValue(row?.client_part_number) ||
  normalizeDisplayValue(row?.original_cat_number) ||
  (fallback ?? '—')

const getSupplierFacingPartNumber = (row, fallback = '—') =>
  normalizeDisplayValue(row?.supplier_display_part_number) ||
  normalizeDisplayValue(row?.supplier_part_number) ||
  normalizeDisplayValue(row?.supplier_visible_part_number) ||
  normalizeDisplayValue(row?.internal_part_number) ||
  normalizeDisplayValue(row?.original_cat_number) ||
  (fallback ?? '—')

const getClientFacingDescription = (row, fallback = '—') =>
  normalizeDisplayValue(row?.client_display_description) ||
  normalizeDisplayValue(row?.client_description) ||
  normalizeDisplayValue(row?.note) ||
  (fallback ?? '—')

const getSupplierFacingDescription = (row, fallback = '—') =>
  normalizeDisplayValue(row?.supplier_display_description) ||
  normalizeDisplayValue(row?.supplier_visible_description) ||
  normalizeDisplayValue(row?.client_description) ||
  normalizeDisplayValue(row?.note) ||
  (fallback ?? '—')

module.exports = {
  getClientFacingPartNumber,
  getSupplierFacingPartNumber,
  getClientFacingDescription,
  getSupplierFacingDescription,
}
