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
    evidenceSource: "SYSTEM_CHECK",
    copyKey: "portrait.plan.natural",
    payload: { direction: "NATURAL_RESCUE" }
  },
  {
    tool: "PORTRAIT_RETOUCH",
    inputAssetId: "asset-type",
    direction: "NATURAL_RESCUE",
    parameters: { naturalness: 85, detailLevel: 35 }
  },
  {
    taskId: "task-type",
    status: "AWAITING_CONFIRMATION",
    tool: "PORTRAIT_RETOUCH",
    lastSequence: 1
  }
];

void contractTypeWitness;

const strictPortraitInput: CreateTaskInput = {
  tool: "PORTRAIT_RETOUCH",
  inputAssetId: "asset-strict",
  // @ts-expect-error legacy Stage-A directions are not public contract values
  direction: "NATURAL",
  parameters: { naturalness: 85, detailLevel: 35 }
};

// @ts-expect-error every public trace event requires evidenceSource
const traceWithoutEvidence: EditTraceEvent = {
  eventId: "evt-missing-evidence",
  taskId: "task-type",
  sequence: 1,
  type: "PLAN_READY",
  phase: "PLAN",
  occurredAt: "2026-07-26T00:00:00.000Z",
  visibility: "PREVIEW",
  copyKey: "portrait.plan.natural",
  payload: { direction: "NATURAL_RESCUE" }
};

const traceWithLegacyCopyKey: EditTraceEvent = {
  eventId: "evt-legacy-copy",
  taskId: "task-type",
  sequence: 1,
  type: "QUALITY_CHECK_PASSED",
  phase: "QUALITY",
  occurredAt: "2026-07-26T00:00:00.000Z",
  visibility: "PREVIEW",
  evidenceSource: "QUALITY_GATE",
  // @ts-expect-error old copy keys are not public contract values
  copyKey: "quality.identity.passed",
  payload: { checks: ["IDENTITY"] }
};

const traceWithArbitraryPayload: EditTraceEvent = {
  eventId: "evt-arbitrary-payload",
  taskId: "task-type",
  sequence: 1,
  type: "PLAN_READY",
  phase: "PLAN",
  occurredAt: "2026-07-26T00:00:00.000Z",
  visibility: "PREVIEW",
  evidenceSource: "SYSTEM_CHECK",
  copyKey: "portrait.plan.natural",
  // @ts-expect-error arbitrary payload fields are not public contract values
  payload: { hiddenReasoning: "must-not-ship" }
};

void strictPortraitInput;
void traceWithoutEvidence;
void traceWithLegacyCopyKey;
void traceWithArbitraryPayload;

const schemaOutputMatchesPublicType: EditTraceEvent = EditTraceEventSchema.parse(
  contractTypeWitness[2]
);
const createInputOutputMatchesPublicType: CreateTaskInput = CreateTaskInputSchema.parse(
  contractTypeWitness[3]
);

void schemaOutputMatchesPublicType;
void createInputOutputMatchesPublicType;

const traceWithMismatchedDiscriminants: EditTraceEvent = {
  eventId: "evt-mismatched-discriminants",
  taskId: "task-type",
  sequence: 1,
  type: "PLAN_READY",
  phase: "PLAN",
  occurredAt: "2026-07-26T00:00:00.000Z",
  visibility: "PREVIEW",
  evidenceSource: "QUALITY_GATE",
  copyKey: "quality.fidelity.passed",
  // @ts-expect-error PLAN_READY must use its plan copy key, system evidence, and direction payload
  payload: { checks: ["IDENTITY"] }
};

void traceWithMismatchedDiscriminants;

