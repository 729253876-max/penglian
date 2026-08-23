import { cancelUpload, clearUploadResume, pollUploadStatus, readUploadResume, uploadFailureMessage, uploadSelectedPhoto } from "../../services/upload.js";
const runtimes = new WeakMap();
function runtimeFor(page) {
    const current = runtimes.get(page);
    if (current)
        return current;
    const runtime = { controller: undefined, sessionId: undefined, selectedPhoto: undefined };
    runtimes.set(page, runtime);
    return runtime;
}
function abortPolling(runtime) {
    runtime.controller?.abort();
    runtime.controller = undefined;
}
function wait(milliseconds, signal) {
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(new Error("UPLOAD_POLL_ABORTED"));
            return;
        }
        const timer = setTimeout(finish, milliseconds);
        function finish() {
            signal.removeEventListener("abort", cancel);
            resolve();
        }
        function cancel() {
            clearTimeout(timer);
            signal.removeEventListener("abort", cancel);
            reject(new Error("UPLOAD_POLL_ABORTED"));
        }
        signal.addEventListener("abort", cancel, { once: true });
    });
}
function chooseOriginalPhoto() {
    return new Promise((resolve, reject) => {
        wx.chooseMedia({
            count: 1,
            mediaType: ["image"],
            sizeType: ["original"],
            sourceType: ["album", "camera"],
            success(result) {
                const file = result.tempFiles[0];
                if (!file) {
                    reject(new Error("IMAGE_NOT_SELECTED"));
                    return;
                }
                const path = file.tempFilePath;
                const name = path.split(/[\\/]/).pop() || "photo.jpg";
                resolve({ path, name, size: file.size });
            },
            fail(error) {
                const message = typeof error.errMsg === "string" ? error.errMsg : "";
                if (message.includes("cancel")) {
                    resolve(undefined);
                    return;
                }
                reject(new Error("IMAGE_SELECTION_FAILED"));
            }
        });
    });
}
async function pollStoredSession(page, sessionId) {
    const runtime = runtimeFor(page);
    abortPolling(runtime);
    const controller = new AbortController();
    runtime.controller = controller;
    runtime.sessionId = sessionId;
    try {
        const presentation = await pollUploadStatus(sessionId, {
            signal: controller.signal,
            wait,
            maxPolls: 15
        });
        if (controller.signal.aborted || runtime.controller !== controller)
            return;
        applyPresentation(page, presentation);
        if (presentation.phase === "READY" || presentation.phase === "WARNING" || presentation.phase === "FAILED") {
            clearUploadResume();
            runtime.sessionId = undefined;
        }
    }
    catch (error) {
        if (controller.signal.aborted)
            return;
        page.setData({
            phase: "FAILED",
            busy: false,
            error: uploadFailureMessage(error),
            canRetry: true,
            canContinue: false,
            assetId: ""
        });
    }
    finally {
        if (runtime.controller === controller && controller.signal.aborted)
            runtime.controller = undefined;
    }
}
function applyPresentation(page, presentation) {
    page.setData({
        ...presentation,
        assetId: presentation.assetId ?? "",
        busy: false,
        progress: presentation.phase === "READY" || presentation.phase === "WARNING" ? 100 : 72,
        error: presentation.phase === "FAILED" ? presentation.detail : ""
    });
}
Page({
    data: {
        phase: "IDLE",
        busy: false,
        progress: 0,
        title: "上传自己的照片",
        detail: "原图仅用于本次处理",
        error: "",
        canRetry: false,
        canContinue: false,
        assetId: ""
    },
    async onLoad() {
        const resume = readUploadResume();
        if (!resume)
            return;
        this.setData({
            phase: "PROCESSING",
            busy: true,
            progress: 72,
            title: "正在恢复安全检查",
            detail: "只恢复处理记录，不会重新读取你的相册。",
            error: "",
            canRetry: false,
            canContinue: false
        });
        await pollStoredSession(this, resume.sessionId);
    },
    async onShow() {
        const runtime = runtimeFor(this);
        if (runtime.controller)
            return;
        const resume = readUploadResume();
        if (resume)
            await pollStoredSession(this, resume.sessionId);
    },
    onHide() {
        abortPolling(runtimeFor(this));
    },
    onUnload() {
        const page = this;
        const runtime = runtimeFor(page);
        abortPolling(runtime);
        runtime.selectedPhoto = undefined;
        runtimes.delete(page);
    },
    async choosePhoto() {
        if (this.data.busy)
            return;
        this.setData({ busy: true, error: "", canRetry: false, canContinue: false, assetId: "" });
        try {
            const photo = await chooseOriginalPhoto();
            if (!photo) {
                this.setData({ busy: false });
                return;
            }
            const runtime = runtimeFor(this);
            runtime.selectedPhoto = photo;
            this.setData({
                phase: "PROCESSING",
                progress: 24,
                title: "正在私密上传",
                detail: "离开本页前请保持网络连接。"
            });
            const status = await uploadSelectedPhoto(photo);
            runtime.selectedPhoto = undefined;
            runtime.sessionId = status.sessionId;
            this.setData({ progress: 72, title: "正在安全检查", detail: "上传已完成，正在确认照片是否适合处理。" });
            await pollStoredSession(this, status.sessionId);
        }
        catch (error) {
            runtimeFor(this).selectedPhoto = undefined;
            this.setData({
                phase: "FAILED",
                busy: false,
                progress: 0,
                title: "上传没有完成",
                detail: "可以重新选择照片后再试。",
                error: uploadFailureMessage(error),
                canRetry: true,
                canContinue: false,
                assetId: ""
            });
        }
    },
    async retry() {
        if (this.data.busy)
            return;
        await this.choosePhoto();
    },
    async cancel() {
        if (this.data.busy)
            return;
        const runtime = runtimeFor(this);
        const resume = readUploadResume();
        const sessionId = runtime.sessionId ?? resume?.sessionId;
        abortPolling(runtime);
        if (sessionId) {
            try {
                await cancelUpload(sessionId);
            }
            catch {
                // Local privacy state is cleared even if the remote cancellation cannot be confirmed.
            }
        }
        clearUploadResume();
        runtime.sessionId = undefined;
        runtime.selectedPhoto = undefined;
        this.setData({
            phase: "IDLE",
            busy: false,
            progress: 0,
            title: "上传自己的照片",
            detail: "原图仅用于本次处理",
            error: "",
            canRetry: false,
            canContinue: false,
            assetId: ""
        });
    },
    continueEditing() {
        if (!this.data.canContinue || !validUuid(this.data.assetId))
            return;
        wx.navigateTo({ url: `/pages/plan/index?assetId=${encodeURIComponent(this.data.assetId)}` });
    }
});
function validUuid(value) {
    return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
