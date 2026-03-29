const db = require('./db')

const INSERTABLE_COLUMNS = {
  client_contacts: [
    'id',
    'client_id',
    'name',
    'role',
    'email',
    'phone',
    'is_primary',
    'notes',
    'created_at',
    'updated_at',
    'version',
  ],
  clients: [
    'id',
    'company_name',
    'registration_number',
    'tax_id',
    'contact_person',
    'phone',
    'email',
    'website',
    'notes',
    'created_at',
    'updated_at',
    'version',
  ],
  part_suppliers: [
    'id',
    'name',
    'vat_number',
    'country',
    'website',
    'payment_terms',
    'preferred_currency',
    'default_lead_time_days',
    'notes',
    'version',
    'created_at',
    'updated_at',
    'public_code',
    'default_pickup_location',
    'can_oem',
    'can_analog',
    'reliability_rating',
    'risk_level',
  ],
  supplier_contacts: [
    'id',
    'supplier_id',
    'name',
    'role',
    'email',
    'phone',
    'is_primary',
    'notes',
    'created_at',
    'updated_at',
    'version',
  ],
  supplier_addresses: [
    'id',
    'supplier_id',
    'label',
    'type',
    'formatted_address',
    'city',
    'street',
    'house',
    'building',
    'entrance',
    'region',
    'country',
    'is_primary',
    'is_precise_location',
    'place_id',
    'lat',
    'lng',
    'postal_code',
    'comment',
    'created_at',
    'updated_at',
    'version',
  ],
  supplier_bank_details: [
    'id',
    'supplier_id',
    'bank_name',
    'account_number',
    'iban',
    'bic',
    'currency',
    'correspondent_account',
    'bank_address',
    'additional_info',
    'is_primary_for_currency',
    'created_at',
    'updated_at',
    'version',
  ],
  supplier_parts: [
    'id',
    'supplier_id',
    'supplier_part_number',
    'canonical_part_number',
    'description_ru',
    'description_en',
    'uom',
    'comment',
    'lead_time_days',
    'min_order_qty',
    'packaging',
    'active',
    'created_at',
    'original_part_cat_number',
    'default_material_id',
    'updated_at',
    'weight_kg',
    'length_cm',
    'width_cm',
    'height_cm',
    'is_overweight',
    'is_oversize',
    'part_type',
    'price',
    'currency',
    'default_fx_currency',
    'default_markup_pct',
    'default_markup_abs',
    'default_logistics_route_id',
  ],
  supplier_price_lists: [
    'id',
    'supplier_id',
    'list_code',
    'list_name',
    'status',
    'currency_default',
    'valid_from',
    'valid_to',
    'source_file_name',
    'source_file_url',
    'source_file_hash',
    'note',
    'uploaded_by_user_id',
    'activated_by_user_id',
    'activated_at',
    'created_at',
    'updated_at',
  ],
  supplier_price_list_lines: [
    'id',
    'supplier_price_list_id',
    'source_row_no',
    'line_status',
    'supplier_part_number_raw',
    'supplier_part_number_canonical',
    'description_raw',
    'material_code_raw',
    'price',
    'currency',
    'offer_type',
    'lead_time_days',
    'min_order_qty',
    'packaging',
    'validity_days',
    'valid_from',
    'valid_to',
    'comment',
    'matched_supplier_part_id',
    'matched_material_id',
    'match_confidence',
    'match_method',
    'match_note',
    'source_row_hash',
    'imported_by_user_id',
    'created_at',
    'updated_at',
  ],
  supplier_part_materials: [
    'supplier_part_id',
    'material_id',
    'is_default',
    'note',
  ],
  oem_part_material_specs: [
    'oem_part_id',
    'material_id',
    'weight_kg',
    'length_cm',
    'width_cm',
    'height_cm',
  ],
  supplier_part_oem_parts: [
    'supplier_part_id',
    'oem_part_id',
    'priority_rank',
    'is_preferred',
  ],
  supplier_part_standard_parts: [
    'supplier_part_id',
    'standard_part_id',
    'priority_rank',
    'is_preferred',
    'note',
    'created_at',
  ],
  supplier_part_prices: [
    'id',
    'supplier_part_id',
    'material_id',
    'price',
    'currency',
    'date',
    'comment',
    'offer_type',
    'lead_time_days',
    'min_order_qty',
    'packaging',
    'validity_days',
    'source_type',
    'source_subtype',
    'source_id',
    'created_by_user_id',
    'created_at',
  ],
  client_billing_addresses: [
    'id',
    'client_id',
    'label',
    'formatted_address',
    'city',
    'street',
    'house',
    'building',
    'entrance',
    'region',
    'country',
    'type',
    'is_precise_location',
    'place_id',
    'lat',
    'lng',
    'postal_code',
    'comment',
    'created_at',
    'updated_at',
    'version',
  ],
  client_shipping_addresses: [
    'id',
    'client_id',
    'formatted_address',
    'city',
    'region',
    'country',
    'type',
    'is_precise_location',
    'place_id',
    'lat',
    'lng',
    'postal_code',
    'comment',
    'created_at',
    'street',
    'house',
    'building',
    'entrance',
    'updated_at',
    'version',
  ],
  client_bank_details: [
    'id',
    'client_id',
    'bank_name',
    'account_number',
    'iban',
    'bic',
    'currency',
    'correspondent_account',
    'bank_address',
    'additional_info',
    'created_at',
    'updated_at',
    'version',
  ],
  client_equipment_units: [
    'id',
    'client_id',
    'equipment_model_id',
    'serial_number',
    'manufacture_year',
    'site_name',
    'internal_name',
    'commissioning_date',
    'decommissioned_date',
    'status',
    'notes',
    'created_at',
    'updated_at',
  ],
  client_request_revision_items: [
    'id',
    'client_request_revision_id',
    'line_number',
    'oem_part_id',
    'standard_part_id',
    'equipment_model_id',
    'client_part_number',
    'client_description',
    'client_line_text',
    'requested_qty',
    'uom',
    'required_date',
    'priority',
    'oem_only',
    'client_comment',
    'internal_comment',
    'created_at',
  ],
  client_request_revision_item_components: [
    'id',
    'client_request_revision_item_id',
    'oem_part_id',
    'standard_part_id',
    'component_qty',
    'required_qty',
    'source_type',
    'note',
    'created_at',
    'updated_at',
  ],
  client_request_revision_item_strategies: [
    'id',
    'client_request_revision_item_id',
    'mode',
    'allow_oem',
    'allow_analog',
    'allow_kit',
    'allow_partial',
    'note',
    'created_at',
    'updated_at',
  ],
  oem_part_unit_overrides: [
    'id',
    'oem_part_id',
    'client_equipment_unit_id',
    'status',
    'replacement_oem_part_id',
    'note',
    'effective_from',
    'effective_to',
    'created_at',
    'updated_at',
  ],
  oem_part_unit_material_overrides: [
    'oem_part_id',
    'client_equipment_unit_id',
    'material_id',
    'is_default',
    'note',
  ],
  oem_part_unit_material_specs: [
    'oem_part_id',
    'client_equipment_unit_id',
    'material_id',
    'weight_kg',
    'length_cm',
    'width_cm',
    'height_cm',
  ],
  tnved_codes: [
    'id',
    'code',
    'created_at',
    'description',
    'duty_rate',
    'notes',
    'version',
  ],
  logistics_route_templates: [
    'id',
    'corridor_id',
    'name',
    'code',
    'version_no',
    'pricing_model',
    'currency',
    'fixed_cost',
    'rate_per_kg',
    'rate_per_cbm',
    'min_cost',
    'markup_pct',
    'markup_fixed',
    'eta_min_days',
    'eta_max_days',
    'incoterms_baseline',
    'oversize_allowed',
    'overweight_allowed',
    'dangerous_goods_allowed',
    'is_active',
    'is_system',
    'source_legacy_route_id',
    'note',
    'created_by_user_id',
    'updated_by_user_id',
    'created_at',
    'updated_at',
  ],
  original_part_groups: [
    'id',
    'name',
    'description',
    'sort_order',
    'created_at',
    'updated_at',
  ],
  equipment_manufacturers: [
    'id',
    'name',
    'country',
    'website',
    'notes',
    'created_at',
  ],
  equipment_models: [
    'id',
    'manufacturer_id',
    'model_name',
    'created_at',
    'classifier_node_id',
    'model_code',
    'notes',
  ],
  equipment_classifier_nodes: [
    'id',
    'parent_id',
    'name',
    'node_type',
    'code',
    'sort_order',
    'is_active',
    'notes',
    'created_at',
    'updated_at',
  ],
  standard_part_classes: [
    'id',
    'parent_id',
    'code',
    'name',
    'description',
    'sort_order',
    'is_active',
    'created_at',
    'updated_at',
  ],
  standard_part_class_fields: [
    'id',
    'class_id',
    'code',
    'label',
    'field_type',
    'sort_order',
    'is_required',
    'is_active',
    'is_in_title',
    'is_in_list',
    'is_in_filters',
    'is_searchable',
    'unit',
    'placeholder',
    'help_text',
    'default_value',
    'settings_json',
    'created_at',
    'updated_at',
  ],
  standard_part_field_options: [
    'id',
    'field_id',
    'value_code',
    'value_label',
    'sort_order',
    'is_active',
  ],
  users: [
    'id',
    'username',
    'password',
    'full_name',
    'email',
    'phone',
    'position',
    'role_id',
    'is_active',
    'created_at',
    'reset_password_token',
    'reset_password_expires',
  ],
  roles: [
    'id',
    'name',
    'slug',
  ],
  tabs: [
    'id',
    'name',
    'tab_name',
    'path',
    'icon',
    'tooltip',
    'is_active',
    'sort_order',
  ],
  role_permissions: [
    'id',
    'role_id',
    'tab_id',
    'can_view',
  ],
  role_capabilities: [
    'id',
    'role_id',
    'capability_id',
    'is_allowed',
  ],
  procurement_kpi_targets: [
    'id',
    'buyer_user_id',
    'period_start',
    'period_end',
    'target_rfqs',
    'target_invites',
    'target_selections',
    'target_purchase_orders',
    'target_landed_amount',
    'target_currency',
    'created_at',
    'updated_at',
  ],
  sales_kpi_targets: [
    'id',
    'seller_user_id',
    'period_start',
    'period_end',
    'target_requests',
    'target_quotes',
    'target_contracts',
    'target_signed_amount',
    'target_currency',
    'created_at',
    'updated_at',
  ],
  materials: [
    'id',
    'category_id',
    'name',
    'code',
    'standard',
    'source_file',
    'source_path',
    'description',
    'created_at',
    'updated_at',
  ],
  material_properties: [
    'id',
    'material_id',
    'code',
    'display_name',
    'value_num',
    'value_text',
    'unit',
    'use_curve',
    'created_at',
  ],
  material_property_curves: [
    'id',
    'material_id',
    'curve_id',
    'name',
    'type',
    'points',
    'created_at',
  ],
  material_aliases: [
    'id',
    'material_id',
    'alias',
    'source',
  ],
  standard_parts: [
    'id',
    'class_id',
    'display_name',
    'display_name_norm',
    'designation',
    'uom',
    'description_ru',
    'description_en',
    'notes',
    'attributes_search_text',
    'is_active',
    'created_at',
    'updated_at',
  ],
  standard_part_values: [
    'id',
    'standard_part_id',
    'field_id',
    'value_text',
    'value_number',
    'value_boolean',
    'value_date',
    'value_json',
    'created_at',
    'updated_at',
  ],
  oem_part_standard_parts: [
    'oem_part_id',
    'standard_part_id',
    'is_primary',
    'note',
    'created_at',
  ],
  oem_part_materials: [
    'oem_part_id',
    'material_id',
    'is_default',
    'note',
  ],
  oem_part_material_specs: [
    'oem_part_id',
    'material_id',
    'weight_kg',
    'length_cm',
    'width_cm',
    'height_cm',
  ],
  oem_part_model_bom: [
    'parent_oem_part_id',
    'equipment_model_id',
    'child_oem_part_id',
    'quantity',
    'created_at',
  ],
  oem_part_alt_groups: [
    'id',
    'oem_part_id',
    'name',
    'comment',
    'created_at',
    'updated_at',
  ],
  oem_part_alt_items: [
    'group_id',
    'alt_oem_part_id',
    'note',
  ],
  oem_part_documents: [
    'id',
    'oem_part_id',
    'file_name',
    'file_type',
    'file_size',
    'file_url',
    'description',
    'uploaded_by',
    'uploaded_at',
  ],
  oem_part_presentation_profiles: [
    'id',
    'oem_part_id',
    'internal_part_number',
    'internal_part_name',
    'supplier_visible_part_number',
    'supplier_visible_description',
    'drawing_code',
    'use_by_default_in_supplier_rfq',
    'note',
    'created_at',
    'updated_at',
  ],
  oem_parts: [
    'id',
    'manufacturer_id',
    'part_number',
    'uom',
    'tnved_code_id',
    'group_id',
    'has_drawing',
    'is_overweight',
    'is_oversize',
    'created_at',
    'updated_at',
  ],
  rfq_item_components: [
    'id',
    'rfq_item_id',
    'oem_part_id',
    'standard_part_id',
    'component_qty',
    'required_qty',
    'source_type',
    'note',
    'created_at',
    'updated_at',
  ],
  rfq_scenarios: [
    'id',
    'rfq_id',
    'name',
    'basis',
    'status',
    'calc_currency',
    'fx_as_of',
    'fx_snapshot_json',
    'goods_total',
    'freight_total',
    'duty_total',
    'other_total',
    'landed_total',
    'coverage_pct',
    'priced_pct',
    'is_oem_ok',
    'eta_min_days',
    'eta_max_days',
    'warning_json',
    'note',
    'created_by_user_id',
    'updated_by_user_id',
    'created_at',
    'updated_at',
  ],
  rfq_scenario_lines: [
    'id',
    'scenario_id',
    'rfq_item_id',
    'coverage_option_id',
    'decision_status',
    'note',
    'created_at',
    'updated_at',
  ],
  oem_part_model_fitments: [
    'id',
    'oem_part_id',
    'equipment_model_id',
    'description_ru',
    'description_en',
    'tech_description',
    'weight_kg',
    'length_cm',
    'width_cm',
    'height_cm',
    'uom',
    'created_at',
    'updated_at',
  ],
  supplier_bundles: [
    'id',
    'oem_part_id',
    'title',
    'note',
    'name',
    'comment',
    'created_at',
    'updated_at',
  ],
  supplier_bundle_items: [
    'id',
    'bundle_id',
    'role_label',
    'qty',
    'sort_order',
  ],
  supplier_bundle_item_links: [
    'id',
    'item_id',
    'supplier_part_id',
    'is_default',
    'note',
    'default_one',
  ],
}

