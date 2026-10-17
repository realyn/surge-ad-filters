// Filter only advertising fields observed in Xianyu's own API responses.
(function () {
  let result = {};
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  try {
    const status = Number($response.status || $response.statusCode || 200);
    if (!(status >= 200 && status < 300) || typeof $response.body !== 'string') return $done(result);
    const route = /^https:\/\/(acs|g-acs)\.m\.goofish\.com\/gw\/(mtop\.taobao\.(?:idlecommerce\.splash\.(?:async\.)?ads|idlehome\.home\.nextfresh|idlemtopsearch\.search))\/[^/?]+(?:\?|$)/.exec($request.url);
    if (!route) return $done(result);
    const body = JSON.parse($response.body);
    if (!object(body) || !object(body.data)) return $done(result);
    const data = body.data; let changed = false;
    if (/\.splash\.(?:async\.)?ads$/.test(route[2])) {
      if (object(data.adMap) && Object.keys(data.adMap).length) { data.adMap = {}; changed = true; }
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
