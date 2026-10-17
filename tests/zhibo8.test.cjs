const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'apps/zhibo8/zhibo8.js'), 'utf8');
const moduleText = fs.readFileSync(path.join(root, 'apps/zhibo8/Zhibo8.sgmodule'), 'utf8');
const url = 'https://a.qiumibao.com/ios/config/?platform=ios';
function run(body, requestUrl = url, status = 200) {
  let result, calls = 0;
  vm.runInNewContext(source, {
    $request: {url: requestUrl},
    $response: {body: typeof body === 'string' ? body : JSON.stringify(body), status},
    $done: value => { result = value; calls++; }
  }, {timeout: 1000});
  assert.equal(calls, 1);
  return JSON.parse(JSON.stringify(result));
}
// Invented fixtures; never copy private captures into the repository.
test('disables ad configuration while retaining all non-ad app features', () => {
  const normal = {nav: [{title: 'News'}], play_config: {autoplay: true},
    user: {logged_in: true}, vip: {active: false}, bifen: {refresh: 5},
    pop: {notification_prompt: true}, s_video: {recommend: true},
    comments: [{text: 'Normal comment'}], page: {next: 'cursor'}};
  const data = {...normal, advert: {enable: 'true', url: 'https://example.invalid/ad'},
    advert_config: {splash_bk: 'enable', inter_bk: 'enable', pop_bk: 'enable',
      other_bk: 'enable', is_pre_request: 1,
      activities_config: [{name: 'Ad popup', enable: true}],
      wifi_preloading: {enable: 'enable', api_url: 'https://example.invalid/material'},
      sdk_toutiao: {init: 'enable', appname: 'Example'}, future_setting: {retain: true}}};
  const filtered = JSON.parse(run(data).body);
  for (const [key, value] of Object.entries(normal)) assert.deepEqual(filtered[key], value);
  assert.equal(filtered.advert.enable, 'false');
  assert.equal(filtered.advert.url, data.advert.url);
  for (const key of ['splash_bk', 'inter_bk', 'pop_bk', 'other_bk']) assert.equal(filtered.advert_config[key], 'disable');
  assert.equal(filtered.advert_config.is_pre_request, 0);
  assert.deepEqual(filtered.advert_config.activities_config, []);
  assert.equal(filtered.advert_config.wifi_preloading.enable, 'disable');
  assert.equal(filtered.advert_config.sdk_toutiao.init, 'disable');
  assert.deepEqual(filtered.advert_config.future_setting, {retain: true});
});
test('retains scalar types for recognized switches', () => {
  for (const [input, expected] of [[true,false],[1,0],['true','false'],['enable','disable'],['1','0']]) {
    assert.equal(JSON.parse(run({advert:{enable: input}}).body).advert.enable, expected);
  }
});
test('unknown values and similarly named ordinary content pass through', () => {
  for (const value of ['automatic', 2, null, {}, ['enable']]) {
    assert.deepEqual(run({advert:{enable:value}, advert_config:{splash_bk:value}}), {});
  }
  assert.deepEqual(run({news:[{title:'advert', enable:true}], advertising:{enable:true}}), {});
});
test('already disabled settings are unchanged', () => {
  assert.deepEqual(run({advert:{enable:false}, advert_config:{splash_bk:'disable',activities_config:[],is_pre_request:0}}), {});
});
test('invalid JSON, absent bodies, arrays and unknown schemas fail open', () => {
  for (const body of ['', '<html>Error</html>', '{broken', null, [], {}, {advert_config:[]}]) assert.deepEqual(run(body), {});
  assert.deepEqual(run(undefined), {});
});
test('error statuses preserve responses', () => {
  for (const status of [301,400,401,403,429,500,'invalid']) assert.deepEqual(run({advert:{enable:true}}, url, status), {});
});
test('module and script match only exact app configuration endpoint', () => {
  const pattern = new RegExp(moduleText.match(/pattern=(.*?),requires-body=/)[1]);
  for (const target of [url,'http://a.qiumibao.com/ios/config/']) assert.ok(pattern.test(target));
  for (const target of ['https://a.qiumibao.com/ios/config/other', 'https://a.qiumibao.com/ios/',
    'https://a.qiumibao.com.evil.invalid/ios/config/', 'https://headline.qiumibao.com/recommend/list',
    'https://bifen3.qiumibao.com/json/v2/list.htm']) {
    assert.equal(pattern.test(target), false);
    assert.deepEqual(run({advert:{enable:true}}, target), {});
  }
});
test('IP blocks are confined to three observed hosts and port 8091', () => {
  const rules = moduleText.split('\n').filter(line => line.startsWith('AND,'));
  assert.equal(rules.length, 3);
  for (const rule of rules) assert.match(rule, /^AND,\(\(IP-CIDR,(?:47\.111\.8\.123|118\.178\.168\.156|47\.99\.237\.245)\/32\), \(DEST-PORT,8091\)\),REJECT$/);
  assert.doesNotMatch(moduleText, /DOMAIN-SUFFIX|DEST-PORT,8091,REJECT|DOMAIN,(?:a|s|headline|bifen3|tu)\.(?:qiumibao|duoduocdn)\.com,REJECT/);
  assert.match(moduleText, /hostname = %APPEND% a\.qiumibao\.com, s\.qiumibao\.com/);
});
