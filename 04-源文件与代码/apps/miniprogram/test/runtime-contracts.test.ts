import { describe, expect, it } from "vitest";
import {
  parseEditTraceEvent,
  parseTaskSnapshot
} from "../miniprogram/services/runtime-contracts.js";

const legalEvent = {
  eventId: "event-1",
  taskId: "task-1",
  sequence: 1,
  type: "ASSET_APPROVED",
  phase: "UPLOAD",
  occurredAt: "2030-01-02T03:04:05.000Z",
  visibility: "PREVIEW",
  evidenceSource: "SYSTEM_CHECK",
  copyKey: "upload.asset.approved",
  payload: { metadataRemoved: true }
};

describe("mini-program runtime contracts", () => {
  it("parses a legal truthful trace event", () => {
    expect(parseEditTraceEvent(legalEvent)).toEqual(legalEvent);
  });

  it("rejects a missing evidence source", () => {
    const { evidenceSource: _omitted, ...event } = legalEvent;
    expect(() => parseEditTraceEvent(event)).toThrow("API_RESPONSE_INVALID");
  });

  it("rejects unknown enum values and copy keys", () => {
    expect(() => parseEditTraceEvent({ ...legalEvent, phase: "INTERNAL" }))
      .toThrow("API_RESPONSE_INVALID");
    expect(() => parseEditTraceEvent({ ...legalEvent, copyKey: "upload.asset.secret" }))
      .toThrow("API_RESPONSE_INVALID");
  });

  it("rejects extra and sensitive event or payload fields", () => {
    expect(() => parseEditTraceEvent({ ...legalEvent, providerRawPayload: "secret" }))
      .toThrow("API_RESPONSE_INVALID");
    expect(() => parseEditTraceEvent({
      ...legalEvent,
      payload: { metadataRemoved: true, originalImageUrl: "https://secret.invalid" }
    })).toThrow("API_RESPONSE_INVALID");
  });

  it("strictly parses bounded portrait snapshots", () => {
    const snapshot = {
      taskId: "task-1",
      status: "FAILED",
      tool: "PORTRAIT_RETOUCH",
      lastSequence: 8,
      failureCode: "FIDELITY_GATE_FAILED",
      diagnosis: {
        findings: ["FACE_UNDEREXPOSED"],
        protections: ["IDENTITY", "COMPOSITION"]
      },
      selectedDirection: "NATURAL_RESCUE",
      noCharge: true
    };
    expect(parseTaskSnapshot(snapshot)).toEqual(snapshot);
    expect(() => parseTaskSnapshot({ ...snapshot, failureCode: "UNKNOWN" }))
      .toThrow("API_RESPONSE_INVALID");
    expect(() => parseTaskSnapshot({ ...snapshot, extra: true }))
      .toThrow("API_RESPONSE_INVALID");
  });
});
