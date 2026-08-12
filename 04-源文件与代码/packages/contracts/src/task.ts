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

export const PortraitPlanDirectionSchema = z.enum([
  "NATURAL_RESCUE",
  "CLEAR_RESCUE"
]);

export const PortraitFindingSchema = z.enum([
  "FACE_UNDEREXPOSED",
  "BACKGROUND_HIGHLIGHT",
  "SKIN_TONE_GRAY",
  "LIGHT_NOISE",
  "LIGHT_BLUR"
]);

export const PortraitProtectionSchema = z.enum([
  "IDENTITY",
  "FACIAL_STRUCTURE",
  "HAIR",
  "CLOTHING",
  "POSE",
  "SUBJECT_COUNT",
  "COMPOSITION"
]);

export const FidelityCheckSchema = z.enum([
  "FACE_COUNT",
  "IDENTITY",
  "STRUCTURE",
  "NON_TARGET_REGION",
  "ARTIFACTS"
]);

export const TaskFailureCodeSchema = z.enum([
  "PREVIEW_PROVIDER_FAILED",
  "FIDELITY_GATE_FAILED",
  "PORTRAIT_NOT_SUITABLE",
  "ASSET_NOT_APPROVED"
]);

export const EditTraceEvidenceSourceSchema = z.enum([
  "SYSTEM_CHECK",
  "USER_SELECTION",
  "PROVIDER_RECEIPT",
  "QUALITY_GATE"
]);

export const EditTracePhaseSchema = z.enum([
  "UPLOAD",
  "DIAGNOSIS",
  "PLAN",
  "RETOUCH",
  "QUALITY",
  "DELIVERY"
]);

export const EditTraceEventTypeSchema = z.enum([
  "ASSET_APPROVED",
  "DIAGNOSIS_STARTED",
  "DIAGNOSIS_FINDING",
  "PROTECTION_RECORDED",
  "PLAN_READY",
  "PLAN_SELECTED",
  "STAGE_STARTED",
  "PARAM_DIRECTION_APPLIED",
  "STAGE_COMPLETED",
  "QUALITY_CHECK_STARTED",
  "QUALITY_CHECK_PASSED",
  "QUALITY_CHECK_FAILED",
  "RETRY_STARTED",
  "PREVIEW_READY",
  "TASK_FAILED"
]);

export const EditTraceVisibilitySchema = z.enum(["PREVIEW", "UNLOCKED"]);

export const EditTraceCopyKeySchema = z.enum([
  "upload.asset.approved",
  "portrait.diagnosis.started",
  "portrait.diagnosis.light",
  "portrait.protection.recorded",
  "portrait.plan.natural",
  "portrait.plan.selected",
  "portrait.stage.retouch.started",
  "portrait.parameter.direction",
  "portrait.stage.retouch.completed",
  "quality.started",
  "quality.fidelity.passed",
  "quality.fidelity.failed",
  "portrait.retry.started",
  "preview.ready",
  "preview.provider.failed"
]);

const EmptyPayloadSchema = z.object({}).strict();
const AssetApprovedPayloadSchema = z.object({ metadataRemoved: z.literal(true) }).strict();
const FindingPayloadSchema = z.object({ finding: PortraitFindingSchema }).strict();
const ProtectionPayloadSchema = z.object({
  protections: z.array(PortraitProtectionSchema).min(1)
}).strict();
const DirectionPayloadSchema = z.object({ direction: PortraitPlanDirectionSchema }).strict();
const StagePayloadSchema = z.object({ stage: z.literal("LOCAL_LIGHT_AND_SKIN") }).strict();
const ParameterPayloadSchema = z.object({
  direction: PortraitPlanDirectionSchema,
  level: z.literal("MODERATE")
}).strict();
const QualityPassedPayloadSchema = z.object({
  checks: z.array(FidelityCheckSchema).min(1)
}).strict();
const QualityFailedPayloadSchema = z.object({
  checks: z.array(FidelityCheckSchema).min(1),
  failedChecks: z.array(FidelityCheckSchema).min(1)
}).strict();
const RetryPayloadSchema = z.object({ attempt: z.literal(2) }).strict();
const PreviewPayloadSchema = z.object({
  watermarked: z.literal(true),
  downloadable: z.literal(false)
}).strict();
const FailurePayloadSchema = z.object({ code: TaskFailureCodeSchema }).strict();

const EditTracePayloadSchema = z.union([
  EmptyPayloadSchema,
  AssetApprovedPayloadSchema,
  FindingPayloadSchema,
  ProtectionPayloadSchema,
  DirectionPayloadSchema,
  StagePayloadSchema,
  ParameterPayloadSchema,
  QualityPassedPayloadSchema,
  QualityFailedPayloadSchema,
  RetryPayloadSchema,
  PreviewPayloadSchema,
  FailurePayloadSchema
]);

