ALTER TABLE supplier_inquiries
  DROP FOREIGN KEY fk_supplier_inquiry_supplier,
  MODIFY COLUMN supplier_id INT NULL,
  ADD COLUMN supplier_identity_snapshot_json JSON NULL AFTER supplier_id;

UPDATE supplier_inquiries si
LEFT JOIN part_suppliers ps ON ps.id = si.supplier_id
SET si.supplier_identity_snapshot_json = JSON_OBJECT(
  'supplier_id', si.supplier_id,
  'supplier_name', ps.name,
  'supplier_public_code', ps.public_code,
  'source', 'pre_forward_fix'
)
WHERE si.supplier_identity_snapshot_json IS NULL;

ALTER TABLE supplier_inquiries
  MODIFY COLUMN supplier_identity_snapshot_json JSON NOT NULL,
  ADD CONSTRAINT fk_supplier_inquiry_supplier
    FOREIGN KEY (supplier_id) REFERENCES part_suppliers (id) ON DELETE SET NULL ON UPDATE CASCADE;

INSERT INTO supplier_inquiries
  (sourcing_case_id, supplier_id, supplier_identity_snapshot_json, status, language,
   legacy_rfq_supplier_id, created_by_user_id, created_at, updated_at)
SELECT sc.id, ps.id,
       JSON_OBJECT(
         'legacy_supplier_id', rs.supplier_id,
         'supplier_name', ps.name,
         'supplier_public_code', ps.public_code,
         'source', CASE WHEN ps.id IS NULL THEN 'legacy_orphan_reference' ELSE 'supplier_master_reference' END
       ),
       CASE WHEN rs.responded_at IS NOT NULL OR rs.status = 'responded' THEN 'responded'
            WHEN rs.invited_at IS NOT NULL OR rs.status = 'sent' THEN 'sent' ELSE 'draft' END,
       COALESCE(NULLIF(rs.language, ''), 'en'), rs.id, r.created_by_user_id,
       COALESCE(rs.invited_at, r.created_at), COALESCE(rs.responded_at, rs.invited_at, r.updated_at)
FROM rfq_suppliers rs
JOIN rfqs r ON r.id = rs.rfq_id
JOIN sourcing_cases sc ON sc.legacy_rfq_id = r.id
LEFT JOIN part_suppliers ps ON ps.id = rs.supplier_id;

INSERT INTO supplier_inquiry_revisions
  (supplier_inquiry_id, revision_number, status, subject_snapshot, message_snapshot,
   contact_snapshot_json, payload_hash, legacy_rfq_revision_id,
   finalized_by_user_id, finalized_at, created_by_user_id, created_at)
SELECT si.id, 1, 'finalized', CONCAT('Legacy RFQ ', r.rfq_number), rs.note,
       JSON_OBJECT('legacy_supplier_id', rs.supplier_id, 'language', rs.language),
       NULL, r.current_rfq_revision_id, COALESCE(r.sent_by_user_id, r.created_by_user_id),
       COALESCE(r.sent_at, r.created_at), r.created_by_user_id, r.created_at
FROM supplier_inquiries si
JOIN rfq_suppliers rs ON rs.id = si.legacy_rfq_supplier_id
JOIN rfqs r ON r.id = rs.rfq_id;

INSERT INTO supplier_inquiry_revision_lines
  (supplier_inquiry_revision_id, sourcing_demand_id, requested_quantity_snapshot,
   uom_snapshot, request_snapshot_json, created_at)
SELECT sir.id, sd.id,
       COALESCE(MAX(sel.qty), ri.requested_qty),
       COALESCE(MAX(sel.uom), ri.uom, sd.uom_snapshot),
       JSON_OBJECT(
         'legacy_rfq_item_id', ri.id,
         'legacy_selection_count', COUNT(sel.id),
         'legacy_selection_keys', COALESCE(JSON_ARRAYAGG(sel.selection_key), JSON_ARRAY()),
         'source', 'legacy_supplier_line_selections_collapsed_for_demand'
       ),
       COALESCE(MIN(sel.created_at), ri.created_at)
