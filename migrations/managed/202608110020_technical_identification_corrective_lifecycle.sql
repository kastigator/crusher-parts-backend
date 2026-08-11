ALTER TABLE technical_identification_tasks
  DROP CHECK chk_ti_status;

ALTER TABLE technical_identification_tasks
  ADD CONSTRAINT chk_ti_status CHECK (status IN (
    'new', 'in_progress', 'waiting_client', 'resolved', 'closed', 'cancelled', 'superseded'
  ));
