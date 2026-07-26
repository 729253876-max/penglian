import { z } from "zod";

export const ToolTypeSchema = z.enum([
  "PORTRAIT_RETOUCH",
  "QUALITY_ENHANCE",
  "OBJECT_REMOVAL",
  "OLD_PHOTO_RESTORE"
]);

export const TaskStatusSchema = z.enum([
  "REVIEWING",
  "DIAGNOSING",
  "AWAITING_CONFIRMATION",
  "QUEUED",
  "PROCESSING",
  "QUALITY_CHECKING",
  "SUCCEEDED",
  "FAILED",
  "REJECTED",
  "CANCELED"
]);

export const EditTraceEventTypeSchema = z.enum([
  "DIAGNOSIS_STARTED",
  "DIAGNOSIS_FINDING",
  "PLAN_READY",
  "STAGE_STARTED",
  "STAGE_COMPLETED",
  "PARAM_DIRECTION_APPLIED",
  "QUALITY_CHECK_STARTED",
  "QUALITY_CHECK_PASSED",
  "QUALITY_CHECK_FAILED",
  "RETRY_STARTED",
  "PREVIEW_READY",
  "TASK_FAILED"
]);

export const EditTraceVisibilitySchema = z.enum(["PREVIEW", "UNLOCKED"]);
export const PortraitDirectionSchema = z.enum(["NATURAL", "BRIGHT", "WARM"]);

export const EditTracePhaseSchema = z.enum([
  "DIAGNOSIS",
  "PLAN",
  "RETOUCH",
  "QUALITY",
  "DELIVERY"
]);

export const EditTraceCopyKeySchema = z.enum([
  "portrait.diagnosis.started",
  "portrait.diagnosis.light",
  "portrait.plan.natural",
  "portrait.stage.retouch.started",
  "portrait.parameter.direction",
  "portrait.stage.retouch.completed",
  "quality.started",
  "quality.identity.failed",
  "portrait.retry.started",
  "portrait.stage.retry.started",
  "quality.retry.started",
  "quality.identity.passed",
  "preview.ready",
  "preview.provider.failed"
]);

const EmptyEditTracePayloadSchema = z.object({}).strict();
const DiagnosisFindingPayloadSchema = z.object({
  finding: z.literal("FACE_SHADOW_AND_BACKGROUND_HIGHLIGHT")
}).strict();
const PlanReadyPayloadSchema = z.object({
  direction: PortraitDirectionSchema
}).strict();
const StagePayloadSchema = z.object({
  stage: z.literal("LOCAL_LIGHT_AND_SKIN").optional()
}).strict();
const ParameterDirectionPayloadSchema = z.object({
  direction: PortraitDirectionSchema,
  level: z.literal("MODERATE")
}).strict();
const QualityCheckPassedPayloadSchema = z.object({
  check: z.literal("IDENTITY_CONSISTENCY").optional()
}).strict();
const QualityCheckFailedPayloadSchema = z.object({
  check: z.literal("IDENTITY_CONSISTENCY").optional(),
  code: z.literal("IDENTITY_CHECK_FAILED").optional()
}).strict();
const RetryStartedPayloadSchema = z.object({
  attempt: z.number().int().positive().max(10)
}).strict();
const PreviewReadyPayloadSchema = z.object({
  watermarked: z.literal(true),
  downloadable: z.literal(false)
}).strict();
const TaskFailedPayloadSchema = z.object({
  code: z.literal("PREVIEW_PROVIDER_FAILED")
}).strict();

const EditTracePayloadSchema = z.union([
  EmptyEditTracePayloadSchema,
  DiagnosisFindingPayloadSchema,
  PlanReadyPayloadSchema,
  StagePayloadSchema,
  ParameterDirectionPayloadSchema,
  QualityCheckPassedPayloadSchema,
  QualityCheckFailedPayloadSchema,
  RetryStartedPayloadSchema,
  PreviewReadyPayloadSchema,
  TaskFailedPayloadSchema
]);

