import type { Clock } from "../domain/clock.js";
import { systemClock } from "../domain/clock.js";
import type { UploadState } from "@photo-ai/contracts";
import type {
  CreateUploadSessionRequest,
  UploadSessionService
} from "./upload-session-service.js";

interface UploadStatusRecord {
  sessionId: string;
  userId: string;
  state: UploadState;
  objectKey: string;
  expiresAt: Date;
  qualityWarning?: boolean;
  failureCode?: string;
}

export interface UploadApplicationRepository {
  findOwnedStatus(sessionId: string, userId: string): Promise<UploadStatusRecord | undefined>;
  cancelOwned(sessionId: string, userId: string, now: Date): Promise<void>;
}

export interface UploadAcceptanceService {
  acceptUploadedObject(input: {
    sessionId: string;
    userId: string;
    sourceObjectKey: string;
    expectedEtag: string;
    now: Date;
  }): Promise<void>;
}

type SessionIssuer = Pick<UploadSessionService, "createSession" | "reissueCredentials">;

export class UploadApplicationService {
  public constructor(
    private readonly sessions: SessionIssuer,
    private readonly acceptance: UploadAcceptanceService,
    private readonly repository: UploadApplicationRepository,
    private readonly clock: Clock = systemClock
  ) {}

  public async createSession(userId: string, input: CreateUploadSessionRequest) {
    const { session, credential } = await this.sessions.createSession(userId, input);
    return {
      sessionId: session.id,
      state: session.state,
      expiresAt: session.expiresAt.toISOString(),
      credentialExpiresAt: credential.expiresAt.toISOString(),
      upload: { url: credential.url, method: credential.method, headers: credential.headers }
    };
  }

  public async reissueCredentials(userId: string, sessionId: string) {
    const credential = await this.sessions.reissueCredentials(userId, sessionId);
    return { ...credential, expiresAt: credential.expiresAt.toISOString() };
  }

  public async completeUpload(userId: string, sessionId: string, etag: string) {
    const session = await this.requireOwned(sessionId, userId);
    if (session.state === "UPLOADED" || session.state === "NORMALIZING" || session.state === "REVIEWING" || session.state === "APPROVED") {
      return { sessionId, state: session.state };
    }
    if (session.state !== "INIT" && session.state !== "UPLOADING") {
      throw new Error("UPLOAD_STATE_CONFLICT");
    }
    const now = this.clock.now();
    if (session.expiresAt.getTime() <= now.getTime()) throw new Error("UPLOAD_SESSION_EXPIRED");
    await this.acceptance.acceptUploadedObject({
      sessionId, userId, sourceObjectKey: session.objectKey, expectedEtag: etag, now
    });
    return { sessionId, state: "UPLOADED" as const };
  }

  public async getStatus(userId: string, sessionId: string) {
    const session = await this.requireOwned(sessionId, userId);
    return {
      sessionId,
      state: session.state,
      ...(session.qualityWarning !== undefined ? { qualityWarning: session.qualityWarning } : {}),
      ...(session.failureCode !== undefined ? { failureCode: session.failureCode } : {})
    };
  }

  public async cancel(userId: string, sessionId: string): Promise<void> {
    await this.requireOwned(sessionId, userId);
    await this.repository.cancelOwned(sessionId, userId, this.clock.now());
  }

  private async requireOwned(sessionId: string, userId: string): Promise<UploadStatusRecord> {
    const record = await this.repository.findOwnedStatus(sessionId, userId);
    if (!record) throw new Error("UPLOAD_SESSION_NOT_FOUND");
    return record;
  }
}