const EXISTENCE_KEY_FIELDS = {
  supplier_part_materials: ['supplier_part_id', 'material_id'],
  oem_part_material_specs: ['oem_part_id', 'material_id'],
  supplier_part_oem_parts: ['supplier_part_id', 'oem_part_id'],
  supplier_part_standard_parts: ['supplier_part_id', 'standard_part_id'],
  oem_part_standard_parts: ['oem_part_id', 'standard_part_id'],
  oem_part_materials: ['oem_part_id', 'material_id'],
  oem_part_model_bom: ['parent_oem_part_id', 'equipment_model_id', 'child_oem_part_id'],
  oem_part_alt_items: ['group_id', 'alt_oem_part_id'],
  oem_part_unit_material_overrides: ['oem_part_id', 'client_equipment_unit_id', 'material_id'],
  oem_part_unit_material_specs: ['oem_part_id', 'client_equipment_unit_id', 'material_id'],
  oem_part_presentation_profiles: ['oem_part_id'],
}

const ENTITY_RESTORE_TABLE = {
  clients: 'clients',
  part_suppliers: 'part_suppliers',
  supplier_parts: 'supplier_parts',
  supplier_price_lists: 'supplier_price_lists',
  supplier_price_list_lines: 'supplier_price_list_lines',
  supplier_part_prices: 'supplier_part_prices',
  materials: 'materials',
  standard_parts: 'standard_parts',
  oem_part_materials: 'oem_part_materials',
  oem_part_unit_overrides: 'oem_part_unit_overrides',
  oem_part_unit_material_overrides: 'oem_part_unit_material_overrides',
  oem_part_unit_material_specs: 'oem_part_unit_material_specs',
  oem_parts: 'oem_parts',
  oem_part_model_bom: 'oem_part_model_bom',
  oem_part_model_fitments: 'oem_part_model_fitments',
  oem_part_alt_groups: 'oem_part_alt_groups',
  oem_part_alt_items: 'oem_part_alt_items',
  oem_part_documents: 'oem_part_documents',
  oem_part_presentation_profiles: 'oem_part_presentation_profiles',
  supplier_part_oem_parts: 'supplier_part_oem_parts',
  supplier_part_standard_parts: 'supplier_part_standard_parts',
  supplier_part_materials: 'supplier_part_materials',
  oem_part_standard_parts: 'oem_part_standard_parts',
  oem_part_material_specs: 'oem_part_material_specs',
  supplier_bundles: 'supplier_bundles',
  supplier_bundle_items: 'supplier_bundle_items',
  supplier_bundle_item_links: 'supplier_bundle_item_links',
  client_request_revision_items: 'client_request_revision_items',
  client_request_revision_item_components: 'client_request_revision_item_components',
  client_request_revision_item_strategies: 'client_request_revision_item_strategies',
  rfq_item_components: 'rfq_item_components',
  role_permissions: 'role_permissions',
  role_capabilities: 'role_capabilities',
  client_contacts: 'client_contacts',
  client_billing_addresses: 'client_billing_addresses',
  client_shipping_addresses: 'client_shipping_addresses',
  client_bank_details: 'client_bank_details',
  supplier_contacts: 'supplier_contacts',
  supplier_addresses: 'supplier_addresses',
  supplier_bank_details: 'supplier_bank_details',
  tnved_codes: 'tnved_codes',
  logistics_route_templates: 'logistics_route_templates',
  procurement_kpi_targets: 'procurement_kpi_targets',
  sales_kpi_targets: 'sales_kpi_targets',
  material_properties: 'material_properties',
  material_property_curves: 'material_property_curves',
  material_aliases: 'material_aliases',
  standard_part_values: 'standard_part_values',
  equipment_manufacturers: 'equipment_manufacturers',
  equipment_models: 'equipment_models',
  equipment_classifier_nodes: 'equipment_classifier_nodes',
  standard_part_classes: 'standard_part_classes',
  standard_part_class_fields: 'standard_part_class_fields',
  standard_part_field_options: 'standard_part_field_options',
  users: 'users',
  original_part_groups: 'original_part_groups',
  roles: 'roles',
  tabs: 'tabs',
  rfq_scenarios: 'rfq_scenarios',
  rfq_scenario_lines: 'rfq_scenario_lines',
  client_equipment_units: 'client_equipment_units',
}

