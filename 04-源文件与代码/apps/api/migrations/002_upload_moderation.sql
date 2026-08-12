CREATE TABLE IF NOT EXISTS upload_sessions (
  id CHAR(36) PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  state VARCHAR(32) NOT NULL,
  object_key VARCHAR(512) NOT NULL,
  file_name VARCHAR(255) NOT NULL,
  declared_size_bytes BIGINT UNSIGNED NOT NULL,
  consent_policy_version VARCHAR(64) NOT NULL,
  etag VARCHAR(256) NULL,
  quality_warning BOOLEAN NULL,
  failure_code VARCHAR(64) NULL,
  moderation_started_at DATETIME(3) NULL,
  credential_issue_count TINYINT UNSIGNED NOT NULL DEFAULT 0,
  expires_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  UNIQUE KEY uq_upload_object (object_key),
  KEY ix_upload_owner (user_id, id),
  KEY ix_upload_state (state, updated_at)
);

CREATE TABLE IF NOT EXISTS assets (
  id CHAR(36) PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  upload_session_id CHAR(36) NOT NULL,
  kind VARCHAR(32) NOT NULL,
  object_key VARCHAR(512) NOT NULL,
  mime_type VARCHAR(64) NOT NULL,
  size_bytes BIGINT UNSIGNED NOT NULL,
  width INT UNSIGNED NULL,
  height INT UNSIGNED NULL,
  delete_after DATETIME(3) NOT NULL,
  UNIQUE KEY uq_asset_object (object_key)
);

CREATE TABLE IF NOT EXISTS moderation_checks (
  id CHAR(36) PRIMARY KEY,
  upload_session_id CHAR(36) NOT NULL,
  attempt TINYINT UNSIGNED NOT NULL,
  outcome VARCHAR(32) NOT NULL,
  error_code VARCHAR(64) NULL,
  created_at DATETIME(3) NOT NULL,
  UNIQUE KEY uq_moderation_attempt (upload_session_id, attempt)
);

CREATE TABLE IF NOT EXISTS jobs (
  id CHAR(36) PRIMARY KEY,
  type VARCHAR(64) NOT NULL,
  payload_json JSON NOT NULL,
  status VARCHAR(32) NOT NULL,
  attempt TINYINT UNSIGNED NOT NULL DEFAULT 0,
  max_attempts TINYINT UNSIGNED NOT NULL,
  run_after DATETIME(3) NOT NULL,
  lease_owner VARCHAR(128) NULL,
  lease_token CHAR(36) NULL,
  lease_expires_at DATETIME(3) NULL,
  idempotency_key VARCHAR(191) NOT NULL,
  last_error_code VARCHAR(64) NULL,
  UNIQUE KEY uq_job_idempotency (idempotency_key),
  KEY ix_jobs_claim (status, run_after, lease_expires_at)
);