FROM supplier_inquiry_revisions sir
JOIN supplier_inquiries si ON si.id = sir.supplier_inquiry_id
JOIN rfq_suppliers rs ON rs.id = si.legacy_rfq_supplier_id
JOIN rfq_items ri ON ri.rfq_id = rs.rfq_id
JOIN sourcing_demands sd ON sd.sourcing_case_id = si.sourcing_case_id
  AND sd.procurement_release_item_id = ri.procurement_release_item_id
LEFT JOIN rfq_supplier_line_selections sel
  ON sel.rfq_supplier_id = rs.id AND sel.rfq_item_id = ri.id
WHERE sel.id IS NOT NULL OR NOT EXISTS (
  SELECT 1 FROM rfq_supplier_line_selections sx WHERE sx.rfq_supplier_id = rs.id
)
GROUP BY sir.id, sd.id, ri.id, ri.requested_qty, ri.uom, sd.uom_snapshot, ri.created_at;

INSERT INTO supplier_inquiry_dispatches
  (supplier_inquiry_id, supplier_inquiry_revision_id, channel, recipient_snapshot_json,
   payload_hash, document_id, legacy_dispatch_id, dispatched_by_user_id, dispatched_at, note, created_at)
SELECT si.id, sir.id, 'legacy',
       JSON_OBJECT('legacy_supplier_id', rs.supplier_id, 'legacy_dispatch_type', d.dispatch_type),
       d.payload_hash, d.document_id, d.id, d.sent_by_user_id, d.sent_at, d.note, d.sent_at
FROM rfq_supplier_dispatches d
JOIN supplier_inquiries si ON si.legacy_rfq_supplier_id = d.rfq_supplier_id
JOIN supplier_inquiry_revisions sir ON sir.supplier_inquiry_id = si.id AND sir.revision_number = 1
JOIN rfq_suppliers rs ON rs.id = d.rfq_supplier_id;

INSERT INTO supplier_offers
  (sourcing_case_id, supplier_inquiry_id, supplier_id, source_type, status,
   legacy_response_id, created_by_user_id, created_at, updated_at)
SELECT si.sourcing_case_id, si.id, rs.supplier_id, 'legacy',
       CASE WHEN sr.status IN ('rejected', 'withdrawn') THEN sr.status ELSE 'finalized' END,
       sr.id, sr.created_by_user_id, sr.created_at, sr.created_at
FROM rfq_supplier_responses sr
JOIN rfq_suppliers rs ON rs.id = sr.rfq_supplier_id
JOIN supplier_inquiries si ON si.legacy_rfq_supplier_id = rs.id
JOIN part_suppliers ps ON ps.id = rs.supplier_id;

INSERT INTO supplier_offer_revisions
  (supplier_offer_id, revision_number, status, currency, source_evidence_json,
   note, legacy_response_revision_id, finalized_by_user_id, finalized_at,
   created_by_user_id, created_at)
SELECT so.id, rr.rev_number,
       CASE WHEN rr.rev_number = mx.max_rev THEN 'finalized' ELSE 'superseded' END,
       (SELECT MIN(rl.currency) FROM rfq_response_lines rl WHERE rl.rfq_response_revision_id = rr.id),
       JSON_OBJECT('source', 'legacy_rfq_response_revision', 'legacy_response_revision_id', rr.id),
       rr.note, rr.id, rr.created_by_user_id, rr.created_at, rr.created_by_user_id, rr.created_at
FROM rfq_response_revisions rr
JOIN supplier_offers so ON so.legacy_response_id = rr.rfq_supplier_response_id
JOIN (
  SELECT rfq_supplier_response_id, MAX(rev_number) AS max_rev
  FROM rfq_response_revisions GROUP BY rfq_supplier_response_id
) mx ON mx.rfq_supplier_response_id = rr.rfq_supplier_response_id;

INSERT INTO supplier_offer_lines
  (supplier_offer_revision_id, supplier_part_id, offered_catalog_position_id,
   relationship_type, supplier_part_number_snapshot, description_snapshot,
   supplier_reply_status, offered_quantity, moq, pack_quantity, unit_price, currency,
   lead_time_days, validity_until, payment_terms, incoterms, incoterms_place,
   origin_country, evidence_json, legacy_response_line_id, created_at)
