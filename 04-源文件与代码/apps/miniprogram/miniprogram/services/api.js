import { parseEditTraceEvent, parseTaskSnapshot } from "./runtime-contracts.js";
const API_BASE = "http://127.0.0.1:3100";
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
function request(options, parse) {
    return new Promise((resolve, reject) => {
        wx.request({
            ...options,
            url: `${API_BASE}${options.url}`,
            success(response) {
                if (response.statusCode >= 200 && response.statusCode < 300) {
                    try {
                        resolve(parse(response.data));
                    }
                    catch {
                        reject(new Error("API_RESPONSE_INVALID"));
                    }
                    return;
                }
                reject(new Error(`API_${response.statusCode}`));
            },
            fail: reject
        });
    });
}
function taskPath(taskId) {
    return encodeURIComponent(taskId);
}
export const createTask = (input) => request({
    method: "POST",
    url: "/v1/tasks",
    data: input
}, parseTaskSnapshot);
export const runPreview = (taskId) => request({
    method: "POST",
    url: `/v1/tasks/${taskPath(taskId)}/preview`,
    data: {}
}, parseTaskSnapshot);
export const getTask = (taskId) => request({
    method: "GET",
    url: `/v1/tasks/${taskPath(taskId)}`
}, parseTaskSnapshot);
export const getEvents = (taskId, afterSequence) => {
    if (!isNonNegativeSafeInteger(afterSequence)) {
        return Promise.reject(new Error("INVALID_AFTER_SEQUENCE"));
    }
    return request({
        method: "GET",
        url: `/v1/tasks/${taskPath(taskId)}/events?afterSequence=${afterSequence}`
    }, parseEventPage(taskId, afterSequence));
};
