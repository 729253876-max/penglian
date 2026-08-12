import { describe, expect, it } from "vitest";
import { MockContentModerator } from "../src/infrastructure/mock-content-moderator.js";

describe("content moderator contract", () => {
  it.each(["PASS", "REJECT", "SUSPECTED"] as const)(
    "returns only the normalized %s outcome",
    async (outcome) => {
      const result = await new MockContentModerator([outcome]).review({
        sessionId: "session-1",
        auditObjectKey: "users/user-1/uploads/session-1/audit"
      });
      expect(result.outcome).toBe(outcome);
      expect(JSON.stringify(result)).not.toContain("confidence");
      expect(JSON.stringify(result)).not.toContain("http");
    }
  );

  it("normalizes provider outages without exposing provider response data", async () => {
    const result = await new MockContentModerator(["SERVICE_ERROR"]).review({
      sessionId: "session-1",
      auditObjectKey: "users/user-1/uploads/session-1/audit"
    });
    expect(result).toEqual({ outcome: "SERVICE_ERROR", retryable: true, code: "MODERATION_SERVICE_ERROR" });
  });
});
