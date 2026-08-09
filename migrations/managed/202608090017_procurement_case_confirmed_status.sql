ALTER TABLE procurement_execution_cases
  DROP CHECK chk_procurement_case_status,
  ADD CONSTRAINT chk_procurement_case_status CHECK (
    status IN (
      'READINESS_REVIEW',
      'READY_FOR_PO',
      'PO_DRAFTING',
      'AWAITING_CONFIRMATION',
      'CONFIRMED',
      'CHANGE_REQUIRED',
      'BLOCKED',
      'CLOSED',
      'CANCELLED'
    )
  );
