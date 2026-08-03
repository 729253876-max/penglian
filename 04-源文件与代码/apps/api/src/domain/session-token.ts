import { createHash, randomBytes } from "node:crypto";

export interface IssuedToken {
  raw: string;
  digest: Buffer;
}

export function digestToken(raw: string): Buffer {
  return createHash("sha256").update(raw).digest();
}

export function issueToken(): IssuedToken {
  const raw = randomBytes(32).toString("base64url");
  return { raw, digest: digestToken(raw) };
}
