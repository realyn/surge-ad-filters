// Weibo ad filtering. No network calls, persistent storage, or account changes.
(function () {
  var result = {}, removed = 0;
  function object(v) { return v && typeof v === 'object' && !Array.isArray(v); }
  function one(v) { return v === true || v === 1 || v === '1'; }
  function marked(v) {
    return object(v) && (one(v.is_ad) || one(v.isAd) || one(v.is_ad_card) ||
      one(v.ad_marked) || one(v.mblogtype) ||
      one(v.is_ad_pos) || (typeof v.itemid === 'string' && /(?:^|\|)(?:is_ad_pos:1|cate_type:ads_hotword)(?:\||$)/.test(v.itemid)) ||
      (object(v.corner_mark_data) && v.corner_mark_data.title === '广告') ||
      (object(v.promotion) && v.promotion.type === 'ad'));
  }
  function adItem(v) {
    if (!object(v)) return false;
    if (marked(v) || marked(v.mblog)) return true;
    if (v.category === 'feed' || v.category === 'card' || v.category === 'detail' || v.category === 'svs') {
      if (marked(v.data)) return true;
      if (object(v.data) && (marked(v.data.blog) || marked(v.data.mblog))) return true;
      if (v.category === 'detail' && v.type === 'trend' && object(v.data) && one(v.data.ad_from_comment)) return true;
    }
    return false;
  }
  function clean(v, depth) {
    if (depth > 80) throw new Error('Unexpected nesting');
    if (Array.isArray(v)) {
      var kept = [];
      v.forEach(function (item) {
        if (adItem(item)) { removed++; return; }
        var hadSubItems = object(item) && Array.isArray(item.sub_item) && item.sub_item.length > 0;
        var hadCardItems = object(item) && item.category === 'card' && object(item.data) && Array.isArray(item.data.items) && item.data.items.length > 0;
        var previousRemoved = removed;
        var cleaned = clean(item, depth + 1);
        // Drop an empty carousel cell only when its explicitly labelled ads were removed.
        if (removed > previousRemoved && ((hadSubItems && cleaned.sub_item.length === 0) ||
          (hadCardItems && cleaned.data.items.length === 0))) return;
        kept.push(cleaned);
      });
      return kept;
    }
    if (object(v)) {
      Object.keys(v).forEach(function (key) {
        // These are explicit ad collections; ordinary recommendations are retained.
        if ((key === 'advertises' || key === 'advertisements') && Array.isArray(v[key]) && v[key].length) {
          removed += v[key].length; v[key] = [];
        } else { v[key] = clean(v[key], depth + 1); }
      });
    }
    return v;
  }
  try {
    var url = $request.url;
    var preload = /^https:\/\/(?:bootpreload|bootrealtime)\.uve\.weibo\.com\/v[123]\/ad\/(?:preload|realtime)(?:\?|$)/.test(url);
    var cached = /^https:\/\/wbapp\.uve\.weibo\.com\/(?:wbapplua\/wbpullad\.lua|preload\/get_ad)(?:\?|$)/.test(url);
    var sdk = /^https:\/\/sdkapp\.uve\.weibo\.com\/interface\/sdk\/sdkad\.php(?:\?|$)/.test(url);
    var api = /^https:\/\/(?:api\.weibo\.cn|mapi\.weibo\.com)\/2\/(?:statuses\/|comments\/|search\/|searchall(?:\?|$)|cardlist(?:\?|$)|page(?:\?|$)|profile\/(?:container_timeline|statuses)|flowlist(?:\?|$)|flowpage(?:\?|$)|video\/(?:flow_stream(?:_cache)?|flow_video_list|full_screen_stream|tiny_stream_mid_detail|tiny_stream_video_list)|stories\/(?:video_stream|home_list)|groups\/timeline|fangle\/timeline|photo\/recommend_list|service\/picfeed)/.test(url);
    if (!(preload || cached || sdk || api) || typeof $response.body !== 'string') { $done({}); return; }
    if (Number($response.status) >= 400) { $done({}); return; }
    var raw = $response.body, suffix = '';
    if (sdk && /OK\s*$/.test(raw)) {
      var end = raw.lastIndexOf('}'); suffix = raw.slice(end + 1); raw = raw.slice(0, end + 1);
    }
    var body = JSON.parse(raw);
    if (!object(body)) { $done({}); return; }
    if (preload || sdk) {
      if (Array.isArray(body.ads) && body.ads.length) { removed += body.ads.length; body.ads = []; }
      if (sdk && body.show_push_splash_ad === true) { body.show_push_splash_ad = false; removed++; }
    } else if (cached) {
      if (object(body.cached_ad) && Array.isArray(body.cached_ad.ads) && body.cached_ad.ads.length) {
        removed += body.cached_ad.ads.length; body.cached_ad.ads = [];
      }
      if (Array.isArray(body.ads) && body.ads.length) { removed += body.ads.length; body.ads = []; }
    } else { body = clean(body, 0); }
    if (removed) {
      result = { body: JSON.stringify(body) + suffix };
      console.log('Weibo Ad Filter: removed ' + removed + ' ad items');
    }
  } catch (_) { result = {}; }
  $done(result);
})();
