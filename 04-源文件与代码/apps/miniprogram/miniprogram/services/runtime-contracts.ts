import type { EditTraceEvent, TaskSnapshot } from "@photo-ai/contracts";

type EventType =
  | "ASSET_APPROVED" | "DIAGNOSIS_STARTED" | "DIAGNOSIS_FINDING"
  | "PROTECTION_RECORDED" | "PLAN_READY" | "PLAN_SELECTED"
  | "STAGE_STARTED" | "PARAM_DIRECTION_APPLIED" | "STAGE_COMPLETED"
  | "QUALITY_CHECK_STARTED" | "QUALITY_CHECK_PASSED" | "QUALITY_CHECK_FAILED"
  | "RETRY_STARTED" | "PREVIEW_READY" | "TASK_FAILED";
type EventPhase = "UPLOAD" | "DIAGNOSIS" | "PLAN" | "RETOUCH" | "QUALITY" | "DELIVERY";

const taskStatuses = new Set<string>([
  "REVIEWING", "DIAGNOSING", "AWAITING_CONFIRMATION", "QUEUED",
  "PROCESSING", "QUALITY_CHECKING", "SUCCEEDED", "FAILED", "REJECTED", "CANCELED"
]);
const toolTypes = new Set<string>([
  "PORTRAIT_RETOUCH", "QUALITY_ENHANCE", "OBJECT_REMOVAL", "OLD_PHOTO_RESTORE"
]);
const directions = new Set<string>(["NATURAL_RESCUE", "CLEAR_RESCUE"]);
const findings = new Set<string>([
  "FACE_UNDEREXPOSED", "BACKGROUND_HIGHLIGHT", "SKIN_TONE_GRAY", "LIGHT_NOISE", "LIGHT_BLUR"
]);
const protections = new Set<string>([
  "IDENTITY", "FACIAL_STRUCTURE", "HAIR", "CLOTHING", "POSE", "SUBJECT_COUNT", "COMPOSITION"
]);
const fidelityChecks = new Set<string>([
  "FACE_COUNT", "IDENTITY", "STRUCTURE", "NON_TARGET_REGION", "ARTIFACTS"
]);
const failureCodes = new Set<string>([
  "PREVIEW_PROVIDER_FAILED", "FIDELITY_GATE_FAILED", "PORTRAIT_NOT_SUITABLE", "ASSET_NOT_APPROVED"
]);
const evidenceSources = new Set<string>([
  "SYSTEM_CHECK", "USER_SELECTION", "PROVIDER_RECEIPT", "QUALITY_GATE"
]);
const visibilities = new Set<string>(["PREVIEW", "UNLOCKED"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function isAbsoluteUrl(value: unknown): value is string {
  return typeof value === "string" && /^https?:\/\/[^\s]+$/.test(value);
}
function isDateTime(value: unknown): value is string {
  return typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) &&
    Number.isFinite(Date.parse(value));
}
function hasExactlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));
}
function isEnumArray(value: unknown, allowed: ReadonlySet<string>, allowEmpty = false): boolean {
  return Array.isArray(value) && (allowEmpty || value.length > 0) &&
    value.every((item) => typeof item === "string" && allowed.has(item));
}

type EventRule = {
  phase: EventPhase;
  copyKey: string | readonly string[];
  evidenceSources: readonly string[];
  validatePayload: (value: unknown) => boolean;
};

