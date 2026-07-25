import { describe, expect, it } from "vitest";
import {
  CreateTaskInputSchema,
  EditTraceEventSchema,
  TaskSnapshotSchema,
  ToolTypeSchema
} from "../src/index.js";
import type {
  CreateTaskInput,
  EditTraceEvent,
  TaskSnapshot,
  TaskStatus,
  ToolType
} from "../src/index.js";

const contractTypeWitness: [
  ToolType,
  TaskStatus,
  EditTraceEvent,
  CreateTaskInput,
  TaskSnapshot
] = [
  "PORTRAIT_RETOUCH",
  "AWAITING_CONFIRMATION",
  {
    eventId: "evt-type",
    taskId: "task-type",
    sequence: 1,
    type: "PLAN_READY",
    phase: "PLAN",
    occurredAt: "2026-07-26T00:00:00.000Z",
    visibility: "PREVIEW",
    copyKey: "trace.plan.ready",
    payload: {}
  },
  {
    tool: "PORTRAIT_RETOUCH",
    inputAssetId: "asset-type",
    direction: "NATURAL",
    parameters: { brightness: 0, warmth: 0, naturalness: 80 }
  },
  {
    taskId: "task-type",
    status: "AWAITING_CONFIRMATION",
    tool: "PORTRAIT_RETOUCH",
    lastSequence: 1
  }
];

void contractTypeWitness;

