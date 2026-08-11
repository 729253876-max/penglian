Page({
  data: {
    comparePercent: 50,
    showDetails: false
  },
  setComparison(event: { detail: { value: number } }) {
    const comparePercent = Math.max(0, Math.min(100, Number(event.detail.value)));
    this.setData({ comparePercent });
  },
  toggleDetails() {
    this.setData({ showDetails: !this.data.showDetails });
  },
  adjustAgain() {
    wx.redirectTo({ url: "/pages/plan/index?scenario=travel-portrait" });
  }
});
