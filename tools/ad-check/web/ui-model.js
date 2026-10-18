/* Presentation decisions only. Diagnostic evidence remains owned by the Rust analyzer. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AdCheckUI = factory();
})(typeof window === 'object' ? window : globalThis, function () {
  function summarize(report, phase) {
    const rows = report.rows || [], sampled = rows.filter(r => r.count > 0);
    const review = rows.filter(r => r.status === 'review');
    const missing = rows.filter(r => !r.count);
    const visualIssue = Object.values(report.feedback || {}).some(f => f.visibleAd === 'yes' || f.normalBrowsing === 'no');
    let title, detail, tone = 'neutral';
    if (phase === 'running') { title = '正在收集证据'; detail = '请继续浏览手机应用，结束后再判断结果。'; }
    else if (phase !== 'done') { title = '还没有可查看的报告'; detail = '完成一次手机检测，或导入带响应正文的 HAR。'; }
    else if (report.mode === 'har') { title = '已完成本地模拟'; detail = '这是对文件内容的回放，不能证明手机上的实际过滤效果。'; tone = 'info'; }
    else if (report.errors?.length || report.restored === false || report.homeUnchanged === false) { title = '本次检测需要处理'; detail = '检测或恢复过程中有异常，请先查看下方提示。'; tone = 'warning'; }
    else if (visualIssue) { title = '你标记了广告或浏览异常'; detail = '请结合对应页面的证据复查；摘要没有异常也不能替代目测。'; tone = 'warning'; }
    else if (review.length) { title = `${review.length} 个位置需要复查`; detail = '变化可能来自广告、正常内容更新或证据不足，需要逐项确认。'; tone = 'warning'; }
    else if (!sampled.length) { title = '尚未采到有效样本'; detail = '当前不能判断过滤效果；请检查连接并重新浏览应用。'; }
    else { title = '已采样位置未发现已知异常'; detail = missing.length ? `还有 ${missing.length} 个接口位置未采集，不能据此判断全部页面。` : '仍需确认手机上的广告和正常浏览情况，再保存比较基准。'; tone = 'info'; }
    return { title, detail, tone, sampled: sampled.length, review: review.length, missing: missing.length, total: rows.length };
  }
  function metricsKnown(row) {
    return row.count > 0 && !(row.reasons || []).some(x => x.includes('正文缺失') || x.includes('未识别到预期数据结构'));
  }
  function nextStep(report, phase) {
    if (phase !== 'done') return '先完成检测或导入 HAR，再查看处理建议。';
    if (report.restored === false) return '先在设置中关闭诊断模块；连接不上时，请在手机 Surge 手动关闭 Surge Ad Check。';
    if (report.mode === 'har') return '确认 HAR 包含响应正文。若要验证手机上的效果，请再进行一次实机检测。';
    if (report.errors?.length || report.homeUnchanged === false) return '先查看检测提示，处理连接或证据问题，再重新采集。';
    if (Object.values(report.feedback || {}).some(f => f.visibleAd === 'yes' || f.normalBrowsing === 'no')) return '保留出现异常的位置和复现步骤，导出交接包，交给编程助手结合证据复查。';
    if ((report.rows || []).some(r => r.status === 'review')) return '展开“需要复查”的位置。证据不足时先补采，证据充分后再准备修改建议。';
    if ((report.rows || []).every(r => !r.count)) return '检查手机连接，重新开始检测，并实际浏览待检查页面。';
    return '补充手机目测结果。确认未见广告且浏览正常后，可将符合条件的位置保存为比较基准。';
  }
  return { summarize, metricsKnown, nextStep };
});
