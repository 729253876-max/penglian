import type { UploadSession, UploadState, UploadStatus } from "@photo-ai/contracts";
import { authenticatedRequest } from "./session.js";

const RESUME_STORAGE_KEY = "photo-ai:upload-resume:v1";
const CONSENT_POLICY_VERSION = "2026-08-02";
const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;
const allowedExtensions = new Set(["jpg", "jpeg", "png", "heic", "heif"]);
const uploadStates = new Set<UploadState>([
  "INIT", "UPLOADING", "UPLOADED", "NORMALIZING", "REVIEWING",
  "APPROVED", "REJECTED", "FAILED", "EXPIRED", "CANCELED"
]);

export type LocalPhoto = { path: string; name: string; size: number };
export type LocalFileValidation =
  | { allowed: true }
  | { allowed: false; code: "IMAGE_TOO_LARGE" | "IMAGE_FORMAT_UNSUPPORTED" };

export type IssuedUploadTarget = {
  url: string;
  method: "PUT";
  headers: Record<string, string>;
  expiresAt: string;
};

export type UploadCompletion = {
  sessionId: string;
  state: "UPLOADED" | "NORMALIZING" | "REVIEWING" | "APPROVED";
};

export type StoredUploadResume = {
  sessionId: string;
  state: "UPLOADED" | "PROCESSING";
  updatedAt: string;
};

export interface UploadTransport {
  putFile(input: {
    filePath: string;
    target: IssuedUploadTarget;
  }): Promise<{ etag: string }>;
}

export interface UploadDependencies {
  now: () => Date;
  createSession: typeof createUploadSession;
  reissue: typeof reissueUploadCredential;
  transport: UploadTransport;
  complete: typeof completeUpload;
  getStatus: typeof getUploadStatus;
  persistResume: typeof writeUploadResume;
}

export function validateLocalFile(file: LocalPhoto): LocalFileValidation {
  if (file.size > MAX_UPLOAD_BYTES) return { allowed: false, code: "IMAGE_TOO_LARGE" };
  const extension = /\.([^.]+)$/.exec(file.name.trim())?.[1]?.toLowerCase();
  if (!extension || !allowedExtensions.has(extension)) {
    return { allowed: false, code: "IMAGE_FORMAT_UNSUPPORTED" };
  }
  return { allowed: true };
}

export const createUploadSession = (file: LocalPhoto): Promise<UploadSession> =>
  authenticatedRequest({
    method: "POST",
    url: "/v1/uploads",
    data: {
      fileName: file.name,
      sizeBytes: file.size,
      metadataRemovalConsentVersion: CONSENT_POLICY_VERSION
    }
  }, parseUploadSession);

export const reissueUploadCredential = (sessionId: string): Promise<IssuedUploadTarget> =>
  authenticatedRequest({
    method: "POST",
    url: `/v1/uploads/${sessionPath(sessionId)}/credentials`,
    data: {}
  }, parseIssuedUploadTarget);

export const completeUpload = (sessionId: string, etag: string): Promise<UploadCompletion> =>
  authenticatedRequest({
    method: "POST",
    url: `/v1/uploads/${sessionPath(sessionId)}/complete`,
    data: { etag }
  }, parseUploadCompletion);

export const getUploadStatus = (sessionId: string): Promise<UploadStatus> =>
  authenticatedRequest({
    method: "GET",
    url: `/v1/uploads/${sessionPath(sessionId)}`
  }, parseUploadStatus);

export const cancelUpload = (sessionId: string): Promise<void> =>
  authenticatedRequest({
    method: "DELETE",
    url: `/v1/uploads/${sessionPath(sessionId)}`
  }, (value) => {
    if (value !== undefined && value !== null && value !== "") invalidResponse();
  });

