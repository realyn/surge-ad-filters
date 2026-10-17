const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'apps/weibo/weibo.js'), 'utf8');
const moduleText = fs.readFileSync(path.join(root, 'apps/weibo/Weibo.sgmodule'), 'utf8');
const pattern = new RegExp(moduleText.match(/pattern=(.*?),requires-body=/)[1]);
const timeline = 'https://api.weibo.cn/2/statuses/container_timeline_hot';

// All samples below are invented. No production responses or account data.
function run(body, url = timeline, status = 200) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  let result, calls = 0;
  const logs = [];
  vm.runInNewContext(source, {
    $request: { url },
    $response: { body: raw, status },
    console: { log: message => logs.push(String(message)) },
    $done: value => { calls++; result = value; }
  }, { timeout: 1000 });
  assert.equal(calls, 1, '$done must be called exactly once');
  return { result: JSON.parse(JSON.stringify(result)), logs };
}
function filtered(body, url = timeline) {
  const { result } = run(body, url);
  return result.body ? JSON.parse(result.body) : body;
}
const normal = {
  category: 'feed',
  data: { mblogtype: 0, ad_marked: false, text: 'Ordinary content',
    tag_struct: [{ promotion: { monitor_url: ['https://example.invalid/metric'] } }] }
};

test('splash and cached ads are emptied without losing unrelated fields', () => {
  for (const host of ['bootpreload', 'bootrealtime']) {
    const body = { ads: [{ duration: 5 }], config: { retry: 60 }, code: 0 };
    assert.deepEqual(filtered(body, `https://${host}.uve.weibo.com/v2/ad/preload`), { ...body, ads: [] });
  }
  const body = { cached_ad: { ads: [{ placement: 'splash' }], expires: 123 }, ads: [{}], code: 0 };
  assert.deepEqual(filtered(body, 'https://wbapp.uve.weibo.com/wbapplua/wbpullad.lua'), {
    ...body, ads: [], cached_ad: { ...body.cached_ad, ads: [] }
  });
});

test('SDK response suffix is preserved', () => {
  const { result } = run('{"ads":[{}],"show_push_splash_ad":true,"code":0}OK\n',
    'https://sdkapp.uve.weibo.com/interface/sdk/sdkad.php');
  assert.equal(result.body, '{"ads":[],"show_push_splash_ad":false,"code":0}OK\n');
});

test('feed ads are removed while normal content and pagination remain identical', () => {
  const body = { items: [normal,
    { category: 'feed', data: { mblogtype: 1 } },
    { category: 'card', data: { is_ad_card: '1' } },
    { mblog: { promotion: { type: 'ad' } } },
    { is_ad: true }, { isAd: 1 }, { ad_marked: true }
  ], pageData: { cursor: 'next-page' }, moreInfo: { noMore: false }, config: { layout: 1 } };
  assert.deepEqual(filtered(body), { ...body, items: [normal] });
});

test('standalone ad_state and ordinary promotion metadata do not delete content', () => {
  const body = { items: [normal, { category: 'feed', data: { ad_state: 1, mblogtype: 0, ad_marked: false } },
    { promotion: { monitor_url: [] } }, { mblogtype: 2 }] };
  assert.deepEqual(run(body).result, {});
});

test('comment ad cards are removed while comments and replies remain intact', () => {
  const comment = { category: 'detail', type: 'comment', data: { text: 'A comment', replies: [{ text: 'A reply' }] } };
  const body = { items: [comment,
    { category: 'detail', type: 'trend', data: { ad_from_comment: true } },
    { category: 'detail', data: { blog: { mblogtype: 1 } } }
  ], moreInfo: { params: { page: 2 } } };
  assert.deepEqual(filtered(body, 'https://api.weibo.cn/2/statuses/container_detail_comment'), { ...body, items: [comment] });
});

test('hot-search ad markers match complete delimited values only', () => {
  const kept = [
    { itemid: 'is_ad_pos:10' }, { itemid: 'prefix_is_ad_pos:1' },
    { itemid: 'adid:123' }, { itemid: 'cate_type:ads_hotword_extra' },
    { title_sub: 'Normal topic', promotion: { monitor_url: [] } }
  ];
  const body = { items: [...kept, { itemid: 'pos:3|is_ad_pos:1|other:0' },
    { itemid: 'cate_type:ads_hotword|pos:3' },
    { category: 'card', data: { itemid: 'is_ad_pos:1' } }], pageData: { cursor: 'keep' } };
  assert.deepEqual(filtered(body, 'https://api.weibo.cn/2/flowpage'), { ...body, items: kept });
});

