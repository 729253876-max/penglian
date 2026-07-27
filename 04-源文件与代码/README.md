# Project-002 V1 阶段 A 源码

本目录是 Project-002 的可编辑源码工作区。当前阶段打通人像精修的示例任务、状态机、AI 精修实况事件与水印预览纵向切片；它不是正式上线服务。

## 环境

- Node.js：`v24.18.0`
- npm：`11.16.0`
- 微信开发者工具：用于编译和打开小程序工程。已取证的是可执行文件 `ProductVersion 1.03.0`；“关于”窗口版本尚未取证。

## 安装

在项目规范目录中执行：

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

`D:\Documents\workspace\projects\Project-002-修图AI小程序\04-源文件与代码\apps\miniprogram`

工程使用 `touristappid` 进行编译验证。导入后先启动本地 API，再从首页进入方案确认页，创建示例任务并查看 AI 精修实况和水印预览。

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

阶段 A 的自动化测试、仓库侧无外部模块运行时验证与较早基线的微信编译已有
记录；本轮修复后的模拟器运行时交互仍待在可用的 9420 WebSocket 环境中完成
验证。详见 `../06-复盘与踩坑/V1阶段A验证记录-v01-20260726.md`。

功能分支最终整合完成前，请同时运行 `git status --short --branch` 与
`git log -1 --oneline`：前者确认工作树/分支状态，后者核对当前提交；
若需确认远端最新性，还必须先显式获取远端引用后再比较。
