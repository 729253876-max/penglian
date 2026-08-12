import type { ContentModerator, ModerationResult } from "../ports/content-moderator.js";

export interface TencentModerationClient {
  reviewPrivateAuditCopy(input: {
    sessionId: string;
    auditObjectKey: string;
  }): Promise<ModerationResult>;
}

export class TencentContentModerator implements ContentModerator {
  public constructor(private readonly client?: TencentModerationClient) {}

  public async review(input: {
    sessionId: string;
    auditObjectKey: string;
  }): Promise<ModerationResult> {
    if (!this.client) throw new Error("TENCENT_MODERATION_CREDENTIALS_NOT_APPROVED");
    return sanitize(await this.client.reviewPrivateAuditCopy(input));
  }
}

function sanitize(result: ModerationResult): ModerationResult {
  switch (result.outcome) {
    case "PASS": return { outcome: "PASS" };
    case "REJECT": return { outcome: "REJECT", publicReason: "CONTENT_UNSUPPORTED" };
    case "SUSPECTED": return { outcome: "SUSPECTED" };
    case "SERVICE_ERROR": return {
      outcome: "SERVICE_ERROR",
      retryable: result.retryable,
      code: normalizeCode(result.code)
    };
  }
}

function normalizeCode(code: string): string {
  return /^[A-Z][A-Z0-9_]{2,63}$/.test(code) ? code : "MODERATION_SERVICE_ERROR";
}
