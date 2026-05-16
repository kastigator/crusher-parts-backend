UPDATE client_contracts cc
JOIN sales_quotes sq ON sq.id = cc.sales_quote_id
SET cc.status = 'signed',
    cc.updated_at = NOW()
WHERE cc.status = 'in_execution'
  AND NOT EXISTS (
    SELECT 1
      FROM supplier_purchase_orders po
     WHERE po.selection_id = sq.selection_id
       AND po.status <> 'cancelled'
  );
