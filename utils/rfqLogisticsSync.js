const toId = (value) => {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : null
}

const syncRfqCoverageLogisticsFromLatestResponses = async (conn, rfqId, { supplierId = null } = {}) => {
  const normalizedRfqId = toId(rfqId)
  if (!normalizedRfqId) return { coverageLines: 0, shipmentLines: 0, groups: 0 }

  const normalizedSupplierId = toId(supplierId)
  const supplierFilter = normalizedSupplierId ? 'AND rs.supplier_id = ?' : ''
  const supplierParams = normalizedSupplierId ? [normalizedSupplierId] : []

  const [coverageResult] = await conn.execute(
    `
    UPDATE rfq_coverage_option_lines col
    JOIN rfq_coverage_options opt ON opt.id = col.coverage_option_id
    JOIN rfq_response_lines old_rl ON old_rl.id = col.rfq_response_line_id
    JOIN (
      SELECT ranked.*
      FROM (
        SELECT
          rs.rfq_id,
          rs.supplier_id,
          rl.rfq_item_id,
          COALESCE(NULLIF(TRIM(rl.selection_key), ''), '__NO_SELECTION__') AS selection_key_norm,
          rl.id AS response_line_id,
          rl.price,
          rl.currency,
          rl.lead_time_days,
          rl.origin_country,
          rl.incoterms,
          rl.incoterms_place,
          sp.weight_kg AS unit_weight_kg,
          sp.length_cm,
          sp.width_cm,
          sp.height_cm,
          ROW_NUMBER() OVER (
            PARTITION BY
              rs.rfq_id,
              rs.supplier_id,
              rl.rfq_item_id,
              COALESCE(NULLIF(TRIM(rl.selection_key), ''), '__NO_SELECTION__')
            ORDER BY rr.rev_number DESC, rl.id DESC
          ) AS rn
        FROM rfq_response_lines rl
        JOIN rfq_response_revisions rr ON rr.id = rl.rfq_response_revision_id
        JOIN rfq_supplier_responses rsr ON rsr.id = rr.rfq_supplier_response_id
        JOIN rfq_suppliers rs ON rs.id = rsr.rfq_supplier_id
        LEFT JOIN supplier_parts sp ON sp.id = rl.supplier_part_id
        WHERE rs.rfq_id = ?
          ${supplierFilter}
      ) ranked
      WHERE ranked.rn = 1
    ) latest
      ON latest.rfq_id = opt.rfq_id
     AND latest.supplier_id = col.supplier_id
     AND latest.rfq_item_id = col.rfq_item_id
     AND latest.selection_key_norm = COALESCE(NULLIF(TRIM(old_rl.selection_key), ''), '__NO_SELECTION__')
    SET col.rfq_response_line_id = latest.response_line_id,
        col.unit_price = latest.price,
        col.goods_amount = CASE
          WHEN latest.price IS NULL THEN col.goods_amount
          ELSE latest.price * COALESCE(NULLIF(col.qty, 0), 1)
        END,
        col.goods_currency = COALESCE(latest.currency, col.goods_currency),
        col.weight_kg = CASE
          WHEN latest.unit_weight_kg IS NULL THEN NULL
          ELSE latest.unit_weight_kg * COALESCE(NULLIF(col.qty, 0), 1)
        END,
        col.volume_cbm = CASE
          WHEN latest.length_cm IS NULL OR latest.width_cm IS NULL OR latest.height_cm IS NULL THEN NULL
          ELSE (latest.length_cm * latest.width_cm * latest.height_cm * COALESCE(NULLIF(col.qty, 0), 1)) / 1000000
        END,
        col.lead_time_days = COALESCE(latest.lead_time_days, col.lead_time_days),
        col.origin_country = COALESCE(latest.origin_country, col.origin_country),
        col.incoterms = COALESCE(latest.incoterms, col.incoterms),
        col.incoterms_place = COALESCE(latest.incoterms_place, col.incoterms_place),
        col.updated_at = NOW()
    WHERE opt.rfq_id = ?
      ${normalizedSupplierId ? 'AND col.supplier_id = ?' : ''}
      AND col.rfq_response_line_id IS NOT NULL
      AND col.rfq_response_line_id <> latest.response_line_id
    `,
    [normalizedRfqId, ...supplierParams, normalizedRfqId, ...supplierParams]
  )

  const [shipmentLineResult] = await conn.execute(
    `
    UPDATE rfq_shipment_group_lines gl
    JOIN rfq_coverage_option_lines col ON col.id = gl.coverage_option_line_id
    JOIN rfq_coverage_options opt ON opt.id = col.coverage_option_id
    SET gl.weight_allocated_kg = CASE
          WHEN col.weight_kg IS NULL THEN NULL
          WHEN gl.qty_allocated IS NOT NULL AND col.qty IS NOT NULL AND col.qty > 0
            THEN col.weight_kg * (gl.qty_allocated / col.qty)
          ELSE col.weight_kg
        END
    WHERE opt.rfq_id = ?
      ${normalizedSupplierId ? 'AND col.supplier_id = ?' : ''}
    `,
    [normalizedRfqId, ...supplierParams]
  )

  const [groupResult] = await conn.execute(
    `
    UPDATE rfq_shipment_groups g
    JOIN rfq_scenarios sc ON sc.id = g.scenario_id
    LEFT JOIN (
      SELECT
        gl.shipment_group_id,
        NULLIF(SUM(COALESCE(gl.weight_allocated_kg, 0)), 0) AS total_weight_kg,
        NULLIF(SUM(COALESCE(
          CASE
            WHEN col.volume_cbm IS NULL THEN NULL
            WHEN gl.qty_allocated IS NOT NULL AND col.qty IS NOT NULL AND col.qty > 0
              THEN col.volume_cbm * (gl.qty_allocated / col.qty)
            ELSE col.volume_cbm
          END,
          0
        )), 0) AS total_volume_cbm
      FROM rfq_shipment_group_lines gl
      JOIN rfq_coverage_option_lines col ON col.id = gl.coverage_option_line_id
      JOIN rfq_coverage_options opt ON opt.id = col.coverage_option_id
      WHERE opt.rfq_id = ?
        ${normalizedSupplierId ? 'AND col.supplier_id = ?' : ''}
        AND gl.included = 1
      GROUP BY gl.shipment_group_id
    ) totals ON totals.shipment_group_id = g.id
    SET g.total_weight_kg = totals.total_weight_kg,
        g.total_volume_cbm = totals.total_volume_cbm,
        g.updated_at = NOW()
    WHERE sc.rfq_id = ?
      ${normalizedSupplierId ? 'AND g.supplier_id = ?' : ''}
    `,
    [normalizedRfqId, ...supplierParams, normalizedRfqId, ...supplierParams]
  )

  return {
    coverageLines: Number(coverageResult?.affectedRows || 0),
    shipmentLines: Number(shipmentLineResult?.affectedRows || 0),
    groups: Number(groupResult?.affectedRows || 0),
  }
}

module.exports = {
  syncRfqCoverageLogisticsFromLatestResponses,
}
