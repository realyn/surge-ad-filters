// Weibo Ad Filter. No networking or persistent storage. Diagnostics contain counts only.
(function () {
  var removed = 0, recognized = false;
  var result = {}, reason = "no_matching_ad", guarded = 0, phase = "input", started = Date.now();
  var url = $request.url || '';
  var splash = /^https:\/\/(?:(?:bootpreload|bootrealtime)\.uve\.weibo\.com\/v[1-9][0-9]*\/ad\/(?:preload|realtime)|wbapp\.uve\.weibo\.com\/(?:wbapplua\/wbpullad\.lua|preload\/get_ad)|sdkapp\.uve\.weibo\.com\/interface\/sdk\/sdkad\.php)(?:\?|$)/;
  var api = /^https:\/\/(?:api\.weibo\.cn|mapi\.weibo\.com)\/2\/(?:statuses\/(?:container_(?:timeline(?:_[a-z0-9]+)*|detail(?:_comment|_forward)?|positive)|(?:home|user|friends)_timeline)|comments\/(?:build_comments|show|hotflow|bullet_screens)|search\/(?:finder|container_timeline)|searchall|cardlist|page|profile\/(?:container_timeline|statuses)|flowlist|flowpage|video\/(?:flow_stream(?:_cache)?|flow_video_list|full_screen_stream|tiny_stream_mid_detail|tiny_stream_video_list)|stories\/(?:video_stream|home_list)|groups\/timeline|fangle\/timeline|photo\/recommend_list|service\/picfeed)(?:\?|$)/;
  var listKeys = /^(?:statuses|items|comments|replies|cards|data|sub_item|group|resultList)$/;
  var envelope = /^(?:data|header|pageHeader|lists|statuses|items|comments|replies|cards|sub_item|group|resultList)$/;
  function object(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function one(x) { return x === true || x === 1 || x === '1'; }
  function marked(v, legacy) {
    return object(v) && (one(v.is_ad) || one(v.isAd) || one(v.is_ad_card) || one(v.ad_marked) || one(v.is_ad_pos) || (legacy && one(v.mblogtype)) ||
      (typeof v.itemid === 'string' && /(?:^|\|)(?:is_ad_pos:1|cate_type:ads_hotword)(?:\||$)/.test(v.itemid)) ||
      (object(v.corner_mark_data) && v.corner_mark_data.title === '广告') || (object(v.promotion) && v.promotion.type === 'ad'));
  }
  function ad(v, key) {
    if (!object(v)) return false;
    var familiar = /^(?:feed|card|detail|svs)$/.test(v.category);
    function wrapped(x, depth, legacy) {
      if (!object(x) || depth > 3) return false;
      if (marked(x, legacy)) return true;
      return ['data','mblog','blog'].some(function (k) {
        return wrapped(x[k], depth + 1, familiar || k === 'mblog');
      });
    }
    if (wrapped(v, 0, key === 'statuses')) return true;
    if (v.category === 'detail' && v.type === 'trend' && object(v.data) && one(v.data.ad_from_comment)) return true;
    // Only remove a pure, identified carousel shell; a normal parent may contain ad children.
    return Array.isArray(v.sub_item) && v.sub_item.length > 0 && Object.keys(v).every(k => ['card_type','itemid','sub_item'].indexOf(k)>=0) && v.sub_item.every(x=>marked(x,false));
  }
  function run() {
    if (!splash.test(url) && !api.test(url)) { reason='endpoint_not_supported'; return; }
    if (typeof $response.body !== 'string') { reason='body_missing'; return; }
    var status=Number($response.status !== undefined ? $response.status : $response.statusCode);
    if (!(status>=200 && status<300) || status===204 || status===206) { reason='http_status_passthrough'; return; }
    if (api.test(url) && $request.method && !/^(GET|POST)$/.test($request.method)) { reason='unsupported_method'; return; }
    var raw=$response.body, suffix=''; if(!raw || raw.length>2097152) { reason='body_empty_or_limit'; return; }
    if (url.indexOf('https://sdkapp.uve.weibo.com/')===0 && /OK\s*$/.test(raw)) {
      var end=raw.lastIndexOf('}'); if(end<0){reason='invalid_sdk_suffix';return;} suffix=raw.slice(end+1); if(!/^\s*OK\s*$/.test(suffix)){reason='invalid_sdk_suffix';return;}raw=raw.slice(0,end+1);
    }
    phase='json'; var root=JSON.parse(raw); if(!object(root)){reason='root_not_object';return;}
    // User/session/error envelopes can use HTTP 200. Leave these unchanged.
    if (root.error || root.error_code || root.errno || root.ok===0 || root.ok===false) { reason='business_error'; return; }
    // Build source spans on validated JSON. Never serialize unrelated IDs/cursors via a JS number.
    var i=0,nodes=0;
    function ws(){while(i<raw.length && /[\t\r\n ]/.test(raw[i]))i++;}
    function stringEnd(){i++;while(i<raw.length){var c=raw[i++];if(c==='"')return;if(c==='\\')i++;}throw Error('string');}
    function read(v,d){ws();if(d>56 || ++nodes>50000)throw Error('limit');var a=i,ch=raw[i],node={a:a,v:v};
      if(ch==='{'){i++;ws();var seen=Object.create(null);node.props=[];while(raw[i]!=='}'){var start=i;stringEnd();var k=JSON.parse(raw.slice(start,i));if(seen[k])throw Error('duplicate');seen[k]=true;ws();i++;node.props.push([k,read(v[k],d+1)]);ws();if(raw[i]===','){i++;ws();}else break;}i++;}
      else if(ch==='['){i++;ws();node.items=[];while(raw[i]!==']'){node.items.push(read(v[node.items.length],d+1));ws();if(raw[i]===','){i++;ws();}else break;}i++;}
      else if(ch==='"')stringEnd();else while(i<raw.length && !/[,\]}\s]/.test(raw[i]))i++;
      node.b=i;return node;
    }
    phase='structure'; var tree=read(root,0);ws();if(i!==raw.length){reason='unsupported_structure';return;}
    function original(n){return raw.slice(n.a,n.b);}
    function patch(n, edits){if(!edits.length)return null;var pos=n.a,out='';for(var e of edits){out+=raw.slice(pos,e[0].a)+e[1];pos=e[0].b;}return out+raw.slice(pos,n.b);}
    function rewrite(n,key,area){
      if(n.items){if(!envelope.test(key))return null;recognized=true;var kept=[],changed=false, beforeRemoved=removed;
        for(var c of n.items){if(listKeys.test(key)&&ad(c.v,key)){changed=true;removed++;continue;}var sub=rewrite(c,'',area);changed=changed||sub!==null;kept.push(sub===null?original(c):sub);}
        // No empty business page solely because all entries happened to be marked.
        if(changed && !kept.length){guarded++;removed=beforeRemoved;}
        return changed && kept.length ? '['+kept.join(',')+']' : null;
      }
      if(!n.props)return null;var edits=[];
      for(var pair of n.props){var k=pair[0],x=pair[1],s=null;
        if(area==='splash'||area==='cache'){
          if(k==='ads' && x.items){recognized=true;if(x.items.length){s='[]';removed+=x.items.length;}}
          else if(k==='show_push_splash_ad' && typeof x.v==='boolean'){recognized=true;if(x.v)s='false';}
          else if(area==='splash' && k==='cached_ad' && x.props)s=rewrite(x,k,'cache');
        }else if((k==='advertises'||k==='advertisements')&&x.items){recognized=true;if(x.items.length){s='[]';removed+=x.items.length;}}
        else if(envelope.test(k))s=rewrite(x,k,area);
        if(s!==null)edits.push([x,s]);
      }
      return patch(n,edits);
    }
    phase='rewrite'; var replacement=rewrite(tree,'',splash.test(url)?'splash':'content');
    if(replacement!==null){result={body:raw.slice(0,tree.a)+replacement+raw.slice(tree.b)+suffix};reason='rewritten';}
    else if(guarded)reason='empty_list_guard';
    else if(!recognized)reason='unrecognized_structure';
  }
  try { run(); } catch (_) { result={}; removed=0; reason=phase==='json'?'invalid_json':phase==='structure'?'unsupported_structure':'processing_error'; }
  // Never log URLs, exception messages, IDs, credentials or response content.
  try {
    if(typeof $argument==='string' && $argument==='diagnostic')
      console.log('Weibo Ad Filter: '+reason+'; removed='+removed+'; guarded_lists='+guarded+'; elapsed_ms='+(Date.now()-started));
  } catch (_) {}
  $done(result);
})();
