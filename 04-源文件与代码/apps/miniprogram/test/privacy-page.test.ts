import { afterEach, describe, expect, it, vi } from "vitest";

type PageConfig = Record<string, any> & { data?: Record<string, unknown> };

const session = {
  ensureSession: vi.fn()
};

vi.mock("../miniprogram/services/session", () => session);

function pageInstance(config: PageConfig) {
  const page = Object.assign({
    data: structuredClone(config.data ?? {}),
    setData(patch: Record<string, unknown>) {
      Object.assign(this.data, patch);
    }
  }, config);
  page.data = structuredClone(config.data ?? {});
  return page;
}

async function loadPrivacyPage(): Promise<PageConfig> {
  let config: PageConfig | undefined;
  vi.stubGlobal("Page", (definition: PageConfig) => { config = definition; });
  vi.stubGlobal("wx", {
    navigateBack: vi.fn(),
    reLaunch: vi.fn(),
    navigateTo: vi.fn()
  });
  await import("../miniprogram/pages/privacy/index");
  if (!config) throw new Error("privacy page was not registered");
  return config;
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("privacy consent page", () => {
  it("starts with both independent consent choices off", async () => {
    const config = await loadPrivacyPage();
    const page = pageInstance(config);

    expect(page.data.privacyAccepted).toBe(false);
    expect(page.data.metadataRemoval).toBe(false);
    expect(page.data.submitting).toBe(false);
  });

  it("does not start login when either explicit choice is missing", async () => {
    const config = await loadPrivacyPage();
    const page = pageInstance(config);

    await config.continueUpload.call(page);
    config.setPrivacyAccepted.call(page, { detail: { value: ["accepted"] } });
    await config.continueUpload.call(page);

    expect(session.ensureSession).not.toHaveBeenCalled();
    expect(wx.navigateTo).not.toHaveBeenCalled();
    expect(page.data.error).toContain("两项");
  });

  it("logs in only after both choices are explicitly selected", async () => {
    session.ensureSession.mockResolvedValueOnce({
      accessToken: "stored-access",
      accessExpiresAt: "2030-08-02T02:00:00.000Z",
      refreshToken: "stored-refresh",
      refreshExpiresAt: "2030-09-01T00:00:00.000Z"
    });
    const config = await loadPrivacyPage();
    const page = pageInstance(config);

    config.setPrivacyAccepted.call(page, { detail: { value: ["accepted"] } });
    config.setMetadataRemoval.call(page, { detail: { value: ["accepted"] } });
    await config.continueUpload.call(page);

    expect(page.data.privacyAccepted).toBe(true);
    expect(page.data.metadataRemoval).toBe(true);
    expect(session.ensureSession).toHaveBeenCalledWith({
      policyVersion: "2026-08-02",
      metadataRemoval: true
    });
    expect(wx.navigateTo).toHaveBeenCalledWith({ url: "/pages/plan/index" });
  });

  it("declines by reliably returning to anonymous home", async () => {
    const config = await loadPrivacyPage();
    const page = pageInstance(config);

    config.decline.call(page);

    expect(session.ensureSession).not.toHaveBeenCalled();
    expect(wx.reLaunch).toHaveBeenCalledWith({ url: "/pages/home/index" });
    expect(wx.navigateBack).not.toHaveBeenCalled();
    expect(wx.navigateTo).not.toHaveBeenCalled();
  });

  it("keeps the user on the page with an actionable token-free login error", async () => {
    session.ensureSession.mockRejectedValueOnce(new Error("access-token-secret"));
    const config = await loadPrivacyPage();
    const page = pageInstance(config);
    config.setPrivacyAccepted.call(page, { detail: { value: true } });
    config.setMetadataRemoval.call(page, { detail: { value: true } });

    await config.continueUpload.call(page);

    expect(page.data.submitting).toBe(false);
    expect(page.data.error).toContain("重试");
    expect(page.data.error).not.toContain("access-token-secret");
    expect(wx.navigateTo).not.toHaveBeenCalled();
  });

  it.each([
    ["WECHAT_LOGIN_FAILED", "微信登录未完成"],
    ["API_503", "登录服务暂时不可用"],
    ["WECHAT_NETWORK_ERROR", "网络连接失败"]
  ])("maps %s without leaking the original error", async (code, expected) => {
    session.ensureSession.mockRejectedValueOnce(new Error(code));
    const config = await loadPrivacyPage();
    const page = pageInstance(config);
    config.setPrivacyAccepted.call(page, { detail: { value: true } });
    config.setMetadataRemoval.call(page, { detail: { value: true } });

    await config.continueUpload.call(page);

    expect(page.data.error).toContain(expected);
    expect(page.data.error).not.toContain(code);
    expect(wx.navigateTo).not.toHaveBeenCalled();
  });
});
