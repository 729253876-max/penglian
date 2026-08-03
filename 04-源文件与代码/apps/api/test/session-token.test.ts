import {
  createDecipheriv,
  createHash,
  createHmac
} from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  digestToken,
  issueToken
} from "../src/domain/session-token.js";
import { protectOpenId } from "../src/domain/identity-protection.js";

describe("opaque session tokens", () => {
  it("returns a 256-bit bearer value while exposing only its SHA-256 persistence digest", () => {
    const issued = issueToken();

    expect(Buffer.from(issued.raw, "base64url")).toHaveLength(32);
    expect(issued.digest).toEqual(
      createHash("sha256").update(issued.raw).digest()
    );
    expect(issued.digest).toEqual(digestToken(issued.raw));
    expect(issued.digest.toString("utf8")).not.toContain(issued.raw);
  });

  it("does not reuse bearer values across issues", () => {
    const first = issueToken();
    const second = issueToken();

    expect(second.raw).not.toBe(first.raw);
    expect(second.digest.equals(first.digest)).toBe(false);
  });
});

describe("OpenID protection", () => {
  it("stores a deterministic keyed lookup digest and decryptable AES-256-GCM envelope", () => {
    const openId = "o-user-secret-openid";
    const lookupKey = Buffer.alloc(32, 0x11);
    const encryptionKey = Buffer.alloc(32, 0x22);

    const protectedIdentity = protectOpenId(openId, lookupKey, encryptionKey);

    expect(protectedIdentity.lookupHash).toEqual(
      createHmac("sha256", lookupKey).update(openId).digest()
    );
    expect(protectedIdentity.ciphertext).toHaveLength(12 + 16 + Buffer.byteLength(openId));
    expect(protectedIdentity.ciphertext.includes(Buffer.from(openId))).toBe(false);

    const iv = protectedIdentity.ciphertext.subarray(0, 12);
    const authTag = protectedIdentity.ciphertext.subarray(12, 28);
    const encryptedOpenId = protectedIdentity.ciphertext.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([
      decipher.update(encryptedOpenId),
      decipher.final()
    ]).toString("utf8");
    expect(plaintext).toBe(openId);
  });

  it("randomizes ciphertext without changing the lookup hash", () => {
    const lookupKey = Buffer.alloc(32, 0x33);
    const encryptionKey = Buffer.alloc(32, 0x44);

    const first = protectOpenId("same-openid", lookupKey, encryptionKey);
    const second = protectOpenId("same-openid", lookupKey, encryptionKey);

    expect(second.lookupHash).toEqual(first.lookupHash);
    expect(second.ciphertext.equals(first.ciphertext)).toBe(false);
  });
});
