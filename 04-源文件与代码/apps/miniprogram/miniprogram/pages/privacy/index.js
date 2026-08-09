import { ensureSession } from "../../services/session";
function isChecked(value) {
    return value === true || (Array.isArray(value) && value.includes("accepted"));
}
function loginFailureMessage(error) {
    const code = error instanceof Error ? error.message : "";
    if (code === "WECHAT_LOGIN_FAILED")
        return "微信登录未完成，请重试。";
    if (code.startsWith("API_") || code === "WECHAT_UNAVAILABLE") {
        return "登录服务暂时不可用，请稍后重试。";
    }
    return "网络连接失败，请检查网络后重试。";
}
Page({
    data: {
        privacyAccepted: false,
        metadataRemoval: false,
        submitting: false,
        error: ""
    },
    setPrivacyAccepted(event) {
        this.setData({
            privacyAccepted: isChecked(event.detail.value),
            error: ""
        });
    },
    setMetadataRemoval(event) {
        this.setData({
            metadataRemoval: isChecked(event.detail.value),
            error: ""
        });
    },
    async continueUpload() {
        if (this.data.submitting)
            return;
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
        }
        catch (error) {
            this.setData({
                submitting: false,
                error: loginFailureMessage(error)
            });
        }
    },
    decline() {
        if (this.data.submitting)
            return;
        wx.reLaunch({ url: "/pages/home/index" });
    }
});
