# dsh-image-tiler

[English](README.md) | [简体中文](README.zh-CN.md)

[![version](https://img.shields.io/badge/version-0.1.6-4176E6)](https://github.com/Ssrs-Pro-Max/dsh-image-tiler)
[![npm](https://img.shields.io/npm/v/dsh-image-tiler?label=npm)](https://www.npmjs.com/package/dsh-image-tiler)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![dsh](https://img.shields.io/badge/DeepSeek%20Harness-dsh--plugin-4176E6)](https://github.com/deepseek-ai/deepseek-harness)
[![awesome · DSH plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

> 上传截图、拍下来的文档、长漫画页，模型就能看清里面的小字 —— 没有这个插件它看不清：一张请求图片
> 最多只能承载 1024 个视觉 token，所以 Harness 会先把更大的图缩掉，8000x8000 的截图到了模型眼里
> 只剩下约 1300 像素宽，字已经没了。
>
> 本项目**不是** DeepSeek 官方产品，也不代表 DeepSeek 的认可。

## 它做什么

插件替换了附件存储的「准入」环节。当一条消息里的图片大到无法在 Harness 自己的缩放中存活时，插件把
这张图切成相邻的若干区域，并在同一轮消息里把每个区域当作一张独立图片提交。每个区域于是按自己的
分辨率发送，模型看到的就是上传时的分辨率，而不是单张图片能装下的分辨率。

真机实测（DSH 0.2.0-rc.2、桌面宿主、一张写满小字的 8000x8000 PNG）：

| | 单张图片 | 切片（默认配置） |
| --- | --- | --- |
| 模型实际收到 | 2048x2048，被重新编码 | 20 个 2000x1600 区域，各占一个图片 part |
| 字形高度 | 源图 10 px，缩放后不可读 | 仍是 10 px |
| 能分辨的文字行 | 0 行 | 8 行 |
| 文字带对比度 | 11.2 | 29.7 |

小图不受影响：凡是 provider 本来就会原样传输的图片，准入过程与从前完全一致。

## 兼容性

- DeepSeek Harness `>=0.2.0-rc.1 <0.3.0`（写在 `engines.dsh` 里，同时以 `peerDependencies` 声明在
  `@deepseek-ai/dsh-attachment` / `-attachment-local` 上；已在 `0.2.0-rc.2` 上实测）。这个范围覆盖
  整个 `0.2.x`（含预发布版），所以宿主的小版本或 rc 变化不会让插件被停用。
- Node.js 20 或更高（宿主自身的要求）。
- 状态：**实验性**。切片策略经过真机验证，但插件替换的是核心服务，宿主大版本变化后建议重新验证。
- `sharp` 是运行时依赖。插件不自带预编译二进制，pnpm 会照常为你的机器安装 `sharp` 的平台包。

## 安装

### 从 npm 安装（推荐）

```
dsh plugin --profile web add dsh-image-tiler@0.1.6
```

这里有两个版本号，混淆它们是常见错误。要固定的是**插件**版本（`@0.1.6`），它才决定安装可复现；
**不要**去固定宿主版本——本包接受任何 `0.2.x`（含预发布版），宿主的小版本或 rc 变化不会让插件失效。
宿主实在不兼容时，安装器会在 pnpm 运行之前就拒绝：
`dsh: installation rejected: Plugin <name>@<version> is incompatible with dsh <version>`；
如果你在测试未发布的宿主，可以用 `dsh plugin allow-version` 手动放行。

### 桌面版（desktop profile）手动安装

把依赖与 bundle 加进 `~/.dsh/profiles/desktop/package.json`，装好后从托盘彻底退出再重启：

```json
{
  "dependencies": { "dsh-image-tiler": "0.1.6" },
  "dsh": { "profile": { "bundles": ["...", "dsh-image-tiler"] } }
}
```

### 验证安装

发一张大于约 1500x1500 的图片，看宿主日志：

```
image-tiler: 8000x8000 shown as 20 tiles of up to 2000x1600 (20.4x detail, 54% covered)
```

变化体现在消息里的图片附件数量上：一次上传变成了 N 个 part。

### 更新 / 卸载

```
dsh plugin --profile web add dsh-image-tiler@0.1.6
dsh plugin --profile web remove dsh-image-tiler
```

## 配置

插件本身不新增任何配置项。它就是那个存储，所以它读的只有官方 `attachment-local` 行本来就接受的
那一个 `config:` 块：

```yaml
- id: attachment-local
  disabled: true          # 由插件顶替它来提供 `attachments`

- insert:
    - id: image-tiler
      name: dsh-image-tiler
```

官方 `attachment-local` 行的全部配置项照旧生效：`dshHome`、`maxImageBytes`、`maxImagesPerMessage`、
`maxMessageImageBytes`、`maxImagePixels`、`maxImageDimension`、`normalizedImageMaxPixels`、
`normalizedImageMaxDimension`、`normalizedImageMaxBytes`、`imageCompressionConcurrency`。

其中两项决定切片行为：

| 配置项 | 默认值 | 对切片的影响 |
| --- | --- | --- |
| `maxImagesPerMessage` | `20` | 切片预算，由同一条消息里的图片**平均分摊**。单张 8000x8000 上传会被花成 20 块 2000x1600（相对单张缩图有 20.4 倍细节）；同一条消息里发三张则每张 6 块（约 15.5 倍），这样没有哪张图被落在 provider 的打印尺寸上。调小会让每块变大、**更不清晰**：大于 `normalizedImageMaxPixels` 的块会在裁剪之后被缩小。 |
| `normalizedImageMaxPixels` | `4194304` | 单张发布图的上限。规划器会读到这个数字并保证每块都不超过它，因此没有哪一块会在切完之后被缩小。 |
| `maxImageBytes` | `20971520` | 单张存储图的上限。超过它的块会让存储拒绝**整条消息**，所以插件会实测每一块的字节数，任何一块超标就改发原图。实际上块远低于这个数：PNG 是无损的，连照片类切片也只有个位数 MB。 |

同时该行必须能被解析到：如果 profile 里已经为了超大图抬高过全局上限，请保留那些值 —— 插件不会改动
它们，而被存储拒收的图永远到不了切片器。

## 安全声明

- 无遥测、无网络访问、无凭据处理、无后台服务。
- 无 `prepare` / `install` / `postinstall` 脚本；包内只有 JavaScript、YAML 与文本。
- 不启动子进程，不执行任何外部程序；`sharp` 通过其原生绑定在进程内运行。
- 图片在内存中解码与重新编码。切片由 Harness 自己的附件存储落盘，位置与原图本来会落盘的位置相同，
  不额外写任何地方。
- 插件只读取存储交给它的那些文件。

## 工作原理

1. `apply(ctx, config)` 把 `TilingAttachmentStore` 挂到 `attachments` 服务名下，从而顶替官方
   `attachment-local` 存储，同时继承它。存储、准入上限、归一化、读取全部沿用基类实现。
2. `admitPromptContent(content)` 是会话控制器在追加用户消息之前唯一会调用的入口。重写它即规划切片
   布局、用 `sharp` 裁出区域，并把切片作为图片 part 返回。消息里有几张图，`maxImagesPerMessage`
   的预算就由它们平均分摊，每张的块数低于四块时整条消息都不切。
3. 因为替换发生在准入之前，切片图会成为会话消息本身的一部分：回放、恢复、分叉重建出的就是模型当时
   看到的内容。
4. 布局来自 `lib/geometry.js`，它转写了 provider 自己的图片投影（patch/downsample 网格、
   1024 token 预算），并在候选中挑出「各区域与 provider 本来会发送的图最接近 1:1」的那套网格。
   provider 本来就会原样传输的源图只会得到一块，所以小图走的是原来的路径。
5. 整批切片在准入前会按存储自己的上限校验 —— 块数、每一块的存储字节数、以及总字节数。若不满足，
   或任何一块会变成细条，就改发原图并记录原因 —— 一个切坏了的插件绝不能把用户的图片弄丢，而存储
   会因为其中一个成员超标而拒绝整条消息。

## 开发与验证

```
node test/geometry.test.mjs        # 切片几何不变量，无需测试框架
node test/admission.test.mjs       # 消息准入：预算、退路、part 顺序
node test/_cap-table.mjs           # 各图片预算下的布局表
node test/feasibility.mjs          # 在生成的样张上做可读性量测
```

`test/` 不包含在发布包里。

## 已知限制

- **切片上传比单图消耗更多视觉 token。** 一张源图切成 N 块就是 N 张图，这正是目的，但 20 块的请求量
  远大于 1 张图。
- **切片尺寸受存储归一化策略限制。** 大于 `normalizedImageMaxPixels`（4194304，约 2048x2048）的块会在
  裁剪**之后**被缩小，所以规划器会把 `maxImagesPerMessage` 的预算（默认 20）用满，而不是只切几块大的。
- **块数跟着 `maxImagesPerMessage` 走，调低只会让切片更差。** 把预算设成 6 时，8000x8000 会变成五条
  4579x915 的横条：完整、清晰，但不是人会选的形状。默认的 `20` 给出的布局最接近方形。
- **一条消息里的多张大图要分摊预算。** 一次发十张时每张只剩两块，低于「把一张图切成网格」所需的
  四块，于是它们按 provider 的打印尺寸原样发送。细节重要时请一次发一到两张。
- **切片是不重叠的整块。** 正好压在切缝上的字会被切成两半，相邻两块都不会完整显示它。
- **只处理内联图片路径。** 以文档附件形式提交的文件、以及经由其他工具进入的图片不在处理范围内。
- 实测环境为 Windows + `0.2.0-rc.2`，其他平台未验证。

## 许可

MIT —— 见 [LICENSE](LICENSE)。
