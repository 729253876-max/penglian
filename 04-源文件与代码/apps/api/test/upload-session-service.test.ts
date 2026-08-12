import { describe, expect, it } from "vitest";
import {
  UploadSessionService,
  type StoredUploadSession,
  type UploadSessionRepository
} from "../src/application/upload-session-service.js";

const now = new Date("2030-01-02T03:04:05.000Z");

class MemoryRepository implements UploadSessionRepository {
  public readonly sessions = new Map<string, StoredUploadSession>();
  public consentActive = true;

  public async hasActiveMetadataRemovalConsent(userId: string, version: string) {
    return this.consentActive && userId === "user-1" && version === "2026-08-02";
  }
  public async insert(session: StoredUploadSession) {
    this.sessions.set(session.id, structuredClone(session));
  }
  public async findOwned(sessionId: string, userId: string) {
    const session = this.sessions.get(sessionId);
    return session?.userId === userId ? structuredClone(session) : undefined;
  }
  public async recordCredentialIssue(sessionId: string, expectedCount: number) {
    const session = this.sessions.get(sessionId);
    if (!session || session.credentialIssueCount !== expectedCount) return false;
    session.credentialIssueCount += 1;
    return true;
  }
}

describe("upload session service", () => {
  it("creates a 30-minute owned session and 10-minute credential", async () => {
    const repository = new MemoryRepository();
    const issued: string[] = [];
    const service = new UploadSessionService(
      repository,
      { issueUploadCredential: async ({ objectKey }) => {
        issued.push(objectKey);
        return { url: "https://upload.example.test/object", method: "PUT", headers: {} };
      } },
      { now: () => new Date(now) },
      () => "session-1"
    );

    const result = await service.createSession("user-1", {
      fileName: "photo.jpg",
      sizeBytes: 1024,
      metadataRemovalConsentVersion: "2026-08-02"
    });

    expect(result.session.id).toBe("session-1");
    expect(result.session.objectKey).toBe("users/user-1/uploads/session-1/original");
    expect(result.session.credentialIssueCount).toBe(1);
    expect(repository.sessions.get("session-1")?.credentialIssueCount).toBe(1);
    expect(result.session.expiresAt.toISOString()).toBe("2030-01-02T03:34:05.000Z");
    expect(result.credential.expiresAt.toISOString()).toBe("2030-01-02T03:14:05.000Z");
    expect(issued).toEqual(["users/user-1/uploads/session-1/original"]);
  });

  it("does not count an initial credential that storage failed to issue", async () => {
    const repository = new MemoryRepository();
    const service = new UploadSessionService(
      repository,
      { issueUploadCredential: async () => { throw new Error("STORAGE_UNAVAILABLE"); } },
      { now: () => new Date(now) },
      () => "session-1"
    );

    await expect(service.createSession("user-1", {
      fileName: "photo.jpg",
      sizeBytes: 1024,
      metadataRemovalConsentVersion: "2026-08-02"
    })).rejects.toThrow("STORAGE_UNAVAILABLE");
    expect(repository.sessions.get("session-1")?.credentialIssueCount).toBe(0);
  });

  it("fails closed before storage when current consent is absent", async () => {
    const repository = new MemoryRepository();
    repository.consentActive = false;
    let calls = 0;
    const service = new UploadSessionService(
      repository,
      { issueUploadCredential: async () => { calls += 1; throw new Error("unexpected"); } },
      { now: () => new Date(now) }
    );

    await expect(service.createSession("user-1", {
      fileName: "photo.jpg",
      sizeBytes: 1024,
      metadataRemovalConsentVersion: "2026-08-02"
    })).rejects.toThrow("CONSENT_REQUIRED");
    expect(calls).toBe(0);
  });

  it("allows only one credential reissue while the session is active", async () => {
    const repository = new MemoryRepository();
    let clock = new Date(now);
    const service = new UploadSessionService(
      repository,
      { issueUploadCredential: async () => ({ url: "https://upload.example.test/object", method: "PUT", headers: {} }) },
      { now: () => new Date(clock) },
      () => "session-1"
    );
    await service.createSession("user-1", {
      fileName: "photo.png",
      sizeBytes: 1024,
      metadataRemovalConsentVersion: "2026-08-02"
    });

    await expect(service.reissueCredentials("user-1", "session-1")).resolves.toBeDefined();
    await expect(service.reissueCredentials("user-1", "session-1"))
      .rejects.toThrow("CREDENTIAL_REISSUE_LIMIT");
    clock = new Date("2030-01-02T03:34:05.000Z");
    await expect(service.reissueCredentials("user-1", "session-1"))
      .rejects.toThrow("UPLOAD_SESSION_EXPIRED");
  });
});
