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
  "portrait.plan.clear",
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
const ProviderFailurePayloadSchema = z.object({
  code: z.literal("PREVIEW_PROVIDER_FAILED")
}).strict();
const FidelityFailurePayloadSchema = z.object({
  code: z.literal("FIDELITY_GATE_FAILED")
}).strict();

const EventIdentityShape = {
  eventId: z.string().min(1),
  taskId: z.string().min(1),
  sequence: z.number().int().positive(),
  occurredAt: z.string().datetime(),
  visibility: EditTraceVisibilitySchema
};

export const EditTraceEventSchema = z.union([
  z.object({ ...EventIdentityShape, type: z.literal("ASSET_APPROVED"), phase: z.literal("UPLOAD"), evidenceSource: z.literal("SYSTEM_CHECK"), copyKey: z.literal("upload.asset.approved"), payload: AssetApprovedPayloadSchema }).strict(),
  z.object({ ...EventIdentityShape, type: z.literal("DIAGNOSIS_STARTED"), phase: z.literal("DIAGNOSIS"), evidenceSource: z.literal("SYSTEM_CHECK"), copyKey: z.literal("portrait.diagnosis.started"), payload: EmptyPayloadSchema }).strict(),
  z.object({ ...EventIdentityShape, type: z.literal("DIAGNOSIS_FINDING"), phase: z.literal("DIAGNOSIS"), evidenceSource: z.literal("SYSTEM_CHECK"), copyKey: z.literal("portrait.diagnosis.light"), payload: FindingPayloadSchema }).strict(),
  z.object({ ...EventIdentityShape, type: z.literal("PROTECTION_RECORDED"), phase: z.literal("DIAGNOSIS"), evidenceSource: z.literal("SYSTEM_CHECK"), copyKey: z.literal("portrait.protection.recorded"), payload: ProtectionPayloadSchema }).strict(),
  z.object({ ...EventIdentityShape, type: z.literal("PLAN_READY"), phase: z.literal("PLAN"), evidenceSource: z.literal("SYSTEM_CHECK"), copyKey: z.literal("portrait.plan.natural"), payload: z.object({ direction: z.literal("NATURAL_RESCUE") }).strict() }).strict(),
  z.object({ ...EventIdentityShape, type: z.literal("PLAN_READY"), phase: z.literal("PLAN"), evidenceSource: z.literal("SYSTEM_CHECK"), copyKey: z.literal("portrait.plan.clear"), payload: z.object({ direction: z.literal("CLEAR_RESCUE") }).strict() }).strict(),
  z.object({ ...EventIdentityShape, type: z.literal("PLAN_SELECTED"), phase: z.literal("PLAN"), evidenceSource: z.literal("USER_SELECTION"), copyKey: z.literal("portrait.plan.selected"), payload: DirectionPayloadSchema }).strict(),
  z.object({ ...EventIdentityShape, type: z.literal("STAGE_STARTED"), phase: z.literal("RETOUCH"), evidenceSource: z.literal("PROVIDER_RECEIPT"), copyKey: z.literal("portrait.stage.retouch.started"), payload: StagePayloadSchema }).strict(),
  z.object({ ...EventIdentityShape, type: z.literal("PARAM_DIRECTION_APPLIED"), phase: z.literal("RETOUCH"), evidenceSource: z.literal("PROVIDER_RECEIPT"), copyKey: z.literal("portrait.parameter.direction"), payload: ParameterPayloadSchema }).strict(),
  z.object({ ...EventIdentityShape, type: z.literal("STAGE_COMPLETED"), phase: z.literal("RETOUCH"), evidenceSource: z.literal("PROVIDER_RECEIPT"), copyKey: z.literal("portrait.stage.retouch.completed"), payload: StagePayloadSchema }).strict(),
  z.object({ ...EventIdentityShape, type: z.literal("QUALITY_CHECK_STARTED"), phase: z.literal("QUALITY"), evidenceSource: z.literal("QUALITY_GATE"), copyKey: z.literal("quality.started"), payload: EmptyPayloadSchema }).strict(),
  z.object({ ...EventIdentityShape, type: z.literal("QUALITY_CHECK_PASSED"), phase: z.literal("QUALITY"), evidenceSource: z.literal("QUALITY_GATE"), copyKey: z.literal("quality.fidelity.passed"), payload: QualityPassedPayloadSchema }).strict(),
  z.object({ ...EventIdentityShape, type: z.literal("QUALITY_CHECK_FAILED"), phase: z.literal("QUALITY"), evidenceSource: z.literal("QUALITY_GATE"), copyKey: z.literal("quality.fidelity.failed"), payload: QualityFailedPayloadSchema }).strict(),
  z.object({ ...EventIdentityShape, type: z.literal("RETRY_STARTED"), phase: z.literal("RETOUCH"), evidenceSource: z.literal("SYSTEM_CHECK"), copyKey: z.literal("portrait.retry.started"), payload: RetryPayloadSchema }).strict(),
  z.object({ ...EventIdentityShape, type: z.literal("PREVIEW_READY"), phase: z.literal("DELIVERY"), evidenceSource: z.literal("QUALITY_GATE"), copyKey: z.literal("preview.ready"), payload: PreviewPayloadSchema }).strict(),
  z.object({ ...EventIdentityShape, type: z.literal("TASK_FAILED"), phase: z.literal("DELIVERY"), evidenceSource: z.literal("SYSTEM_CHECK"), copyKey: z.literal("preview.provider.failed"), payload: ProviderFailurePayloadSchema }).strict(),
  z.object({ ...EventIdentityShape, type: z.literal("TASK_FAILED"), phase: z.literal("DELIVERY"), evidenceSource: z.literal("QUALITY_GATE"), copyKey: z.literal("preview.provider.failed"), payload: FidelityFailurePayloadSchema }).strict()
]);

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
