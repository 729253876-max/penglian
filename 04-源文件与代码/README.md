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

阶段 A 环境验收已集成至 `master`。依赖安装按以下顺序处理，避免在受限或国内
网络环境中把临时下载失败误判为源码问题：

1. 优先复用与 `package-lock.json` 一致、已经验证过的工作区 `node_modules`。
2. 需要重建依赖时，先使用本机 npm 缓存执行离线安装；缓存不完整时命令会明确
   失败，不得把失败写成安装成功。
3. 只有在用户批准联网后，才使用组织允许的源；国内环境可在单次命令中显式指定
   合规镜像，不把镜像地址或凭据写进仓库配置。

规范主路径下的离线优先命令：

```powershell
cd "D:\Documents\workspace\projects\Project-002-修图AI小程序\04-源文件与代码"
npm.cmd ci --offline
```

如果本机缓存不足，应停止并申请联网/镜像授权，不要改写 lockfile，也不要在未批准
时自动下载依赖。本仓库不得保存 npm token、数据库密码、AppSecret 或其他密钥。

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

### B1 MySQL 8 真实集成测试

`apps/api/test/mysql-identity.integration.test.ts` 只接受专用测试数据库，且必须
同时满足以下两个条件才会建立连接：

- `MYSQL_INTEGRATION_URL` 的协议为 `mysql:`，数据库名必须为
  `photo_ai_b1_test` 或以 `photo_ai_b1_test_` 开头的安全名称；
- `MYSQL_INTEGRATION_ALLOW=1` 已显式开启破坏性测试许可。

建议由获授权人员预先创建独立的 MySQL 8 测试库和最低权限测试账号，再只在当前
PowerShell 会话注入变量。以下值均为占位符，不是可用凭据：

```powershell
$env:MYSQL_INTEGRATION_URL = "mysql://<test-user>:<password>@127.0.0.1:3306/photo_ai_b1_test"
$env:MYSQL_INTEGRATION_ALLOW = "1"
npm.cmd test -- apps/api/test/mysql-identity.integration.test.ts --run --reporter=verbose
```

测试会执行仓库内真实 `001_identity.sql` 迁移，验证 MySQL 主版本为 8，并串行覆盖
同 OpenID 并发/重复登录、并发 refresh 单赢家、第六设备淘汰、应用连接池重建后的会话
持久性与撤销持久性。清理动作仅为在已通过数据库名安全检查后，删除该专用测试库
内 `sessions`、`consents`、`identity_bindings`、`users` 四张表的数据；测试不会
创建或删除数据库，也不会输出连接 URL 或密码。

缺少 URL 或安全开关时，测试输出会明确标记 `NOT ACCEPTED` 并显示 skipped，表示
MySQL 验收未执行，不得记为 B1 通过。URL 无效或数据库名不安全时会在连接、迁移
或清理前直接拒绝。

正式微信 AppID 和 Android、iOS、HarmonyOS 真机验收是另一道门禁，必须由用户另行
批准并提供受控环境；不得在仓库中记录 AppSecret，不得用本地编译或测试 double
代替正式 AppID 的第二设备登录、当前设备退出、全部设备退出及删除入口验收。
第六设备淘汰只由 Task 6 的真实 MySQL 套件承担，不需要第六台物理手机。
HarmonyOS 原生微信与 Android 兼容模式必须分别记录，不能合并成同一项 PASS。

### B1 小程序运行配置与构建

运行配置由构建脚本同时生成 TypeScript 与 JavaScript 文件；API origin 是非秘密
配置，但不得把真实验收或生产 endpoint 硬编码进仓库。以下命令都从本目录运行。

本地模式固定使用开发机 localhost：

```powershell
npm.cmd run config:local -w @photo-ai/miniprogram
npm.cmd run build:wechat -w @photo-ai/miniprogram
```

验收模式允许获批准的手机可访问地址；实际值只由获授权人员在当前进程注入：

```powershell
$env:PHOTO_AI_APP_MODE = "acceptance"
# PHOTO_AI_API_BASE 由获授权人员在当前进程安全注入
npm.cmd run build:wechat:configured -w @photo-ai/miniprogram
```

生产模式只接受 HTTPS origin，并沿用同一安全注入方式：

```powershell
$env:PHOTO_AI_APP_MODE = "production"
# PHOTO_AI_API_BASE 由获授权人员在当前进程安全注入
npm.cmd run build:wechat:configured -w @photo-ai/miniprogram
```

`build:wechat` 只运行 TypeScript 编译，不验证 WXML、微信 IDE、preview 或真机行为；
正式环境证据必须另外在微信开发者工具和三类设备上取得。

## 打开小程序

在微信开发者工具中导入以下目录：

`D:\Documents\workspace\projects\Project-002-修图AI小程序\04-源文件与代码\apps\miniprogram\miniprogram`

这是微信实际运行时工程根。其 `project.config.json` 使用
`miniprogramRoot: "./"`，并在 `beforeCompile` 中从父目录执行
`npm --prefix .. run build:wechat`。两份工程配置已写入批准的正式 AppID；这只是
仓库配置事实，不代表正式 AppID 编译、预览、登录或真机验收已经通过。
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

## B1-CODE MySQL 8 验收证据（2026-08-11）

- 临时实例代号：`Project-002-local-mysql8-ec9bd158`（仅本机、专用、受控；不记录连接 URL、地址、端口、账户、密码或库名）。
- 连接材料只通过 DPAPI 在单个 PowerShell 测试进程中临时注入 `MYSQL_INTEGRATION_URL`，并显式设置 `MYSQL_INTEGRATION_ALLOW=1`；进程 `finally` 删除环境变量、释放 `SecureString` 和清空明文。
- 聚焦真实 MySQL 8 测试：1 个文件、6/6 通过、0 skipped。覆盖生产迁移幂等、同 OpenID 并发/重复登录、并发 refresh 单一胜者、第六设备淘汰，以及连接池重建后活跃/撤销会话的持久性。
- 并发登录在首次真实测试中暴露 MySQL deadlock；`withTransaction` 现仅对 `ER_LOCK_DEADLOCK` 且 `errno=1213` 进行最多三次的全事务重试。每次失败均先 rollback/release，再重新获取连接并 begin。单元测试覆盖成功重试、非 deadlock 不重试和耗尽后抛回原错误。
- 最终全分支审查发现并修复两项 Important：后端此前允许 `metadataRemoval=false` 或任意客户端自报政策版本登录。现在 API 契约与服务层均只接受已批准的 `2026-08-02` 政策和显式 `true`，未授权请求在换取 OpenID、开启事务或签发 token 前拒绝。
- fresh 门禁（代码修复基线：`8f42371`）：`npm.cmd run typecheck` 通过；受控环境下 `npm.cmd test -- --run` 为 23 文件、334 测试全部通过（含 MySQL 6/6，0 skipped）；`npm.cmd run verify:miniprogram-runtime`、`npm.cmd run build:wechat -w @photo-ai/miniprogram` 与 `git diff --check` 均通过。
- `B1-CODE` 为 `PASS / ACCEPTED`，只表示仓库代码、真实 MySQL 8 和最终代码审查通过。`B1-ENV` 仍为 `NOT RUN / NOT ACCEPTED`；没有正式 AppID IDE、preview 或 Android、iOS、HarmonyOS 真机证据，产品仍不可发布。

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
