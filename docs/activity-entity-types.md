# Activity Entity Types

Updated: 2026-07-03

This document defines current entity-type names for activity/audit logs and future UI labels.

Use current classifier-first names. Do not introduce old standalone OEM/original-parts or standard-parts entity names in new work.

## Active Classifier And Catalog Entities

| Entity type | Meaning |
| --- | --- |
| `classifier_node` | Classifier section/category. |
| `equipment_model` | Equipment model card, for example `Metso HP 800`. |
| `equipment_model_bom_item` | One row/application in a model BOM tree. |
| `catalog_position` | Position card opened from a BOM row. Stores characteristics, materials, TN VED, applicability and supplier links. |
| `catalog_position_material` | Material variant/execution of a catalog position. |
| `material` | Material dictionary item. |
| `tnved_code` | TN VED dictionary item. |
| `measurement_unit` | Shared measurement-unit dictionary item. |

## Supplier Entities

| Entity type | Meaning |
| --- | --- |
| `part_supplier` | Supplier company. |
| `supplier_part` | Part/service/material that a supplier can sell or make. |
| `supplier_part_catalog_position` | Link saying a supplier part can supply/replace a catalog position. |
| `supplier_part_material` | Material info for supplier part. |
| `supplier_part_price` | Price history or offer info for supplier part. |
| `supplier_price_list` | Imported supplier price list. |

## Commercial Entities

These are still subject to later commercial-contour refactor, but they are current enough for activity naming:

| Entity type | Meaning |
| --- | --- |
| `client_request` | Client request/intake. |
| `client_request_item` | One requested item. |
| `rfq` | Request for quotation to suppliers. |
| `rfq_item` | RFQ line. |
| `supplier_response` | Supplier response/offer. |
| `sales_quote` | Quote to client. |
| `purchase_order` | Supplier purchase order. |
| `client` | Client company. |

## Legacy Names

Do not use these names for new activity events:

| Legacy name | Current direction |
| --- | --- |
| `oem_part`, `original_part`, `oem_parts` | Use `catalog_position` and `equipment_model_bom_item`. |
| `standard_part`, `standard_parts` | Use `catalog_position` when it is a normalized/shared classifier position. |
| `supplier_part_oem_part` | Use `supplier_part_catalog_position`. |
| `oem_part_model_bom` | Use `equipment_model_bom_item`. |

If old records still contain legacy values, treat them as historical data or migration cleanup, not as product architecture.
