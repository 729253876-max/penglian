export type ModerationResult =
  | { outcome: "PASS" }
  | { outcome: "REJECT"; publicReason?: "CONTENT_UNSUPPORTED" }
  | { outcome: "SUSPECTED" }
  | { outcome: "SERVICE_ERROR"; retryable: boolean; code: string };

export interface ContentModerator {
  review(input: { sessionId: string; auditObjectKey: string }): Promise<ModerationResult>;
}
