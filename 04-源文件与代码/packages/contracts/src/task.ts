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

export const EditTraceEventSchema = z.object({
  eventId: z.string().min(1),
  taskId: z.string().min(1),
  sequence: z.number().int().positive(),
  type: EditTraceEventTypeSchema,
  phase: z.string().min(1),
  occurredAt: z.string().datetime(),
  visibility: EditTraceVisibilitySchema,
  copyKey: z.string().min(1),
  payload: z.record(z.string(), z.union([
    z.string(),
    z.number(),
    z.boolean()
  ])).default({})
}).superRefine((event, context) => {
  const forbiddenPayloadKeys = new Set([
    "hiddenreasoning",
    "apikey",
    "originalimageurl"
  ]);

  for (const key of Object.keys(event.payload)) {
    if (forbiddenPayloadKeys.has(key.toLowerCase())) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["payload", key],
        message: "Sensitive fields are not permitted in edit traces"
      });
    }
  }
});

const PortraitTaskInputSchema = z.object({
  tool: z.literal("PORTRAIT_RETOUCH"),
  inputAssetId: z.string().min(1),
  direction: z.enum(["NATURAL", "BRIGHT", "WARM"]),
  parameters: z.object({
    brightness: z.number().min(-100).max(100),
    warmth: z.number().min(-100).max(100),
    naturalness: z.number().min(0).max(100)
  })
});

const QualityEnhanceTaskInputSchema = z.object({
  tool: z.literal("QUALITY_ENHANCE"),
  inputAssetId: z.string().min(1),
  direction: z.literal("QUALITY_FIRST"),
  parameters: z.object({
    outputTier: z.string().min(1),
    detailPreservation: z.number().min(0).max(100)
  })
});

const ObjectRemovalTaskInputSchema = z.object({
  tool: z.literal("OBJECT_REMOVAL"),
  inputAssetId: z.string().min(1),
  direction: z.literal("REMOVE_CONFIRMED_TARGET"),
  parameters: z.object({
    confirmedMaskAssetId: z.string().min(1)
  })
});

const OldPhotoRestoreTaskInputSchema = z.object({
  tool: z.literal("OLD_PHOTO_RESTORE"),
  inputAssetId: z.string().min(1),
  direction: z.literal("FAITHFUL_RESTORE"),
  parameters: z.object({
    colorizationRequested: z.boolean().default(false),
    colorizationConfirmed: z.boolean().default(false)
  })
});

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
