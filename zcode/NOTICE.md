# zcode 站点：第三方内容授权边界

本目录的代码（`build.mjs`、`template.html`、生成脚本）以 **GPL-3.0-or-later** 授权，
全文见仓库根目录 `LICENSE`。

## 一、插件元数据

`site/catalog.json`、`site/stats.json` 与页面中的条目是**汇总的元数据**：插件名、版本、
来源类型、sha256、描述、分类、关键字。它们来自本机 ZCode 安装的插件目录与各市场清单：

- ZCode 官方插件市场（`zcode-plugins-official`）
- Claude 社区与官方目录（`claude-community`、`claude-code-workflows`、`claude-code-hooks`、
  `claude-code-lsps`、`claude-plugins-official`）
- 精选与第三方源（`skills-curated`、`superpowers-marketplace`、`gptaku-plugins`、
  `power-platform-skills`）

描述文字与统计数字的权利归各插件作者与目录维护方所有。本仓库只做聚合与去重，
不主张对这些内容的著作权；GPL 仅覆盖本目录自己的代码。

## 二、不含图像素材

页面不使用任何插件图标、头像或截图；条目标识是文字缩写。视觉语言（等宽微标签、
1px 分隔线、编号、无圆角）为本项目自绘，不含第三方美术资源。

## 三、无外部请求

页面为单文件，CSS/JS/数据全部内联，不从 CDN 拉取字体、图标或统计数据。

## 四、商标

“ZCode”“Claude”等名称仅用于描述兼容的插件来源，权利归各自所有者；本站与这些
厂商无隶属关系，也不为其插件背书。
