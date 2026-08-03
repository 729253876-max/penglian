CREATE TABLE IF NOT EXISTS users (
  id CHAR(36) PRIMARY KEY,
  status ENUM('ACTIVE','DELETING','DELETED') NOT NULL,
  created_at DATETIME(3) NOT NULL,
  deletion_requested_at DATETIME(3) NULL
);

CREATE TABLE IF NOT EXISTS identity_bindings (
  id CHAR(36) PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  app_id VARCHAR(64) NOT NULL,
  openid_ciphertext VARBINARY(512) NOT NULL,
  openid_lookup_hash BINARY(32) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  UNIQUE KEY uq_identity_app_openid (app_id, openid_lookup_hash)
);

CREATE TABLE IF NOT EXISTS consents (
  id CHAR(36) PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  consent_type VARCHAR(64) NOT NULL,
  policy_version VARCHAR(64) NOT NULL,
  granted BOOLEAN NOT NULL,
  granted_at DATETIME(3) NOT NULL,
  revoked_at DATETIME(3) NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id CHAR(36) PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  device_id_hash BINARY(32) NOT NULL,
  access_token_hash BINARY(32) NOT NULL,
  access_expires_at DATETIME(3) NOT NULL,
  refresh_token_hash BINARY(32) NOT NULL,
  refresh_expires_at DATETIME(3) NOT NULL,
  last_used_at DATETIME(3) NOT NULL,
  revoked_at DATETIME(3) NULL,
  UNIQUE KEY uq_access_hash (access_token_hash),
  UNIQUE KEY uq_refresh_hash (refresh_token_hash)
);
