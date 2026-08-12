export interface UploadCredential {
  url: string;
  method: "PUT";
  headers: Record<string, string>;
}

export interface PrivateObjectMetadata {
  sizeBytes: number;
  contentType: string;
  etag: string;
}

export interface ObjectStorage {
  issueUploadCredential(input: {
    userId: string;
    sessionId: string;
    objectKey: string;
    expiresInSeconds: 600;
  }): Promise<UploadCredential>;
  headPrivateObject(objectKey: string): Promise<PrivateObjectMetadata>;
  createReadUrl(objectKey: string, expiresInSeconds: number): Promise<string>;
  deleteObject(objectKey: string): Promise<void>;
}
