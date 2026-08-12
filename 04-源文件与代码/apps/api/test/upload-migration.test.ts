import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  fileURLToPath(new URL("../migrations/002_upload_moderation.sql", import.meta.url)),
  "utf8"
);

describe("002 upload moderation migration", () => {
  it("persists all state required to recover API and worker processing", () => {
    for (const definition of [
      "file_name VARCHAR(255) NOT NULL",
      "declared_size_bytes BIGINT UNSIGNED NOT NULL",
      "consent_policy_version VARCHAR(64) NOT NULL",
      "etag VARCHAR(256) NULL",
      "quality_warning BOOLEAN NULL",
      "failure_code VARCHAR(64) NULL",
      "moderation_started_at DATETIME(3) NULL",
      "updated_at DATETIME(3) NOT NULL"
    ]) expect(migration).toContain(definition);
  });

  it("indexes owned upload reads and state recovery", () => {
    expect(migration).toContain("KEY ix_upload_owner (user_id, id)");
    expect(migration).toContain("KEY ix_upload_state (state, updated_at)");
  });
});
