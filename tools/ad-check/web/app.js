'use strict';
const $ = id => document.getElementById(id);
const token = location.hash.slice(1) || sessionStorage.getItem('adcheck-token');
if (token) { sessionStorage.setItem('adcheck-token', token); history.replaceState(null, '', '/'); }
const names = { weibo: '微博', zhibo8: '直播吧', xianyu: '闲鱼' };
const routes = { weibo: '重开应用 → 首页 → 热搜 → 评论 → 视频', zhibo8: '重开应用 → 首页 → 新闻 → 比赛详情', xianyu: '重开应用 → 首页 → 搜索 → 商品详情' };
const statuses = { uncovered: '未采集', review: '需要复查', observed: '与基准一致', 'no-baseline': '尚无比较基准' };
const titles = { check: ['检查与复核', '检测'], report: ['结果与下一步', '报告'], principle: ['了解处理方式', '过滤原理'], settings: ['连接与偏好', '设置'] };
let state, initialized = false, busy = false, lastReportId, rowSignature, currentPage = 'check', currentFilter = 'all', interval, quitting = false;
const actionIds = ['start','stop','chooseHar','prepare','saveConnection','recover','export','handoff','saveFeedback','baseline','saveLLM','testLLM','forgetLLM','analyze','quit'];
function notice(text, error = false) { $('notice').textContent = text || ''; $('notice').hidden = !text; $('notice').classList.toggle('error', error); }
function node(tag, text, cls) { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; }
async function api(path, data) {
  const r = await fetch('/api/' + path, { method: data === undefined ? 'GET' : 'POST', headers: { 'X-Ad-Check-Token': token || '', ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  let v; try { v = await r.json(); } catch (_) { throw Error('应用连接已关闭，请重新打开应用。'); }
  if (!r.ok) throw Error(v.error || '操作未完成');
  return v;
}
function configured(s) { return ['host', 'profile', 'cli'].every(k => !!s?.settings?.[k]); }
function syncControls() {
  const running = state?.phase === 'running' || state?.phase === 'stopping';
  const done = state?.phase === 'done';
  for (const id of actionIds) $(id).disabled = busy || !state;
  for (const id of ['prepare','saveConnection','chooseHar']) $(id).disabled ||= running;
  for (const id of ['host','profile','cli']) $(id).disabled = busy || running;
  for (const id of ['export','handoff','saveFeedback']) $(id).disabled ||= !done;
  $('baseline').disabled ||= !done || state?.report?.mode === 'har' || state?.report?.restored !== true || state?.report?.homeUnchanged === false || !!state?.report?.errors?.length;
  $('analyze').disabled ||= !done || !state?.llm?.enabled || !state?.llm?.hasKey;
  $('recover').disabled ||= running;
  $('forgetLLM').disabled ||= !state?.llm?.hasKey || $('baseURL').value.trim() !== state?.llm?.baseURL;
  $('har').disabled = busy || running;
  for (const e of $('feedback').querySelectorAll('select')) e.disabled = busy || !done;
}
async function action(fn, success = '操作已完成。') {
  if (busy) return;
  busy = true; syncControls(); notice('正在处理…');
  try { const result = await fn(); if (result !== false) notice(success); if (!quitting) await refresh(); }
  catch (e) { notice(e.message || '连接未完成，请检查后重试。', true); }
  finally { busy = false; syncControls(); }
}
window.showPage = function (page) {
  if (!titles[page]) return;
  currentPage = page;
  for (const p of Object.keys(titles)) $('page-' + p).hidden = p !== page;
  document.querySelectorAll('[data-page]').forEach(b => { if (b.dataset.page === page) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
  $('pageEyebrow').textContent = titles[page][0]; $('pageTitle').textContent = titles[page][1];
  window.scrollTo(0, 0);
};
for (const b of document.querySelectorAll('[data-page], [data-go]')) b.onclick = () => showPage(b.dataset.page || b.dataset.go);

for (const app of Object.keys(names)) {
  const card = node('div', undefined, 'app-card');
  const heading = node('div', undefined, 'app-heading');
  heading.append(node('span', names[app][0], 'app-symbol ' + app), node('h3', names[app]));
  const coverage = node('div', undefined, 'coverage-line'); coverage.append(node('span', '采集覆盖分组')); const value = node('strong', '0 / 0'); value.id = 'coverage-' + app; coverage.append(value);
  const bar = node('div', undefined, 'coverage-bar'); bar.id = 'bar-' + app; bar.setAttribute('aria-hidden', 'true');
  card.append(heading, node('p', routes[app], 'route-text'), coverage, bar); $('cards').append(card);
  const f = node('div', undefined, 'feedback-card'); f.append(node('h3', names[app]));
  for (const [key, label, yes, no] of [['visibleAd','还看到广告吗？','仍有广告','未看到广告'], ['normalBrowsing','浏览、图片、视频正常吗？','浏览正常','存在异常']]) {
    const l = node('label', label), select = node('select'); select.id = app + '-' + key;
    for (const [v,t] of [['untested','尚未检查'],['yes',yes],['no',no]]) { const o = node('option', t); o.value = v; select.append(o); }
    l.append(select); f.append(l);
  }
  $('feedback').append(f);
}
function renderRows(report, force = false) {
  const signature = JSON.stringify(report.rows) + currentFilter;
  if (!force && signature === rowSignature) return;
  rowSignature = signature;
  const opened = new Set([...$('reportRows').querySelectorAll('details[open]')].map(e => e.dataset.route));
  const focusedRoute = document.activeElement?.closest('.report-row')?.dataset.route;
  $('reportRows').replaceChildren(); let visible = 0;
  for (const r of report.rows) {
    if (currentFilter === 'sampled' ? !r.count : currentFilter !== 'all' && r.status !== currentFilter) continue;
    visible++;
    const detail = node('details', undefined, 'report-row'); detail.dataset.route = r.route; detail.open = opened.has(r.route);
    const summary = node('summary'); const title = node('span', `${names[r.app]} · ${r.label}`, 'row-name'); title.append(node('small', r.count ? `${r.count} 次采样${r.simulated ? ' · 文件模拟' : ''}` : '没有该位置的有效样本'));
    const tone = r.status === 'review' ? 'warning' : r.status === 'observed' ? 'info' : '';
    const counts = AdCheckUI.metricsKnown(r) ? `${r.beforeAds} → ${r.afterAds}` : '待判断';
    summary.append(title, node('span', statuses[r.status] || r.status, 'pill ' + tone), node('span', counts, 'row-counts'));
    const body = node('div', undefined, 'row-body');
    if (r.reasons.length) { const list = node('ul'); for (const reason of r.reasons) list.append(node('li', reason)); body.append(list); }
    else body.append(node('p', r.count ? '该样本的已知检查未发现异常。请结合手机目测确认效果。' : '请重新检测并浏览该页面；本次没有样本，不能判断过滤是否有效。'));
    if (AdCheckUI.metricsKnown(r)) body.append(node('p', `已知广告标记：处理前 ${r.beforeAds}，处理后 ${r.afterAds}。这是样本累计统计，并非屏幕上的广告条数。`));
    else if (r.count) body.append(node('p', '当前正文证据不足，不能把“0”解释为没有广告。'));
    const preservation = { 'pagination-only': '正常内容校验仅覆盖翻页字段，正文仍需实机确认。', 'selected-fields': '所选正常字段校验一致，仍需检查实际浏览。', changed: '所选正常字段发生变化，需要复查正常内容是否受到影响。', unverified: '正常内容尚未得到验证。' };
    body.append(node('p', preservation[r.preservation] || preservation.unverified));
    if (r.count && !r.baseline && !r.simulated) body.append(node('p', '还没有已确认的比较基准，暂时不能判断与上次相比是否变化。'));
    body.append(node('code', r.route)); detail.append(summary, body); $('reportRows').append(detail);
    if (focusedRoute === r.route) summary.focus({ preventScroll: true });
  }
  $('emptyFilter').hidden = visible !== 0;
}
function fillLLM(s) {
  $('llmEnabled').checked = s.enabled;
  for (const k of ['provider','baseURL','model','maxTokens']) $(k).value = s[k];
  $('keyStatus').textContent = s.hasKey ? '当前地址的密钥已保存在 Mac 钥匙串；不会在此显示。' : '当前地址尚未保存密钥。';
}
function render(s) {
  state = s; const r = s.report, running = s.phase === 'running';
  $('phase').textContent = ({ idle:'待开始', ready:'连接已核验', running:'正在检测', stopping:'正在结束', done:'已有报告', error:'需要处理' })[s.phase] || s.phase;
  $('phase').className = 'pill ' + (s.phase === 'error' ? 'warning' : running ? 'info' : '');
  $('message').textContent = s.message;
  $('start').hidden = running; $('stop').hidden = !running; $('viewReport').hidden = s.phase !== 'done';
  $('start').textContent = configured(s) ? (s.phase === 'done' ? '开始新的检测 ↗' : '开始检测 ↗') : '连接手机 →';
  $('checkTitle').replaceChildren(node('span', running ? '检测中，' : '检查过滤效果，'), node('br'), node('span', running ? '请在手机上浏览。' : '看清广告变化。'));
  $('checkDescription').textContent = running ? '按下方路线依次打开三个应用，完成后点击“结束并生成报告”。' : '在手机上照常浏览，在这里查看已知广告标记与接口变化。';
  $('timer').textContent = running ? `剩余 ${Math.floor(s.remaining / 60)} 分 ${s.remaining % 60} 秒 · 最长 6 分钟` : '';
  $('connectionHint').textContent = running ? '检测已开启，可以开始浏览。' : s.phase === 'ready' ? '本次连接已核验，可以开始检测。' : configured(s) ? '已保存连接信息，开始时会核验。' : '在同一网络中连接 iPhone 的 Surge。';
  $('connectionState').textContent = running ? '检测中' : s.phase === 'ready' ? '已核验' : configured(s) ? '已保存 · 待核验' : '待配置';
  $('step-connect').classList.toggle('active', !running); $('step-browse').classList.toggle('active', running);
  $('recoveryAlert').hidden = !s.recoveryPending || running;
  if (!initialized) {
    for (const k of ['host','profile','cli']) $(k).value = s.settings[k] || '';
    for (const path of s.settings.profiles || []) { const o = node('option'); o.value = path; $('profiles').append(o); }
    fillLLM(s.llm); initialized = true;
  }
  const reportKey = r.id || (running ? 'running' : 'empty');
  if (reportKey !== lastReportId) {
    for (const a of Object.keys(names)) for (const k of ['visibleAd','normalBrowsing']) $(a + '-' + k).value = r.feedback?.[a]?.[k] || 'untested';
    lastReportId = reportKey;
    if (s.phase === 'done') {
      currentFilter = r.rows.some(x => x.status === 'review') ? 'review' : r.rows.some(x => x.count) ? 'sampled' : 'all';
      document.querySelectorAll('[data-filter]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.filter === currentFilter)));
    }
  }
  for (const app of Object.keys(names)) {
    const c = r.coverage[app]; $('coverage-' + app).textContent = `${c.done} / ${c.total}`;
    const bar = $('bar-' + app); bar.replaceChildren(); for (let i = 0; i < c.total; i++) bar.append(node('i', undefined, i < c.done ? 'filled' : ''));
  }
  const summary = AdCheckUI.summarize(r, s.phase);
  $('reportTitle').textContent = summary.title; $('reportDescription').textContent = summary.detail;
  $('reportSummary').className = 'report-summary ' + summary.tone;
  $('sampleCount').textContent = summary.sampled; $('reviewCount').textContent = summary.review; $('missingCount').textContent = summary.missing;
  $('reviewBadge').textContent = summary.review; $('reviewBadge').hidden = !summary.review;
  $('evidenceMode').textContent = s.phase === 'running' ? '采集中 · 结果未定' : s.phase !== 'done' ? '尚无完整报告' : r.mode === 'har' ? 'HAR 本地模拟' : '手机实机观察';
  $('reportTime').textContent = s.phase === 'done' && r.time ? new Date(r.time).toLocaleString('zh-CN', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' }) : '';
  const errors = [...r.errors];
  if (r.restored === false) errors.push('诊断模块尚未确认关闭，请先处理恢复。');
  if (r.homeUnchanged === false) errors.push('主配置校验不一致或无法读取；本工具不会写入主配置，请复核。');
  $('reportErrors').replaceChildren(...errors.map(e => node('li', e))); $('reportIssues').hidden = !errors.length;
  renderRows(r);
  $('stats').textContent = `相关请求 ${r.requestCount} · 请求失败 ${r.failedRequests} · 被规则拒绝 ${r.rejectedRequests} · 新地址线索 ${r.newEndpointCount ?? '尚无基准'}${r.homeUnchanged === true ? ' · 主配置校验一致' : ''}`;
  $('limitations').textContent = r.notice;
  $('nextStep').textContent = AdCheckUI.nextStep(r, s.phase);
  $('summary').textContent = JSON.stringify(summaryForModel(r), null, 2);
  $('analysisHint').textContent = !s.llm.enabled ? '尚未启用模型。请先在设置中配置；本地检测不需要模型。' : !s.llm.hasKey ? '当前 API 地址尚未保存密钥，请前往设置。' : '点击下方按钮才会发送摘要，使用你自己的 API 额度。';
  syncControls();
}
function summaryForModel(r) {
  return { evidenceMode:r.mode || 'live', rows:r.rows.map(x => Object.fromEntries(['route','count','status','reasons','beforeAds','afterAds','normal','preservation','simulated','baseline'].map(k => [k,x[k]]).concat([['structureChanges',x.changes],['newTypes',x.newTypes]]))), coverage:r.coverage, visibleFeedback:r.feedback, newEndpointCount:r.newEndpointCount, failedRequests:r.failedRequests, errors:r.errors, notice:r.notice };
}
async function refresh() { if (quitting) return; try { render(await api('state')); } catch (e) { notice(e.message || '应用连接已关闭，请重新打开。', true); } }
const getFeedback = () => Object.fromEntries(Object.keys(names).map(a => [a,Object.fromEntries(['visibleAd','normalBrowsing'].map(k => [k,$(a + '-' + k).value]))]));
const getConnection = () => Object.fromEntries(['host','profile','cli'].map(k => [k,$(k).value.trim()]));
function resetFeedback() { for (const a of Object.keys(names)) for (const k of ['visibleAd','normalBrowsing']) $(a + '-' + k).value = 'untested'; }
$('start').onclick = () => {
  if (!configured(state)) { showPage('settings'); $('host').focus(); return; }
  action(async () => { await api('start', {}); resetFeedback(); }, '检测已开始。请在手机上按路线浏览。');
};
$('stop').onclick = () => action(async () => { await api('stop', {}); showPage('report'); }, '报告已生成，请查看证据并补充目测结果。');
$('saveConnection').onclick = () => action(() => api('settings', getConnection()), '连接信息已保存，开始检测时会核验。');
$('prepare').onclick = () => action(async () => { await api('settings', getConnection()); await api('prepare', {}); }, '连接已核验，诊断模块已准备。可返回检测页开始。');
$('recover').onclick = () => action(() => api('recover', {}), '已执行诊断关闭，请查看恢复状态。');
$('saveFeedback').onclick = () => action(() => api('feedback', getFeedback()), '目测结果已保存。');
$('baseline').onclick = () => action(async () => { await api('feedback', getFeedback()); await api('baseline', {}); }, '符合条件的位置已保存为比较基准。');
$('chooseHar').onclick = () => $('har').click();
$('har').onchange = () => action(async () => {
  const f = $('har').files[0]; if (!f) return false;
  try { if (f.size > 23_000_000) throw Error('请选择小于 23 MB 的 HAR。'); let data; try { data = JSON.parse(await f.text()); } catch (_) { throw Error('文件不是有效的 HAR / JSON，请从 Surge 重新导出。'); }
    await api('import', data); resetFeedback(); showPage('report');
  } finally { $('har').value = ''; }
}, '文件已在本机模拟完成；结果不代表手机的实际过滤效果。');
async function download(route, name) {
  if (window.adCheckDesktop) {
    await new Promise(resolve => { window.desktopExportDone = message => { notice(message); resolve(); }; window.ipc.postMessage(JSON.stringify({ command:'export', route })); }); return false;
  }
  const r = await fetch('/api/' + route, { headers:{ 'X-Ad-Check-Token':token } }); if (!r.ok) throw Error((await r.json()).error);
  const url = URL.createObjectURL(await r.blob()), a = node('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
}
$('export').onclick = () => action(() => download('report', 'surge-ad-check-report.json'), '报告已导出。');
$('handoff').onclick = () => action(async () => { await api('feedback', getFeedback()); return await download('handoff', 'surge-ad-check-handoff.zip'); }, '交接包已导出。');
for (const b of document.querySelectorAll('[data-filter]')) b.onclick = () => { currentFilter = b.dataset.filter; document.querySelectorAll('[data-filter]').forEach(e => e.setAttribute('aria-pressed', String(e === b))); if (state) renderRows(state.report, true); };
$('baseURL').addEventListener('input', syncControls);
$('provider').onchange = () => {
  const p = $('provider').value;
  if (p === 'qwen') { $('baseURL').value = 'https://dashscope.aliyuncs.com/compatible-mode/v1'; $('model').value = 'qwen-plus'; }
  if (p === 'deepseek') { $('baseURL').value = 'https://api.deepseek.com'; $('model').value = 'deepseek-flash'; }
  $('apiKey').value = ''; $('keyStatus').textContent = '保存后会检查此地址对应的密钥。'; $('llmTestResult').textContent = ''; syncControls();
};
async function saveLLM() {
  const v = await api('llm/settings', { enabled:$('llmEnabled').checked, provider:$('provider').value, baseURL:$('baseURL').value.trim(), model:$('model').value.trim(), apiKey:$('apiKey').value, maxTokens:Number($('maxTokens').value) });
  $('apiKey').value = ''; fillLLM(v); return v;
}
$('saveLLM').onclick = () => action(saveLLM, '模型设置已保存。');
$('testLLM').onclick = () => action(async () => { $('llmTestResult').textContent = '正在保存并测试…'; try { await saveLLM(); const v = await api('llm/test', {}); $('llmTestResult').textContent = '连接成功：' + v.text; } catch (e) { $('llmTestResult').textContent = '测试未通过：' + e.message; throw e; } }, '模型连接测试成功。');
$('forgetLLM').onclick = () => action(async () => { fillLLM(await api('llm/forget', {})); $('llmTestResult').textContent = ''; }, '已删除当前已保存地址的密钥。');
$('openAnalysis').onclick = () => { $('analysisPanel').hidden = false; $('analysisPanel').scrollIntoView({ behavior:'auto', block:'start' }); };
$('analyze').onclick = () => action(async () => { await api('feedback', getFeedback()); $('advice').textContent = '正在分析脱敏摘要…'; try { const v = await api('llm/analyze', {}); $('advice').textContent = '模型建议 · 尚未验证\n\n' + v.text + '\n\n用量：' + JSON.stringify(v.usage); } catch (e) { $('advice').textContent = '分析未完成。'; throw e; } }, '分析完成，建议仍需验证。');
$('quit').onclick = () => action(async () => { await api('quit', {}); quitting = true; clearInterval(interval); notice('应用已退出。'); return false; });
const methods = { clean:['在混合数据中，只处理明确的广告项','适合广告与正常内容共用接口的情况。'], block:['确认是广告专用请求，再精确拦截','不会把整个应用域名当作广告处理。'], verify:['自动观察 + 手机目测，才能形成判断','检测工具记录证据，修复仍需要验证。'] };
for (const b of document.querySelectorAll('[data-method]')) b.onclick = () => { const method = b.dataset.method; for (const m of Object.keys(methods)) $('demo-' + m).hidden = m !== method; document.querySelectorAll('[data-method]').forEach(e => e.setAttribute('aria-pressed', String(e === b))); $('methodTitle').textContent = methods[method][0]; $('methodDescription').textContent = methods[method][1]; };
$('methodDescription').textContent = methods.clean[1];
let demoFiltered = true;
$('toggleDemo').onclick = () => { demoFiltered = !demoFiltered; $('demoAd').textContent = demoFiltered ? '已移除明确广告项' : '明确标记的广告仍在'; $('demoAd').className = demoFiltered ? 'removed-slot' : 'removed-slot demo-unfiltered'; $('demoResultLabel').textContent = demoFiltered ? '应用收到 · 处理后' : '对照示意 · 未经处理'; $('toggleDemo').textContent = demoFiltered ? '对比：未经处理' : '查看：处理后'; };
syncControls(); refresh(); interval = setInterval(refresh, 2500);