describe("task contracts", () => {
  it("accepts a faithful portrait task", () => {
    expect(CreateTaskInputSchema.parse({
      tool: "PORTRAIT_RETOUCH",
      inputAssetId: "demo-portrait-001",
      direction: "NATURAL",
      parameters: { brightness: 0, warmth: 0, naturalness: 80 }
    }).tool).toBe("PORTRAIT_RETOUCH");
  });

  it("rejects old-photo parameters attached to a portrait task", () => {
    expect(CreateTaskInputSchema.safeParse({
      tool: "PORTRAIT_RETOUCH",
      inputAssetId: "demo-portrait-001",
      direction: "NATURAL",
      parameters: {
        brightness: 0,
        warmth: 0,
        naturalness: 80,
        colorizationRequested: false
      }
    }).success).toBe(false);
  });

  it("rejects an unknown top-level task field", () => {
    expect(CreateTaskInputSchema.safeParse({
      tool: "QUALITY_ENHANCE",
      inputAssetId: "demo-quality-001",
      direction: "QUALITY_FIRST",
      parameters: { outputTier: "HD", detailPreservation: 85 },
      unexpectedDirective: "must-not-be-discarded"
    }).success).toBe(false);
  });

  it("accepts exactly the four V1 tools", () => {
    expect([
      "PORTRAIT_RETOUCH",
      "QUALITY_ENHANCE",
      "OBJECT_REMOVAL",
      "OLD_PHOTO_RESTORE"
    ].map((tool) => ToolTypeSchema.safeParse(tool).success)).toEqual([
      true,
      true,
      true,
      true
    ]);
    expect(ToolTypeSchema.safeParse("BACKGROUND_REPLACE").success).toBe(false);
  });

  it("defaults old-photo colorization to not requested and not confirmed", () => {
    expect(CreateTaskInputSchema.parse({
      tool: "OLD_PHOTO_RESTORE",
      inputAssetId: "demo-old-photo-001",
      direction: "FAITHFUL_RESTORE",
      parameters: {}
    }).parameters).toEqual({
      colorizationRequested: false,
      colorizationConfirmed: false
    });
  });

  it("requires explicit confirmation before old-photo colorization", () => {
    expect(() => CreateTaskInputSchema.parse({
      tool: "OLD_PHOTO_RESTORE",
      inputAssetId: "demo-old-photo-001",
      direction: "FAITHFUL_RESTORE",
      parameters: { colorizationRequested: true, colorizationConfirmed: false }
    })).toThrow();
  });

  it("rejects an old-photo confirmation without a colorization request", () => {
    expect(() => CreateTaskInputSchema.parse({
      tool: "OLD_PHOTO_RESTORE",
      inputAssetId: "demo-old-photo-001",
      direction: "FAITHFUL_RESTORE",
      parameters: { colorizationRequested: false, colorizationConfirmed: true }
    })).toThrow();
  });

  it("accepts explicitly requested and confirmed old-photo colorization", () => {
    expect(CreateTaskInputSchema.parse({
      tool: "OLD_PHOTO_RESTORE",
      inputAssetId: "demo-old-photo-001",
      direction: "FAITHFUL_RESTORE",
      parameters: { colorizationRequested: true, colorizationConfirmed: true }
    }).parameters).toEqual({
      colorizationRequested: true,
      colorizationConfirmed: true
    });
  });

  it("rejects an event without sequence", () => {
    expect(EditTraceEventSchema.safeParse({
      eventId: "evt-1",
      taskId: "task-1",
      type: "PLAN_READY",
      phase: "PLAN",
      occurredAt: "2026-07-26T00:00:00.000Z",
      visibility: "PREVIEW",
      copyKey: "trace.plan.ready"
    }).success).toBe(false);
  });

  it("rejects sensitive trace payload fields", () => {
    const baseEvent = {
      eventId: "evt-2",
      taskId: "task-1",
      sequence: 1,
      type: "PLAN_READY",
      phase: "PLAN",
      occurredAt: "2026-07-26T00:00:00.000Z",
      visibility: "PREVIEW",
      copyKey: "trace.plan.ready"
    };

    expect([
      "hiddenReasoning",
      "apiKey",
      "originalImageUrl"
    ].map((field) => EditTraceEventSchema.safeParse({
      ...baseEvent,
      payload: { [field]: "must-not-ship" }
    }).success)).toEqual([false, false, false]);
  });

  it("rejects normalized sensitive trace payload keys and sensitive event fields", () => {
    const baseEvent = {
      eventId: "evt-sensitive",
      taskId: "task-1",
      sequence: 1,
      type: "PLAN_READY",
      phase: "PLAN",
      occurredAt: "2026-07-26T00:00:00.000Z",
      visibility: "PREVIEW",
      copyKey: "trace.plan.ready"
    };

    expect([
      "originalUrl",
      "originalImageUrl",
      "original_url",
      "original_image_url",
      "apiKey",
      "api_key",
      "hiddenReasoning",
      "hidden_reasoning"
    ].map((key) => EditTraceEventSchema.safeParse({
      ...baseEvent,
      payload: { [key]: "must-not-ship" }
    }).success)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false
    ]);

    expect([
      "hiddenReasoning",
      "apiKey",
      "api_key"
    ].map((key) => EditTraceEventSchema.safeParse({
      ...baseEvent,
      [key]: "must-not-ship"
    }).success)).toEqual([false, false, false]);
  });

  it("accepts an awaiting confirmation snapshot", () => {
    expect(TaskSnapshotSchema.parse({
      taskId: "task-1",
      status: "AWAITING_CONFIRMATION",
      tool: "PORTRAIT_RETOUCH",
      lastSequence: 2
    }).status).toBe("AWAITING_CONFIRMATION");
  });

  it("accepts a quality enhancement task", () => {
    expect(CreateTaskInputSchema.parse({
      tool: "QUALITY_ENHANCE",
      inputAssetId: "demo-quality-001",
      direction: "QUALITY_FIRST",
      parameters: { outputTier: "HD", detailPreservation: 85 }
    }).tool).toBe("QUALITY_ENHANCE");
  });

  it("accepts an object removal task with a confirmed mask", () => {
    expect(CreateTaskInputSchema.parse({
      tool: "OBJECT_REMOVAL",
      inputAssetId: "demo-object-001",
      direction: "REMOVE_CONFIRMED_TARGET",
      parameters: { confirmedMaskAssetId: "mask-001" }
    }).tool).toBe("OBJECT_REMOVAL");
  });
});
