const taskStatuses = new Set([
    "REVIEWING", "DIAGNOSING", "AWAITING_CONFIRMATION", "QUEUED",
    "PROCESSING", "QUALITY_CHECKING", "SUCCEEDED", "FAILED", "REJECTED", "CANCELED"
]);
const toolTypes = new Set([
    "PORTRAIT_RETOUCH", "QUALITY_ENHANCE", "OBJECT_REMOVAL", "OLD_PHOTO_RESTORE"
]);
const directions = new Set(["NATURAL_RESCUE", "CLEAR_RESCUE"]);
const findings = new Set([
    "FACE_UNDEREXPOSED", "BACKGROUND_HIGHLIGHT", "SKIN_TONE_GRAY", "LIGHT_NOISE", "LIGHT_BLUR"
]);
const protections = new Set([
    "IDENTITY", "FACIAL_STRUCTURE", "HAIR", "CLOTHING", "POSE", "SUBJECT_COUNT", "COMPOSITION"
]);
const fidelityChecks = new Set([
    "FACE_COUNT", "IDENTITY", "STRUCTURE", "NON_TARGET_REGION", "ARTIFACTS"
]);
const failureCodes = new Set([
    "PREVIEW_PROVIDER_FAILED", "FIDELITY_GATE_FAILED", "PORTRAIT_NOT_SUITABLE", "ASSET_NOT_APPROVED"
]);
const evidenceSources = new Set([
    "SYSTEM_CHECK", "USER_SELECTION", "PROVIDER_RECEIPT", "QUALITY_GATE"
]);
const visibilities = new Set(["PREVIEW", "UNLOCKED"]);
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isNonEmptyString(value) {
    return typeof value === "string" && value.length > 0;
}
function isNonNegativeSafeInteger(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function isAbsoluteUrl(value) {
    return typeof value === "string" && /^https?:\/\/[^\s]+$/.test(value);
}
function isDateTime(value) {
    return typeof value === "string" &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) &&
        Number.isFinite(Date.parse(value));
}
function hasExactlyKeys(value, keys) {
    return Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));
}
function isEnumArray(value, allowed, allowEmpty = false) {
    return Array.isArray(value) && (allowEmpty || value.length > 0) &&
        value.every((item) => typeof item === "string" && allowed.has(item));
}
const emptyPayload = (value) => isRecord(value) && hasExactlyKeys(value, []);
const eventRules = {
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
function directionPayload(value) {
    return isRecord(value) && hasExactlyKeys(value, ["direction"]) &&
        typeof value.direction === "string" && directions.has(value.direction);
}
function stagePayload(value) {
    return isRecord(value) && hasExactlyKeys(value, ["stage"]) && value.stage === "LOCAL_LIGHT_AND_SKIN";
}
export function parseTaskSnapshot(value) {
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
    return value;
}
function isDiagnosis(value) {
    return isRecord(value) && hasExactlyKeys(value, ["findings", "protections"]) &&
        isEnumArray(value.findings, findings, true) && isEnumArray(value.protections, protections, true);
}
export function parseEditTraceEvent(value) {
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
    const rule = eventRules[value.type];
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
    return value;
}
