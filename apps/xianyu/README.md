# 闲鱼

独立模块：`Xianyu Ad Filter`。追加两个 Goofish 主机名和三个脚本，不需要编辑 Home 等主配置。

## 安装

在 Surge 的「首页 → 修改 → 模块 → 安装新模块」加入并启用：

```text
https://raw.githubusercontent.com/realyn/surge-ad-filters/main/apps/xianyu/Xianyu.sgmodule
```

关闭其他处理相同接口的闲鱼模块，确保 MitM 证书已完全信任，MitM 与脚本已开启。模块引用 `v0.3.0` 标签下的脚本。

首次启用后，调度缓存可能还在使用旧连接。完全退出闲鱼再打开，让新调度响应生效；必要时再重启一次。无需卸载、退出账号或修改主配置。

## 实际过滤范围

| 接口 | 识别依据及处理 |
| --- | --- |
| `mtop.taobao.idlecommerce.splash.ads` | 仅清空 `data.adMap`，保留状态、时间及其余配置 |
| `mtop.taobao.idlecommerce.splash.async.ads` | 同上；当前版本会按日期预取未来开屏素材 |
| `mtop.taobao.idlehome.home.nextfresh` | 只删除 `data.sections[].data.clickParam.args.cardType` 等于 `mamaAD` 的卡片 |
| `mtop.taobao.idlemtopsearch.search` | 只删除 `data.resultList[].data.item.main.exContent.dislikeFeedback.clickParam.args.bizType` 等于 `ad` 的条目 |

HTTPS 解密范围仅 `acs.m.goofish.com` 和 `g-acs.m.goofish.com`。不改写个人页、订单、商品详情或聊天接口；不删除未知模板、普通推荐、优惠券和交易服务入口。分页、计数及返回状态保留。解析失败或未知结构直接放行。

## 为什么还有调度脚本

2026-10-17 的实机记录显示，闲鱼使用 AMDC 调度返回的 IP，通过 QUIC 或自定义 TCP 协议访问业务接口，绕过常规 HTTPS 解密。只添加广告 URL 规则不能稳定生效。

调度脚本只处理 `/amdc/mobileDispatch` 且 User-Agent 以闲鱼（中文或 URL 编码）加 `/` 开头的请求：

- 请求接受 gzip，避免客户端专用字典压缩格式。
- 响应支持普通 JSON 与 Base64 包装 JSON。
- 仅当两个 Goofish 网关的通道已提供 `https` 回退时，保留该回退并清空该通道直连 IP，使应用使用域名连接。
- 其他主机、未知且无 HTTPS 回退的通道、响应元数据均保持原样。

不拦截整个阿里域名或 IP 段，不修改其他应用的调度，不额外联网、存储或上传数据。关闭模块后停止后续改写；应用缓存的调度可能仍持续一段时间。

## 验证与边界

2026-10-17：iOS 实机冷启动观察；开屏两个接口命中，新旧 `adMap` 均为空；首页保留 20 张正常商品卡片，广告标记不再出现。原始搜索样本有 10 条普通商品、1 条广告及 1 条其他内容；启用后实机响应保留 10 条普通商品和 1 条其他内容，明确广告条目已移除。商品详情、图片、消息列表正常加载。

32 项自动测试中的 10 项针对闲鱼，使用人工构造数据，覆盖广告与普通内容区分、未知结构、异常响应、两种调度编码及其他应用保持不变。没有执行购买、付款、发消息等操作；不宣称支付或全部广告形式已经实测。

已缓存的广告、内置营销入口、活动券、没有明确广告标记的商业内容和后续新接口可能仍会显示。应用更新或服务端调度结构变化后需要重新验证。

接口与字段依据为本机私下捕获；原始响应及个人数据不公开。开屏预取接口调查时也参考了 [近期维护记录](https://github.com/Thelongdarkorg/loon-plugins/blob/main/xianyu_splash_ad_block.plugin)，随后在设备上确认；未复制其代码。Surge 机制参见 [模块文档](https://manual.nssurge.com/profile/module.html) 和 [HTTP 响应脚本](https://manual.nssurge.com/scripting/http-response.html)。
