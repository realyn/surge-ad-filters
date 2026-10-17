(function () {
  const url = $request.url;
  if (!/^http:\/\/[^/]+\/amdc\/mobileDispatch(?:\?|$)/.test(url)) return $done({});
  const headers = $request.headers || {};
  const ua = Object.keys(headers).find(k => k.toLowerCase() === 'user-agent');
  if (!ua || !/^(?:%E9%97%B2%E9%B1%BC|闲鱼)\//i.test(headers[ua])) return $done({});
  if (typeof $response === 'undefined') {
    const updated = {...headers};
    Object.keys(updated).filter(k => k.toLowerCase() === 'accept-encoding').forEach(k => delete updated[k]);
    updated['Accept-Encoding'] = 'gzip';
    return $done({headers: updated});
  }
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function decode(s) {
    let bits = 0, acc = 0, bytes = '';
    for (const c of s.replace(/\s/g, '')) {
      if (c === '=') break;
      const v = alphabet.indexOf(c); if (v < 0) throw Error('base64');
      acc = (acc << 6) | v; bits += 6;
      if (bits >= 8) { bits -= 8; bytes += '%' + ((acc >> bits) & 255).toString(16).padStart(2, '0'); }
    }
    return decodeURIComponent(bytes);
  }
  function encode(s) {
    const bytes = unescape(encodeURIComponent(s)); let out='';
    for(let i=0;i<bytes.length;i+=3){
      const n=(bytes.charCodeAt(i)<<16)|((bytes.charCodeAt(i+1)||0)<<8)|(bytes.charCodeAt(i+2)||0);
      out += alphabet[(n>>>18)&63]+alphabet[(n>>>12)&63]+(i+1<bytes.length?alphabet[(n>>>6)&63]:'=')+(i+2<bytes.length?alphabet[n&63]:'=');
    } return out;
  }
  try {
    const status = Number($response.status || $response.statusCode || 200);
    if (!(status >= 200 && status < 300) || typeof $response.body !== 'string') return $done({});
    const raw=$response.body; const base64=!raw.trim().startsWith('{');
    const body=JSON.parse(base64?decode(raw):raw);
    let changed=false;
    if(body.code !== 1000 || !Array.isArray(body.dns)) return $done({});
    for(const entry of body.dns){
      if(!['acs.m.goofish.com','g-acs.m.goofish.com'].includes(entry.host)) continue;
      for(const server of entry.servers || []) for(const channel of server.channels || []) {
        if(!Array.isArray(channel.attributes)) continue;
        const keep=channel.attributes.filter(a=>a.protocol === 'https');
        if(keep.length && Array.isArray(channel.ips) && channel.ips.length) { channel.ips=[]; changed=true; }
        if(keep.length && keep.length < channel.attributes.length) {channel.attributes=keep;changed=true;}
      }
    }
    if(!changed) return $done({});
    const serialized=JSON.stringify(body);
    $done({body:base64?encode(serialized):serialized});
  } catch(e) { $done({}); }
})();
