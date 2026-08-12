import { randomUUID } from "node:crypto";
import { systemClock, type Clock } from "../domain/clock.js";
import { uploadPolicy, validateUploadHeader } from "../domain/upload-policy.js";
import type { ObjectStorage, UploadCredential } from "../ports/object-storage.js";

const approvedConsentPolicyVersion = "2026-08-02";

export interface CreateUploadSessionRequest {
  fileName: string;
  sizeBytes: number;
  metadataRemovalConsentVersion: string;
}

export interface StoredUploadSession {
  id: string;
  userId: string;
  state: "INIT";
  objectKey: string;
  fileName: string;
  declaredSizeBytes: number;
  consentPolicyVersion: string;
  credentialIssueCount: number;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface UploadSessionRepository {
  hasActiveMetadataRemovalConsent(userId: string, version: string): Promise<boolean>;
  insert(session: StoredUploadSession): Promise<void>;
  findOwned(sessionId: string, userId: string): Promise<StoredUploadSession | undefined>;
  recordCredentialIssue(sessionId: string, expectedCount: number): Promise<boolean>;
}

export interface IssuedUploadCredential extends UploadCredential {
  expiresAt: Date;
}

type IdGenerator = () => string;

export class UploadSessionService {
  public constructor(
    private readonly repository: UploadSessionRepository,
    private readonly credentialIssuer: Pick<ObjectStorage, "issueUploadCredential">,
    private readonly clock: Clock = systemClock,
    private readonly idGenerator: IdGenerator = randomUUID
  ) {}

  public async createSession(
    userId: string,
    input: CreateUploadSessionRequest
  ): Promise<{ session: StoredUploadSession; credential: IssuedUploadCredential }> {
    if (input.metadataRemovalConsentVersion !== approvedConsentPolicyVersion) {
      throw new Error("INVALID_UPLOAD_INPUT");
    }
    validateUploadHeader(input);
    if (!await this.repository.hasActiveMetadataRemovalConsent(
      userId,
      approvedConsentPolicyVersion
    )) {
      throw new Error("CONSENT_REQUIRED");
    }

    const now = this.clock.now();
    const sessionId = this.idGenerator();
    const objectKey = `users/${userId}/uploads/${sessionId}/original`;
    const session: StoredUploadSession = {
      id: sessionId,
      userId,
      state: "INIT",
      objectKey,
      fileName: input.fileName,
      declaredSizeBytes: input.sizeBytes,
      consentPolicyVersion: input.metadataRemovalConsentVersion,
      credentialIssueCount: 0,
      expiresAt: new Date(now.getTime() + uploadPolicy.sessionTtlMs),
      createdAt: new Date(now),
      updatedAt: new Date(now)
    };
    await this.repository.insert(session);
    const credential = await this.issueCredential(userId, sessionId, objectKey, now);
    if (!await this.repository.recordCredentialIssue(sessionId, 0)) {
      throw new Error("CREDENTIAL_ISSUE_RECORD_FAILED");
    }
    return { session: { ...session, credentialIssueCount: 1 }, credential };
  }

  public async reissueCredentials(
    userId: string,
    sessionId: string
  ): Promise<IssuedUploadCredential> {
    const session = await this.repository.findOwned(sessionId, userId);
    if (!session) {
      throw new Error("UPLOAD_SESSION_NOT_FOUND");
    }
    const now = this.clock.now();
    if (session.expiresAt.getTime() <= now.getTime()) {
      throw new Error("UPLOAD_SESSION_EXPIRED");
    }
    if (session.credentialIssueCount >= uploadPolicy.maxCredentialIssues) {
      throw new Error("CREDENTIAL_REISSUE_LIMIT");
    }
    const recorded = await this.repository.recordCredentialIssue(
      session.id,
      session.credentialIssueCount
    );
    if (!recorded) {
      throw new Error("CREDENTIAL_REISSUE_LIMIT");
    }
    return this.issueCredential(userId, session.id, session.objectKey, now);
  }

  private async issueCredential(
    userId: string,
    sessionId: string,
    objectKey: string,
    now: Date
  ): Promise<IssuedUploadCredential> {
    const target = await this.credentialIssuer.issueUploadCredential({
      userId,
      sessionId,
      objectKey,
      expiresInSeconds: uploadPolicy.credentialTtlSeconds as 600
    });
    return {
      ...target,
      expiresAt: new Date(now.getTime() + uploadPolicy.credentialTtlSeconds * 1_000)
    };
  }
}
