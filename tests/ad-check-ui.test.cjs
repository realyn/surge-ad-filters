const test = require('node:test');
const assert = require('node:assert/strict');
const ui = require('../tools/ad-check/web/ui-model.js');
const report = (rows, extras = {}) => ({ rows, errors: [], feedback: {}, restored: true, homeUnchanged: true, ...extras });
const row = (extras = {}) => ({ count: 0, status: 'uncovered', reasons: [], ...extras });
test('uncollected locations are never treated as a clean result', () => {
  const s = ui.summarize(report([row(), row()]), 'done');
  assert.equal(s.sampled, 0); assert.equal(s.missing, 2); assert.equal(s.title, '尚未采到有效样本');
  assert.match(s.detail, /不能判断/);
});
test('unrecognized body cannot display synthetic zero counts as meaningful', () => {
  assert.equal(ui.metricsKnown(row({ count: 1, reasons: ['正文缺失、格式异常或超出诊断上限'] })), false);
  assert.equal(ui.metricsKnown(row({ count: 1, reasons: ['未识别到预期数据结构'] })), false);
  assert.equal(ui.metricsKnown(row({ count: 2, status: 'no-baseline', beforeAds: 3, afterAds: 0 })), true);
});
test('a structure change asks for review rather than claiming new ads', () => {
  const r = report([row({ count: 1, status: 'review', reasons: ['响应结构变化，需复查（不等于新增广告）'] }), row()]);
  const s = ui.summarize(r, 'done'); assert.equal(s.review, 1); assert.equal(s.missing, 1); assert.equal(s.tone, 'warning'); assert.match(s.detail, /正常内容更新/);
});
test('HAR simulation never claims phone filtering success', () => {
  const s = ui.summarize(report([row({ count: 1, status: 'no-baseline' })], { mode: 'har' }), 'done');
  assert.equal(s.title, '已完成本地模拟'); assert.match(s.detail, /不能证明手机/);
});
test('visible browsing trouble overrides a clean automated summary', () => {
  const r = report([row({ count: 1, status: 'observed' })], { feedback: { weibo: { visibleAd: 'no', normalBrowsing: 'no' } } });
  assert.equal(ui.summarize(r, 'done').tone, 'warning'); assert.match(ui.nextStep(r, 'done'), /异常的位置/);
});
test('incomplete coverage remains explicit after apparently clean samples', () => {
  const s = ui.summarize(report([row({ count: 1, status: 'observed' }), row()]), 'done');
  assert.match(s.title, /已采样位置/); assert.match(s.detail, /1 个接口位置未采集/);
});
test('recovery and collection errors take priority over starting another check', () => {
  const r = report([], { restored: false, errors: ['连接断开'] });
  assert.equal(ui.summarize(r, 'done').title, '本次检测需要处理');
  assert.match(ui.nextStep(r, 'done'), /先在设置中关闭诊断模块/);
});
test('live collection remains provisional even when all samples look unchanged', () => {
  const s = ui.summarize(report([row({ count: 1, status: 'observed' })]), 'running');
  assert.equal(s.title, '正在收集证据'); assert.match(s.detail, /结束后再判断/);
});
