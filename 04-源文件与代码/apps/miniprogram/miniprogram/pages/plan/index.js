import { createTask } from "../../services/api";
const protections = ["保留人物身份", "保留五官结构", "保留发型", "保留服装", "保留姿势", "保留人物数量", "保留主要构图"];
const forbiddenOperations = ["禁止换脸", "禁止改变脸型", "禁止改变身形", "禁止生成妆容", "禁止替换背景"];
const plans = [
    { direction: "NATURAL_RESCUE", title: "自然救片", naturalness: 85, detailLevel: 35, recommended: true, warning: "", protections, forbiddenOperations },
    { direction: "CLEAR_RESCUE", title: "清晰救片", naturalness: 75, detailLevel: 60, recommended: false, warning: "增强细节可能同时暴露轻微噪点。", protections, forbiddenOperations }
];
const runtimes = new WeakMap();
function begin(page) {
    const previous = runtimes.get(page);
    if (previous)
        previous.alive = false;
    const runtime = {
        alive: true,
        generation: (previous?.generation ?? 0) + 1,
        requestId: 0,
        pendingRequest: false
    };
    runtimes.set(page, runtime);
    return runtime;
}
function current(page, runtime, generation, requestId) {
    return runtime.alive && runtime.generation === generation && runtimes.get(page) === runtime && (requestId === undefined || runtime.requestId === requestId);
}
Page({
    data: { assetId: "", plans, selectedDirection: "NATURAL_RESCUE", submitting: false, error: "" },
    onLoad(options = {}) {
        begin(this);
        const assetId = validUuid(options.assetId) ? options.assetId : "";
        this.setData({ assetId, selectedDirection: "NATURAL_RESCUE", error: assetId ? "" : "照片资产缺失，请重新完成私密上传。" });
    },
    onShow() {
        const runtime = runtimes.get(this);
        if (runtime?.alive) {
            this.setData({ submitting: runtime.pendingRequest });
        }
    },
    onUnload() {
        const page = this;
        const runtime = runtimes.get(page);
        if (!runtime)
            return;
        runtime.alive = false;
        runtime.generation += 1;
        runtimes.delete(page);
    },
    selectDirection(event) {
        const direction = event.currentTarget?.dataset?.direction;
        if (direction !== "NATURAL_RESCUE" && direction !== "CLEAR_RESCUE")
            return;
        this.setData({ selectedDirection: direction, error: "" });
    },
    async startPreview() {
        if (this.data.submitting)
            return;
        if (!validUuid(this.data.assetId)) {
            this.setData({ error: "照片资产缺失，请重新完成私密上传。" });
            return;
        }
        const selectedPlan = plans.find((plan) => plan.direction === this.data.selectedDirection);
        if (!selectedPlan)
            return;
        const page = this;
        const runtime = runtimes.get(page) ?? begin(page);
        if (runtime.pendingRequest)
            return;
        const generation = runtime.generation;
        const requestId = runtime.requestId + 1;
        runtime.requestId = requestId;
        runtime.pendingRequest = true;
        this.setData({ submitting: true, error: "" });
        try {
            const task = await createTask({
                tool: "PORTRAIT_RETOUCH",
                inputAssetId: this.data.assetId,
                direction: selectedPlan.direction,
                parameters: { naturalness: selectedPlan.naturalness, detailLevel: selectedPlan.detailLevel }
            });
            if (!current(page, runtime, generation, requestId))
                return;
            runtime.pendingRequest = false;
            this.setData({ submitting: false });
            wx.navigateTo({ url: `/pages/live/index?taskId=${task.taskId}` });
        }
        catch {
            if (!current(page, runtime, generation, requestId))
                return;
            runtime.pendingRequest = false;
            this.setData({ submitting: false, error: "暂时无法创建任务，请确认本地 API 已启动后重试。" });
        }
    }
});
function validUuid(value) {
    return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
