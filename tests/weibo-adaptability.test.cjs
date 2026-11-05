// Synthetic fixtures only. Run locally: node --test check.cjs
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const src=fs.readFileSync(path.join(__dirname,'../apps/weibo/weibo.js'),'utf8');
const api='https://api.weibo.cn/2/statuses/container_timeline_hot',boot='https://bootpreload.uve.weibo.com/v4/ad/preload';
function run(body,url=api,status=200,method='GET'){let calls=0,out;vm.runInNewContext(src,{$request:{url,method},$response:{status,body},$done(v){calls++;out=v.body}},{timeout:1000});assert.equal(calls,1);return out;}
function pattern(name){const text=fs.readFileSync(path.join(__dirname,'../apps/weibo/Weibo.sgmodule'),'utf8');const lines=text.split('\n').filter(x=>x.includes('type=http-response'));return new RegExp(lines[0].match(/pattern=(.*?),requires-body/)[1]);}
test('same ad slots with new creative, version and cache wrapper',()=>{const b=' {"ads":[{"future":"creative B"}],"cached_ad":{"ads":[{"x":1}],"keep":9},"show_push_splash_ad":true,"id":9223372036854775807} ';assert.equal(run(b,boot),' {"ads":[],"cached_ad":{"ads":[],"keep":9},"show_push_splash_ad":false,"id":9223372036854775807} ');});
test('change content wrappers without changing structural evidence',()=>{const x={items:[{category:'new-wrapper',data:{mblog:{is_ad:1}}},{category:'new-wrapper',data:{mblogtype:1}},{category:'feed',data:{ad_state:1}},{text:'广告 in a normal post',promotion:{url:'keep'}}]};assert.deepEqual(JSON.parse(run(JSON.stringify(x))).items,x.items.slice(1));});
test('protect raw cursor, ID, strings, pagination and unrelated marked metadata',()=>{const raw='{"items":[{"is_ad":true},{"id":9223372036854775807,"text":"\\u5fae\\\"[123]"}],"moreInfo":{"params":{"cursor":9007199254740993}},"config":{"items":[{"is_ad":true}]},"amount":1.23450000}';assert.equal(run(raw),raw.replace('{"is_ad":true},',''));});
test('all-ad business page and unknown-only envelope are passed through',()=>{for(const b of ['{"items":[{"is_ad":true}],"cursor":1}','{"arbitrary":{"items":[{"is_ad":1},{"title":"keep"}]}}'])assert.equal(run(b),undefined);});
test('normal parent retained, pure marked carousel slots may be removed',()=>{const normal={text:'news',sub_item:[{is_ad:1}]},shell={card_type:9,itemid:'normal-slot',sub_item:[{corner_mark_data:{title:'广告'}}]},news={text:'news'};assert.deepEqual(JSON.parse(run(JSON.stringify({items:[normal,shell,news]}))),{items:[normal,news]});});
test('only content read families and complete path boundaries',()=>{const x='{"items":[{"is_ad":1},{"title":"keep"}]}';assert(pattern('Lists').test(api));assert(pattern('Lists').test(api+'_v5'));for(const path of ['statuses/update','statuses/container_timeline_hot/save','comments/create','video/flow_stream_write','users/show']){const url='https://api.weibo.cn/2/'+path;assert(!pattern('Lists').test(url));assert.equal(run(x,url),undefined);}assert.equal(run(x,api,200,'POST'),run(x,api,200,'GET'));assert.equal(run(x,api,200,'DELETE'),undefined);});
test('malformed, duplicate-key, deep, partial and error envelopes fail open',()=>{const src='{"items":[{"is_ad":1},{"text":"normal"}]}';for(const code of [204,206,301,304,403,500])assert.equal(run(src,api,code),undefined);for(const b of ['broken','[]',src.replace('"items":','"items":[],"items":'),'{"error_code":99,'+src.slice(1),'{"ok":0,'+src.slice(1),'{"deep":'+'['.repeat(70)+'0'+']'.repeat(70)+','+src.slice(1)])assert.equal(run(b),undefined);});
test('SDK suffix and signed-looking URI boundaries preserved',()=>{const sdk='https://sdkapp.uve.weibo.com/interface/sdk/sdkad.php';assert.equal(run('{"ads":[{}],"keep":0}OK\n',sdk),'{"ads":[],"keep":0}OK\n');assert.equal(run('{"ads":[{}]}extraOK',sdk),undefined);assert(!pattern('Splash').test(boot+'_other'));});
test('diagnostic outcomes contain no URL, payload, or exception text',()=>{
  for(const [body,reason] of [['PRIVATE_SENTINEL','invalid_json'],['{"items":[{"is_ad":1}]}','empty_list_guard'],['{"items":[{"is_ad":1},{"text":"PRIVATE_SENTINEL"}]}','rewritten'],['{"error_code":1}','business_error']]){
    const logs=[];let calls=0;
    vm.runInNewContext(src,{$argument:'diagnostic',$request:{url:api+'?token=PRIVATE_SENTINEL',method:'GET'},$response:{status:200,body},console:{log:x=>logs.push(x)},$done(){calls++}},{timeout:1000});
    assert.equal(calls,1);assert.equal(logs.length,1);assert(logs[0].includes(reason));assert(!logs[0].includes('PRIVATE_SENTINEL'));assert(!logs[0].includes(api));
  }
});
test('logging failure cannot interrupt delivery; diagnostics are opt-in',()=>{
  for(const argument of [undefined,'diagnostic']){
    let calls=0,logs=0;
    vm.runInNewContext(src,{$argument:argument,$request:{url:api,method:'GET'},$response:{status:200,body:'{"items":[{"is_ad":1},{"text":"keep"}]}'},console:{log(){logs++;throw Error('log unavailable')}},$done(v){calls++;assert.equal(v.body,'{"items":[{"text":"keep"}]}')}},{timeout:1000});
    assert.equal(calls,1);assert.equal(logs,argument?1:0);
  }
});
test('content candidate preserves JSC and keeps buffering bounded',()=>{
  const m=fs.readFileSync(path.join(__dirname,'../apps/weibo/Weibo.sgmodule'),'utf8');
  assert(m.includes('engine=jsc'));assert(m.includes('max-size=2097152'));assert(!m.includes('argument=diagnostic'));assert(m.includes('debug=false'));
});

test('observed POST reads are supported without admitting write endpoints',()=>{
  const b='{"items":[{"is_ad":1},{"text":"keep"}],"cursor":9007199254740993}';
  for(const p of ['statuses/container_timeline','statuses/container_timeline_unread','statuses/container_timeline_hot','statuses/container_detail','statuses/container_detail_comment','statuses/container_positive','video/flow_video_list','video/tiny_stream_mid_detail','flowlist']){
    const u='https://api.weibo.cn/2/'+p;
    assert(pattern('Lists').test(u));assert.equal(run(b,u,200,'POST'),'{"items":[{"text":"keep"}],"cursor":9007199254740993}');
  }
  for(const p of ['statuses/update','statuses/destroy','comments/create','comments/destroy','friendships/create','statuses/longtext_show_batch'])assert.equal(run(b,'https://api.weibo.cn/2/'+p,200,'POST'),undefined);
});
