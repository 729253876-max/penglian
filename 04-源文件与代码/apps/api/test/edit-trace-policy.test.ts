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
  copyKey: "portrait.plan.ready"
};

describe("edit trace policy", () => {
  it("accepts a permitted event and preserves its structured public payload", () => {
    const event = {
      ...baseEvent,
      payload: {
        direction: "NATURAL",
        brightnessDelta: 12,
        warmthDelta: -4,
        keepSkinTexture: true
      }
    };

    expect(sanitizeEditTraceEvent(event)).toEqual(event);
  });

  it("accepts stage and parameter direction events with public structured output", () => {
    const stageEvent = {
      ...baseEvent,
      eventId: "evt-2",
      sequence: 2,
      type: "STAGE_COMPLETED" as const,
      phase: "RETOUCH",
      copyKey: "portrait.stage.skin.completed",
      payload: { stage: "SKIN_RETOUCH", completed: true }
    };
    const parameterEvent = {
      ...baseEvent,
      eventId: "evt-3",
      sequence: 3,
      type: "PARAM_DIRECTION_APPLIED" as const,
      phase: "RETOUCH",
      copyKey: "portrait.parameter.brightness.applied",
      payload: { parameter: "brightness", direction: "increase", amount: 12 }
    };

    expect(sanitizeEditTraceEvent(stageEvent)).toEqual(stageEvent);
    expect(sanitizeEditTraceEvent(parameterEvent)).toEqual(parameterEvent);
  });

  it("rejects explicit hidden-reasoning and provider-secret payload fields", () => {
    expect(() => sanitizeEditTraceEvent({
      ...baseEvent,
      payload: { chainOfThought: "private deliberation" }
    })).toThrow("Forbidden EditTrace payload key: chainOfThought");

    expect(() => sanitizeEditTraceEvent({
      ...baseEvent,
      payload: { hiddenReasoning: "private deliberation" }
    })).toThrow(ZodError);

    expect(() => sanitizeEditTraceEvent({
      ...baseEvent,
      payload: { providerApiKey: "secret" }
    })).toThrow("Forbidden EditTrace payload key: providerApiKey");

    expect(() => sanitizeEditTraceEvent({
      ...baseEvent,
      payload: { providerSecret: "secret" }
    })).toThrow("Forbidden EditTrace payload key: providerSecret");

    expect(() => sanitizeEditTraceEvent({
      ...baseEvent,
      payload: { providerRawResponse: "unfiltered provider output" }
    })).toThrow("Forbidden EditTrace payload key: providerRawResponse");

    expect(() => sanitizeEditTraceEvent({
      ...baseEvent,
      payload: { internalRoute: "provider/internal" }
    })).toThrow("Forbidden EditTrace payload key: internalRoute");
  });

  it("does not reject normal public copy merely for discussing reasoning", () => {
    const event = {
      ...baseEvent,
      payload: {
        publicSummary: "已按你的修图方向完成参数调整，不展示内部 reasoning。"
      }
    };

    expect(sanitizeEditTraceEvent(event)).toEqual(event);
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
        payload: { [key]: "must-not-ship" }
      })).toThrow(`Forbidden EditTrace payload key: ${key}`);
    }
  });

  it("uses the contract default when a public trace omits payload", () => {
    expect(sanitizeEditTraceEvent(baseEvent as unknown as EditTraceEvent)).toEqual({
      ...baseEvent,
      payload: {}
    });
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
});
