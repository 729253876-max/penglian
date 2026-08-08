import { parseEditTraceEvent, parseTaskSnapshot } from "./runtime-contracts.js";
import { authenticatedRequest } from "./session.js";
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isNonNegativeSafeInteger(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function parseEventPage(expectedTaskId, afterSequence) {
    return (value) => {
        if (!isRecord(value) || !Array.isArray(value.items) || !isNonNegativeSafeInteger(value.nextSequence)) {
            throw new Error("API_RESPONSE_INVALID");
        }
        let previousSequence = afterSequence;
        const items = value.items.map((event) => {
            const parsed = parseEditTraceEvent(event);
            if (parsed.taskId !== expectedTaskId ||
                parsed.sequence !== previousSequence + 1) {
                throw new Error("API_RESPONSE_INVALID");
            }
            previousSequence = parsed.sequence;
            return parsed;
        });
        if (value.nextSequence !== previousSequence) {
            throw new Error("API_RESPONSE_INVALID");
        }
        return { items, nextSequence: value.nextSequence };
    };
}
function taskPath(taskId) {
    return encodeURIComponent(taskId);
}
export const createTask = (input) => authenticatedRequest({
    method: "POST",
    url: "/v1/tasks",
    data: input
}, parseTaskSnapshot);
export const runPreview = (taskId) => authenticatedRequest({
    method: "POST",
    url: `/v1/tasks/${taskPath(taskId)}/preview`,
    data: {}
}, parseTaskSnapshot);
export const getTask = (taskId) => authenticatedRequest({
    method: "GET",
    url: `/v1/tasks/${taskPath(taskId)}`
}, parseTaskSnapshot);
export const getEvents = (taskId, afterSequence) => {
    if (!isNonNegativeSafeInteger(afterSequence)) {
        return Promise.reject(new Error("INVALID_AFTER_SEQUENCE"));
    }
    return authenticatedRequest({
        method: "GET",
        url: `/v1/tasks/${taskPath(taskId)}/events?afterSequence=${afterSequence}`
    }, parseEventPage(taskId, afterSequence));
};
