Page({
  data: {
    evidenceLabel: "示例流程 / 非真实用户案例"
  },
  startDemo() {
    wx.navigateTo({ url: "/pages/plan/index?scenario=travel-portrait" });
  }
});
