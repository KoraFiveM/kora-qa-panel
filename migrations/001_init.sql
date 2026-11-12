-- kora_qa panel schema (QA-CONTRACTS.md section 2). Times are ms epoch BIGINT.

CREATE TABLE users (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  discord_id VARCHAR(25) NOT NULL UNIQUE,
  name VARCHAR(100) NULL,
  avatar VARCHAR(200) NULL,
  role ENUM('tester','dev','admin') NOT NULL DEFAULT 'tester',
  legacy TINYINT DEFAULT 0,
  created_at BIGINT NULL,
  last_login_at BIGINT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE sessions (
  id CHAR(64) PRIMARY KEY,
  user_id BIGINT NULL,
  created_at BIGINT NULL,
  expires_at BIGINT NULL,
  KEY idx_sessions_user (user_id),
  KEY idx_sessions_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE issues (
  id VARCHAR(25) PRIMARY KEY,
  title VARCHAR(200) NULL,
  kind ENUM('bug','suggestion') DEFAULT 'bug',
  status VARCHAR(32) NOT NULL,
  source ENUM('discord','scenario','freeform','retest') NOT NULL,
  reporter_discord_id VARCHAR(25) NULL,
  reporter_name VARCHAR(100) NULL,
  scenario_id VARCHAR(191) NULL,
  run_id BIGINT NULL,
  failed_step INT NULL,
  not_fixed_count INT DEFAULT 0,
  mod_override JSON NULL,
  report JSON NULL,
  legacy JSON NULL,
  fixed_paid TINYINT DEFAULT 0,
  deleted TINYINT DEFAULT 0,
  created_at BIGINT NULL,
  updated_at BIGINT NULL,
  status_at BIGINT NULL,
  KEY idx_issues_status (status),
  KEY idx_issues_updated (updated_at),
  KEY idx_issues_scenario (scenario_id),
  KEY idx_issues_reporter (reporter_discord_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE issue_messages (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  issue_id VARCHAR(25) NOT NULL,
  author_discord_id VARCHAR(25) NULL,
  author_name VARCHAR(100) NULL,
  is_bot TINYINT DEFAULT 0,
  content MEDIUMTEXT NULL,
  created_at BIGINT NULL,
  legacy_message_id VARCHAR(25) NULL UNIQUE,
  KEY idx_msg_issue (issue_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE issue_attachments (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  issue_id VARCHAR(25) NULL,
  message_id BIGINT NULL,
  kind ENUM('screenshot','file') DEFAULT 'file',
  path VARCHAR(300) NULL,
  mime VARCHAR(100) NULL,
  size INT NULL,
  original_url TEXT NULL,
  created_at BIGINT NULL,
  KEY idx_att_issue (issue_id),
  KEY idx_att_message (message_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE issue_events (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  issue_id VARCHAR(25) NOT NULL,
  at BIGINT NULL,
  by_discord_id VARCHAR(25) NULL,
  by_name VARCHAR(100) NULL,
  type ENUM('status','comment','meta','fix','xp','import') NOT NULL,
  from_status VARCHAR(32) NULL,
  to_status VARCHAR(32) NULL,
  note TEXT NULL,
  data JSON NULL,
  KEY idx_ev_issue (issue_id, at),
  KEY idx_ev_at (at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE fixes (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  issue_id VARCHAR(25) NOT NULL,
  patch_id VARCHAR(64) NOT NULL,
  model VARCHAR(64) NULL,
  risk VARCHAR(32) NULL,
  summary TEXT NULL,
  details MEDIUMTEXT NULL,
  test_steps MEDIUMTEXT NULL,
  scenario MEDIUMTEXT NULL,
  meta JSON NULL,
  applied JSON NULL,
  is_history TINYINT DEFAULT 0,
  created_at BIGINT NULL,
  UNIQUE KEY uq_fix (issue_id, patch_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE issue_prompts (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  issue_id VARCHAR(25) NOT NULL,
  kind VARCHAR(32) NULL,
  content MEDIUMTEXT NULL,
  meta JSON NULL,
  created_at BIGINT NULL,
  legacy_key VARCHAR(64) NULL UNIQUE,
  KEY idx_prompt_issue (issue_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE scenarios (
  id VARCHAR(191) PRIMARY KEY,
  resource VARCHAR(64) NULL,
  file VARCHAR(200) NULL,
  line INT NULL,
  name VARCHAR(300) NULL,
  description TEXT NULL,
  tags JSON NULL,
  steps JSON NULL,
  hash CHAR(40) NULL,
  target INT DEFAULT 1,
  legacy_ids JSON NULL,
  valid TINYINT NULL,
  errors JSON NULL,
  removed TINYINT DEFAULT 0,
  updated_at BIGINT NULL,
  KEY idx_scn_resource (resource)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE runs (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  scenario_id VARCHAR(191) NULL,
  scenario_hash CHAR(40) NULL,
  legacy_test_id VARCHAR(64) NULL,
  discord_id VARCHAR(25) NULL,
  name VARCHAR(100) NULL,
  status ENUM('running','passed','failed','aborted','blocked') NULL,
  started_at BIGINT NULL,
  finished_at BIGINT NULL,
  legacy TINYINT DEFAULT 0,
  issue_id VARCHAR(25) NULL,
  context JSON NULL,
  note TEXT NULL,
  KEY idx_runs_scenario (scenario_id),
  KEY idx_runs_discord (discord_id),
  KEY idx_runs_started (started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE run_steps (
  run_id BIGINT NOT NULL,
  idx INT NOT NULL,
  text VARCHAR(500) NULL,
  kind VARCHAR(16) NULL,
  status ENUM('pending','passed','failed','skipped','unverified','blocked') NULL,
  detail JSON NULL,
  at BIGINT NULL,
  PRIMARY KEY (run_id, idx)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE legacy_tests (
  id VARCHAR(64) PRIMARY KEY,
  source ENUM('game','checklist') NULL,
  resource VARCHAR(64) NULL,
  title VARCHAR(300) NULL,
  description TEXT NULL,
  data JSON NULL,
  scenario_id VARCHAR(191) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE tester_stats (
  discord_id VARCHAR(25) PRIMARY KEY,
  data JSON NULL,
  updated_at BIGINT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE xp_outbox (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  discord_id VARCHAR(25) NOT NULL,
  event VARCHAR(32) NOT NULL,
  issue_id VARCHAR(64) NOT NULL,
  at BIGINT NULL,
  sent_at BIGINT NULL,
  attempts INT DEFAULT 0,
  last_error TEXT NULL,
  UNIQUE KEY uq_xp (issue_id, event, discord_id),
  KEY idx_xp_pending (sent_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE registry (
  id INT PRIMARY KEY DEFAULT 1,
  data JSON NULL,
  updated_at BIGINT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE kv (
  k VARCHAR(64) PRIMARY KEY,
  v JSON NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
