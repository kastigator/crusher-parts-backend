UPDATE client_contracts cc
JOIN (
  SELECT
    cc2.id AS contract_id,
    SUM(COALESCE(ql.sell_price, ql.cost, 0) * COALESCE(ql.qty, 0)) AS total_amount
  FROM client_contracts cc2
  JOIN sales_quotes sq ON sq.id = cc2.sales_quote_id
  JOIN sales_quote_lines ql
    ON ql.sales_quote_revision_id = COALESCE(
      cc2.sales_quote_revision_id,
      (
        SELECT r.id
          FROM sales_quote_revisions r
         WHERE r.sales_quote_id = sq.id
         ORDER BY r.rev_number DESC, r.id DESC
         LIMIT 1
      )
    )
   AND COALESCE(ql.line_status, 'active') = 'active'
  WHERE cc2.amount IS NULL
    AND cc2.status IN ('signed', 'in_execution', 'completed', 'closed_with_issues')
  GROUP BY cc2.id
) totals ON totals.contract_id = cc.id
SET cc.amount = totals.total_amount,
    cc.updated_at = NOW()
WHERE cc.amount IS NULL
  AND totals.total_amount IS NOT NULL;
