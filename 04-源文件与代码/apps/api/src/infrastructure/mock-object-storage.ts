import { randomUUID } from "node:crypto";
import { uploadPolicy } from "../domain/upload-policy.js";
import type {
  ObjectStorage,
  PrivateObjectMetadata,
  UploadCredential
} from "../ports/object-storage.js";

interface MockObjectStorageOptions {
  nowEpochSeconds?: () => number;
}

export class MockObjectStorage implements ObjectStorage {
  private readonly objects = new Map<string, PrivateObjectMetadata>();
  private readonly credentialScopes = new Map<string, string>();
  private readonly nowEpochSeconds: () => number;

  public constructor(options: MockObjectStorageOptions = {}) {
    this.nowEpochSeconds = options.nowEpochSeconds ?? (() => Math.floor(Date.now() / 1_000));
  }

  public async issueUploadCredential(input: {
    userId: string;
    sessionId: string;
    objectKey: string;
    expiresInSeconds: 600;
  }): Promise<UploadCredential> {
    assertOwnedObjectKey(input.userId, input.sessionId, input.objectKey);
    const token = randomUUID();
    this.credentialScopes.set(token, input.objectKey);
    return {
      url: `https://mock-cos.invalid/upload/${encodeURIComponent(input.objectKey)}?token=${token}`,
      method: "PUT",
      headers: { "x-cos-acl": "private" }
    };
  }

  public async headPrivateObject(objectKey: string): Promise<PrivateObjectMetadata> {
    const metadata = this.objects.get(objectKey);
    if (!metadata) throw new Error("OBJECT_NOT_FOUND");
    if (metadata.sizeBytes > uploadPolicy.maxBytes) throw new Error("IMAGE_TOO_LARGE");
    return { ...metadata };
  }

  public async createReadUrl(objectKey: string, expiresInSeconds: number): Promise<string> {
    if (!this.objects.has(objectKey)) throw new Error("OBJECT_NOT_FOUND");
    if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 1 || expiresInSeconds > 600) {
      throw new Error("READ_URL_EXPIRY_EXCEEDED");
    }
    const expiresAt = this.nowEpochSeconds() + expiresInSeconds;
    return `https://mock-cos.invalid/read/${encodeURIComponent(objectKey)}?expiresAt=${expiresAt}&signature=${randomUUID()}`;
  }

  public async deleteObject(objectKey: string): Promise<void> {
    this.objects.delete(objectKey);
  }

  public seedPrivateObject(objectKey: string, metadata: PrivateObjectMetadata): void {
    this.objects.set(objectKey, { ...metadata });
  }

  public async putPrivateObject(
    credential: UploadCredential,
    objectKey: string,
    metadata: PrivateObjectMetadata
  ): Promise<void> {
    const token = new URL(credential.url).searchParams.get("token");
    if (!token || this.credentialScopes.get(token) !== objectKey) {
      throw new Error("UPLOAD_CREDENTIAL_SCOPE_VIOLATION");
    }
    this.objects.set(objectKey, { ...metadata });
  }

  public async readPublicObject(objectKey: string): Promise<never> {
    if (!this.objects.has(objectKey)) throw new Error("OBJECT_NOT_FOUND");
    throw new Error("OBJECT_NOT_PUBLIC");
  }
}

function assertOwnedObjectKey(userId: string, sessionId: string, objectKey: string): void {
  if (objectKey !== `users/${userId}/uploads/${sessionId}/original`) {
    throw new Error("INVALID_OBJECT_KEY");
  }
}
