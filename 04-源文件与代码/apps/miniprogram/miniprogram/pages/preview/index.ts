import { productEvents } from "../../services/product-events";

Page({
  data: {
    comparePercent: 50,
    showDetails: false
  },
  setComparison(event: { detail: { value: unknown } }) {
    const value = event.detail.value;
    if (typeof value !== "number" || !Number.isFinite(value)) return;
    const comparePercent = Math.max(0, Math.min(100, value));
    this.setData({ comparePercent });
    productEvents.record("PREVIEW_COMPARE_USED", { mode: "SLIDER" });
  },
  toggleDetails() {
    const showDetails = !this.data.showDetails;
    this.setData({ showDetails });
    productEvents.record("PREVIEW_DETAILS_TOGGLED", {
      state: showDetails ? "OPEN" : "CLOSED"
    });
  },
  adjustAgain() {
    wx.redirectTo({ url: "/pages/plan/index?scenario=travel-portrait" });
  }
});
