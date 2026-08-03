import { describe, expect, it } from "vitest";
import {
  ConsentInputSchema,
  CurrentUserSchema,
  RefreshInputSchema,
  SessionPairSchema,
  WechatLoginInputSchema
} from "../src/index.js";

describe("identity contracts", () => {
  it("accepts a WeChat login with explicit metadata-removal consent", () => {
    const consent = { policyVersion: "2026-08-02", metadataRemoval: true };

    expect(WechatLoginInputSchema.parse({
      code: "wx-code",
      deviceId: "device-1",
      consent
    })).toEqual({ code: "wx-code", deviceId: "device-1", consent });
  });

  it("requires metadata-removal consent to be explicitly supplied", () => {
    expect(() => ConsentInputSchema.parse({
      policyVersion: "2026-08-02",
      metadataRemoval: undefined
    })).toThrow();
  });

  it("accepts a complete session pair with ISO timestamps", () => {
    expect(SessionPairSchema.parse({
      accessToken: "a",
      accessExpiresAt: "2026-08-02T02:00:00.000Z",
      refreshToken: "r",
      refreshExpiresAt: "2026-09-01T00:00:00.000Z"
    }).accessToken).toBe("a");
  });

  it("rejects unexpected fields from identity inputs", () => {
    expect(RefreshInputSchema.safeParse({
      refreshToken: "refresh-1",
      deviceId: "device-1",
      role: "admin"
    }).success).toBe(false);
  });

  it("accepts an active user within the device limit", () => {
    expect(CurrentUserSchema.parse({
      userId: "d9428888-122b-11e1-b85c-61cd3cbb3210",
      status: "ACTIVE",
      activeDeviceCount: 5
    }).status).toBe("ACTIVE");
  });
});