const emptyPayload = (value: unknown) => isRecord(value) && hasExactlyKeys(value, []);
const eventRules: Record<EventType, EventRule> = {
  ASSET_APPROVED: {
    phase: "UPLOAD", copyKey: "upload.asset.approved", evidenceSources: ["SYSTEM_CHECK"],
    validatePayload: (value) => isRecord(value) && hasExactlyKeys(value, ["metadataRemoved"]) && value.metadataRemoved === true
  },
  DIAGNOSIS_STARTED: {
    phase: "DIAGNOSIS", copyKey: "portrait.diagnosis.started", evidenceSources: ["SYSTEM_CHECK"], validatePayload: emptyPayload
  },
  DIAGNOSIS_FINDING: {
    phase: "DIAGNOSIS", copyKey: "portrait.diagnosis.light", evidenceSources: ["SYSTEM_CHECK"],
    validatePayload: (value) => isRecord(value) && hasExactlyKeys(value, ["finding"]) &&
      typeof value.finding === "string" && findings.has(value.finding)
  },
  PROTECTION_RECORDED: {
    phase: "DIAGNOSIS", copyKey: "portrait.protection.recorded", evidenceSources: ["SYSTEM_CHECK"],
    validatePayload: (value) => isRecord(value) && hasExactlyKeys(value, ["protections"]) &&
      isEnumArray(value.protections, protections)
  },
  PLAN_READY: {
    phase: "PLAN", copyKey: ["portrait.plan.natural", "portrait.plan.clear"], evidenceSources: ["SYSTEM_CHECK"],
    validatePayload: directionPayload
  },
  PLAN_SELECTED: {
    phase: "PLAN", copyKey: "portrait.plan.selected", evidenceSources: ["USER_SELECTION"],
    validatePayload: directionPayload
  },
  STAGE_STARTED: {
    phase: "RETOUCH", copyKey: "portrait.stage.retouch.started", evidenceSources: ["PROVIDER_RECEIPT"],
    validatePayload: stagePayload
  },
  PARAM_DIRECTION_APPLIED: {
    phase: "RETOUCH", copyKey: "portrait.parameter.direction", evidenceSources: ["PROVIDER_RECEIPT"],
    validatePayload: (value) => isRecord(value) && hasExactlyKeys(value, ["direction", "level"]) &&
      typeof value.direction === "string" && directions.has(value.direction) && value.level === "MODERATE"
  },
  STAGE_COMPLETED: {
    phase: "RETOUCH", copyKey: "portrait.stage.retouch.completed", evidenceSources: ["PROVIDER_RECEIPT"],
    validatePayload: stagePayload
  },
  QUALITY_CHECK_STARTED: {
    phase: "QUALITY", copyKey: "quality.started", evidenceSources: ["QUALITY_GATE"], validatePayload: emptyPayload
  },
  QUALITY_CHECK_PASSED: {
    phase: "QUALITY", copyKey: "quality.fidelity.passed", evidenceSources: ["QUALITY_GATE"],
    validatePayload: (value) => isRecord(value) && hasExactlyKeys(value, ["checks"]) &&
      isEnumArray(value.checks, fidelityChecks)
  },
  QUALITY_CHECK_FAILED: {
    phase: "QUALITY", copyKey: "quality.fidelity.failed", evidenceSources: ["QUALITY_GATE"],
    validatePayload: (value) => isRecord(value) && hasExactlyKeys(value, ["checks", "failedChecks"]) &&
      isEnumArray(value.checks, fidelityChecks) && isEnumArray(value.failedChecks, fidelityChecks)
  },
  RETRY_STARTED: {
    phase: "RETOUCH", copyKey: "portrait.retry.started", evidenceSources: ["SYSTEM_CHECK"],
    validatePayload: (value) => isRecord(value) && hasExactlyKeys(value, ["attempt"]) && value.attempt === 2
  },
  PREVIEW_READY: {
    phase: "DELIVERY", copyKey: "preview.ready", evidenceSources: ["QUALITY_GATE"],
    validatePayload: (value) => isRecord(value) && hasExactlyKeys(value, ["watermarked", "downloadable"]) &&
      value.watermarked === true && value.downloadable === false
  },
  TASK_FAILED: {
    phase: "DELIVERY", copyKey: "preview.provider.failed", evidenceSources: ["SYSTEM_CHECK", "QUALITY_GATE"],
    validatePayload: (value) => isRecord(value) && hasExactlyKeys(value, ["code"]) &&
      typeof value.code === "string" && failureCodes.has(value.code)
  }
};

