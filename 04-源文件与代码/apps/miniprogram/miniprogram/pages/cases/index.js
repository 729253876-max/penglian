import { productEvents } from "../../services/product-events";
Page({
    data: {
        evidenceLabel: "示例流程 / 非真实用户案例"
    },
    startDemo() {
        productEvents.record("DEMO_STARTED", { source: "CASE_PAGE" });
        wx.navigateTo({ url: "/pages/plan/index?scenario=travel-portrait" });
    }
});