const BUSINESS_KEY_RULES = {
  clients: [
    { fields: ['registration_number'], label: 'registration_number' },
    { fields: ['tax_id'], label: 'tax_id' },
  ],
  part_suppliers: [
    { fields: ['vat_number'], label: 'vat_number' },
    { fields: ['public_code'], label: 'public_code' },
  ],
  users: [
    { fields: ['username'], label: 'username' },
  ],
  roles: [
    { fields: ['name'], label: 'name' },
    { fields: ['slug'], label: 'slug' },
  ],
  tabs: [
    { fields: ['tab_name'], label: 'tab_name' },
  ],
  tnved_codes: [
    { fields: ['code', 'description'], label: 'code + description' },
  ],
  equipment_manufacturers: [
    { fields: ['name'], label: 'name' },
  ],
  equipment_models: [
    { fields: ['manufacturer_id', 'model_name'], label: 'manufacturer_id + model_name' },
  ],
  supplier_parts: [
    { fields: ['supplier_id', 'supplier_part_number'], label: 'supplier_id + supplier_part_number' },
  ],
  supplier_price_lists: [
    { fields: ['supplier_id', 'is_active_flag'], label: 'one active price list per supplier' },
  ],
  client_equipment_units: [
    { fields: ['client_id', 'equipment_model_id', 'serial_number_norm'], label: 'client_id + equipment_model_id + serial_number_norm' },
  ],
  supplier_bank_details: [
    { fields: ['primary_key_for_currency'], label: 'single primary bank details per supplier/currency' },
  ],
  oem_part_unit_overrides: [
    { fields: ['oem_part_id', 'client_equipment_unit_id'], label: 'oem_part_id + client_equipment_unit_id' },
  ],
  supplier_bundle_items: [
    { fields: ['bundle_id', 'role_label'], label: 'bundle_id + role_label' },
  ],
  supplier_bundle_item_links: [
    { fields: ['item_id', 'supplier_part_id'], label: 'item_id + supplier_part_id' },
    { fields: ['item_id', 'default_one'], label: 'single default supplier part per bundle item' },
  ],
  client_request_revision_item_components: [
    { fields: ['client_request_revision_item_id', 'source_type'], label: 'client_request_revision_item_id + source_type' },
    { fields: ['client_request_revision_item_id', 'oem_part_id', 'source_type'], label: 'client_request_revision_item_id + oem_part_id + source_type' },
  ],
  client_request_revision_item_strategies: [
    { fields: ['client_request_revision_item_id'], label: 'client_request_revision_item_id' },
  ],
  rfq_item_components: [
    { fields: ['rfq_item_id', 'source_type'], label: 'rfq_item_id + source_type' },
  ],
  role_permissions: [
    { fields: ['role_id', 'tab_id'], label: 'role_id + tab_id' },
  ],
  role_capabilities: [
    { fields: ['role_id', 'capability_id'], label: 'role_id + capability_id' },
  ],
  procurement_kpi_targets: [
    { fields: ['buyer_user_id', 'period_start', 'period_end'], label: 'buyer_user_id + period_start + period_end' },
  ],
  sales_kpi_targets: [
    { fields: ['seller_user_id', 'period_start', 'period_end'], label: 'seller_user_id + period_start + period_end' },
  ],
  rfq_scenario_lines: [
    { fields: ['scenario_id', 'rfq_item_id'], label: 'scenario_id + rfq_item_id' },
  ],
  material_aliases: [
    { fields: ['material_id', 'alias'], label: 'material_id + alias' },
  ],
  standard_part_values: [
    { fields: ['standard_part_id', 'field_id'], label: 'standard_part_id + field_id' },
  ],
  standard_part_classes: [
    { fields: ['code'], label: 'code' },
  ],
  standard_part_class_fields: [
    { fields: ['class_id', 'code'], label: 'class_id + code' },
  ],
  standard_part_field_options: [
    { fields: ['field_id', 'value_code'], label: 'field_id + value_code' },
  ],
  original_part_groups: [
    { fields: ['name'], label: 'name' },
  ],
  oem_parts: [
    { fields: ['manufacturer_id', 'part_number_norm'], label: 'manufacturer_id + part_number_norm' },
  ],
}

