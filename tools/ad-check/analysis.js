/* Deterministic, offline analysis. All filter sources are embedded at build time. */
const Engine = (() => {
  const APPS = {weibo:'微博',zhibo8:'直播吧',xianyu:'闲鱼'};
  const ROUTES = {'weibo.splash':'开屏','weibo.splash-cache':'开屏缓存','weibo.splash-sdk':'开屏 SDK','weibo.feed':'信息流','weibo.comments':'评论','weibo.video':'视频','weibo.search':'搜索/热搜','weibo.cards':'卡片/发现','zhibo8.config':'广告配置','xianyu.splash':'开屏','xianyu.splash-cache':'开屏预取','xianyu.home':'首页','xianyu.search':'搜索'};
  const GROUPS = {weibo:[['weibo.splash','weibo.splash-cache','weibo.splash-sdk'],['weibo.feed'],['weibo.cards','weibo.search'],['weibo.comments'],['weibo.video']],zhibo8:[['zhibo8.config']],xianyu:[['xianyu.splash','xianyu.splash-cache'],['xianyu.home'],['xianyu.search']]};
  const DOMAINS = {weibo:['weibo.cn','weibo.com'],zhibo8:['qiumibao.com','zhibo8.cc','zhibo8.com','duoduocdn.com'],xianyu:['goofish.com']};
  function metric(v) {
    if(!v||typeof v!=='object') return {parse:'missing',recognized:false};
    const out={parse:['ok','missing','too-large','too-complex','invalid-json','unknown-root'].includes(v.parse)?v.parse:'missing',recognized:v.recognized===true};
    for(const k of ['ads','normal'])out[k]=Number.isInteger(v[k])&&v[k]>=0&&v[k]<=1000000?v[k]:null;
    out.types=Array.isArray(v.types)?[...new Set(v.types.filter(x=>typeof x==='string'&&/^(item|unmarked|type-[a-f0-9]{8})$/.test(x)))].sort().slice(0,32):[];
    out.shape={signature:/^[a-f0-9]{8}$/.test(v.shape?.signature||'')?v.shape.signature:null,truncated:v.shape?.truncated===true};
    out.shape.paths=Array.isArray(v.shape?.paths)?v.shape.paths.filter(AdCheck.safePath).slice(0,180):[];
    if(v.protectionScope==='pagination-only')out.protectionScope=v.protectionScope;
    return out;
  }
  function event(v,session) {
    if(!v||v.v!==1||!APPS[v.app]||!ROUTES[v.route]||!v.route.startsWith(v.app+'.')||(session&&v.session!==session))return null;
    const def=DEFINITIONS.find(d=>d.app===v.app);
    if(v.source!==def.sourceHash)return null;
    return {v:1,app:v.app,route:v.route,source:v.source,status:Number.isInteger(v.status)&&v.status>=100&&v.status<=599?v.status:0,
      before:metric(v.before),after:metric(v.after),preserved:typeof v.preserved==='boolean'?v.preserved:null,simulated:v.simulated===true};
  }
  function metadata(record) {
    const m=/^https?:\/\/([^/:?#]+)(?::\d+)?([^?#]*)/i.exec(record.URL||'');
    if(!m)return null;
    const host=m[1].toLowerCase();
    let app=Object.keys(DOMAINS).find(a=>DOMAINS[a].some(d=>host===d||host.endsWith('.'+d)));
    if(!app&&['sdkquic.e.qq.com','tk.lanjingads.com'].includes(host))app='zhibo8';
    if(!app)return null;
    const endpoint=AdCheck.hash(host+'\n'+m[2]);
    return {app,endpoint,failed:record.failed===true,rejected:record.rejected===true,completed:record.completed===true};
  }
  function ingest(record,session) {
    const events=[];
    for(const note of Array.isArray(record.notes)?record.notes:[]) {
      if(typeof note!=='string'||!note.includes('AD_CHECK_V1 '))continue;
      try {const e=event(JSON.parse(note.split('AD_CHECK_V1 ')[1]),session);if(e)events.push(e);}catch(_){}
    }
    return {id:typeof record.id==='number'||typeof record.id==='string'?String(record.id).slice(0,80):null,events,request:metadata(record)};
  }
  function replay(entries) {
    const out=[];
    for(const entry of entries) {
      const def=DEFINITIONS.find(d=>new RegExp(d.pattern).test(entry.url));
      if(!def)continue;
      let result={},calls=0;
      // Only build-time trusted source is executed; HAR text is passed as data.
      new Function('$request','$response','$done','console',def.source)({url:entry.url},{status:entry.status,body:entry.body},r=>{result=r||{};calls++;},{log(){}});
      if(calls!==1)throw Error('Invalid completion');
      const route=AdCheck.route(def.app,entry.url);
      const before=AdCheck.inspect(def.app,route,entry.body),after=AdCheck.inspect(def.app,route,result.body??entry.body);
      const preserved=before.protected!==null&&before.protected!==undefined?before.protected===after.protected:null;
      out.push(event({v:1,app:def.app,route,source:def.sourceHash,status:entry.status,before,after,preserved,simulated:true}));
    }
    return out.filter(Boolean);
  }
  function precedence(scripts,observed) {
    const probes={weibo:['https://bootpreload.uve.weibo.com/v3/ad/preload','https://api.weibo.cn/2/statuses/home_timeline','https://mapi.weibo.com/2/cardlist'],zhibo8:['https://a.qiumibao.com/ios/config/'],xianyu:['https://acs.m.goofish.com/gw/mtop.taobao.idlecommerce.splash.ads/2.0','https://g-acs.m.goofish.com/gw/mtop.taobao.idlehome.home.nextfresh/8.0']};
    const errors=[];
    for(const [app,urls]of Object.entries(probes))for(const url of urls){
      const s=scripts.find(s=>s.enabled&&s.type==='http-response'&&new RegExp(s.parameters.pattern).test(url));
      if(!s||s.name!==(observed?'adcheck-'+app:app+'-ad-filter'))errors.push(app);
    }
    return [...new Set(errors)];
  }
  function report(input) {
    const {events=[],requests=[],baseline=null,feedback={},errors=[]}=input;
    const rows=Object.entries(ROUTES).map(([route,label])=>{
      const samples=events.filter(e=>e.route===route),old=baseline?.routes?.[route],reasons=[];
      const shapes=[...new Set(samples.map(e=>e.before.shape?.signature).filter(Boolean))].sort();
      const paths=[...new Set(samples.flatMap(e=>e.before.shape?.paths||[]))].sort().slice(0,360);
      const types=[...new Set(samples.flatMap(e=>e.before.types||[]))].sort();
      const newTypes=old?.types?types.filter(t=>!old.types.includes(t)):[];
      const changes=samples.length&&old?.paths?{added:paths.filter(p=>!old.paths.includes(p)).slice(0,30),absent:old.paths.filter(p=>!paths.includes(p)).slice(0,30)}:null;
      if(samples.length){
        if(samples.some(e=>e.status>=400||e.status===0))reasons.push('响应状态异常');
        if(samples.some(e=>e.before.parse!=='ok'||e.after.parse!=='ok'))reasons.push('正文缺失、格式异常或超出诊断上限');
        if(samples.some(e=>!e.before.recognized))reasons.push('未识别到预期数据结构');
        if(samples.some(e=>(e.after.ads||0)>0))reasons.push('过滤后仍存在已知广告标记');
        if(samples.some(e=>e.preserved===false))reasons.push('受保护的正常字段发生变化');
        if(samples.some(e=>e.before.shape?.truncated||e.after.shape?.truncated))reasons.push('结构摘要不完整');
        if(old&&shapes.some(s=>!old.shapes.includes(s)))reasons.push('响应结构变化，需复查（不等于新增广告）');
        if(newTypes.length)reasons.push('内容类型变化，需复查（不等于新增广告）');
        if(old&&samples.some(e=>!old.sources.includes(e.source)))reasons.push('过滤脚本版本变化，需重新确认');
        if(samples.some(e=>e.simulated))reasons.push('HAR 本地模拟，不能证明手机实际过滤效果');
      }
      return {route,app:route.split('.')[0],label,count:samples.length,status:!samples.length?'uncovered':reasons.length?'review':old?'observed':'no-baseline',reasons,
        beforeAds:samples.reduce((n,e)=>n+(e.before.ads||0),0),afterAds:samples.reduce((n,e)=>n+(e.after.ads||0),0),
        normal:samples.length?samples[samples.length-1].after.normal:null,shapes,paths,changes,types,newTypes,sources:[...new Set(samples.map(e=>e.source))],
        baseline:!!old,simulated:samples.some(e=>e.simulated),
        preservation:samples.some(e=>e.preserved===false)?'changed':samples.some(e=>e.preserved===true)?route.startsWith('weibo.')&&!route.startsWith('weibo.splash')?'pagination-only':'selected-fields':'unverified'};
    });
    const coverage={};for(const [app,groups]of Object.entries(GROUPS))coverage[app]={done:groups.filter(g=>rows.some(r=>r.count&&g.includes(r.route))).length,total:groups.length};
    const endpoints=[...new Set(requests.map(r=>r.endpoint))].sort();
    return {version:1,time:new Date().toISOString(),rows,coverage,requestCount:requests.length,
      newEndpointCount:baseline?endpoints.filter(e=>!(baseline.endpoints||[]).includes(e)).length:null,
      failedRequests:requests.filter(r=>r.failed).length,rejectedRequests:requests.filter(r=>r.rejected).length,
      feedback,errors,endpoints,
      notice:'通过只表示已采集的已知接口未发现相应异常，不代表全部广告消失。结构变化和新地址仅是线索；未采集接口不能判定有效。'};
  }
  function baseline(report,previous) {
    if(report.mode==='har'||!report.restored||report.errors.length)throw Error('请先完成无连接异常的实机检测。HAR 模拟不能设为实机基准。');
    const base=JSON.parse(JSON.stringify(previous||{routes:{},endpoints:[]}));let count=0;
    for(const row of report.rows){
      const f=report.feedback[row.app];
      if(!row.count||row.simulated||f?.visibleAd!=='no'||f?.normalBrowsing!=='yes')continue;
      if(row.reasons.some(r=>!r.startsWith('响应结构变化')&&!r.startsWith('过滤脚本版本变化')&&!r.startsWith('内容类型变化')))continue;
      base.routes[row.route]={shapes:row.shapes,paths:row.paths||[],types:row.types||[],sources:row.sources};count++;
    }
    if(!count)throw Error('请确认已检查应用未看到广告且浏览正常，并确保响应无异常。');
    base.endpoints=[...new Set([...base.endpoints,...report.endpoints])].slice(0,10000);base.updated=report.time;
    return {baseline:base,count};
  }
  function match(url){const d=DEFINITIONS.find(d=>new RegExp(d.pattern).test(url));return d?AdCheck.route(d.app,url):null;}
  return {metric,event,metadata,ingest,replay,precedence,report,baseline,match};
})();
