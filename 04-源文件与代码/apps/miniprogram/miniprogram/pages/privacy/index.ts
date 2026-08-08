import { ensureSession } from "../../services/session";

function isChecked(value: unknown): boolean {
  return value === true || (Array.isArray(value) && value.includes("accepted"));
}

Page({
  data: {
    privacyAccepted: false,
    metadataRemoval: false,
    submitting: false,
    error: ""
  },

  setPrivacyAccepted(event: { detail: { value: unknown } }) {
    this.setData({
      privacyAccepted: isChecked(event.detail.value),
      error: ""
    });
  },

  setMetadataRemoval(event: { detail: { value: unknown } }) {
    this.setData({
      metadataRemoval: isChecked(event.detail.value),
      error: ""
    });
  },

  async continueUpload() {
    if (this.data.submitting) return;
    if (!this.data.privacyAccepted || !this.data.metadataRemoval) {
      this.setData({ error: "请先明确选择两项授权，再继续。" });
      return;
    }

    this.setData({ submitting: true, error: "" });
    try {
      await ensureSession({
        policyVersion: "2026-08-02",
        metadataRemoval: true
      });
      this.setData({ submitting: false });
      wx.navigateTo({ url: "/pages/plan/index" });
    } catch {
      this.setData({
        submitting: false,
        error: "暂时无法完成登录，请检查网络后重试。"
      });
    }
  },

  decline() {
    if (this.data.submitting) return;
    wx.navigateBack({ delta: 1 });
  }
});
