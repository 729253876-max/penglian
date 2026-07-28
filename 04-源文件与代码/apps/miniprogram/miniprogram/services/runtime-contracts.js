const taskStatuses = new Set([
    "REVIEWING",
    "DIAGNOSING",
    "AWAITING_CONFIRMATION",
    "QUEUED",
    "PROCESSING",
    "QUALITY_CHECKING",
    "SUCCEEDED",
    "FAILED",
    "REJECTED",
    "CANCELED"
]);
const toolTypes = new Set([
    "PORTRAIT_RETOUCH",
    "QUALITY_ENHANCE",
    "OBJECT_REMOVAL",
    "OLD_PHOTO_RESTORE"
]);
const directions = new Set(["NATURAL", "BRIGHT", "WARM"]);
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
    return (typeof value === "string" &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) &&
        Number.isFinite(Date.parse(value)));
}
function hasOnlyKeys(value, allowedKeys) {
    const allowed = new Set(allowedKeys);
    return Object.keys(value).every((key) => allowed.has(key));
}
function isEmptyPayload(value) {
    return isRecord(value) && Object.keys(value).length === 0;
}
function isDiagnosisFindingPayload(value) {
    return (isRecord(value) &&
        hasOnlyKeys(value, ["finding"]) &&
        value.finding === "FACE_SHADOW_AND_BACKGROUND_HIGHLIGHT");
}
function isPlanReadyPayload(value) {
    return (isRecord(value) &&
        hasOnlyKeys(value, ["direction"]) &&
        typeof value.direction === "string" &&
        directions.has(value.direction));
}
function isStagePayload(value) {
    return (isRecord(value) &&
        hasOnlyKeys(value, ["stage"]) &&
        (value.stage === undefined || value.stage === "LOCAL_LIGHT_AND_SKIN"));
}
function isParameterDirectionPayload(value) {
    return (isRecord(value) &&
        hasOnlyKeys(value, ["direction", "level"]) &&
        typeof value.direction === "string" &&
        directions.has(value.direction) &&
        value.level === "MODERATE");
}
function isQualityPassedPayload(value) {
    return (isRecord(value) &&
        hasOnlyKeys(value, ["check"]) &&
        (value.check === undefined || value.check === "IDENTITY_CONSISTENCY"));
}
function isQualityFailedPayload(value) {
    return (isRecord(value) &&
        hasOnlyKeys(value, ["check", "code"]) &&
        (value.check === undefined || value.check === "IDENTITY_CONSISTENCY") &&
        (value.code === undefined || value.code === "IDENTITY_CHECK_FAILED"));
}
function isRetryStartedPayload(value) {
    return (isRecord(value) &&
        hasOnlyKeys(value, ["attempt"]) &&
        typeof value.attempt === "number" &&
        Number.isSafeInteger(value.attempt) &&
        value.attempt > 0 &&
        value.attempt <= 10);
}
function isPreviewReadyPayload(value) {
    return (isRecord(value) &&
        hasOnlyKeys(value, ["watermarked", "downloadable"]) &&
        value.watermarked === true &&
        value.downloadable === false);
}
function isTaskFailedPayload(value) {
    return (isRecord(value) &&
        hasOnlyKeys(value, ["code"]) &&
        value.code === "PREVIEW_PROVIDER_FAILED");
}
const eventRules = {
    DIAGNOSIS_STARTED: {
        phase: "DIAGNOSIS",
        copyKeys: ["portrait.diagnosis.started"],
        validatePayload: isEmptyPayload
    },
    DIAGNOSIS_FINDING: {
        phase: "DIAGNOSIS",
        copyKeys: ["portrait.diagnosis.light"],
        validatePayload: isDiagnosisFindingPayload
    },
    PLAN_READY: {
        phase: "PLAN",
        copyKeys: ["portrait.plan.natural"],
        validatePayload: isPlanReadyPayload
    },
    STAGE_STARTED: {
        phase: "RETOUCH",
        copyKeys: [
            "portrait.stage.retouch.started",
            "portrait.stage.retry.started"
        ],
        validatePayload: isStagePayload
    },
    STAGE_COMPLETED: {
        phase: "RETOUCH",
        copyKeys: ["portrait.stage.retouch.completed"],
        validatePayload: isStagePayload
    },
    PARAM_DIRECTION_APPLIED: {
        phase: "RETOUCH",
        copyKeys: ["portrait.parameter.direction"],
        validatePayload: isParameterDirectionPayload
    },
    QUALITY_CHECK_STARTED: {
        phase: "QUALITY",
        copyKeys: ["quality.started", "quality.retry.started"],
        validatePayload: isEmptyPayload
    },
    QUALITY_CHECK_PASSED: {
        phase: "QUALITY",
        copyKeys: ["quality.identity.passed"],
        validatePayload: isQualityPassedPayload
    },
    QUALITY_CHECK_FAILED: {
        phase: "QUALITY",
        copyKeys: ["quality.identity.failed"],
        validatePayload: isQualityFailedPayload
    },
    RETRY_STARTED: {
        phase: "RETOUCH",
        copyKeys: ["portrait.retry.started"],
        validatePayload: isRetryStartedPayload
    },
    PREVIEW_READY: {
        phase: "DELIVERY",
        copyKeys: ["preview.ready"],
        validatePayload: isPreviewReadyPayload
    },
    TASK_FAILED: {
        phase: "DELIVERY",
        copyKeys: ["preview.provider.failed"],
        validatePayload: isTaskFailedPayload
    }
};
export function parseTaskSnapshot(value) {
    if (!isRecord(value) ||
        !isNonEmptyString(value.taskId) ||
        typeof value.status !== "string" ||
        !taskStatuses.has(value.status) ||
        typeof value.tool !== "string" ||
        !toolTypes.has(value.tool) ||
        !isNonNegativeSafeInteger(value.lastSequence) ||
        (value.previewUrl !== undefined &&
            !isAbsoluteUrl(value.previewUrl)) ||
        (value.failureCode !== undefined &&
            typeof value.failureCode !== "string")) {
        throw new Error("API_RESPONSE_INVALID");
    }
    return {
        taskId: value.taskId,
        status: value.status,
        tool: value.tool,
        lastSequence: value.lastSequence,
        ...(typeof value.previewUrl === "string"
            ? { previewUrl: value.previewUrl }
            : {}),
        ...(typeof value.failureCode === "string"
            ? { failureCode: value.failureCode }
            : {})
    };
}
export function parseEditTraceEvent(value) {
    const eventKeys = [
        "eventId",
        "taskId",
        "sequence",
        "type",
        "phase",
        "occurredAt",
        "visibility",
        "copyKey",
        "payload"
    ];
    if (!isRecord(value) ||
        !hasOnlyKeys(value, eventKeys) ||
        Object.keys(value).length !== eventKeys.length ||
        !isNonEmptyString(value.eventId) ||
        !isNonEmptyString(value.taskId) ||
        !isNonNegativeSafeInteger(value.sequence) ||
        value.sequence === 0 ||
        typeof value.type !== "string" ||
        !Object.prototype.hasOwnProperty.call(eventRules, value.type) ||
        typeof value.phase !== "string" ||
        !isDateTime(value.occurredAt) ||
        typeof value.visibility !== "string" ||
        !visibilities.has(value.visibility) ||
        !isNonEmptyString(value.copyKey)) {
        throw new Error("API_RESPONSE_INVALID");
    }
    const type = value.type;
    const rule = eventRules[type];
    if (value.phase !== rule.phase ||
        !rule.copyKeys.includes(value.copyKey) ||
        !rule.validatePayload(value.payload)) {
        throw new Error("API_RESPONSE_INVALID");
    }
    return value;
}
