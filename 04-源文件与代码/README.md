# Project-002 V1 阶段 A 源码

本目录是 Project-002 的可编辑源码工作区。当前阶段打通人像精修的示例任务、状态机、AI 精修实况事件与水印预览纵向切片；它不是正式上线服务。

## 环境

- Node.js：`v24.18.0`
- npm：`11.16.0`
- 微信开发者工具：用于编译和打开小程序工程。2026-07-28 从真实项目窗口的
  “微信开发者工具 → 当前版本”弹窗直接确认
  `2.02.2607171 RC win32-x64`；证据截图为
  `../06-复盘与踩坑/阶段A-微信开发者工具-当前版本-20260728.png`。
  完整项目窗口及“关于 / 当前版本”入口的组合证据为
  `../06-复盘与踩坑/阶段A-微信开发者工具-版本入口-20260728.jpg`。
  本 RC 的“关于”菜单项会打开官网概览页，版本弹窗入口实际为“当前版本”。

## 安装

阶段 A 环境验收已集成至 `master`。在规范主路径安装依赖：

```powershell
cd "D:\Documents\workspace\projects\Project-002-修图AI小程序\04-源文件与代码"
npm.cmd install
```

## 启动本地 API

```powershell
npm.cmd run dev:api
```

服务监听地址为 `http://127.0.0.1:3100`。本阶段 API 仅用于本地示例验证，不包含真实图片上传、账户、支付或持久化数据。

## 测试

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run verify:miniprogram-runtime
npm.cmd run build:wechat -w @photo-ai/miniprogram
npm.cmd test -- apps/api/test/http-smoke.test.ts --reporter=verbose
```

`npm.cmd test` 是严格测试命令；测试文件缺失会失败，不能用作伪通过检查。

`verify:miniprogram-runtime` 会把小程序 service 编译产物复制到一个不含
`node_modules` 的系统临时目录，加载客户端并真实调用一次 `getTask`。这项
验证用于防止运行时代码意外依赖 Zod 或 workspace 包。

最后一条命令会由生产 `buildApp()` 真实监听 `127.0.0.1:3100`，并通过原生
HTTP 请求覆盖阶段 A 的 `201/202/200/200/422` 主链路；运行前需确保 3100
没有其他 `LISTENING` 进程。

## 打开小程序

在微信开发者工具中导入以下目录：

`D:\Documents\workspace\projects\Project-002-修图AI小程序\04-源文件与代码\apps\miniprogram\miniprogram`

这是微信实际运行时工程根。其 `project.config.json` 使用
`miniprogramRoot: "./"`，并在 `beforeCompile` 中从父目录执行
`npm --prefix .. run build:wechat`。工程使用 `touristappid` 进行编译验证。
导入后先启动本地 API，再从首页进入方案确认页，创建示例任务并查看 AI 精修
实况和水印预览。

TypeScript 是唯一手写源；`build:wechat` 会生成微信可直接加载的 8 个 `.js`
文件。修改 TypeScript 后必须先重新生成，再用微信开发者工具编译并以
`page_data` 验证实际页面。`project-config.test.ts` 还会把 TypeScript 输出到
临时目录并逐一与这 8 个仓库内 `.js` 比较，防止提交过期生成物。

阶段 A 的小程序运行时代码已经内置最小响应校验器；`@photo-ai/contracts`
仅作为开发期类型依赖。因此无需生成 `miniprogram_npm`，也无需在微信开发者
工具中执行“构建 npm”。这只说明仓库侧没有外部运行时模块，不等同于微信
模拟器交互已经通过。

## 阶段边界

V1 的产品契约包含四项工具：人像精修、画质增强、路人/杂物消除、老照片修复。

- 阶段 A UI 只开放人像精修示例路径。
- 其余三项只保留共享契约和“阶段 B 接入”状态，尚未开放任务入口。
- 老照片修复的上色请求与显式确认参数保留在契约中；阶段 A 不执行该工具。
- 本阶段使用示例资产与本地模拟服务，不接入真实用户图片、供应商、支付、积分、审美档案或增长系统。

阶段 A 的全量测试、仓库侧无外部模块运行时验证、当前主分支微信编译、
9420 模拟器主链路、失败提示、减少动态效果持久化和 SVG 模拟器渲染均已有
记录。API 仓储仍为内存态：API 重启后旧任务不可恢复，这一阶段边界不能写成
“重启后恢复成功”。微信开发者工具版本 GUI 证据和验收分支最终复核、提交、
集成均已完成，阶段 A 环境验收结束；这仍不等于产品可发布，阶段 B 尚未启动。详见
`../06-复盘与踩坑/V1阶段A验证记录-v01-20260726.md`。

后续每项功能使用新的 `codex/*` 分支和独立 worktree。整合前请同时运行
`git status --short --branch` 与
`git log -1 --oneline`：前者确认工作树/分支状态，后者核对当前提交；
若需确认远端最新性，还必须先显式获取远端引用后再比较。
