const API_BASE = "http://127.0.0.1:3100";
const SESSION_STORAGE_KEY = "photo-ai:session";
const DEVICE_STORAGE_KEY = "photo-ai:device-id";
const APPROVED_POLICY_VERSION = "2026-08-02";
const PRIVACY_PAGE = "/pages/privacy/index";
const MAX_ACCESS_LIFETIME_MS = 2 * 60 * 60 * 1000;
const MAX_REFRESH_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const refreshFlights = new Map();
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasExactKeys(value, expected) {
    const keys = Object.keys(value);
    return keys.length === expected.length && expected.every((key) => (Object.prototype.hasOwnProperty.call(value, key)));
}
function dateTime(value) {
    if (typeof value !== "string")
        return undefined;
    const time = Date.parse(value);
    if (!Number.isFinite(time) || new Date(time).toISOString() !== value)
        return undefined;
    return { value, time };
}
function parseSessionPair(value, allowExpiredAccess = false) {
    if (!isRecord(value))
        throw new Error("API_RESPONSE_INVALID");
    const accessExpiry = dateTime(value.accessExpiresAt);
    const refreshExpiry = dateTime(value.refreshExpiresAt);
    const now = Date.now();
    if (!hasExactKeys(value, [
        "accessToken",
        "accessExpiresAt",
        "refreshToken",
        "refreshExpiresAt"
    ]) ||
        typeof value.accessToken !== "string" ||
        value.accessToken.length === 0 ||
        !accessExpiry ||
        typeof value.refreshToken !== "string" ||
        value.refreshToken.length === 0 ||
        !refreshExpiry ||
        (!allowExpiredAccess && accessExpiry.time <= now) ||
        accessExpiry.time > now + MAX_ACCESS_LIFETIME_MS ||
        refreshExpiry.time <= now ||
        refreshExpiry.time > now + MAX_REFRESH_LIFETIME_MS ||
        accessExpiry.time > refreshExpiry.time) {
        throw new Error("API_RESPONSE_INVALID");
    }
    return {
        accessToken: value.accessToken,
        accessExpiresAt: accessExpiry.value,
        refreshToken: value.refreshToken,
        refreshExpiresAt: refreshExpiry.value
    };
}
function parseConsent(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, ["policyVersion", "metadataRemoval"]) ||
        value.policyVersion !== APPROVED_POLICY_VERSION ||
        value.metadataRemoval !== true) {
        throw new Error("CONSENT_INVALID");
    }
    return {
        policyVersion: value.policyVersion,
        metadataRemoval: true
    };
}
function storedSession() {
    const value = wx.getStorageSync(SESSION_STORAGE_KEY);
    if (value === undefined || value === null || value === "")
        return undefined;
    try {
        return parseSessionPair(value, true);
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
    try {
        const refreshed = await identityRequest("/v1/sessions/refresh", {
            refreshToken: pair.refreshToken,
            deviceId: stableDeviceId()
        });
        const current = storedSession();
        if (current && !samePair(current, pair)) {
            return { pair: current, sourceReplaced: true };
        }
        if (current)
            wx.setStorageSync(SESSION_STORAGE_KEY, refreshed);
        return { pair: refreshed, sourceReplaced: false };
    }
    catch (error) {
        const current = storedSession();
        if (current && !samePair(current, pair)) {
            return { pair: current, sourceReplaced: true };
        }
        throw error;
    }
}
function samePair(left, right) {
    return left.accessToken === right.accessToken &&
        left.accessExpiresAt === right.accessExpiresAt &&
        left.refreshToken === right.refreshToken &&
        left.refreshExpiresAt === right.refreshExpiresAt;
}
function refreshSingleFlight(pair) {
    const key = pair.refreshToken;
    const existing = refreshFlights.get(key);
    if (existing)
        return existing;
    let flight;
    flight = refreshSession(pair).finally(() => {
        if (refreshFlights.get(key) === flight)
            refreshFlights.delete(key);
    });
    refreshFlights.set(key, flight);
    return flight;
}
function returnToPrivacy(code, expected) {
    const current = storedSession();
    if (!expected || !current || samePair(current, expected)) {
        wx.removeStorageSync(SESSION_STORAGE_KEY);
        wx.reLaunch({ url: PRIVACY_PAGE });
    }
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
    let requestPair = current;
    let proactivelyRefreshed = false;
    let refreshSourceReplaced = false;
    if (Date.parse(current.accessExpiresAt) <= Date.now()) {
        proactivelyRefreshed = true;
        try {
            const result = await refreshSingleFlight(current);
            requestPair = result.pair;
            refreshSourceReplaced = result.sourceReplaced;
        }
        catch {
            throw returnToPrivacy("SESSION_EXPIRED", current);
        }
    }
    const first = await protectedRequest(options, requestPair.accessToken);
    if (first.statusCode !== 401)
        return parseProtectedResponse(first, parse);
    if (proactivelyRefreshed) {
        throw returnToPrivacy("SESSION_EXPIRED", refreshSourceReplaced ? current : requestPair);
    }
    const latest = storedSession();
    if (latest && !samePair(latest, current)) {
        const retryWithLatest = await protectedRequest(options, latest.accessToken);
        if (retryWithLatest.statusCode === 401) {
            throw returnToPrivacy("SESSION_EXPIRED", latest);
        }
        return parseProtectedResponse(retryWithLatest, parse);
    }
    let refreshed;
    try {
        refreshed = await refreshSingleFlight(current);
    }
    catch {
        throw returnToPrivacy("SESSION_EXPIRED", current);
    }
    const retry = await protectedRequest(options, refreshed.pair.accessToken);
    if (retry.statusCode === 401) {
        throw returnToPrivacy("SESSION_EXPIRED", refreshed.sourceReplaced ? current : refreshed.pair);
    }
    return parseProtectedResponse(retry, parse);
}
