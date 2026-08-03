import { z } from "zod";

export const WechatLoginInputSchema = z.object({
  code: z.string().min(1).max(128),
  deviceId: z.string().min(1).max(128),
  consent: z.object({
    policyVersion: z.string().min(1).max(64),
    metadataRemoval: z.boolean()
  }).strict()
}).strict();

export const ConsentInputSchema = z.object({
  policyVersion: z.string().min(1).max(64),
  metadataRemoval: z.boolean()
}).strict();

export const RefreshInputSchema = z.object({
  refreshToken: z.string().min(1),
  deviceId: z.string().min(1).max(128)
}).strict();

export const SessionPairSchema = z.object({
  accessToken: z.string().min(1),
  accessExpiresAt: z.string().datetime(),
  refreshToken: z.string().min(1),
  refreshExpiresAt: z.string().datetime()
}).strict();

export const CurrentUserSchema = z.object({
  userId: z.string().uuid(),
  status: z.enum(["ACTIVE", "DELETING"]),
  activeDeviceCount: z.number().int().min(1).max(5)
}).strict();

export type WechatLoginInput = z.infer<typeof WechatLoginInputSchema>;
export type ConsentInput = z.infer<typeof ConsentInputSchema>;
export type RefreshInput = z.infer<typeof RefreshInputSchema>;
export type SessionPair = z.infer<typeof SessionPairSchema>;
export type CurrentUser = z.infer<typeof CurrentUserSchema>;
