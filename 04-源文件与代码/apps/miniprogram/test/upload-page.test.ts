import { afterEach, describe, expect, it, vi } from "vitest";

type PageConfig = Record<string, any> & { data?: Record<string, unknown> };

const upload = vi.hoisted(() => ({
  uploadSelectedPhoto: vi.fn(),
  readUploadResume: vi.fn(),
  clearUploadResume: vi.fn(),
  pollUploadStatus: vi.fn(),
  uploadFailureMessage: vi.fn(() => "安全错误文案"),
  cancelUpload: vi.fn()
}));

vi.mock("../miniprogram/services/upload", () => upload);

function pageInstance(config: PageConfig) {
  return Object.assign({
    data: structuredClone(config.data ?? {}),
    setData(patch: Record<string, unknown>) { Object.assign(this.data, patch); }
  }, config);
}

async function loadPage(): Promise<PageConfig> {
  let config: PageConfig | undefined;
  vi.stubGlobal("Page", (definition: PageConfig) => { config = definition; });
  vi.stubGlobal("wx", {
    chooseMedia: vi.fn(),
    navigateTo: vi.fn(),
    navigateBack: vi.fn()
  });
  await import("../miniprogram/pages/upload/index");
  if (!config) throw new Error("upload page was not registered");
  return config;
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("private upload page", () => {
  const approvedAssetId = "22222222-2222-4222-8222-222222222222";

  it("starts idle without reading a photo or exposing private fields", async () => {
    const page = pageInstance(await loadPage());
    expect(page.data).toMatchObject({ phase: "IDLE", busy: false, canRetry: false, canContinue: false });
    expect(page.data).not.toHaveProperty("filePath");
    expect(page.data).not.toHaveProperty("uploadUrl");
  });

  it("chooses one original image and presents the returned upload state", async () => {
    const config = await loadPage();
    vi.mocked(wx.chooseMedia).mockImplementationOnce((options) => {
      options.success?.({
        type: "image",
        tempFiles: [{ tempFilePath: "/tmp/photo.jpg", size: 1024, fileType: "image" }]
      });
    });
    upload.uploadSelectedPhoto.mockResolvedValueOnce({ sessionId: "s1", state: "APPROVED" });
    upload.pollUploadStatus.mockResolvedValueOnce({
      phase: "READY", title: "照片已准备好", detail: "可以继续精修。", canRetry: false, canContinue: true
    });
    const page = pageInstance(config);

    await page.choosePhoto();

    expect(wx.chooseMedia).toHaveBeenCalledWith(expect.objectContaining({
      count: 1, mediaType: ["image"], sizeType: ["original"], sourceType: ["album", "camera"]
    }));
    expect(upload.uploadSelectedPhoto).toHaveBeenCalledWith({ path: "/tmp/photo.jpg", name: "photo.jpg", size: 1024 });
    expect(page.data).toMatchObject({ phase: "READY", busy: false, canContinue: true });
    expect(page.data).not.toHaveProperty("filePath");
  });

  it("guards repeated taps and maps failures without raw error leakage", async () => {
    const config = await loadPage();
    const page = pageInstance(config);
    page.data.busy = true;
    await page.choosePhoto();
    expect(wx.chooseMedia).not.toHaveBeenCalled();

    page.data.busy = false;
    vi.mocked(wx.chooseMedia).mockImplementationOnce((options) => options.fail?.({ errMsg: "raw-secret" }));
    await page.choosePhoto();
    expect(page.data.error).toBe("安全错误文案");
    expect(page.data.error).not.toContain("raw-secret");
  });

  it("resumes only by stored session and aborts polling when hidden", async () => {
    upload.readUploadResume.mockReturnValueOnce({
      sessionId: "11111111-1111-4111-8111-111111111111",
      state: "PROCESSING",
      updatedAt: "2030-01-02T03:04:05.000Z"
    });
    let observedSignal: AbortSignal | undefined;
    upload.pollUploadStatus.mockImplementationOnce(async (_id, control) => {
      observedSignal = control.signal;
      return { phase: "RECHECKING", title: "正在检查", detail: "请稍候", canRetry: false, canContinue: false };
    });
    const page = pageInstance(await loadPage());

    await page.onLoad();
    expect(upload.pollUploadStatus).toHaveBeenCalledTimes(1);
    expect(wx.chooseMedia).not.toHaveBeenCalled();
    expect(upload.uploadSelectedPhoto).not.toHaveBeenCalled();
    page.onHide();
    expect(observedSignal?.aborted).toBe(true);
  });

  it("cancels the recoverable session and continues only from a ready state", async () => {
    upload.readUploadResume.mockReturnValue({
      sessionId: "11111111-1111-4111-8111-111111111111",
      state: "UPLOADED",
      updatedAt: "2030-01-02T03:04:05.000Z"
    });
    const page = pageInstance(await loadPage());
    await page.cancel();
    expect(upload.cancelUpload).toHaveBeenCalled();
    expect(upload.clearUploadResume).toHaveBeenCalled();

    page.continueEditing();
    expect(wx.navigateTo).not.toHaveBeenCalled();
    page.data.canContinue = true;
    page.continueEditing();
    expect(wx.navigateTo).not.toHaveBeenCalled();
    page.data.assetId = approvedAssetId;
    page.continueEditing();
    expect(wx.navigateTo).toHaveBeenCalledWith({
      url: `/pages/plan/index?assetId=${encodeURIComponent(approvedAssetId)}`
    });
  });
});
