// Only the observed advertising section of Zhibo8's app configuration is changed.
(function () {
  var result = {}, changed = false;
  function object(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function turnOff(parent, key) {
    if (!object(parent)) return;
    var value = parent[key], next;
    if (value === true) next = false;
    else if (value === 1) next = 0;
    else if (value === 'true') next = 'false';
    else if (value === 'enable') next = 'disable';
    else if (value === '1') next = '0';
    else return; // Leave unknown formats and already disabled values intact.
    parent[key] = next;
    changed = true;
  }
  try {
    var status = Number($response.status || $response.statusCode || 200);
    if (status >= 200 && status < 300 &&
        /^https?:\/\/a\.qiumibao\.com\/ios\/config\/(?:\?|$)/.test($request.url) &&
        typeof $response.body === 'string') {
      var data = JSON.parse($response.body);
      if (object(data)) {
        turnOff(data.advert, 'enable');
        var ad = data.advert_config;
        if (object(ad)) {
          ['splash_bk', 'inter_bk', 'pop_bk', 'other_bk', 'is_pre_request'].forEach(function (key) {
            turnOff(ad, key);
          });
          if (Array.isArray(ad.activities_config) && ad.activities_config.length) {
            ad.activities_config = [];
            changed = true;
          }
          turnOff(ad.wifi_preloading, 'enable');
          turnOff(ad.sdk_toutiao, 'init');
        }
      }
      if (changed) result = {body: JSON.stringify(data)};
    }
  } catch (_) { result = {}; }
  $done(result);
})();