function directionPayload(value: unknown): boolean {
  return isRecord(value) && hasExactlyKeys(value, ["direction"]) &&
    typeof value.direction === "string" && directions.has(value.direction);
}
function stagePayload(value: unknown): boolean {
  return isRecord(value) && hasExactlyKeys(value, ["stage"]) && value.stage === "LOCAL_LIGHT_AND_SKIN";
}

export function parseTaskSnapshot(value: unknown): TaskSnapshot {
  const keys = [
    "taskId", "status", "tool", "lastSequence", "previewUrl", "failureCode",
    "diagnosis", "selectedDirection", "noCharge"
  ];
  if (!isRecord(value) || !Object.keys(value).every((key) => keys.includes(key)) ||
      !isNonEmptyString(value.taskId) || typeof value.status !== "string" || !taskStatuses.has(value.status) ||
      typeof value.tool !== "string" || !toolTypes.has(value.tool) || !isNonNegativeSafeInteger(value.lastSequence) ||
      (value.previewUrl !== undefined && !isAbsoluteUrl(value.previewUrl)) ||
      (value.failureCode !== undefined && (typeof value.failureCode !== "string" || !failureCodes.has(value.failureCode))) ||
      (value.selectedDirection !== undefined && (typeof value.selectedDirection !== "string" || !directions.has(value.selectedDirection))) ||
      (value.noCharge !== undefined && value.noCharge !== true) ||
      (value.diagnosis !== undefined && !isDiagnosis(value.diagnosis))) {
    throw new Error("API_RESPONSE_INVALID");
  }
  return value as TaskSnapshot;
}

function isDiagnosis(value: unknown): boolean {
  return isRecord(value) && hasExactlyKeys(value, ["findings", "protections"]) &&
    isEnumArray(value.findings, findings, true) && isEnumArray(value.protections, protections, true);
}

export function parseEditTraceEvent(value: unknown): EditTraceEvent {
  const keys = [
    "eventId", "taskId", "sequence", "type", "phase", "occurredAt",
    "visibility", "evidenceSource", "copyKey", "payload"
  ];
  if (!isRecord(value) || !hasExactlyKeys(value, keys) || !isNonEmptyString(value.eventId) ||
      !isNonEmptyString(value.taskId) || !isNonNegativeSafeInteger(value.sequence) || value.sequence === 0 ||
      typeof value.type !== "string" || !Object.prototype.hasOwnProperty.call(eventRules, value.type) ||
      typeof value.phase !== "string" || !isDateTime(value.occurredAt) ||
      typeof value.visibility !== "string" || !visibilities.has(value.visibility) ||
      typeof value.evidenceSource !== "string" || !evidenceSources.has(value.evidenceSource) ||
      !isNonEmptyString(value.copyKey)) {
    throw new Error("API_RESPONSE_INVALID");
  }
  const rule = eventRules[value.type as EventType];
  const copyKeyAllowed = Array.isArray(rule.copyKey)
    ? rule.copyKey.includes(value.copyKey)
    : value.copyKey === rule.copyKey;
  const planDirection = isRecord(value.payload) ? value.payload.direction : undefined;
  const planPairAllowed = value.type !== "PLAN_READY" ||
    (value.copyKey === "portrait.plan.natural" &&
      planDirection === "NATURAL_RESCUE") ||
    (value.copyKey === "portrait.plan.clear" &&
      planDirection === "CLEAR_RESCUE");
  if (value.phase !== rule.phase || !copyKeyAllowed || !planPairAllowed ||
      !rule.evidenceSources.includes(value.evidenceSource) || !rule.validatePayload(value.payload)) {
    throw new Error("API_RESPONSE_INVALID");
  }
  return value as EditTraceEvent;
}
