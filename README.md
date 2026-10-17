# Surge Ad Filters

[![Tests](https://github.com/realyn/surge-ad-filters/actions/workflows/test.yml/badge.svg)](https://github.com/realyn/surge-ad-filters/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

按应用维护的 Surge 去广告模块。优先保留正常浏览，只过滤有明确依据的广告数据；每个应用可以独立安装、更新和关闭。

## 已支持的应用

| 应用 | 覆盖范围 | 验证状态 | 安装 |
| --- | --- | --- | --- |
| [微博](apps/weibo/README.md) | 开屏及广告缓存、热搜推广、发现页广告横幅、内容列表与评论中的明确广告标记 | 2026-10-17：iOS 实机验证；视频列表正常播放及切换已验证，未验证所有视频广告形式 | [模块地址](https://raw.githubusercontent.com/realyn/surge-ad-filters/main/apps/weibo/Weibo.sgmodule) |

其他应用会陆续加入 `apps/<应用名>/`。尚未列出的应用不在当前支持范围内。

## 安装

1. 在 iPhone 的 Surge 中完成自己的 MitM 证书安装与系统完全信任，并开启 MitM 和脚本功能。
2. 打开 **首页 → 修改 → 模块 → 安装新模块**，粘贴下方地址，然后启用 **Weibo Ad Filter**。
3. 确认模块的外部脚本资源下载成功。关闭同样处理微博接口的其他去广告脚本，避免匹配冲突。
4. 将微博从后台关闭后重新打开，检查广告以及正常浏览。已有广告缓存可能需要再次启动、刷新后才不再出现。

```text
https://raw.githubusercontent.com/realyn/surge-ad-filters/main/apps/weibo/Weibo.sgmodule
```

模块叠加在当前配置上，不需要替换或编辑主配置文件（例如 Home）；它会追加指定域名的 MitM 和响应脚本。启用状态需在每台设备上单独设置。参见 [Surge 模块说明](https://manual.nssurge.com/profile/module.html)。

## 更新与撤销

- **更新**：在 Surge 中更新已安装模块，并确认外部资源已下载成功。发布版模块引用版本标签下的脚本，避免模块与脚本在不同时间更新造成版本不一致。
- **撤销**：关闭对应模块即可停止后续请求的过滤；已被应用缓存的内容可能需要刷新或重启应用。
- **保留指定版本**：把模块地址中的 `main` 换成发布标签，例如 `v0.1.0`。标签内容发布后不覆盖修改。

模块不修改代理节点、分流策略或账号设置，也不屏蔽整个微博主域名。脚本在设备内处理响应，没有额外网络请求、持久化存储或数据上报；首次安装、更新时 Surge 会从 GitHub 下载脚本。

## 效果边界

不同应用版本、账号和服务端实验可能使用不同接口。没有可靠广告标记的软文、用户自己发布的商业内容会保留。无法保证所有广告永久消失，也不会通过删除全部推荐、评论或视频来实现表面上的去广告。

遇到异常可先关闭对应模块，再通过 [Issue](https://github.com/realyn/surge-ad-filters/issues/new/choose) 反馈。请提供应用版本、广告位置和复现步骤；**不要公开上传原始 HAR、Cookie、Token、证书、完整请求 URL 或个人配置文件**。

## 开发与验证

使用 Node.js 22 或更高版本，无第三方运行依赖：

```sh
npm test
```

公开测试使用人工构造的最小样本，覆盖广告识别、正常内容保留、分页字段、异常响应和模块匹配。实机验证及局限见各应用说明；私人抓包不会提交到仓库。

新增应用请阅读 [贡献规范](CONTRIBUTING.md)。版本变化见 [更新记录](CHANGELOG.md)。

## 许可

[MIT](LICENSE)。本项目与 Surge、微博及后续收录应用的开发者无隶属关系。
