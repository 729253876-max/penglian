import { z } from "zod";

export const UploadStateSchema = z.enum([
  "INIT",
  "UPLOADING",
  "UPLOADED",
  "NORMALIZING",
  "REVIEWING",
  "APPROVED",
  "REJECTED",
  "FAILED",
  "EXPIRED",
  "CANCELED"
]);

export const ModerationOutcomeSchema = z.enum([
  "PASS",
  "REJECT",
  "SUSPECTED",
  "SERVICE_ERROR"
]);

export const CreateUploadSessionInputSchema = z.object({
  fileName: z.string().min(1).max(255),
  sizeBytes: z.number().int().positive().max(30 * 1024 * 1024),
  metadataRemovalConsentVersion: z.literal("2026-08-02")
}).strict();

const UploadTargetSchema = z.object({
  url: z.string().url(),
  method: z.literal("PUT"),
  headers: z.record(z.string(), z.string())
}).strict();

export const UploadSessionSchema = z.object({
  sessionId: z.string().uuid(),
  state: UploadStateSchema,
  expiresAt: z.string().datetime(),
  credentialExpiresAt: z.string().datetime(),
  upload: UploadTargetSchema
}).strict();

export const CompleteUploadInputSchema = z.object({
  etag: z.string().min(1).max(256)
}).strict();

export const UploadStatusSchema = z.object({
  sessionId: z.string().uuid(),
  state: UploadStateSchema,
  assetId: z.string().uuid().optional(),
  qualityWarning: z.boolean().optional(),
  failureCode: z.string().min(1).max(64).optional()
}).strict();

export type UploadState = z.infer<typeof UploadStateSchema>;
export type ModerationOutcome = z.infer<typeof ModerationOutcomeSchema>;
export type CreateUploadSessionInput = z.infer<typeof CreateUploadSessionInputSchema>;
export type UploadSession = z.infer<typeof UploadSessionSchema>;
export type CompleteUploadInput = z.infer<typeof CompleteUploadInputSchema>;
export type UploadStatus = z.infer<typeof UploadStatusSchema>;