const CONFLICT_ROW_SUMMARIZERS = {
  clients: (row) => row.company_name || `#${row.id}`,
  part_suppliers: (row) => row.name || `#${row.id}`,
  users: (row) => row.full_name || row.username || `#${row.id}`,
  roles: (row) => row.name || row.slug || `#${row.id}`,
  tabs: (row) => [row.tab_name, row.path].filter(Boolean).join(' / ') || `#${row.id}`,
  tnved_codes: (row) => [row.code, row.description].filter(Boolean).join(' / ') || `#${row.id}`,
  equipment_manufacturers: (row) => row.name || `#${row.id}`,
  equipment_models: (row) => [row.model_name, row.model].filter(Boolean).join(' / ') || `#${row.id}`,
  supplier_price_lists: (row) => [row.list_code, row.list_name, row.status].filter(Boolean).join(' / ') || `#${row.id}`,
  client_equipment_units: (row) =>
    [row.internal_name, row.serial_number, row.site_name].filter(Boolean).join(' / ') || `#${row.id}`,
  supplier_bank_details: (row) =>
    [row.bank_name, row.currency, row.account_number].filter(Boolean).join(' / ') || `#${row.id}`,
  oem_part_unit_overrides: (row) =>
    [row.oem_part_id != null ? `oem=${row.oem_part_id}` : null, row.client_equipment_unit_id != null ? `unit=${row.client_equipment_unit_id}` : null, row.status]
      .filter(Boolean)
      .join(' / ') || `#${row.id}`,
  supplier_bundle_items: (row) => [row.role_label, row.bundle_id != null ? `bundle=${row.bundle_id}` : null].filter(Boolean).join(' / ') || `#${row.id}`,
  supplier_bundle_item_links: (row) =>
    [row.item_id != null ? `item=${row.item_id}` : null, row.supplier_part_id != null ? `supplier_part=${row.supplier_part_id}` : null]
      .filter(Boolean)
      .join(' / ') || `#${row.id}`,
  client_request_revision_item_components: (row) =>
    [row.source_type, row.oem_part_id != null ? `oem=${row.oem_part_id}` : null, row.standard_part_id != null ? `standard=${row.standard_part_id}` : null]
      .filter(Boolean)
      .join(' / ') || `#${row.id}`,
  client_request_revision_item_strategies: (row) =>
    [row.client_request_revision_item_id != null ? `item=${row.client_request_revision_item_id}` : null, row.mode].filter(Boolean).join(' / ') || `#${row.id}`,
  rfq_item_components: (row) =>
    [row.source_type, row.rfq_item_id != null ? `rfq_item=${row.rfq_item_id}` : null].filter(Boolean).join(' / ') || `#${row.id}`,
  role_permissions: (row) =>
    [row.role_id != null ? `role=${row.role_id}` : null, row.tab_id != null ? `tab=${row.tab_id}` : null].filter(Boolean).join(' / ') || `#${row.id}`,
  role_capabilities: (row) =>
    [row.role_id != null ? `role=${row.role_id}` : null, row.capability_id != null ? `capability=${row.capability_id}` : null]
      .filter(Boolean)
      .join(' / ') || `#${row.id}`,
  procurement_kpi_targets: (row) =>
    [row.buyer_user_id != null ? `buyer=${row.buyer_user_id}` : null, row.period_start, row.period_end].filter(Boolean).join(' / ') || `#${row.id}`,
  sales_kpi_targets: (row) =>
    [row.seller_user_id != null ? `seller=${row.seller_user_id}` : null, row.period_start, row.period_end].filter(Boolean).join(' / ') || `#${row.id}`,
  rfq_scenario_lines: (row) =>
    [row.scenario_id != null ? `scenario=${row.scenario_id}` : null, row.rfq_item_id != null ? `rfq_item=${row.rfq_item_id}` : null]
      .filter(Boolean)
      .join(' / ') || `#${row.id}`,
  material_aliases: (row) =>
    [row.material_id != null ? `material=${row.material_id}` : null, row.alias].filter(Boolean).join(' / ') || `#${row.id}`,
  standard_part_values: (row) =>
    [row.standard_part_id != null ? `part=${row.standard_part_id}` : null, row.field_id != null ? `field=${row.field_id}` : null]
      .filter(Boolean)
      .join(' / ') || `#${row.id}`,
  standard_part_classes: (row) => [row.code, row.name].filter(Boolean).join(' / ') || `#${row.id}`,
  standard_part_class_fields: (row) => [row.code, row.label].filter(Boolean).join(' / ') || `#${row.id}`,
  standard_part_field_options: (row) => [row.value_code, row.value_label].filter(Boolean).join(' / ') || `#${row.id}`,
  original_part_groups: (row) => row.name || `#${row.id}`,
  oem_parts: (row) => [row.part_number, row.description_ru].filter(Boolean).join(' / ') || `#${row.id}`,
  supplier_parts: (row) =>
    [row.supplier_part_number, row.canonical_part_number, row.description_ru]
      .filter(Boolean)
      .join(' / ') || `#${row.id}`,
}

