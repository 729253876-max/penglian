import { describe, expect, it } from "vitest";
import { ModerationService } from "../src/application/moderation-service.js";
import { MockContentModerator, type MockModerationOutcome } from "../src/infrastructure/mock-content-moderator.js";

async function processSequence(sequence: MockModerationOutcome[]) {
  const transitions: unknown[] = [];
  const retries: unknown[] = [];
  const service = new ModerationService(new MockContentModerator(sequence), {
    recordTerminal: async (input) => { transitions.push(input); },
    scheduleRetry: async (input) => { retries.push(input); }
  });
  let attempt = 1;
  const startedAt = new Date("2030-01-02T03:04:05.000Z");
  let now = startedAt;
  while (attempt <= sequence.length) {
    const result = await service.process({
      sessionId: "session-1",
      auditObjectKey: "users/user-1/uploads/session-1/audit",
      attempt,
      startedAt,
      now
    });
    if (result.terminal) return { state: result.state, transitions, retries };
    now = result.nextRunAt;
    attempt += 1;
  }
  throw new Error("sequence did not terminate");
}

describe("moderation service", () => {
  it.each([
    [["PASS"], "APPROVED"],
    [["REJECT"], "REJECTED"],
    [["SUSPECTED", "PASS"], "APPROVED"],
    [["SUSPECTED", "SUSPECTED"], "REJECTED"],
    [["SERVICE_ERROR", "SERVICE_ERROR", "SERVICE_ERROR"], "FAILED"]
  ] as const)("maps %j to %s", async (sequence, state) => {
    expect((await processSequence([...sequence])).state).toBe(state);
  });

  it("bounds service retries to 30 seconds then 2 minutes", async () => {
    const result = await processSequence(["SERVICE_ERROR", "SERVICE_ERROR", "SERVICE_ERROR"]);
    expect(result.retries).toEqual([
      expect.objectContaining({ attempt: 1, delayMs: 30_000, nextRunAt: new Date("2030-01-02T03:04:35.000Z") }),
      expect.objectContaining({ attempt: 2, delayMs: 120_000, nextRunAt: new Date("2030-01-02T03:06:35.000Z") })
    ]);
    expect(result.transitions).toEqual([expect.objectContaining({
      nextState: "FAILED",
      outcome: "SERVICE_ERROR",
      publicReason: "SAFETY_CHECK_UNAVAILABLE"
    })]);
  });

  it("fails closed instead of scheduling beyond the five-minute deadline", async () => {
    const terminals: unknown[] = [];
    let retryCalls = 0;
    const service = new ModerationService(new MockContentModerator(["SERVICE_ERROR"]), {
      recordTerminal: async (input) => { terminals.push(input); },
      scheduleRetry: async () => { retryCalls += 1; }
    });

    const result = await service.process({
      sessionId: "session-1",
      auditObjectKey: "users/user-1/uploads/session-1/audit",
      attempt: 2,
      startedAt: new Date("2030-01-02T03:04:05.000Z"),
      now: new Date("2030-01-02T03:08:30.001Z")
    });

    expect(result).toEqual({ terminal: true, state: "FAILED" });
    expect(retryCalls).toBe(0);
    expect(terminals).toEqual([expect.objectContaining({
      outcome: "SERVICE_ERROR",
      nextState: "FAILED",
      publicReason: "SAFETY_CHECK_UNAVAILABLE"
    })]);
  });
});
