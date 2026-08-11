import { rescueScenarios } from "../../services/rescue-scenarios";
Page({
    data: { scenarios: rescueScenarios },
    startPortraitDemo() {
        wx.navigateTo({ url: "/pages/plan/index?scenario=travel-portrait" });
    },
    openDemoCase() {
        wx.navigateTo({ url: "/pages/cases/index" });
    }
});
