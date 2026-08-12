import COS from "cos-nodejs-sdk-v5";
import * as STS from "qcloud-cos-sts";
import { uploadPolicy } from "../domain/upload-policy.js";
import type {
  ObjectStorage,
  PrivateObjectMetadata,
  UploadCredential
} from "../ports/object-storage.js";

export interface TencentCosConfig {
  bucket: string;
  region: string;
  secretId: string;
  secretKey: string;
}

export interface StsCredentialIssuer {
  getCredential(options: STS.GetCredentialOptions): Promise<STS.CredentialData>;
}

interface CosUploadUrlInput {
  bucket: string;
  region: string;
  objectKey: string;
  expiresInSeconds: number;
  temporarySecretId: string;
  temporarySecretKey: string;
  securityToken: string;
}

export interface CosClient {
  createUploadUrl(input: CosUploadUrlInput): string;
  headObject(input: { bucket: string; region: string; objectKey: string }): Promise<PrivateObjectMetadata>;
  createReadUrl(input: {
    bucket: string;
    region: string;
    objectKey: string;
    expiresInSeconds: number;
  }): string;
  deleteObject(input: { bucket: string; region: string; objectKey: string }): Promise<void>;
}

export class TencentCosObjectStorage implements ObjectStorage {
  public constructor(
    private readonly config: TencentCosConfig,
    private readonly sts: StsCredentialIssuer = STS,
    private readonly cos: CosClient = createCosClient(config)
  ) {}

  public async issueUploadCredential(input: {
    userId: string;
    sessionId: string;
    objectKey: string;
    expiresInSeconds: 600;
  }): Promise<UploadCredential> {
    assertOwnedObjectKey(input.userId, input.sessionId, input.objectKey);
    const policy = STS.getPolicy([{
      action: "name/cos:PutObject",
      bucket: this.config.bucket,
      region: this.config.region,
      prefix: input.objectKey
    }]);
    const issued = await this.sts.getCredential({
      secretId: this.config.secretId,
      secretKey: this.config.secretKey,
      region: this.config.region,
      durationSeconds: input.expiresInSeconds,
      policy
    });
    const url = this.cos.createUploadUrl({
      bucket: this.config.bucket,
      region: this.config.region,
      objectKey: input.objectKey,
      expiresInSeconds: input.expiresInSeconds,
      temporarySecretId: issued.credentials.tmpSecretId,
      temporarySecretKey: issued.credentials.tmpSecretKey,
      securityToken: issued.credentials.sessionToken
    });
    return { url, method: "PUT", headers: { "x-cos-acl": "private" } };
  }

  public async headPrivateObject(objectKey: string): Promise<PrivateObjectMetadata> {
    assertServerObjectKey(objectKey);
    const metadata = await this.cos.headObject({
      bucket: this.config.bucket,
      region: this.config.region,
      objectKey
    });
    if (metadata.sizeBytes > uploadPolicy.maxBytes) throw new Error("IMAGE_TOO_LARGE");
    return metadata;
  }

  public async createReadUrl(objectKey: string, expiresInSeconds: number): Promise<string> {
    assertServerObjectKey(objectKey);
    if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 1 || expiresInSeconds > 600) {
      throw new Error("READ_URL_EXPIRY_EXCEEDED");
    }
    return this.cos.createReadUrl({
      bucket: this.config.bucket,
      region: this.config.region,
      objectKey,
      expiresInSeconds
    });
  }

  public async deleteObject(objectKey: string): Promise<void> {
    assertServerObjectKey(objectKey);
    await this.cos.deleteObject({
      bucket: this.config.bucket,
      region: this.config.region,
      objectKey
    });
  }
}

function createCosClient(config: TencentCosConfig): CosClient {
  const permanentClient = new COS({ SecretId: config.secretId, SecretKey: config.secretKey });
  return {
    createUploadUrl(input) {
      const temporaryClient = new COS({
        SecretId: input.temporarySecretId,
        SecretKey: input.temporarySecretKey,
        SecurityToken: input.securityToken
      });
      return temporaryClient.getObjectUrl({
        Bucket: input.bucket,
        Region: input.region,
        Key: input.objectKey,
        Method: "PUT",
        Sign: true,
        Expires: input.expiresInSeconds
      });
    },
    async headObject(input) {
      const result = await permanentClient.headObject({
        Bucket: input.bucket,
        Region: input.region,
        Key: input.objectKey
      });
      const headers = result.headers ?? {};
      const sizeBytes = Number(headers["content-length"]);
      const contentType = String(headers["content-type"] ?? "");
      if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || !contentType || !result.ETag) {
        throw new Error("INVALID_OBJECT_METADATA");
      }
      return { sizeBytes, contentType, etag: result.ETag };
    },
    createReadUrl(input) {
      return permanentClient.getObjectUrl({
        Bucket: input.bucket,
        Region: input.region,
        Key: input.objectKey,
        Method: "GET",
        Sign: true,
        Expires: input.expiresInSeconds
      });
    },
    async deleteObject(input) {
      await permanentClient.deleteObject({
        Bucket: input.bucket,
        Region: input.region,
        Key: input.objectKey
      });
    }
  };
}

function assertOwnedObjectKey(userId: string, sessionId: string, objectKey: string): void {
  if (objectKey !== `users/${userId}/uploads/${sessionId}/original`) {
    throw new Error("INVALID_OBJECT_KEY");
  }
}

function assertServerObjectKey(objectKey: string): void {
  if (!/^users\/[^/]+\/uploads\/[^/]+\/(?:original|normalized|audit|preview)$/.test(objectKey)) {
    throw new Error("INVALID_OBJECT_KEY");
  }
}