const editTraceRules = {
  ASSET_APPROVED: ["UPLOAD", "upload.asset.approved", AssetApprovedPayloadSchema, ["SYSTEM_CHECK"]],
  DIAGNOSIS_STARTED: ["DIAGNOSIS", "portrait.diagnosis.started", EmptyPayloadSchema, ["SYSTEM_CHECK"]],
  DIAGNOSIS_FINDING: ["DIAGNOSIS", "portrait.diagnosis.light", FindingPayloadSchema, ["SYSTEM_CHECK"]],
  PROTECTION_RECORDED: ["DIAGNOSIS", "portrait.protection.recorded", ProtectionPayloadSchema, ["SYSTEM_CHECK"]],
  PLAN_READY: ["PLAN", "portrait.plan.natural", DirectionPayloadSchema, ["SYSTEM_CHECK"]],
  PLAN_SELECTED: ["PLAN", "portrait.plan.selected", DirectionPayloadSchema, ["USER_SELECTION"]],
  STAGE_STARTED: ["RETOUCH", "portrait.stage.retouch.started", StagePayloadSchema, ["PROVIDER_RECEIPT"]],
  PARAM_DIRECTION_APPLIED: ["RETOUCH", "portrait.parameter.direction", ParameterPayloadSchema, ["PROVIDER_RECEIPT"]],
  STAGE_COMPLETED: ["RETOUCH", "portrait.stage.retouch.completed", StagePayloadSchema, ["PROVIDER_RECEIPT"]],
  QUALITY_CHECK_STARTED: ["QUALITY", "quality.started", EmptyPayloadSchema, ["QUALITY_GATE"]],
  QUALITY_CHECK_PASSED: ["QUALITY", "quality.fidelity.passed", QualityPassedPayloadSchema, ["QUALITY_GATE"]],
  QUALITY_CHECK_FAILED: ["QUALITY", "quality.fidelity.failed", QualityFailedPayloadSchema, ["QUALITY_GATE"]],
  RETRY_STARTED: ["RETOUCH", "portrait.retry.started", RetryPayloadSchema, ["SYSTEM_CHECK"]],
  PREVIEW_READY: ["DELIVERY", "preview.ready", PreviewPayloadSchema, ["QUALITY_GATE"]],
  TASK_FAILED: ["DELIVERY", "preview.provider.failed", FailurePayloadSchema, ["SYSTEM_CHECK", "QUALITY_GATE"]]
} as const;

export const EditTraceEventSchema = z.object({
  eventId: z.string().min(1),
  taskId: z.string().min(1),
  sequence: z.number().int().positive(),
  type: EditTraceEventTypeSchema,
  phase: EditTracePhaseSchema,
  occurredAt: z.string().datetime(),
  visibility: EditTraceVisibilitySchema,
  evidenceSource: EditTraceEvidenceSourceSchema,
  copyKey: EditTraceCopyKeySchema,
  payload: EditTracePayloadSchema
}).strict().superRefine((event, context) => {
  const [phase, copyKey, payloadSchema, evidenceSources] = editTraceRules[event.type];
  if (event.phase !== phase) {
    context.addIssue({ code: "custom", path: ["phase"], message: `Invalid phase for ${event.type}` });
  }
  if (event.copyKey !== copyKey) {
    context.addIssue({ code: "custom", path: ["copyKey"], message: `Invalid copy key for ${event.type}` });
  }
  if (!(evidenceSources as readonly string[]).includes(event.evidenceSource)) {
    context.addIssue({ code: "custom", path: ["evidenceSource"], message: `Invalid evidence source for ${event.type}` });
  }
  const payloadResult = payloadSchema.safeParse(event.payload);
  if (!payloadResult.success) {
    for (const issue of payloadResult.error.issues) {
      context.addIssue({ ...issue, path: ["payload", ...issue.path] });
    }
  }
});

const PortraitTaskInputSchema = z.object({
  tool: z.literal("PORTRAIT_RETOUCH"),
  inputAssetId: z.string().min(1),
  direction: PortraitPlanDirectionSchema,
  parameters: z.object({
    naturalness: z.number().min(0).max(100),
    detailLevel: z.number().min(0).max(100)
  }).strict()
}).strict();

const QualityEnhanceTaskInputSchema = z.object({
  tool: z.literal("QUALITY_ENHANCE"), inputAssetId: z.string().min(1),
  direction: z.literal("QUALITY_FIRST"),
  parameters: z.object({ outputTier: z.string().min(1), detailPreservation: z.number().min(0).max(100) }).strict()
}).strict();

const ObjectRemovalTaskInputSchema = z.object({
  tool: z.literal("OBJECT_REMOVAL"), inputAssetId: z.string().min(1),
  direction: z.literal("REMOVE_CONFIRMED_TARGET"),
  parameters: z.object({ confirmedMaskAssetId: z.string().min(1) }).strict()
}).strict();

const OldPhotoRestoreTaskInputSchema = z.object({
  tool: z.literal("OLD_PHOTO_RESTORE"), inputAssetId: z.string().min(1),
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
  if (input.tool === "OLD_PHOTO_RESTORE" &&
      input.parameters.colorizationRequested !== input.parameters.colorizationConfirmed) {
    context.addIssue({ code: "custom", path: ["parameters"], message: "Colorization request and explicit confirmation must be consistent" });
  }
});

export const TaskSnapshotSchema = z.object({
  taskId: z.string().min(1),
  status: TaskStatusSchema,
  tool: ToolTypeSchema,
  lastSequence: z.number().int().nonnegative(),
  previewUrl: z.string().url().optional(),
  failureCode: TaskFailureCodeSchema.optional(),
  diagnosis: z.object({
    findings: z.array(PortraitFindingSchema),
    protections: z.array(PortraitProtectionSchema)
  }).strict().optional(),
  selectedDirection: PortraitPlanDirectionSchema.optional(),
  noCharge: z.literal(true).optional()
}).strict();

export type ToolType = z.infer<typeof ToolTypeSchema>;
export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export type PortraitPlanDirection = z.infer<typeof PortraitPlanDirectionSchema>;
export type PortraitFinding = z.infer<typeof PortraitFindingSchema>;
export type PortraitProtection = z.infer<typeof PortraitProtectionSchema>;
export type EditTraceEvidenceSource = z.infer<typeof EditTraceEvidenceSourceSchema>;
export type EditTraceEvent = z.infer<typeof EditTraceEventSchema>;
export type CreateTaskInput = z.infer<typeof CreateTaskInputSchema>;
export type TaskSnapshot = z.infer<typeof TaskSnapshotSchema>;
