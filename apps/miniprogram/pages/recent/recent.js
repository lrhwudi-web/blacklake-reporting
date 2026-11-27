const { request } = require("../../utils/api");

Page({
  data: { loading: true, loaded: false, loadError: "", assignments: [] },
  onLoad() { this._unloaded = false; return this.loadAssignments(); },
  onUnload() { this._unloaded = true; },
  async onPullDownRefresh() { await this.loadAssignments(); wx.stopPullDownRefresh(); },
  async loadAssignments() {
    const requestId = this._requestId = (this._requestId || 0) + 1;
    const isCurrent = () => !this._unloaded && requestId === this._requestId;
    this.setData({ loading: true, loadError: "" });
    try {
      const result = await request("/v1/assignments/recent?limit=10");
      if (!isCurrent()) return;
      const labels = { COMPLETED: "已完成", NEEDS_REVIEW: "等待核对", QUANTITY_PENDING: "完工待核量", CANCELLED: "已取消" };
      this.setData({ loaded: true, assignments: result.assignments.map((item) => ({
        ...item,
        statusText: labels[item.status] || item.status,
        durationText: formatDuration(item.durationSeconds)
      })) });
    } catch (error) {
      if (isCurrent()) this.setData({ loadError: error.message || "加载失败，请检查网络后重试。" });
    } finally {
      if (isCurrent()) this.setData({ loading: false });
    }
  }
});

function formatDuration(seconds = 0) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  return `${hours ? `${hours}小时` : ""}${minutes}分钟`;
}