export function readUploadResume(): StoredUploadResume | undefined {
  const stored = wx.getStorageSync(RESUME_STORAGE_KEY) as unknown;
  if (stored === undefined || stored === null || stored === "") return undefined;
  try {
    return parseUploadResume(stored);
  } catch {
    wx.removeStorageSync(RESUME_STORAGE_KEY);
    return undefined;
  }
}

export function writeUploadResume(value: StoredUploadResume): void {
  wx.setStorageSync(RESUME_STORAGE_KEY, parseUploadResume(value));
}

export function clearUploadResume(): void {
  wx.removeStorageSync(RESUME_STORAGE_KEY);
}

export const wechatPutTransport: UploadTransport = {
  async putFile({ filePath, target }) {
    const data = await readFileBytes(filePath);
    return requestPut(data, target);
  }
};

const defaultUploadDependencies: UploadDependencies = {
  now: () => new Date(),
  createSession: createUploadSession,
  reissue: reissueUploadCredential,
  transport: wechatPutTransport,
  complete: completeUpload,
  getStatus: getUploadStatus,
  persistResume: writeUploadResume
};

export async function uploadSelectedPhoto(
  photo: LocalPhoto,
  dependencies: UploadDependencies = defaultUploadDependencies
): Promise<UploadStatus> {
  const validation = validateLocalFile(photo);
  if (!validation.allowed) throw new Error(validation.code);

  const session = await dependencies.createSession(photo);
  let target: IssuedUploadTarget = {
    ...session.upload,
    expiresAt: session.credentialExpiresAt
  };
  let uploaded: { etag: string };
  try {
    uploaded = await dependencies.transport.putFile({ filePath: photo.path, target });
  } catch (error) {
    if (!credentialCanBeReissued(error, target.expiresAt, dependencies.now())) throw error;
    target = await dependencies.reissue(session.sessionId);
    uploaded = await dependencies.transport.putFile({ filePath: photo.path, target });
  }

  await dependencies.complete(session.sessionId, uploaded.etag);
  const status = await dependencies.getStatus(session.sessionId);
  if (["UPLOADED", "NORMALIZING", "REVIEWING"].includes(status.state)) {
    dependencies.persistResume({
      sessionId: session.sessionId,
      state: status.state === "UPLOADED" ? "UPLOADED" : "PROCESSING",
      updatedAt: dependencies.now().toISOString()
    });
  }
  return status;
}

function credentialCanBeReissued(error: unknown, expiresAt: string, now: Date): boolean {
  return error instanceof Error &&
    (error.message === "UPLOAD_HTTP_401" || error.message === "UPLOAD_HTTP_403") &&
    now.getTime() >= Date.parse(expiresAt);
}

function readFileBytes(filePath: string): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    let settled = false;
    wx.getFileSystemManager().readFile({
      filePath,
      success(result) {
        if (settled) return;
        settled = true;
        if (!(result.data instanceof ArrayBuffer)) {
          reject(new Error("UPLOAD_FILE_READ_FAILED"));
          return;
        }
        resolve(result.data);
      },
      fail() {
        if (settled) return;
        settled = true;
        reject(new Error("UPLOAD_FILE_READ_FAILED"));
      }
    });
  });
}

function requestPut(data: ArrayBuffer, target: IssuedUploadTarget): Promise<{ etag: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    wx.request({
      method: "PUT",
      url: target.url,
      data,
      header: target.headers,
      success(response) {
        if (settled) return;
        settled = true;
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(response.statusCode === 401
            ? "UPLOAD_HTTP_401"
            : response.statusCode === 403 ? "UPLOAD_HTTP_403" : "UPLOAD_HTTP_ERROR"));
          return;
        }
        const etag = responseHeader(response.header, "etag");
        if (!etag) {
          reject(new Error("UPLOAD_ETAG_MISSING"));
          return;
        }
        resolve({ etag: normalizeEtag(etag) });
      },
      fail() {
        if (settled) return;
        settled = true;
        reject(new Error("UPLOAD_NETWORK_ERROR"));
      }
    });
  });
}

