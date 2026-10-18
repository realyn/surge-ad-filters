# Surge Ad Filters

[![Tests](https://github.com/realyn/surge-ad-filters/actions/workflows/test.yml/badge.svg)](https://github.com/realyn/surge-ad-filters/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

按应用维护的 Surge 去广告模块。优先保留正常浏览，只过滤有明确依据的广告数据；每个应用可以独立安装、更新和关闭。

## 已支持的应用

| 应用 | 覆盖范围 | 验证状态 | 安装 |
| --- | --- | --- | --- |
| [微博](apps/weibo/README.md) | 开屏及广告缓存、热搜推广、发现页广告横幅、内容列表与评论中的明确广告标记 | 2026-10-17：iOS 实机验证；视频列表正常播放及切换已验证，未验证所有视频广告形式 | [模块地址](https://raw.githubusercontent.com/realyn/surge-ad-filters/main/apps/weibo/Weibo.sgmodule) |
| [直播吧](apps/zhibo8/README.md) | 广告配置、开屏与弹窗入口、首页广告服务及备用地址 | 2026-10-17：6.9.7 在已有规则环境实测；新闻、评论、短视频、比赛直播与比分正常 | [模块地址](https://raw.githubusercontent.com/realyn/surge-ad-filters/main/apps/zhibo8/Zhibo8.sgmodule) |
| [闲鱼](apps/xianyu/README.md) | 开屏及预取素材、首页与搜索结果中的明确广告卡片 | 2026-10-17：实机命中；商品详情、图片和消息列表正常；保留业务入口及未明确识别的推广 | [模块地址](https://raw.githubusercontent.com/realyn/surge-ad-filters/main/apps/xianyu/Xianyu.sgmodule) |

其他应用会陆续加入 `apps/<应用名>/`。尚未列出的应用不在当前支持范围内。

## 安装

1. 在 iPhone 的 Surge 中完成自己的 MitM 证书安装与系统完全信任，并开启 MitM 和脚本功能。
2. 打开 **首页 → 修改 → 模块 → 安装新模块**，粘贴上表对应应用的模块地址并启用。下方以微博为例。
3. 确认模块的外部脚本资源下载成功。关闭重复处理同一接口的去广告脚本，避免匹配冲突。
4. 将对应应用从后台关闭后重新打开，检查广告以及正常浏览。已有广告缓存可能需要再次启动、刷新后才不再出现。

```text
https://raw.githubusercontent.com/realyn/surge-ad-filters/main/apps/weibo/Weibo.sgmodule
```

模块叠加在当前配置上，不需要替换或编辑主配置文件（例如 Home）；它会追加指定域名的 MitM 和响应脚本。启用状态需在每台设备上单独设置。参见 [Surge 模块说明](https://manual.nssurge.com/profile/module.html)。

## 更新与撤销

- **更新**：在 Surge 中更新已安装模块，并确认外部资源已下载成功。发布版模块引用版本标签下的脚本，避免模块与脚本在不同时间更新造成版本不一致。
- **撤销**：关闭对应模块即可停止后续请求的过滤；已被应用缓存的内容可能需要刷新或重启应用。
- **保留指定版本**：把模块地址中的 `main` 换成发布标签，例如 `v0.1.0`。标签内容发布后不覆盖修改。

模块不修改代理节点或账号设置，不屏蔽整个应用主域名。部分模块会添加精确接口的直连与广告拒绝规则，具体范围见应用说明。脚本在设备内处理响应，没有额外网络请求、持久化存储或数据上报；首次安装、更新时 Surge 会从 GitHub 下载脚本。

## 效果边界

不同应用版本、账号和服务端实验可能使用不同接口。没有可靠广告标记的软文、用户自己发布的商业内容会保留。无法保证所有广告永久消失，也不会通过删除全部推荐、评论或视频来实现表面上的去广告。

遇到异常可先关闭对应模块，再通过 [Issue](https://github.com/realyn/surge-ad-filters/issues/new/choose) 反馈。请提供应用版本、广告位置和复现步骤；**不要公开上传原始 HAR、Cookie、Token、证书、完整请求 URL 或个人配置文件**。

## 按需检测广告变化

[Surge Ad Check](tools/ad-check/README.md) 是 Rust 编写的独立 Mac 应用，检测、报告、过滤原理和设置均在应用窗口内完成，不打开浏览器。支持手机实时观察和 HAR 离线模拟、基准比较、可选 Qwen / DeepSeek API 分析，以及 Codex / Claude Code 交接包。不会修改 Home，也不会自动发布修复。未知变化需要证据和实机复核。

Mac 安装包见 [Releases](https://github.com/realyn/surge-ad-filters/releases)；首次连接与模型设置见 [使用说明](tools/ad-check/README.md)。

## 开发与验证

过滤脚本测试使用 Node.js 22 或更高版本，无第三方运行依赖：

```sh
npm test
```

公开测试使用人工构造的最小样本，覆盖广告识别、正常内容保留、分页字段、异常响应和模块匹配。实机验证及局限见各应用说明；私人抓包不会提交到仓库。

维护与自动化方案见 [维护说明](MAINTENANCE.md)。

新增应用请阅读 [贡献规范](CONTRIBUTING.md)。版本变化见 [更新记录](CHANGELOG.md)。

## 许可

[MIT](LICENSE)。本项目与 Surge、微博及后续收录应用的开发者无隶属关系。
