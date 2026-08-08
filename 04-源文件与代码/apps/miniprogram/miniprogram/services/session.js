const API_BASE = "http://127.0.0.1:3100";
const SESSION_STORAGE_KEY = "photo-ai:session";
const DEVICE_STORAGE_KEY = "photo-ai:device-id";
const APPROVED_POLICY_VERSION = "2026-08-02";
const PRIVACY_PAGE = "/pages/privacy/index";
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasExactKeys(value, expected) {
    const keys = Object.keys(value);
    return keys.length === expected.length && expected.every((key) => (Object.prototype.hasOwnProperty.call(value, key)));
}
function isDateTime(value) {
    return (typeof value === "string" &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) &&
        Number.isFinite(Date.parse(value)));
}
function parseSessionPair(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, [
            "accessToken",
            "accessExpiresAt",
            "refreshToken",
            "refreshExpiresAt"
        ]) ||
        typeof value.accessToken !== "string" ||
        value.accessToken.length === 0 ||
        !isDateTime(value.accessExpiresAt) ||
        typeof value.refreshToken !== "string" ||
        value.refreshToken.length === 0 ||
        !isDateTime(value.refreshExpiresAt)) {
        throw new Error("API_RESPONSE_INVALID");
    }
    return {
        accessToken: value.accessToken,
        accessExpiresAt: value.accessExpiresAt,
        refreshToken: value.refreshToken,
        refreshExpiresAt: value.refreshExpiresAt
    };
}
function parseConsent(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, ["policyVersion", "metadataRemoval"]) ||
        value.policyVersion !== APPROVED_POLICY_VERSION ||
        typeof value.metadataRemoval !== "boolean") {
        throw new Error("CONSENT_INVALID");
    }
    return {
        policyVersion: value.policyVersion,
        metadataRemoval: value.metadataRemoval
    };
}
function storedSession() {
    const value = wx.getStorageSync(SESSION_STORAGE_KEY);
    if (value === undefined || value === null || value === "")
        return undefined;
    try {
        return parseSessionPair(value);
    }
    catch {
        wx.removeStorageSync(SESSION_STORAGE_KEY);
        return undefined;
    }
}
function stableDeviceId() {
    const stored = wx.getStorageSync(DEVICE_STORAGE_KEY);
    if (typeof stored === "string" &&
        stored.length <= 128 &&
        /^device-[a-z0-9-]+$/.test(stored)) {
        return stored;
    }
    const randomPart = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)
        .toString(36)
        .padStart(11, "0");
    const deviceId = `device-${Date.now().toString(36)}-${randomPart}`;
    wx.setStorageSync(DEVICE_STORAGE_KEY, deviceId);
    return deviceId;
}
function wxLogin() {
    return new Promise((resolve, reject) => {
        let settled = false;
        wx.login({
            success(result) {
                if (settled)
                    return;
                settled = true;
                if (typeof result.code !== "string" || result.code.length === 0) {
                    reject(new Error("WECHAT_LOGIN_FAILED"));
                    return;
                }
                resolve(result.code);
            },
            fail() {
                if (settled)
                    return;
                settled = true;
                reject(new Error("WECHAT_LOGIN_FAILED"));
            }
        });
    });
}
function rawRequest(options) {
    return new Promise((resolve, reject) => {
        let settled = false;
        wx.request({
            ...options,
            success(response) {
                if (settled)
                    return;
                settled = true;
                resolve({ statusCode: response.statusCode, data: response.data });
            },
            fail(error) {
                if (settled)
                    return;
                settled = true;
                reject(error);
            }
        });
    });
}
function apiUrl(path) {
    return `${API_BASE}${path}`;
}
async function identityRequest(path, data) {
    const response = await rawRequest({
        method: "POST",
        url: apiUrl(path),
        data
    });
    if (response.statusCode < 200 || response.statusCode >= 300) {
        throw new Error(`API_${response.statusCode}`);
    }
    return parseSessionPair(response.data);
}
async function refreshSession(pair) {
    const refreshed = await identityRequest("/v1/sessions/refresh", {
        refreshToken: pair.refreshToken,
        deviceId: stableDeviceId()
    });
    wx.setStorageSync(SESSION_STORAGE_KEY, refreshed);
    return refreshed;
}
function returnToPrivacy(code) {
    wx.removeStorageSync(SESSION_STORAGE_KEY);
    wx.reLaunch({ url: PRIVACY_PAGE });
    return new Error(code);
}
function protectedRequest(options, accessToken) {
    return rawRequest({
        ...options,
        url: apiUrl(options.url),
        header: {
            ...(options.header ?? {}),
            Authorization: `Bearer ${accessToken}`
        }
    });
}
function parseProtectedResponse(response, parse) {
    if (response.statusCode < 200 || response.statusCode >= 300) {
        throw new Error(`API_${response.statusCode}`);
    }
    try {
        return parse(response.data);
    }
    catch {
        throw new Error("API_RESPONSE_INVALID");
    }
}
export async function ensureSession(input) {
    const consent = parseConsent(input);
    const current = storedSession();
    if (current && Date.parse(current.accessExpiresAt) > Date.now()) {
        return current;
    }
    if (current)
        wx.removeStorageSync(SESSION_STORAGE_KEY);
    const code = await wxLogin();
    const pair = await identityRequest("/v1/identity/wechat", {
        code,
        deviceId: stableDeviceId(),
        consent
    });
    wx.setStorageSync(SESSION_STORAGE_KEY, pair);
    return pair;
}
export async function authenticatedRequest(options, parse) {
    const current = storedSession();
    if (!current)
        throw returnToPrivacy("SESSION_REQUIRED");
    const first = await protectedRequest(options, current.accessToken);
    if (first.statusCode !== 401)
        return parseProtectedResponse(first, parse);
    let refreshed;
    try {
        refreshed = await refreshSession(current);
    }
    catch {
        throw returnToPrivacy("SESSION_EXPIRED");
    }
    const retry = await protectedRequest(options, refreshed.accessToken);
    if (retry.statusCode === 401) {
        throw returnToPrivacy("SESSION_EXPIRED");
    }
    return parseProtectedResponse(retry, parse);
}