function parseJson(value) {
  if (value == null) return null
  if (typeof value === 'object') return value
  return JSON.parse(value)
}

function toMysqlDateTime(value) {
  if (value == null || value === '') return null
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return value
    return value.toISOString().slice(0, 19).replace('T', ' ')
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return null
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(trimmed)) return trimmed
    const date = new Date(trimmed)
    if (!Number.isNaN(date.getTime())) {
      return date.toISOString().slice(0, 19).replace('T', ' ')
    }
  }
  return value
}

function toMysqlDate(value) {
  if (value == null || value === '') return null
  const formatLocalDate = (date) => {
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return value
    return formatLocalDate(value)
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return null
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed
    const date = new Date(trimmed)
    if (!Number.isNaN(date.getTime())) {
      return formatLocalDate(date)
    }
  }
  return value
}

function isDateOnlyColumn(column) {
  return (
    column === 'date' ||
    column === 'valid_from' ||
    column === 'valid_to' ||
    column === 'period_start' ||
    column === 'period_end' ||
    column === 'fx_as_of' ||
    column.endsWith('_date')
  )
}

function normalizePreviewSqlValue(field, value) {
  if (value == null) return value
  if (isDateOnlyColumn(field)) return toMysqlDate(value)
  if (field.endsWith('_at') || field === 'created_at' || field === 'updated_at') {
    return toMysqlDateTime(value)
  }
  return value
}

async function ensureRowMissing(conn, table, id) {
  const [[row]] = await conn.execute(`SELECT id FROM ${table} WHERE id = ?`, [id])
  return !row
}

function getExistenceKeys(table, snapshot) {
  const explicit = EXISTENCE_KEY_FIELDS[table]
  if (explicit?.length) {
    return explicit
      .map((field) => ({ field, value: normalizePreviewSqlValue(field, snapshot?.[field]) }))
      .filter((item) => item.value !== undefined)
  }

  if (snapshot?.id !== undefined && snapshot?.id !== null) {
    return [{ field: 'id', value: normalizePreviewSqlValue('id', snapshot.id) }]
  }

  return []
}

async function rowExistsBySnapshot(conn, table, snapshot) {
  const keys = getExistenceKeys(table, snapshot)
  if (!keys.length) {
    return {
      exists: false,
      keys: [],
      reason: 'no_identity',
    }
  }

  const where = keys.map(({ field }) => `${field} <=> ?`).join(' AND ')
  const params = keys.map(({ value }) => value)
  const [[row]] = await conn.execute(`SELECT 1 AS found FROM ${table} WHERE ${where} LIMIT 1`, params)

  return {
    exists: !!row,
    keys,
    reason: row ? 'row_exists' : 'missing',
  }
}

function formatKeys(keys) {
  if (!Array.isArray(keys) || !keys.length) return 'без ключа'
  return keys.map(({ field, value }) => `${field}=${value == null ? 'null' : value}`).join(', ')
}

async function findBusinessKeyConflicts(conn, table, snapshot) {
  const rules = BUSINESS_KEY_RULES[table] || []
  const conflicts = []

  for (const rule of rules) {
    const fields = Array.isArray(rule.fields) ? rule.fields : []
    if (!fields.length) continue
    const values = fields.map((field) => normalizePreviewSqlValue(field, snapshot?.[field]))
    if (values.some((value) => value == null || value === '')) continue

    const where = fields.map((field) => `${field} = ?`).join(' AND ')
    const params = [...values]
    let sql = `SELECT * FROM ${table} WHERE ${where}`
    if (snapshot?.id != null) {
      sql += ' AND id <> ?'
      params.push(snapshot.id)
    }
    sql += ' LIMIT 1'

    const [[row]] = await conn.execute(sql, params)
    if (row) {
      const summary =
        (typeof CONFLICT_ROW_SUMMARIZERS[table] === 'function' && CONFLICT_ROW_SUMMARIZERS[table](row)) ||
        `#${row.id}`
      conflicts.push({
        code: 'BUSINESS_KEY_CONFLICT',
        message: `Найден конфликт по ${rule.label}: ${fields.map((field) => `${field}=${snapshot[field]}`).join(', ')}`,
        business_key: rule.label,
        fields,
        values: Object.fromEntries(fields.map((field) => [field, snapshot[field]])),
        existing_row: {
          id: row.id ?? null,
          summary,
        },
      })
    }
  }

  return conflicts
}

