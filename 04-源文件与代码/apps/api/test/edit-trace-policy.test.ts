import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import type { EditTraceEvent } from "@photo-ai/contracts";
import { sanitizeEditTraceEvent } from "../src/domain/edit-trace-policy.js";

const baseEvent = {
  eventId: "evt-1",
  taskId: "task-1",
  sequence: 1,
  type: "PLAN_READY" as const,
  phase: "PLAN",
  occurredAt: "2026-07-24T00:00:00.000Z",
  visibility: "PREVIEW" as const,
  evidenceSource: "SYSTEM_CHECK" as const,
  copyKey: "portrait.plan.natural"
};

describe("edit trace policy", () => {
  it("accepts a permitted event and preserves only its event-specific public payload", () => {
    const event = {
      ...baseEvent,
      payload: { direction: "NATURAL_RESCUE" as const }
    };

    expect(sanitizeEditTraceEvent(event)).toEqual(event);
  });

  it("accepts stage and parameter events with their exact public DTOs", () => {
    const stageEvent = {
      ...baseEvent,
      eventId: "evt-2",
      sequence: 2,
      type: "STAGE_COMPLETED" as const,
      phase: "RETOUCH",
      evidenceSource: "PROVIDER_RECEIPT" as const,
      copyKey: "portrait.stage.retouch.completed",
      payload: { stage: "LOCAL_LIGHT_AND_SKIN" as const }
    };
    const parameterEvent = {
      ...baseEvent,
      eventId: "evt-3",
      sequence: 3,
      type: "PARAM_DIRECTION_APPLIED" as const,
      phase: "RETOUCH",
      evidenceSource: "PROVIDER_RECEIPT" as const,
      copyKey: "portrait.parameter.direction",
      payload: { direction: "NATURAL_RESCUE" as const, level: "MODERATE" as const }
    };

    expect(sanitizeEditTraceEvent(stageEvent)).toEqual(stageEvent);
    expect(sanitizeEditTraceEvent(parameterEvent)).toEqual(parameterEvent);
  });

  it("rejects explicit hidden-reasoning and provider-secret payload fields", () => {
    expect(() => sanitizeEditTraceEvent({
      ...baseEvent,
      payload: { chainOfThought: "private deliberation" }
    })).toThrow(ZodError);

    expect(() => sanitizeEditTraceEvent({
      ...baseEvent,
      payload: { hiddenReasoning: "private deliberation" }
    })).toThrow(ZodError);

    expect(() => sanitizeEditTraceEvent({
      ...baseEvent,
      payload: { providerApiKey: "secret" }
    })).toThrow(ZodError);

    expect(() => sanitizeEditTraceEvent({
      ...baseEvent,
      payload: { providerSecret: "secret" }
    })).toThrow(ZodError);

    expect(() => sanitizeEditTraceEvent({
      ...baseEvent,
      payload: { providerRawResponse: "unfiltered provider output" }
    })).toThrow(ZodError);

    expect(() => sanitizeEditTraceEvent({
      ...baseEvent,
      payload: { internalRoute: "provider/internal" }
    })).toThrow(ZodError);
  });

  it("does not reject normal public copy merely for discussing reasoning", () => {
    const event = {
      ...baseEvent,
      payload: {
        direction: "NATURAL_RESCUE",
        publicSummary: "已按你的修图方向完成参数调整，不展示内部 reasoning。"
      }
    };

    expect(() => sanitizeEditTraceEvent(
      event as unknown as EditTraceEvent
    )).toThrow(ZodError);
  });

  it("rejects normalized provider and internal sensitive payload keys", () => {
    for (const key of [
      "provider_api_key",
      "provider-api-key",
      "ProviderApiKey",
      "chain_of_thought",
      "provider_raw_response",
      "internal_route"
    ]) {
      expect(() => sanitizeEditTraceEvent({
        ...baseEvent,
        payload: { direction: "NATURAL_RESCUE", [key]: "must-not-ship" }
      } as unknown as EditTraceEvent)).toThrow(ZodError);
    }
  });

  it("rejects a missing payload instead of inventing an event-specific DTO", () => {
    expect(() => sanitizeEditTraceEvent(
      baseEvent as unknown as EditTraceEvent
    )).toThrow(ZodError);
  });

  it("rejects null payloads through the event contract", () => {
    expect(() => sanitizeEditTraceEvent({
      ...baseEvent,
      payload: null
    } as unknown as EditTraceEvent)).toThrow(ZodError);
  });

  it("rejects nested payload values through the strict scalar boundary", () => {
    expect(() => sanitizeEditTraceEvent({
      ...baseEvent,
      payload: { stage: { name: "SKIN_RETOUCH" } }
    } as unknown as EditTraceEvent)).toThrow(ZodError);
  });

  it.each([
    "accessToken",
    "authorization",
    "signedImageUrl",
    "providerModel",
    "moderationResult",
    "futureUnknownField"
  ])("rejects unknown PLAN_READY payload field %s by default", (key) => {
    expect(() => sanitizeEditTraceEvent({
      ...baseEvent,
      payload: {
        direction: "NATURAL_RESCUE",
        [key]: "must-not-ship"
      }
    } as unknown as EditTraceEvent)).toThrow(ZodError);
  });
});
