import type { ContentModerator, ModerationResult } from "../ports/content-moderator.js";

export type MockModerationOutcome = "PASS" | "REJECT" | "SUSPECTED" | "SERVICE_ERROR";

export class MockContentModerator implements ContentModerator {
  private index = 0;

  public constructor(private readonly outcomes: MockModerationOutcome[]) {}

  public async review(_input: {
    sessionId: string;
    auditObjectKey: string;
  }): Promise<ModerationResult> {
    const outcome = this.outcomes[this.index++];
    if (!outcome) throw new Error("MOCK_MODERATION_SEQUENCE_EXHAUSTED");
    switch (outcome) {
      case "PASS": return { outcome };
      case "REJECT": return { outcome, publicReason: "CONTENT_UNSUPPORTED" };
      case "SUSPECTED": return { outcome };
      case "SERVICE_ERROR": return { outcome, retryable: true, code: "MODERATION_SERVICE_ERROR" };
    }
  }
}
