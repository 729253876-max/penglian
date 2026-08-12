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
