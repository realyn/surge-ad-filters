// Filter only advertising fields observed in Xianyu's own API responses.
(function () {
  let result = {};
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  // Only the two dedicated splash endpoints use this bounded raw-span rewrite.
  function cleanSplash(raw, root, status) {
    var started=Date.now(), cleared=0, edits=[], unknown=false;
    function finish(reason, value) {
      try { if(typeof $argument==='string' && $argument==='diagnostic')
        console.log('Xianyu Ad Filter splash: '+reason+'; cleared_containers='+cleared+'; elapsed_ms='+(Date.now()-started));
      } catch (_) {}
      return value || {};
    }
    if(status===204 || status===206) return finish('partial_or_empty_status');
    if(root.error || (Array.isArray(root.ret) && root.ret.some(x=>typeof x==='string' && /^(?:FAIL|ERROR)(?:_|::|$)/.test(x)))) return finish('business_error');
    try {
    var i=0,nodes=0;
    function ws(){while(i<raw.length && /[\t\r\n ]/.test(raw[i]))i++;}
    function stringEnd(){i++;while(i<raw.length){var c=raw[i++];if(c==='"')return;if(c==='\\')i++;}throw Error('string');}
    function read(v,d){ws();if(d>56 || ++nodes>50000)throw Error('limit');var a=i,ch=raw[i],node={a:a,v:v};
      if(ch==='{'){i++;ws();var seen=Object.create(null);node.props=[];while(raw[i]!=='}'){var start=i;stringEnd();var k=JSON.parse(raw.slice(start,i));if(seen[k])throw Error('duplicate');seen[k]=true;ws();i++;node.props.push([k,read(v[k],d+1)]);ws();if(raw[i]===','){i++;ws();}else break;}i++;}
      else if(ch==='['){i++;ws();node.items=[];while(raw[i]!==']'){node.items.push(read(v[node.items.length],d+1));ws();if(raw[i]===','){i++;ws();}else break;}i++;}
      else if(ch==='"')stringEnd();else while(i<raw.length && !/[,\]}\s]/.test(raw[i]))i++;
      node.b=i;return node;
    }
      var tree=read(root,0);ws();if(i!==raw.length) return finish('unsupported_structure');
      var dataNode=tree.props.find(x=>x[0]==='data');
      if(!dataNode) return finish('unrecognized_structure');
      function visit(node, depth) {
        if(!node.props || depth>2) return;
        for(var pair of node.props) {
          var key=pair[0], value=pair[1];
          if(key==='adMap') {
            if(!value.props && !value.items) { unknown=true; continue; }
            if((value.props && value.props.length) || (value.items && value.items.length))
              edits.push([value.a,value.b,value.items?'[]':'{}']);
          } else if((key==='data'||key==='result') && depth<2) visit(value,depth+1);
        }
      }
      visit(dataNode[1],0);
      if(unknown) return finish('unknown_admap_type');
      if(!edits.length) return finish('no_change');
      edits.sort((a,b)=>a[0]-b[0]);
      var pos=0,out='';
      for(var edit of edits) { if(edit[0]<pos) throw Error('overlap');out+=raw.slice(pos,edit[0])+edit[2];pos=edit[1]; }
      out+=raw.slice(pos);cleared=edits.length;
      return finish('rewritten',{body:out});
    } catch (_) { cleared=0;return finish('unsupported_structure'); }
  }
  try {
    const status = Number($response.status || $response.statusCode || 200);
    if (!(status >= 200 && status < 300) || typeof $response.body !== 'string') return $done(result);
    const route = /^https:\/\/(acs|g-acs)\.m\.goofish\.com\/gw\/(mtop\.taobao\.(?:idlecommerce\.splash\.(?:async\.)?ads|idlehome\.home\.nextfresh|idlemtopsearch\.search))\/[^/?]+(?:\?|$)/.exec($request.url);
    if (!route) return $done(result);
    const splashRoute = /\.splash\.(?:async\.)?ads$/.test(route[2]);
    if(splashRoute && $response.body.length>2097152) return $done({});
    const body = JSON.parse($response.body);
    if (!object(body) || !object(body.data)) return $done(result);
    const data = body.data; let changed = false;
    if (splashRoute) {
      result = cleanSplash($response.body, body, status);
    } else if (route[2] === 'mtop.taobao.idlehome.home.nextfresh' && Array.isArray(data.sections)) {
      const keep = data.sections.filter(section => section?.data?.clickParam?.args?.cardType !== 'mamaAD');
      if (keep.length !== data.sections.length) { data.sections = keep; changed = true; }
    } else if (route[2] === 'mtop.taobao.idlemtopsearch.search' && Array.isArray(data.resultList)) {
      const keep = data.resultList.filter(entry => entry?.data?.item?.main?.exContent?.dislikeFeedback?.clickParam?.args?.bizType !== 'ad');
      if (keep.length !== data.resultList.length) { data.resultList = keep; changed = true; }
    }
    if (changed) result = {body: JSON.stringify(body)};
  } catch (_) { result = {}; }
  $done(result);
})();