SELECT sor.id, rl.supplier_part_id, rl.catalog_position_id,
       CASE rl.offer_type WHEN 'OEM' THEN 'exact' WHEN 'ANALOG' THEN 'analog' ELSE 'unknown' END,
       sp.supplier_part_number, COALESCE(sp.description_ru, sp.description_en, sp.comment),
       LOWER(rl.supplier_reply_status), rl.offered_qty, rl.moq,
       CASE WHEN rl.packaging REGEXP '^[0-9]+([.][0-9]+)?$' THEN CAST(rl.packaging AS DECIMAL(15,3)) ELSE NULL END,
       rl.price, rl.currency, rl.lead_time_days,
       CASE WHEN rl.validity_days IS NOT NULL THEN DATE_ADD(DATE(rl.created_at), INTERVAL rl.validity_days DAY) ELSE NULL END,
       rl.payment_terms, rl.incoterms, rl.incoterms_place, rl.origin_country,
       JSON_OBJECT('entry_source', rl.entry_source, 'selection_key', rl.selection_key,
                   'packaging_text', rl.packaging, 'change_reason', rl.change_reason),
       rl.id, rl.created_at
FROM rfq_response_lines rl
JOIN supplier_offer_revisions sor ON sor.legacy_response_revision_id = rl.rfq_response_revision_id
LEFT JOIN supplier_parts sp ON sp.id = rl.supplier_part_id;

INSERT INTO supplier_offer_line_demands
  (supplier_offer_line_id, sourcing_demand_id, capable_quantity, match_basis_json, created_at)
SELECT sol.id, sd.id, rl.offered_qty,
       JSON_OBJECT('legacy_rfq_item_id', ri.id, 'selection_key', rl.selection_key,
                   'requested_catalog_position_id', ri.catalog_position_id), rl.created_at
FROM supplier_offer_lines sol
JOIN rfq_response_lines rl ON rl.id = sol.legacy_response_line_id
JOIN rfq_items ri ON ri.id = rl.rfq_item_id
JOIN supplier_offer_revisions sor ON sor.id = sol.supplier_offer_revision_id
JOIN supplier_offers so ON so.id = sor.supplier_offer_id
JOIN sourcing_demands sd ON sd.sourcing_case_id = so.sourcing_case_id
  AND sd.procurement_release_item_id = ri.procurement_release_item_id;

INSERT INTO sourcing_coverage_options
  (sourcing_case_id, option_code, option_type, status, title, blocker_json,
   legacy_coverage_option_id, created_by_user_id, created_at, updated_at)
SELECT sc.id, CONCAT('LEGACY-', co.id, '-', co.option_code),
       CASE co.option_kind WHEN 'WHOLE' THEN 'single' WHEN 'BOM' THEN 'split'
            WHEN 'KIT' THEN 'kit' WHEN 'MIXED' THEN 'mixed' ELSE 'manual' END,
       CASE co.coverage_status WHEN 'FULL' THEN 'valid' WHEN 'PARTIAL' THEN 'partial'
            WHEN 'BLOCKED' THEN 'blocked' WHEN 'CONFLICT' THEN 'blocked' ELSE 'draft' END,
       co.option_code, COALESCE(co.warning_json, JSON_ARRAY()), co.id,
       co.created_by_user_id, co.created_at, co.updated_at
FROM rfq_coverage_options co
JOIN sourcing_cases sc ON sc.legacy_rfq_id = co.rfq_id;

INSERT INTO sourcing_coverage_option_lines
  (sourcing_coverage_option_id, sourcing_demand_id, supplier_offer_line_id,
   supplier_id, allocated_quantity, purchase_quantity, surplus_quantity,
   uom_snapshot, validation_json, legacy_coverage_option_line_id, created_at)
SELECT sco.id, sd.id, sol.id, col.supplier_id,
       GREATEST(COALESCE(col.qty, 0.001), 0.001),
       GREATEST(COALESCE(col.qty, 0.001), 0.001), 0,
       COALESCE(NULLIF(col.uom, ''), sd.uom_snapshot),
       JSON_OBJECT('legacy_line_status', col.line_status, 'has_price', col.has_price,
                   'legacy_line_role', col.line_role), col.id, col.created_at
