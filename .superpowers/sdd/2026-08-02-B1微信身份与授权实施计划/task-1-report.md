# Task 1 完成报告：身份与授权共享契约

## 实现内容

- 新增严格 Zod 共享契约：`WechatLoginInputSchema`、`ConsentInputSchema`、`RefreshInputSchema`、`SessionPairSchema`、`CurrentUserSchema`。
- 为全部契约导出对应的推导 TypeScript 类型。
- 从 contracts 统一入口导出身份与授权契约。
- 添加真实解析行为测试，覆盖显式元数据清理授权、会话时间戳、严格未知字段拒绝及用户设备上限。

## RED 命令与预期失败证据

命令：

```powershell
npm.cmd test -w @photo-ai/contracts -- identity.test.ts
```

结果：失败（退出码 1）。在尚未创建 `identity.ts` 且入口未导出契约时，4 个测试报 `Cannot read properties of undefined (reading 'parse'/'safeParse')`；失败原因是所需身份契约导出不存在。另一个 `toThrow` 断言因调用未定义导出本身抛错而通过，不影响 RED 的有效性。

## GREEN 命令与通过证据

命令：

```powershell
npm.cmd test -w @photo-ai/contracts -- identity.test.ts
```

结果：通过，`1` 个测试文件、`5` 个测试全部通过。

## 完整测试结果

```powershell
npm.cmd test
```

结果：通过，`11` 个测试文件、`134` 个测试全部通过。

附加类型验证：

```powershell
npm.cmd run typecheck
```

结果：通过，全部 workspace TypeScript 检查无错误。

## 变更文件

- `04-源文件与代码/packages/contracts/src/identity.ts`
- `04-源文件与代码/packages/contracts/src/index.ts`
- `04-源文件与代码/packages/contracts/test/identity.test.ts`
- `.superpowers/sdd/2026-08-02-B1微信身份与授权实施计划/task-1-report.md`

## 自查

- 仅修改了任务简报指定的契约源码、入口、测试，以及任务明确要求的报告。
- 所有对象 schema 均使用 `.strict()`；敏感授权 `metadataRemoval` 为必填布尔值，不提供默认值。
- 测试直接执行 Zod schema 的真实解析行为，没有 mock。
- 不涉及网络、云资源或业务实现。

## 问题

无。