const editTraceRules = {
  DIAGNOSIS_STARTED: {
    phase: "DIAGNOSIS",
    copyKeys: ["portrait.diagnosis.started"],
    payload: EmptyEditTracePayloadSchema
  },
  DIAGNOSIS_FINDING: {
    phase: "DIAGNOSIS",
    copyKeys: ["portrait.diagnosis.light"],
    payload: DiagnosisFindingPayloadSchema
  },
  PLAN_READY: {
    phase: "PLAN",
    copyKeys: ["portrait.plan.natural"],
    payload: PlanReadyPayloadSchema
  },
  STAGE_STARTED: {
    phase: "RETOUCH",
    copyKeys: [
      "portrait.stage.retouch.started",
      "portrait.stage.retry.started"
    ],
    payload: StagePayloadSchema
  },
  STAGE_COMPLETED: {
    phase: "RETOUCH",
    copyKeys: ["portrait.stage.retouch.completed"],
    payload: StagePayloadSchema
  },
  PARAM_DIRECTION_APPLIED: {
    phase: "RETOUCH",
    copyKeys: ["portrait.parameter.direction"],
    payload: ParameterDirectionPayloadSchema
  },
  QUALITY_CHECK_STARTED: {
    phase: "QUALITY",
    copyKeys: ["quality.started", "quality.retry.started"],
    payload: EmptyEditTracePayloadSchema
  },
  QUALITY_CHECK_PASSED: {
    phase: "QUALITY",
    copyKeys: ["quality.identity.passed"],
    payload: QualityCheckPassedPayloadSchema
  },
  QUALITY_CHECK_FAILED: {
    phase: "QUALITY",
    copyKeys: ["quality.identity.failed"],
    payload: QualityCheckFailedPayloadSchema
  },
  RETRY_STARTED: {
    phase: "RETOUCH",
    copyKeys: ["portrait.retry.started"],
    payload: RetryStartedPayloadSchema
  },
  PREVIEW_READY: {
    phase: "DELIVERY",
    copyKeys: ["preview.ready"],
    payload: PreviewReadyPayloadSchema
  },
  TASK_FAILED: {
    phase: "DELIVERY",
    copyKeys: ["preview.provider.failed"],
    payload: TaskFailedPayloadSchema
  }
} satisfies Record<
  z.infer<typeof EditTraceEventTypeSchema>,
  {
    phase: z.infer<typeof EditTracePhaseSchema>;
    copyKeys: readonly z.infer<typeof EditTraceCopyKeySchema>[];
    payload: z.ZodType;
  }
>;

export const EditTraceEventSchema = z.object({
  eventId: z.string().min(1),
  taskId: z.string().min(1),
  sequence: z.number().int().positive(),
  type: EditTraceEventTypeSchema,
  phase: EditTracePhaseSchema,
  occurredAt: z.string().datetime(),
  visibility: EditTraceVisibilitySchema,
  copyKey: EditTraceCopyKeySchema,
  payload: EditTracePayloadSchema
}).strict().superRefine((event, context) => {
  const rule = editTraceRules[event.type];
  if (event.phase !== rule.phase) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["phase"],
      message: `Invalid phase for ${event.type}`
    });
  }
  if (!(rule.copyKeys as readonly string[]).includes(event.copyKey)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["copyKey"],
      message: `Invalid copy key for ${event.type}`
    });
  }

  const payloadResult = rule.payload.safeParse(event.payload);
  if (!payloadResult.success) {
    for (const issue of payloadResult.error.issues) {
      context.addIssue({
        ...issue,
        path: ["payload", ...issue.path]
      });
    }
  }
});

const PortraitTaskInputSchema = z.object({
  tool: z.literal("PORTRAIT_RETOUCH"),
  inputAssetId: z.string().min(1),
  direction: PortraitDirectionSchema,
  parameters: z.object({
    brightness: z.number().min(-100).max(100),
    warmth: z.number().min(-100).max(100),
    naturalness: z.number().min(0).max(100)
  }).strict()
}).strict();

const QualityEnhanceTaskInputSchema = z.object({
  tool: z.literal("QUALITY_ENHANCE"),
  inputAssetId: z.string().min(1),
  direction: z.literal("QUALITY_FIRST"),
  parameters: z.object({
    outputTier: z.string().min(1),
    detailPreservation: z.number().min(0).max(100)
  }).strict()
}).strict();

const ObjectRemovalTaskInputSchema = z.object({
  tool: z.literal("OBJECT_REMOVAL"),
  inputAssetId: z.string().min(1),
  direction: z.literal("REMOVE_CONFIRMED_TARGET"),
  parameters: z.object({
    confirmedMaskAssetId: z.string().min(1)
  }).strict()
}).strict();

const OldPhotoRestoreTaskInputSchema = z.object({
  tool: z.literal("OLD_PHOTO_RESTORE"),
  inputAssetId: z.string().min(1),
  direction: z.literal("FAITHFUL_RESTORE"),
  parameters: z.object({
    colorizationRequested: z.boolean().default(false),
    colorizationConfirmed: z.boolean().default(false)
  }).strict()
}).strict();

export const CreateTaskInputSchema = z.discriminatedUnion("tool", [
  PortraitTaskInputSchema,
  QualityEnhanceTaskInputSchema,
  ObjectRemovalTaskInputSchema,
  OldPhotoRestoreTaskInputSchema
]).superRefine((input, context) => {
  if (
    input.tool === "OLD_PHOTO_RESTORE" &&
    input.parameters.colorizationRequested !== input.parameters.colorizationConfirmed
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["parameters"],
      message: "Colorization request and explicit confirmation must be consistent"
    });
  }
});

export const TaskSnapshotSchema = z.object({
  taskId: z.string().min(1),
  status: TaskStatusSchema,
  tool: ToolTypeSchema,
  lastSequence: z.number().int().nonnegative(),
  previewUrl: z.string().url().optional(),
  failureCode: z.string().optional()
});

export type ToolType = z.infer<typeof ToolTypeSchema>;
export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export type EditTraceEvent = z.infer<typeof EditTraceEventSchema>;
export type CreateTaskInput = z.infer<typeof CreateTaskInputSchema>;
export type TaskSnapshot = z.infer<typeof TaskSnapshotSchema>;