FROM rfq_coverage_option_lines col
JOIN sourcing_coverage_options sco ON sco.legacy_coverage_option_id = col.coverage_option_id
JOIN rfq_items ri ON ri.id = col.rfq_item_id
JOIN sourcing_demands sd ON sd.sourcing_case_id = sco.sourcing_case_id
  AND sd.procurement_release_item_id = ri.procurement_release_item_id
LEFT JOIN supplier_offer_lines sol ON sol.legacy_response_line_id = col.rfq_response_line_id;

INSERT INTO sourcing_case_events
  (sourcing_case_id, event_type, entity_type, entity_id, actor_user_id, payload_json)
SELECT sc.id, 'legacy_history_linked', 'sourcing_case', sc.id, sc.created_by_user_id,
       JSON_OBJECT(
         'inquiry_count', (SELECT COUNT(*) FROM supplier_inquiries si WHERE si.sourcing_case_id = sc.id),
         'offer_count', (SELECT COUNT(*) FROM supplier_offers so WHERE so.sourcing_case_id = sc.id),
         'coverage_option_count', (SELECT COUNT(*) FROM sourcing_coverage_options co WHERE co.sourcing_case_id = sc.id),
         'orphan_supplier_reference_count', (
           SELECT COUNT(*) FROM supplier_inquiries si
           WHERE si.sourcing_case_id = sc.id AND si.supplier_id IS NULL
         )
       )
FROM sourcing_cases sc WHERE sc.legacy_rfq_id IS NOT NULL;

INSERT INTO capabilities
  (capability_key, name, description, section, sort_order, is_active, is_legacy)
VALUES
  ('sourcing.access', 'Просмотр Sourcing', 'Доступ к очереди и read model Sourcing Case', 'sourcing', 1000, 1, 0),
  ('sourcing.cases.manage', 'Управление Sourcing Case', 'Создание, принятие и архивирование кейсов закупочного поиска', 'sourcing', 1010, 1, 0),
  ('sourcing.inquiries.manage', 'Управление запросами поставщикам', 'Создание immutable-ревизий и dispatch supplier inquiry', 'sourcing', 1020, 1, 0),
  ('sourcing.offers.manage', 'Управление предложениями поставщиков', 'Транзакционный ввод и финализация Supplier Offer', 'sourcing', 1030, 1, 0),
  ('sourcing.coverage.manage', 'Управление покрытием потребности', 'Создание и валидация вариантов покрытия', 'sourcing', 1040, 1, 0),
  ('sourcing.decisions.finalize', 'Финализация Sourcing Decision', 'Фиксация трассируемого решения по покрытию', 'sourcing', 1050, 1, 0),
  ('sourcing.master_data_promotion.request', 'Запрос на продвижение мастер-данных', 'Создание проверяемого запроса без изменения Supplier master data', 'sourcing', 1060, 1, 0)
ON DUPLICATE KEY UPDATE
  name = VALUES(name), description = VALUES(description), section = VALUES(section),
  sort_order = VALUES(sort_order), is_active = 1, is_legacy = 0;

INSERT INTO role_capabilities (role_id, capability_id, is_allowed)
SELECT r.id, c.id, 1 FROM roles r JOIN capabilities c ON c.capability_key LIKE 'sourcing.%'
WHERE r.slug IN ('admin', 'nachalnik-otdela-zakupok')
ON DUPLICATE KEY UPDATE is_allowed = 1;

INSERT INTO role_capabilities (role_id, capability_id, is_allowed)
SELECT r.id, c.id, 1 FROM roles r JOIN capabilities c ON c.capability_key IN (
  'sourcing.access', 'sourcing.cases.manage', 'sourcing.inquiries.manage',
  'sourcing.offers.manage', 'sourcing.coverage.manage',
  'sourcing.master_data_promotion.request'
)
WHERE r.slug = 'zakupshchik'
ON DUPLICATE KEY UPDATE is_allowed = 1;

INSERT INTO role_capabilities (role_id, capability_id, is_allowed)
SELECT r.id, c.id, 1 FROM roles r JOIN capabilities c ON c.capability_key = 'sourcing.access'
WHERE r.slug IN ('prodavec', 'specialist-po-katalogam', 'nablyudatel')
ON DUPLICATE KEY UPDATE is_allowed = 1;