function responseHeader(headers: Record<string, unknown>, name: string): string | undefined {
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name);
  const value = key ? headers[key] : undefined;
  return typeof value === "string" ? value : undefined;
}

function normalizeEtag(value: string): string {
  return value.trim().replace(/^"([^"]*)"$/, "$1");
}

function parseUploadSession(value: unknown): UploadSession {
  const record = exactRecord(value, ["sessionId", "state", "expiresAt", "credentialExpiresAt", "upload"]);
  const upload = exactRecord(record.upload, ["url", "method", "headers"]);
  return {
    sessionId: uuid(record.sessionId),
    state: uploadState(record.state),
    expiresAt: isoDate(record.expiresAt),
    credentialExpiresAt: isoDate(record.credentialExpiresAt),
    upload: {
      url: httpUrl(upload.url),
      method: putMethod(upload.method),
      headers: stringRecord(upload.headers)
    }
  };
}

function parseIssuedUploadTarget(value: unknown): IssuedUploadTarget {
  const record = exactRecord(value, ["url", "method", "headers", "expiresAt"]);
  return {
    url: httpUrl(record.url),
    method: putMethod(record.method),
    headers: stringRecord(record.headers),
    expiresAt: isoDate(record.expiresAt)
  };
}

function parseUploadCompletion(value: unknown): UploadCompletion {
  const record = exactRecord(value, ["sessionId", "state"]);
  const state = uploadState(record.state);
  if (!["UPLOADED", "NORMALIZING", "REVIEWING", "APPROVED"].includes(state)) invalidResponse();
  return { sessionId: uuid(record.sessionId), state: state as UploadCompletion["state"] };
}

function parseUploadStatus(value: unknown): UploadStatus {
  if (!isRecord(value)) invalidResponse();
  const allowed = ["sessionId", "state", "assetId", "qualityWarning", "failureCode"];
  if (Object.keys(value).some((key) => !allowed.includes(key))) invalidResponse();
  const result: UploadStatus = {
    sessionId: uuid(value.sessionId),
    state: uploadState(value.state)
  };
  if (value.assetId !== undefined) result.assetId = uuid(value.assetId);
  if (value.qualityWarning !== undefined) {
    if (typeof value.qualityWarning !== "boolean") invalidResponse();
    result.qualityWarning = value.qualityWarning;
  }
  if (value.failureCode !== undefined) {
    if (typeof value.failureCode !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/.test(value.failureCode)) invalidResponse();
    result.failureCode = value.failureCode;
  }
  return result;
}

function parseUploadResume(value: unknown): StoredUploadResume {
  const record = exactRecord(value, ["sessionId", "state", "updatedAt"]);
  if (record.state !== "UPLOADED" && record.state !== "PROCESSING") invalidResponse();
  return { sessionId: uuid(record.sessionId), state: record.state, updatedAt: isoDate(record.updatedAt) };
}

function sessionPath(value: string): string {
  return encodeURIComponent(uuid(value));
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(value)) invalidResponse();
  const actual = Object.keys(value);
  if (actual.length !== keys.length || !keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))) {
    invalidResponse();
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function uuid(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    invalidResponse();
  }
  return value;
}

function isoDate(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalidResponse();
  return value;
}

function uploadState(value: unknown): UploadState {
  if (typeof value !== "string" || !uploadStates.has(value as UploadState)) invalidResponse();
  return value as UploadState;
}

function putMethod(value: unknown): "PUT" {
  if (value !== "PUT") invalidResponse();
  return "PUT";
}

function httpUrl(value: unknown): string {
  if (typeof value !== "string") invalidResponse();
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") invalidResponse();
  } catch {
    invalidResponse();
  }
  return value;
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value) || !Object.values(value).every((item) => typeof item === "string")) invalidResponse();
  return value as Record<string, string>;
}

function invalidResponse(): never {
  throw new Error("API_RESPONSE_INVALID");
}
