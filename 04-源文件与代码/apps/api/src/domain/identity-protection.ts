import {
  createCipheriv,
  createHmac,
  randomBytes
} from "node:crypto";

export interface ProtectedIdentity {
  lookupHash: Buffer;
  ciphertext: Buffer;
}

export function protectOpenId(
  openId: string,
  lookupKey: Buffer,
  encryptionKey: Buffer
): ProtectedIdentity {
  const lookupHash = createHmac("sha256", lookupKey).update(openId).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
  const ciphertext = Buffer.concat([
    cipher.update(openId, "utf8"),
    cipher.final()
  ]);
  return {
    lookupHash,
    ciphertext: Buffer.concat([iv, cipher.getAuthTag(), ciphertext])
  };
}
