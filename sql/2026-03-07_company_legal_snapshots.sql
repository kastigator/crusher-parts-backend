ALTER TABLE sales_quotes
  ADD COLUMN company_legal_profile_id INT DEFAULT NULL,
  ADD COLUMN company_legal_snapshot_json JSON DEFAULT NULL,
  ADD KEY idx_sales_quotes_company_legal_profile (company_legal_profile_id),
  ADD CONSTRAINT fk_sales_quotes_company_legal_profile
    FOREIGN KEY (company_legal_profile_id) REFERENCES company_legal_profiles (id) ON DELETE SET NULL;

ALTER TABLE client_contracts
  ADD COLUMN company_legal_profile_id INT DEFAULT NULL,
  ADD COLUMN company_legal_snapshot_json JSON DEFAULT NULL,
  ADD KEY idx_client_contracts_company_legal_profile (company_legal_profile_id),
  ADD CONSTRAINT fk_client_contracts_company_legal_profile
    FOREIGN KEY (company_legal_profile_id) REFERENCES company_legal_profiles (id) ON DELETE SET NULL;
