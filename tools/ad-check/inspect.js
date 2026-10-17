/* Shared by the local analyser and the temporary Surge observer. No I/O. */
(function (root) {
  'use strict';
  const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
  const one = x => x === true || x === 1 || x === '1';
  function hash(text) {
    // A structural fingerprint, not a security checksum or an anonymisation guarantee.
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
    return (h >>> 0).toString(16).padStart(8, '0');
  }
  function marked(v) {
    return object(v) && (['is_ad', 'isAd', 'is_ad_card', 'ad_marked', 'mblogtype', 'is_ad_pos'].some(k => one(v[k])) ||
      (typeof v.itemid === 'string' && /(?:^|\|)(?:is_ad_pos:1|cate_type:ads_hotword)(?:\||$)/.test(v.itemid)) ||
      v.corner_mark_data?.title === '广告' || v.promotion?.type === 'ad');
  }
  function weiboAd(v) {
    return object(v) && (marked(v) || marked(v.mblog) ||
      (['feed', 'card', 'detail', 'svs'].includes(v.category) &&
        (marked(v.data) || marked(v.data?.blog) || marked(v.data?.mblog) ||
          (v.category === 'detail' && v.type === 'trend' && one(v.data?.ad_from_comment)))));
  }
  function route(app, url) {
    const m = /^https?:\/\/([^/:?#]+)(?::\d+)?([^?#]*)/.exec(url || '');
    if (!m) return null;
    const h = m[1].toLowerCase(), p = m[2];
    if (app === 'xianyu' && /^(acs|g-acs)\.m\.goofish\.com$/.test(h)) {
      for (const [api, name] of [
        ['idlecommerce.splash.ads', 'splash'], ['idlecommerce.splash.async.ads', 'splash-cache'],
        ['idlehome.home.nextfresh', 'home'], ['idlemtopsearch.search', 'search']]) {
        if (new RegExp('^/gw/mtop\\.taobao\\.' + api.replace(/\./g, '\\.') + '/[^/]+$').test(p)) return app + '.' + name;
      }
    }
    if (app === 'zhibo8' && h === 'a.qiumibao.com' && p === '/ios/config/') return 'zhibo8.config';
    if (app === 'weibo') {
      if (/^(bootpreload|bootrealtime)\.uve\.weibo\.com$/.test(h) && /^\/v[123]\/ad\/(preload|realtime)$/.test(p)) return 'weibo.splash';
      if (h === 'wbapp.uve.weibo.com' && ['/wbapplua/wbpullad.lua', '/preload/get_ad'].includes(p)) return 'weibo.splash-cache';
      if (h === 'sdkapp.uve.weibo.com' && p === '/interface/sdk/sdkad.php') return 'weibo.splash-sdk';
      if (['api.weibo.cn', 'mapi.weibo.com'].includes(h) && p.startsWith('/2/')) {
        if (/^\/2\/comments\//.test(p)) return 'weibo.comments';
        if (/^\/2\/(video|stories)\//.test(p)) return 'weibo.video';
        if (/^\/2\/(search\/|searchall$)/.test(p)) return 'weibo.search';
        if (/^\/2\/(cardlist|page)$/.test(p)) return 'weibo.cards';
        if (/^\/2\/(statuses\/|profile\/|groups\/timeline|fangle\/timeline|flowlist$|flowpage$|photo\/recommend_list|service\/picfeed)/.test(p)) return 'weibo.feed';
      }
    }
    return null;
  }
  // Deliberately do not emit arbitrary JSON field names, values, IDs or URLs.
  const safeKeys = new Set(('data ads cached_ad advert advert_config enable splash_bk inter_bk pop_bk other_bk is_pre_request activities_config wifi_preloading sdk_toutiao init adMap sections resultList clickParam args cardType item main exContent dislikeFeedback bizType statuses comments cards items sub_item mblog blog category is_ad isAd is_ad_card ad_marked mblogtype is_ad_pos itemid corner_mark_data title promotion type ad_from_comment advertises advertisements max_id since_id next_cursor previous_cursor has_more nextPage ret code show_push_splash_ad').split(' '));
  function shape(value) {
    const paths = new Set(); let nodes = 0, truncated = false;
    function walk(v, path, depth) {
      if (++nodes > 6000 || depth > 16 || paths.size > 180) { truncated = true; return; }
      if (Array.isArray(v)) {
        paths.add(path + ':array');
        for (const item of v.slice(0, 24)) walk(item, path + '[]', depth + 1);
      } else if (object(v)) {
        paths.add(path + ':object');
        for (const key of Object.keys(v).sort().slice(0, 100)) {
          // adMap keys are campaign dates, not schema.
          const label = path.endsWith('.adMap') ? '*' : safeKeys.has(key) ? key : 'field-' + hash(key);
          walk(v[key], path + '.' + label, depth + 1);
        }
      } else paths.add(path + ':' + (v === null ? 'null' : typeof v));
    }
    walk(value, '$', 0);
    const list = [...paths].sort();
    return {signature: hash(list.join('\n')), paths: list.slice(0,180), truncated};
  }
  function inspect(app, routeId, raw) {
    if (typeof raw !== 'string') return {parse: 'missing', recognized: false};
    if (raw.length > 524288) return {parse: 'too-large', recognized: false};
    let v;
    try {
      let text = raw;
      if (routeId === 'weibo.splash-sdk' && /OK\s*$/.test(text)) text = text.slice(0, text.lastIndexOf('}') + 1);
      v = JSON.parse(text);
    } catch (_) { return {parse: 'invalid-json', recognized: false}; }
    if (!object(v)) return {parse: 'unknown-root', recognized: false};
    const out = {parse: 'ok', recognized: false, ads: 0, normal: null, types: [], shape: shape(v), protected: null};
    let protectedValue;
    if (app === 'xianyu' && object(v.data)) {
      const d = v.data;
      if (['xianyu.splash', 'xianyu.splash-cache'].includes(routeId) && object(d.adMap)) {
        out.recognized = true; out.ads = Object.keys(d.adMap).length;
        protectedValue = {...v, data: {...d}}; delete protectedValue.data.adMap;
      } else {
        const key = routeId === 'xianyu.home' ? 'sections' : routeId === 'xianyu.search' ? 'resultList' : null;
        if (key && Array.isArray(d[key])) {
          const kind = x => key === 'sections' ? x?.data?.clickParam?.args?.cardType : x?.data?.item?.main?.exContent?.dislikeFeedback?.clickParam?.args?.bizType;
          const ad = x => kind(x) === (key === 'sections' ? 'mamaAD' : 'ad');
          const kept = d[key].filter(x => !ad(x));
          out.recognized = true; out.ads = d[key].length - kept.length; out.normal = kept.length;
          out.types = [...new Set(kept.map(x => kind(x) === undefined ? 'unmarked' : kind(x) === 'item' ? 'item' : 'type-' + hash(String(kind(x)))))].sort().slice(0, 32);
          protectedValue = {...v, data: {...d, [key]: kept}};
        }
      }
    } else if (app === 'zhibo8') {
      const on = x => [true, 1, '1', 'true', 'enable'].includes(x);
      const a = v.advert_config;
      out.recognized = object(v.advert) || object(a);
      out.ads = Number(on(v.advert?.enable));
      if (object(a)) {
        out.ads += ['splash_bk', 'inter_bk', 'pop_bk', 'other_bk', 'is_pre_request'].filter(k => on(a[k])).length;
        out.ads += Number(on(a.wifi_preloading?.enable)) + Number(on(a.sdk_toutiao?.init));
        out.ads += Array.isArray(a.activities_config) ? a.activities_config.length : 0;
      }
      // Protect every field except the precise fields owned by the filter.
      protectedValue = JSON.parse(JSON.stringify(v));
      if (object(protectedValue.advert)) delete protectedValue.advert.enable;
      const b = protectedValue.advert_config;
      if (object(b)) {
        for (const k of ['splash_bk','inter_bk','pop_bk','other_bk','is_pre_request','activities_config']) delete b[k];
        if (object(b.wifi_preloading)) delete b.wifi_preloading.enable;
        if (object(b.sdk_toutiao)) delete b.sdk_toutiao.init;
      }
    } else if (app === 'weibo') {
      if (routeId?.startsWith('weibo.splash')) {
        out.recognized = Array.isArray(v.ads) || Array.isArray(v.cached_ad?.ads) || typeof v.show_push_splash_ad === 'boolean';
        out.ads = (Array.isArray(v.ads) ? v.ads.length : 0) + (Array.isArray(v.cached_ad?.ads) ? v.cached_ad.ads.length : 0) + Number(v.show_push_splash_ad === true);
        protectedValue = {...v}; delete protectedValue.ads; delete protectedValue.show_push_splash_ad;
        if (object(v.cached_ad)) { protectedValue.cached_ad = {...v.cached_ad}; delete protectedValue.cached_ad.ads; }
      } else {
        let nodes = 0, normals = 0; const paging = [];
        function walk(x, depth) {
          if (++nodes > 12000 || depth > 60) throw Error('limit');
          if (Array.isArray(x)) {
            for (const item of x) {
              if (weiboAd(item)) out.ads++;
              else { if (object(item) && (item.mblog || item.text || item.category === 'feed')) normals++; walk(item, depth + 1); }
            }
          } else if (object(x)) {
            for (const k of Object.keys(x)) {
              if (['max_id', 'since_id', 'next_cursor', 'previous_cursor', 'has_more'].includes(k)) paging.push([k, x[k]]);
              if (['advertises', 'advertisements'].includes(k) && Array.isArray(x[k])) out.ads += x[k].length;
              else walk(x[k], depth + 1);
              if (['statuses','comments','cards','items','data'].includes(k) && Array.isArray(x[k])) out.recognized = true;
            }
          }
        }
        try { walk(v, 0); } catch (_) { return {parse: 'too-complex', recognized: false}; }
        out.normal = normals; protectedValue = paging; out.protectionScope = 'pagination-only';
      }
    }
    if (protectedValue !== undefined) out.protected = hash(JSON.stringify(protectedValue));
    return out;
  }
  function safePath(p) {
    if(typeof p!=='string'||p.length>1200||!/^\$(?:\.(?:[a-zA-Z_][a-zA-Z_0-9-]*|\*)|\[\])*:(?:array|object|null|string|number|boolean)$/.test(p))return false;
    const keys=p.split(':')[0].replace(/\[\]/g,'').split('.').slice(1);
    return keys.every(k=>k==='*'||safeKeys.has(k)||/^field-[a-f0-9]{8}$/.test(k));
  }
  const api = {route, inspect, hash, safePath};
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AdCheck = api;
})(typeof globalThis === 'object' ? globalThis : this);
