-- Legacy import (scripts/import-legacy.mjs): stable keys so re-runs upsert instead of duplicating, and fix prompts that
-- belong to a legacy test rather than an issue (communitybot data/test-prompts.json lives in #test-discussion threads).

ALTER TABLE issue_events ADD COLUMN legacy_key VARCHAR(100) NULL, ADD UNIQUE KEY uq_ev_legacy (legacy_key);

ALTER TABLE issue_attachments ADD COLUMN legacy_key VARCHAR(100) NULL, ADD UNIQUE KEY uq_att_legacy (legacy_key);

ALTER TABLE runs ADD COLUMN legacy_key VARCHAR(100) NULL, ADD UNIQUE KEY uq_runs_legacy (legacy_key), ADD KEY idx_runs_legacy_test (legacy_test_id);

ALTER TABLE issue_prompts MODIFY issue_id VARCHAR(25) NULL, ADD COLUMN legacy_test_id VARCHAR(64) NULL, ADD KEY idx_prompt_legacy_test (legacy_test_id);
