import { describe, expect, it } from "vitest";
import { canTransition, transition } from "../src/domain/task-machine.js";

describe("task state machine", () => {
  it("allows every documented transition in the preview path", () => {
    expect(canTransition("REVIEWING", "DIAGNOSING")).toBe(true);
    expect(canTransition("REVIEWING", "REJECTED")).toBe(true);
    expect(canTransition("REVIEWING", "FAILED")).toBe(true);
    expect(canTransition("REVIEWING", "CANCELED")).toBe(true);
    expect(canTransition("DIAGNOSING", "AWAITING_CONFIRMATION")).toBe(true);
    expect(canTransition("DIAGNOSING", "FAILED")).toBe(true);
    expect(canTransition("AWAITING_CONFIRMATION", "QUEUED")).toBe(true);
    expect(canTransition("AWAITING_CONFIRMATION", "CANCELED")).toBe(true);
    expect(canTransition("QUEUED", "PROCESSING")).toBe(true);
    expect(canTransition("QUEUED", "FAILED")).toBe(true);
    expect(canTransition("QUEUED", "CANCELED")).toBe(true);
    expect(canTransition("PROCESSING", "QUALITY_CHECKING")).toBe(true);
    expect(canTransition("PROCESSING", "FAILED")).toBe(true);
    expect(canTransition("QUALITY_CHECKING", "PROCESSING")).toBe(true);
    expect(canTransition("QUALITY_CHECKING", "SUCCEEDED")).toBe(true);
    expect(canTransition("QUALITY_CHECKING", "FAILED")).toBe(true);
  });

  it("rejects illegal jumps and same-status requests", () => {
    expect(canTransition("REVIEWING", "PROCESSING")).toBe(false);
    expect(canTransition("PROCESSING", "PROCESSING")).toBe(false);
    expect(() => transition("REVIEWING", "PROCESSING"))
      .toThrow("Illegal task transition: REVIEWING -> PROCESSING");
  });

  it("does not allow terminal states to transition or return to processing", () => {
    for (const terminal of ["SUCCEEDED", "FAILED", "REJECTED", "CANCELED"] as const) {
      expect(canTransition(terminal, "PROCESSING")).toBe(false);
      expect(canTransition(terminal, terminal)).toBe(false);
      expect(() => transition(terminal, "PROCESSING"))
        .toThrow(`Illegal task transition: ${terminal} -> PROCESSING`);
    }
  });

  it("returns the target state for legal transitions", () => {
    expect(transition("QUALITY_CHECKING", "SUCCEEDED")).toBe("SUCCEEDED");
  });
});