test('mixed banner carousel retains the ordinary news cell', () => {
  const news = { sub_item: [{ title: 'News', corner_mark_data: { title: '热' } }] };
  const body = { header: { data: { items: [{ category: 'card', data: { items: [
    { sub_item: [{ corner_mark_data: { title: '广告' }, pic: 'https://example.invalid/ad.png' }] }, news
  ], loop_interval: 4 } }] } } };
  const expected = structuredClone(body);
  expected.header.data.items[0].data.items.splice(0, 1);
  assert.deepEqual(filtered(body, 'https://api.weibo.cn/2/search/finder'), expected);
});

test('all-ad carousel is removed without pruning pre-existing empty cards', () => {
  const empty = { category: 'card', data: { items: [] } };
  const body = { items: [empty, { category: 'card', data: { items: [
    { sub_item: [{ corner_mark_data: { title: '广告' } }] }
  ] } }] };
  assert.deepEqual(filtered(body), { items: [empty] });
});

test('video list and cache preserve ordinary video and next-page data', () => {
  const video = { category: 'svs', data: { ad_state: 1, mblogtype: 0, ad_marked: false, text: 'Ordinary video' } };
  const page = { items: [video, { category: 'svs', data: { mblogtype: 1 } }], moreInfo: { noMore: false, params: { page: 2 } } };
  assert.deepEqual(filtered(page, 'https://api.weibo.cn/2/video/flow_stream'), { ...page, items: [video] });
  assert.deepEqual(filtered({ lists: [page] }, 'https://api.weibo.cn/2/video/flow_stream_cache'), { lists: [{ ...page, items: [video] }] });
});

test('explicit ad collections are emptied but recommendations are retained', () => {
  const body = { advertises: [{}], advertisements: [{}], recommendations: [{ text: 'Keep' }] };
  assert.deepEqual(filtered(body), { ...body, advertises: [], advertisements: [] });
});

test('malformed, missing and unknown bodies pass through without partial changes', () => {
  for (const body of ['not JSON', '', 'null', '[]', '42', undefined]) assert.deepEqual(run(body).result, {});
  let nested = {};
  for (let i = 0; i < 90; i++) nested = { child: nested };
  assert.deepEqual(run({ items: [{ is_ad: true }], nested }).result, {});
});

test('HTTP errors and unrelated endpoints pass through unchanged', () => {
  for (const status of [400, 403, 500]) assert.deepEqual(run({ ads: [{}] }, 'https://bootpreload.uve.weibo.com/v2/ad/preload', status).result, {});
  for (const url of ['https://example.invalid/2/statuses/container_timeline_hot',
    'https://api.weibo.cn/2/direct_messages/user_list', 'https://api.weibo.cn/2/users/show']) {
    assert.deepEqual(run({ items: [{ is_ad: true }] }, url).result, {});
    assert.equal(pattern.test(url), false);
  }
});

test('module matches the tested endpoints and uses a pinned script from this repository', () => {
  for (const url of [timeline, 'https://api.weibo.cn/2/search/finder',
    'https://api.weibo.cn/2/flowpage?sample=1', 'https://mapi.weibo.com/2/comments/build_comments',
    'https://api.weibo.cn/2/video/flow_stream', 'https://api.weibo.cn/2/video/flow_stream_cache',
    'https://bootpreload.uve.weibo.com/v2/ad/preload', 'https://bootrealtime.uve.weibo.com/v2/ad/realtime',
    'https://wbapp.uve.weibo.com/wbapplua/wbpullad.lua', 'https://sdkapp.uve.weibo.com/interface/sdk/sdkad.php']) {
    assert.equal(pattern.test(url), true, url);
  }
  assert.match(moduleText, /script-path=https:\/\/raw\.githubusercontent\.com\/realyn\/surge-ad-filters\/v\d+\.\d+\.\d+\/apps\/weibo\/weibo\.js/);
  assert.match(moduleText, /hostname = %APPEND% /);
  assert.equal(moduleText.includes('[Rule]'), false);
  assert.equal(moduleText.includes('[Proxy]'), false);
  const hosts = moduleText.match(/^hostname = %APPEND% (.+)$/m)[1].split(',').map(x => x.trim());
  assert.deepEqual(hosts.sort(), ['api.weibo.cn', 'mapi.weibo.com', 'bootpreload.uve.weibo.com',
    'bootrealtime.uve.weibo.com', 'sdkapp.uve.weibo.com', 'wbapp.uve.weibo.com'].sort());
});

test('logs contain counts only, never the request or response content', () => {
  const { logs } = run({ items: [{ is_ad: true, text: 'PRIVATE_SENTINEL' }] }, timeline + '?token=PRIVATE_SENTINEL');
  assert.deepEqual(logs, ['Weibo Ad Filter: removed 1 ad items']);
});