async function buildRestorePreview(trashEntryId) {
  const id = Number(trashEntryId)
  if (!Number.isInteger(id) || id <= 0) {
    const err = new Error('Некорректный идентификатор корзины')
    err.status = 400
    throw err
  }

  const conn = await db.getConnection()
  try {
    const [[entry]] = await conn.execute('SELECT * FROM trash_entries WHERE id = ?', [id])
    if (!entry) {
      const err = new Error('Запись корзины не найдена')
      err.status = 404
      throw err
    }

    const [items] = await conn.execute(
      'SELECT * FROM trash_entry_items WHERE trash_entry_id = ? ORDER BY sort_order ASC, id ASC',
      [id]
    )

    const rootTable = ENTITY_RESTORE_TABLE[entry.entity_type]
    if (!rootTable) {
      return {
        trash_entry_id: id,
        entity_type: entry.entity_type,
        supported: false,
        can_restore: false,
        restore_status: entry.restore_status,
        summary: {
          title: 'Восстановление не поддерживается',
          message: `Для сущности "${entry.entity_type}" preview восстановления пока не реализован`,
        },
        conflicts: [],
        affected: { root: 0, items: 0 },
      }
    }

    const conflicts = []
    const rootSnapshot = parseJson(entry.snapshot_json)
    const rootCheck = rootSnapshot
      ? await rowExistsBySnapshot(conn, rootTable, rootSnapshot)
      : { exists: false, keys: [], reason: 'missing_snapshot' }

    if (entry.restore_status !== 'pending') {
      conflicts.push({
        level: 'entry',
        entity_type: entry.entity_type,
        title: entry.title || entry.entity_type,
        code: 'ALREADY_PROCESSED',
        message: 'Эта запись корзины уже была обработана и не находится в статусе pending',
      })
    }

    if (!rootSnapshot) {
      conflicts.push({
        level: 'root',
        entity_type: entry.entity_type,
        title: entry.title || entry.entity_type,
        code: 'MISSING_SNAPSHOT',
        message: 'У корневой записи отсутствует snapshot для восстановления',
      })
    } else {
      if (rootCheck.exists) {
        conflicts.push({
          level: 'root',
          entity_type: entry.entity_type,
          title: entry.title || entry.entity_type,
          code: 'ROOT_EXISTS',
          message: `Корневая запись уже существует: ${formatKeys(rootCheck.keys)}`,
        })
      }

      const businessConflicts = await findBusinessKeyConflicts(conn, rootTable, rootSnapshot)
      for (const conflict of businessConflicts) {
        conflicts.push({
          level: 'root',
          entity_type: entry.entity_type,
          title: entry.title || entry.entity_type,
          ...conflict,
        })
      }
    }

    for (const item of items) {
      const table = ENTITY_RESTORE_TABLE[item.item_type]
      const snapshot = parseJson(item.snapshot_json)
      if (!table) {
        conflicts.push({
          level: 'item',
          entity_type: item.item_type,
          title: item.title || item.item_type,
          code: 'UNSUPPORTED_ITEM',
          message: `Для связанной сущности "${item.item_type}" preview восстановления не реализован`,
        })
        continue
      }
      if (!snapshot) {
        conflicts.push({
          level: 'item',
          entity_type: item.item_type,
          title: item.title || item.item_type,
          code: 'MISSING_ITEM_SNAPSHOT',
          message: 'У связанной записи отсутствует snapshot для восстановления',
        })
        continue
      }

      const check = await rowExistsBySnapshot(conn, table, snapshot)
      if (check.exists) {
        conflicts.push({
          level: 'item',
          entity_type: item.item_type,
          title: item.title || item.item_type,
          code: 'ITEM_EXISTS',
          message: `Связанная запись уже существует: ${formatKeys(check.keys)}`,
        })
      }

      const businessConflicts = await findBusinessKeyConflicts(conn, table, snapshot)
      for (const conflict of businessConflicts) {
        conflicts.push({
          level: 'item',
          entity_type: item.item_type,
          title: item.title || item.item_type,
          ...conflict,
        })
      }
    }

    return {
      trash_entry_id: id,
      entity_type: entry.entity_type,
      supported: true,
      can_restore: conflicts.length === 0,
      restore_status: entry.restore_status,
      summary: {
        title: conflicts.length
          ? 'Автовосстановление требует внимания'
          : 'Запись можно восстановить',
        message: conflicts.length
          ? 'Перед восстановлением обнаружены конфликты существования записей или бизнес-ключей'
          : 'Конфликтов не найдено, запись можно восстановить автоматически',
      },
      affected: {
        root: rootSnapshot ? 1 : 0,
        items: items.length,
      },
      conflicts,
    }
  } finally {
    conn.release()
  }
}

async function insertSnapshot(conn, table, snapshot) {
  const columns = INSERTABLE_COLUMNS[table]
  if (!columns) throw new Error(`Restore for table "${table}" is not supported`)

  const placeholders = columns.map(() => '?').join(', ')
  const values = columns.map((column) => {
    const value = snapshot[column] === undefined ? null : snapshot[column]
    if (isDateOnlyColumn(column)) {
      return toMysqlDate(value)
    }
    if (column.endsWith('_at') || column === 'created_at' || column === 'updated_at') {
      return toMysqlDateTime(value)
    }
    return value
  })

  await conn.execute(
    `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`,
    values
  )
}

async function restoreClientChild(conn, entry, tableName) {
  const snapshot = parseJson(entry.snapshot_json)
  if (!snapshot) throw new Error('Trash entry snapshot is missing')

  const missing = await ensureRowMissing(conn, tableName, snapshot.id)
  if (!missing) {
    const err = new Error('Целевая запись уже существует и не может быть восстановлена автоматически')
    err.status = 409
    throw err
  }

  await insertSnapshot(conn, tableName, snapshot)
}

async function restoreClientAggregate(conn, entry, items) {
  const snapshot = parseJson(entry.snapshot_json)
  if (!snapshot) throw new Error('Trash entry snapshot is missing')

  const missing = await ensureRowMissing(conn, 'clients', snapshot.id)
  if (!missing) {
    const err = new Error('Клиент уже существует и не может быть восстановлен автоматически')
    err.status = 409
    throw err
  }

  await insertSnapshot(conn, 'clients', snapshot)

  for (const item of items) {
    const childSnapshot = parseJson(item.snapshot_json)
    if (!childSnapshot) continue
    await insertSnapshot(conn, item.item_type, childSnapshot)
  }
}

async function restoreSupplierAggregate(conn, entry, items) {
  const snapshot = parseJson(entry.snapshot_json)
  if (!snapshot) throw new Error('Trash entry snapshot is missing')

  const missing = await ensureRowMissing(conn, 'part_suppliers', snapshot.id)
  if (!missing) {
    const err = new Error('Поставщик уже существует и не может быть восстановлен автоматически')
    err.status = 409
    throw err
  }

  await insertSnapshot(conn, 'part_suppliers', snapshot)

  for (const item of items) {
    const childSnapshot = parseJson(item.snapshot_json)
    if (!childSnapshot) continue
    await insertSnapshot(conn, item.item_type, childSnapshot)
  }
}

