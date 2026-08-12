import { rescueScenarios } from "../../services/rescue-scenarios";
import { productEvents } from "../../services/product-events";

Page({
  data: { scenarios: rescueScenarios },
  startOwnPhoto() {
    productEvents.record("HOME_OWN_PHOTO_TAPPED", { source: "HOME" });
    wx.navigateTo({ url: "/pages/privacy/index?next=upload" });
  },
  startPortraitDemo() {
    productEvents.record("HOME_PRIMARY_TAPPED", { scenario: "TRAVEL_PORTRAIT" });
    wx.navigateTo({ url: "/pages/plan/index?scenario=travel-portrait" });
  },
  openDemoCase() {
    productEvents.record("DEMO_CASE_OPENED", { source: "HOME" });
    wx.navigateTo({ url: "/pages/cases/index" });
  }
});