describe("task contracts", () => {
  it("binds each plan direction to its own truthful copy key", () => {
    const base = {
      eventId: "evt-plan-direction",
      taskId: "task-1",
      sequence: 1,
      type: "PLAN_READY",
      phase: "PLAN",
      occurredAt: "2026-07-26T00:00:00.000Z",
      visibility: "PREVIEW",
      evidenceSource: "SYSTEM_CHECK"
    };

    expect(EditTraceEventSchema.safeParse({
      ...base,
      copyKey: "portrait.plan.clear",
      payload: { direction: "CLEAR_RESCUE" }
    }).success).toBe(true);
    expect(EditTraceEventSchema.safeParse({
      ...base,
      copyKey: "portrait.plan.natural",
      payload: { direction: "CLEAR_RESCUE" }
    }).success).toBe(false);
    expect(EditTraceEventSchema.safeParse({
      ...base,
      copyKey: "portrait.plan.clear",
      payload: { direction: "NATURAL_RESCUE" }
    }).success).toBe(false);
  });

  it("accepts a faithful portrait task", () => {
    expect(CreateTaskInputSchema.parse({
      tool: "PORTRAIT_RETOUCH",
      inputAssetId: "demo-portrait-001",
      direction: "NATURAL_RESCUE",
      parameters: { naturalness: 85, detailLevel: 35 }
    }).tool).toBe("PORTRAIT_RETOUCH");
  });

  it("rejects old-photo parameters attached to a portrait task", () => {
    expect(CreateTaskInputSchema.safeParse({
      tool: "PORTRAIT_RETOUCH",
      inputAssetId: "demo-portrait-001",
      direction: "NATURAL_RESCUE",
      parameters: {
        naturalness: 85,
        detailLevel: 35,
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
      evidenceSource: "SYSTEM_CHECK",
      copyKey: "portrait.plan.natural",
      payload: { direction: "NATURAL_RESCUE" }
    }).success).toBe(false);
  });

  it("enforces a strict payload allowlist for each event kind", () => {
    const baseEvent = {
      eventId: "evt-2",
      taskId: "task-1",
      sequence: 1,
      type: "PLAN_READY",
      phase: "PLAN",
      occurredAt: "2026-07-26T00:00:00.000Z",
      visibility: "PREVIEW",
      evidenceSource: "SYSTEM_CHECK",
      copyKey: "portrait.plan.natural"
    };

    expect([
      { direction: "NATURAL_RESCUE", accessToken: "must-not-ship" },
      { direction: "NATURAL_RESCUE", authorization: "must-not-ship" },
      { direction: "NATURAL_RESCUE", signedImageUrl: "https://secret.invalid/signed" },
      { direction: "NATURAL_RESCUE", providerModel: "internal-model-route" },
      { direction: "NATURAL_RESCUE", moderationResult: "sensitive-review-output" },
      { direction: "NATURAL_RESCUE", futureUnknownField: "must-default-to-reject" },
      { finding: "FACE_UNDEREXPOSED" }
    ].map((payload) => EditTraceEventSchema.safeParse({
      ...baseEvent,
      payload
    }).success)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
      false
    ]);

    expect(EditTraceEventSchema.safeParse({
      ...baseEvent,
      payload: { direction: "NATURAL_RESCUE" }
    }).success).toBe(true);
    expect(EditTraceEventSchema.safeParse({
      ...baseEvent,
      type: "DIAGNOSIS_FINDING",
      phase: "DIAGNOSIS",
      copyKey: "portrait.diagnosis.light",
      payload: { finding: "FACE_UNDEREXPOSED" }
    }).success).toBe(true);
  });

  it("rejects sensitive trace payload fields", () => {
    const baseEvent = {
      eventId: "evt-sensitive-payload",
      taskId: "task-1",
      sequence: 1,
      type: "PLAN_READY",
      phase: "PLAN",
      occurredAt: "2026-07-26T00:00:00.000Z",
      visibility: "PREVIEW",
      evidenceSource: "SYSTEM_CHECK",
      copyKey: "portrait.plan.natural"
    };

    expect([
      "hiddenReasoning",
      "apiKey",
      "originalImageUrl"
    ].map((field) => EditTraceEventSchema.safeParse({
      ...baseEvent,
      payload: { direction: "NATURAL_RESCUE", [field]: "must-not-ship" }
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
      evidenceSource: "SYSTEM_CHECK",
      copyKey: "portrait.plan.natural"
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
      payload: { direction: "NATURAL_RESCUE", [key]: "must-not-ship" }
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

  it("accepts both bounded portrait rescue directions", () => {
    for (const direction of ["NATURAL_RESCUE", "CLEAR_RESCUE"] as const) {
      expect(CreateTaskInputSchema.parse({
        tool: "PORTRAIT_RETOUCH",
        inputAssetId: "11111111-1111-4111-8111-111111111111",
        direction,
        parameters: {
          naturalness: direction === "NATURAL_RESCUE" ? 85 : 75,
          detailLevel: direction === "NATURAL_RESCUE" ? 35 : 60
        }
      }).direction).toBe(direction);
    }
  });

  it("requires a truthful evidence source on every trace event", () => {
    expect(EditTraceEventSchema.parse({
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
    }).evidenceSource).toBe("SYSTEM_CHECK");
  });

  it.each([
    ["FACE_COUNT", ["IDENTITY", "STRUCTURE", "NON_TARGET_REGION", "ARTIFACTS"]],
    ["IDENTITY", ["FACE_COUNT", "STRUCTURE", "NON_TARGET_REGION", "ARTIFACTS"]],
    ["STRUCTURE", ["FACE_COUNT", "IDENTITY", "NON_TARGET_REGION", "ARTIFACTS"]],
    ["NON_TARGET_REGION", ["FACE_COUNT", "IDENTITY", "STRUCTURE", "ARTIFACTS"]],
    ["ARTIFACTS", ["FACE_COUNT", "IDENTITY", "STRUCTURE", "NON_TARGET_REGION"]],
    ["a duplicate", ["FACE_COUNT", "IDENTITY", "STRUCTURE", "ARTIFACTS", "ARTIFACTS"]],
    ["an invalid check", ["FACE_COUNT", "IDENTITY", "STRUCTURE", "NON_TARGET_REGION", "UNKNOWN"]]
  ])("rejects an incomplete, duplicate, or invalid passed quality set: %s", (_name, checks) => {
    expect(EditTraceEventSchema.safeParse({
      eventId: "event-quality-passed",
      taskId: "task-1",
      sequence: 1,
      type: "QUALITY_CHECK_PASSED",
      phase: "QUALITY",
      occurredAt: "2030-01-02T03:04:05.000Z",
      visibility: "PREVIEW",
      evidenceSource: "QUALITY_GATE",
      copyKey: "quality.fidelity.passed",
      payload: { checks }
    }).success).toBe(false);
  });

  it("accepts a passed quality event with the complete frozen set in a different order", () => {
    expect(EditTraceEventSchema.safeParse({
      eventId: "event-quality-passed",
      taskId: "task-1",
      sequence: 1,
      type: "QUALITY_CHECK_PASSED",
      phase: "QUALITY",
      occurredAt: "2030-01-02T03:04:05.000Z",
      visibility: "PREVIEW",
      evidenceSource: "QUALITY_GATE",
      copyKey: "quality.fidelity.passed",
      payload: {
        checks: ["ARTIFACTS", "NON_TARGET_REGION", "STRUCTURE", "IDENTITY", "FACE_COUNT"]
      }
    }).success).toBe(true);
  });

  it("rejects provider-owned quality or delivery claims", () => {
    for (const event of [
      {
        type: "QUALITY_CHECK_PASSED",
        phase: "QUALITY",
        copyKey: "quality.fidelity.passed",
        payload: { checks: ["FACE_COUNT", "IDENTITY", "STRUCTURE", "ARTIFACTS"] }
      },
      {
        type: "QUALITY_CHECK_FAILED",
        phase: "QUALITY",
        copyKey: "quality.fidelity.failed",
        payload: {
          checks: ["FACE_COUNT", "IDENTITY", "STRUCTURE", "ARTIFACTS"],
          failedChecks: ["IDENTITY"]
        }
      },
      {
        type: "PREVIEW_READY",
        phase: "DELIVERY",
        copyKey: "preview.ready",
        payload: { watermarked: true, downloadable: false }
      }
    ]) {
      expect(EditTraceEventSchema.safeParse({
        eventId: "event-2",
        taskId: "task-1",
        sequence: 2,
        occurredAt: "2030-01-02T03:04:06.000Z",
        visibility: "PREVIEW",
        evidenceSource: "PROVIDER_RECEIPT",
        ...event
      }).success).toBe(false);
    }
  });

  it("accepts bounded diagnosis and no-charge failure snapshots", () => {
    expect(TaskSnapshotSchema.parse({
      taskId: "task-2",
      status: "FAILED",
      tool: "PORTRAIT_RETOUCH",
      lastSequence: 9,
      failureCode: "FIDELITY_GATE_FAILED",
      diagnosis: {
        findings: ["FACE_UNDEREXPOSED", "LIGHT_NOISE"],
        protections: ["IDENTITY", "FACIAL_STRUCTURE", "HAIR", "CLOTHING", "POSE", "SUBJECT_COUNT", "COMPOSITION"]
      },
      selectedDirection: "CLEAR_RESCUE",
      noCharge: true
    })).toMatchObject({ noCharge: true, selectedDirection: "CLEAR_RESCUE" });
  });

  it.each([
    ["PREVIEW_PROVIDER_FAILED", "QUALITY_GATE"],
    ["FIDELITY_GATE_FAILED", "SYSTEM_CHECK"],
    ["PORTRAIT_NOT_SUITABLE", "SYSTEM_CHECK"],
    ["ASSET_NOT_APPROVED", "SYSTEM_CHECK"]
  ])("rejects TASK_FAILED code %s from the wrong or non-terminal authority %s", (code, evidenceSource) => {
    expect(EditTraceEventSchema.safeParse({
      eventId: "event-failed",
      taskId: "task-1",
      sequence: 9,
      occurredAt: "2030-01-02T03:04:06.000Z",
      visibility: "PREVIEW",
      type: "TASK_FAILED",
      phase: "DELIVERY",
      evidenceSource,
      copyKey: "preview.provider.failed",
      payload: { code }
    }).success).toBe(false);
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