async function restoreSupplierPart(conn, entry, items) {
  const snapshot = parseJson(entry.snapshot_json)
  if (!snapshot) throw new Error('Trash entry snapshot is missing')

  const missing = await ensureRowMissing(conn, 'supplier_parts', snapshot.id)
  if (!missing) {
    const err = new Error('Позиция поставщика уже существует и не может быть восстановлена автоматически')
    err.status = 409
    throw err
  }

  await insertSnapshot(conn, 'supplier_parts', snapshot)

  for (const item of items) {
    const childSnapshot = parseJson(item.snapshot_json)
    if (!childSnapshot) continue
    await insertSnapshot(conn, item.item_type, childSnapshot)
  }
}

async function restoreSupplierPriceList(conn, entry, items) {
  const snapshot = parseJson(entry.snapshot_json)
  if (!snapshot) throw new Error('Trash entry snapshot is missing')

  const missing = await ensureRowMissing(conn, 'supplier_price_lists', snapshot.id)
  if (!missing) {
    const err = new Error('Прайс-лист уже существует и не может быть восстановлен автоматически')
    err.status = 409
    throw err
  }

  await insertSnapshot(conn, 'supplier_price_lists', snapshot)

  for (const item of items) {
    const childSnapshot = parseJson(item.snapshot_json)
    if (!childSnapshot) continue
    await insertSnapshot(conn, item.item_type, childSnapshot)
  }
}

async function restoreSupplierPriceListLine(conn, entry, items) {
  const snapshot = parseJson(entry.snapshot_json)
  if (!snapshot) throw new Error('Trash entry snapshot is missing')

  const missing = await ensureRowMissing(conn, 'supplier_price_list_lines', snapshot.id)
  if (!missing) {
    const err = new Error('Строка прайс-листа уже существует и не может быть восстановлена автоматически')
    err.status = 409
    throw err
  }

  await insertSnapshot(conn, 'supplier_price_list_lines', snapshot)

  for (const item of items) {
    const childSnapshot = parseJson(item.snapshot_json)
    if (!childSnapshot) continue
    await insertSnapshot(conn, item.item_type, childSnapshot)
  }
}

async function restoreMaterialAggregate(conn, entry, items) {
  const snapshot = parseJson(entry.snapshot_json)
  if (!snapshot) throw new Error('Trash entry snapshot is missing')

  const missing = await ensureRowMissing(conn, 'materials', snapshot.id)
  if (!missing) {
    const err = new Error('Материал уже существует и не может быть восстановлен автоматически')
    err.status = 409
    throw err
  }

  await insertSnapshot(conn, 'materials', snapshot)

  for (const item of items) {
    const childSnapshot = parseJson(item.snapshot_json)
    if (!childSnapshot) continue
    await insertSnapshot(conn, item.item_type, childSnapshot)
  }
}

async function restoreStandardPartAggregate(conn, entry, items) {
  const snapshot = parseJson(entry.snapshot_json)
  if (!snapshot) throw new Error('Trash entry snapshot is missing')

  const missing = await ensureRowMissing(conn, 'standard_parts', snapshot.id)
  if (!missing) {
    const err = new Error('Standard part уже существует и не может быть восстановлена автоматически')
    err.status = 409
    throw err
  }

  await insertSnapshot(conn, 'standard_parts', snapshot)

  for (const item of items) {
    const childSnapshot = parseJson(item.snapshot_json)
    if (!childSnapshot) continue
    await insertSnapshot(conn, item.item_type, childSnapshot)
  }
}

async function restoreRelationAggregate(conn, entry, rootTable, items) {
  const snapshot = parseJson(entry.snapshot_json)
  if (!snapshot) throw new Error('Trash entry snapshot is missing')
  await insertSnapshot(conn, rootTable, snapshot)

  for (const item of items) {
    const childSnapshot = parseJson(item.snapshot_json)
    if (!childSnapshot) continue
    await insertSnapshot(conn, item.item_type, childSnapshot)
  }
}

async function restoreOemDocument(conn, entry, items) {
  await restoreRelationAggregate(conn, entry, 'oem_part_documents', items)
  const snapshot = parseJson(entry.snapshot_json)
  if (snapshot?.oem_part_id) {
    await conn.execute('UPDATE oem_parts SET has_drawing = 1 WHERE id = ?', [snapshot.oem_part_id])
  }
}

async function restoreClientEquipmentUnit(conn, entry, items) {
  const snapshot = parseJson(entry.snapshot_json)
  if (!snapshot) throw new Error('Trash entry snapshot is missing')

  const missing = await ensureRowMissing(conn, 'client_equipment_units', snapshot.id)
  if (!missing) {
    const err = new Error('Единица оборудования уже существует и не может быть восстановлена автоматически')
    err.status = 409
    throw err
  }

  await insertSnapshot(conn, 'client_equipment_units', snapshot)

  for (const item of items) {
    const childSnapshot = parseJson(item.snapshot_json)
    if (!childSnapshot) continue
    await insertSnapshot(conn, item.item_type, childSnapshot)
  }
}

async function restoreOriginalPartGroup(conn, entry) {
  const snapshot = parseJson(entry.snapshot_json)
  if (!snapshot) throw new Error('Trash entry snapshot is missing')

  const missing = await ensureRowMissing(conn, 'original_part_groups', snapshot.id)
  if (!missing) {
    const err = new Error('Группа OEM деталей уже существует и не может быть восстановлена автоматически')
    err.status = 409
    throw err
  }

  await insertSnapshot(conn, 'original_part_groups', snapshot)

  const context = parseJson(entry.context_json) || {}
  const linkedIds = Array.isArray(context.linked_oem_part_ids)
    ? context.linked_oem_part_ids.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0)
    : []

  if (linkedIds.length) {
    const placeholders = linkedIds.map(() => '?').join(', ')
    await conn.execute(
      `UPDATE oem_parts SET group_id = ? WHERE id IN (${placeholders})`,
      [snapshot.id, ...linkedIds]
    )
  }
}

async function restoreRoleAggregate(conn, entry, items) {
  const snapshot = parseJson(entry.snapshot_json)
  if (!snapshot) throw new Error('Trash entry snapshot is missing')

  const missing = await ensureRowMissing(conn, 'roles', snapshot.id)
  if (!missing) {
    const err = new Error('Роль уже существует и не может быть восстановлена автоматически')
    err.status = 409
    throw err
  }

  await insertSnapshot(conn, 'roles', snapshot)
  for (const item of items) {
    const childSnapshot = parseJson(item.snapshot_json)
    if (!childSnapshot) continue
    await insertSnapshot(conn, item.item_type, childSnapshot)
  }
}

async function restoreTabAggregate(conn, entry, items) {
  const snapshot = parseJson(entry.snapshot_json)
  if (!snapshot) throw new Error('Trash entry snapshot is missing')

  const missing = await ensureRowMissing(conn, 'tabs', snapshot.id)
  if (!missing) {
    const err = new Error('Вкладка уже существует и не может быть восстановлена автоматически')
    err.status = 409
    throw err
  }

  await insertSnapshot(conn, 'tabs', snapshot)
  for (const item of items) {
    const childSnapshot = parseJson(item.snapshot_json)
    if (!childSnapshot) continue
    await insertSnapshot(conn, item.item_type, childSnapshot)
  }
}

async function markRestored(conn, trashEntryId, userId) {
  await conn.execute(
    `
    UPDATE trash_entries
       SET restore_status = 'restored',
           restored_at = NOW(),
           restored_by_user_id = ?
     WHERE id = ?
    `,
    [userId || null, trashEntryId]
  )
}

async function restoreTrashEntry(trashEntryId, req) {
  const id = Number(trashEntryId)
  if (!Number.isInteger(id) || id <= 0) {
    const err = new Error('Некорректный идентификатор корзины')
    err.status = 400
    throw err
  }

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()

    const [[entry]] = await conn.execute('SELECT * FROM trash_entries WHERE id = ? FOR UPDATE', [id])
    if (!entry) {
      const err = new Error('Запись корзины не найдена')
      err.status = 404
      throw err
    }
    if (entry.restore_status !== 'pending') {
      const err = new Error('Эта запись корзины уже была обработана')
      err.status = 409
      throw err
    }

    const [items] = await conn.execute(
      'SELECT * FROM trash_entry_items WHERE trash_entry_id = ? ORDER BY sort_order ASC, id ASC',
      [id]
    )

    switch (entry.entity_type) {
      case 'clients':
        await restoreClientAggregate(conn, entry, items)
        break
      case 'part_suppliers':
        await restoreSupplierAggregate(conn, entry, items)
        break
      case 'supplier_parts':
        await restoreSupplierPart(conn, entry, items)
        break
      case 'supplier_price_lists':
        await restoreSupplierPriceList(conn, entry, items)
        break
      case 'supplier_price_list_lines':
        await restoreSupplierPriceListLine(conn, entry, items)
        break
      case 'supplier_part_prices':
        await restoreClientChild(conn, entry, entry.entity_type)
        break
      case 'materials':
        await restoreMaterialAggregate(conn, entry, items)
        break
      case 'standard_parts':
        await restoreStandardPartAggregate(conn, entry, items)
        break
      case 'oem_part_materials':
        await restoreRelationAggregate(conn, entry, 'oem_part_materials', items)
        break
      case 'oem_part_unit_overrides':
        await restoreRelationAggregate(conn, entry, 'oem_part_unit_overrides', items)
        break
      case 'oem_part_unit_material_overrides':
        await restoreRelationAggregate(conn, entry, 'oem_part_unit_material_overrides', items)
        break
      case 'oem_parts':
        await restoreRelationAggregate(conn, entry, 'oem_parts', items)
        break
      case 'oem_part_model_bom':
        await restoreRelationAggregate(conn, entry, 'oem_part_model_bom', items)
        break
      case 'oem_part_model_fitments':
        await restoreRelationAggregate(conn, entry, 'oem_part_model_fitments', items)
        break
      case 'oem_part_alt_groups':
        await restoreRelationAggregate(conn, entry, 'oem_part_alt_groups', items)
        break
      case 'oem_part_alt_items':
        await restoreRelationAggregate(conn, entry, 'oem_part_alt_items', items)
        break
      case 'oem_part_documents':
        await restoreOemDocument(conn, entry, items)
        break
      case 'oem_part_presentation_profiles':
        await restoreRelationAggregate(conn, entry, 'oem_part_presentation_profiles', items)
        break
      case 'supplier_part_oem_parts':
        await restoreRelationAggregate(conn, entry, 'supplier_part_oem_parts', items)
        break
      case 'supplier_part_standard_parts':
        await restoreRelationAggregate(conn, entry, 'supplier_part_standard_parts', items)
        break
      case 'supplier_part_materials':
        await restoreRelationAggregate(conn, entry, 'supplier_part_materials', items)
        break
      case 'oem_part_standard_parts':
        await restoreRelationAggregate(conn, entry, 'oem_part_standard_parts', items)
        break
      case 'oem_part_material_specs':
        await restoreRelationAggregate(conn, entry, 'oem_part_material_specs', items)
        break
      case 'supplier_bundles':
        await restoreRelationAggregate(conn, entry, 'supplier_bundles', items)
        break
      case 'supplier_bundle_items':
        await restoreRelationAggregate(conn, entry, 'supplier_bundle_items', items)
        break
      case 'supplier_bundle_item_links':
        await restoreRelationAggregate(conn, entry, 'supplier_bundle_item_links', items)
        break
      case 'client_request_revision_items':
        await restoreRelationAggregate(conn, entry, 'client_request_revision_items', items)
        break
      case 'client_request_revision_item_components':
        await restoreRelationAggregate(conn, entry, 'client_request_revision_item_components', items)
        break
      case 'rfq_item_components':
        await restoreRelationAggregate(conn, entry, 'rfq_item_components', items)
        break
      case 'client_contacts':
      case 'client_billing_addresses':
      case 'client_shipping_addresses':
      case 'client_bank_details':
      case 'supplier_contacts':
      case 'supplier_addresses':
      case 'supplier_bank_details':
      case 'tnved_codes':
      case 'logistics_route_templates':
      case 'procurement_kpi_targets':
      case 'sales_kpi_targets':
      case 'equipment_manufacturers':
      case 'equipment_models':
      case 'equipment_classifier_nodes':
      case 'standard_part_classes':
      case 'standard_part_class_fields':
      case 'standard_part_field_options':
      case 'users':
        await restoreClientChild(conn, entry, entry.entity_type)
        break
      case 'original_part_groups':
        await restoreOriginalPartGroup(conn, entry)
        break
      case 'roles':
        await restoreRoleAggregate(conn, entry, items)
        break
      case 'tabs':
        await restoreTabAggregate(conn, entry, items)
        break
      case 'rfq_scenarios':
        await restoreRelationAggregate(conn, entry, 'rfq_scenarios', items)
        break
      case 'client_equipment_units':
        await restoreClientEquipmentUnit(conn, entry, items)
        break
      default: {
        const err = new Error(`Restore for entity "${entry.entity_type}" is not supported yet`)
        err.status = 400
        throw err
      }
    }

    await markRestored(conn, id, req?.user?.id ? Number(req.user.id) : null)
    await conn.commit()
    return entry
  } catch (err) {
    try {
      await conn.rollback()
    } catch {}
    throw err
  } finally {
    conn.release()
  }
}

module.exports = {
  buildRestorePreview,
  restoreTrashEntry,
}
