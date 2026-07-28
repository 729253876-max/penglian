---
name: pre-reply-verification
description: Use when preparing any commentary or final reply after tool use, code changes, testing, or evidence collection, especially when partial success, stale results, dirty worktrees, or release-readiness claims could cause an inaccurate conclusion.
---

# 回复前证据复核

在每次对用户回复前执行本门禁。违反步骤本身就是违反复核目的。

## 必做门禁

1. 核对当前目标、用户指定顺序和禁止事项。
2. 读取最新工具证据；旧结果只能作背景，不能替代当前验证。
3. 核对 Git 分支、worktree、HEAD 和未提交文件是否符合任务边界。
4. 明确区分已完成、部分通过、待验证、阻塞和未开始。
5. 逐句检查结论：证据是否直接支持，是否遗漏反例，是否过度声明。
6. 核对项目阶段门槛；前置证据未齐时，不进入下一阶段或宣称可发布。

任一项失败：先纠正、补证或明确报告阻塞，再回复。

## 证据规则

| 情形 | 允许结论 |
|---|---|
| 单个命令成功但真实运行失败 | 仅报告命令成功；整体仍失败 |
| 测试通过但 GUI/设备未验证 | 仅报告自动化测试通过 |
| 工作树有未提交变更 | 明示未提交范围，不称集成完成 |
| 证据互相冲突 | 以更接近用户真实场景的新证据为准，并解释冲突 |

## 常见借口

| 借口 | 事实 |
|---|---|
| “刚才已经检查过” | 状态可能已变化；回复前必须复核最新状态。 |
| “CLI 显示成功，应该够了” | CLI 只能证明其覆盖的层，不能替代真实运行。 |
| “先说完成，细节后补” | 未完成边界必须在当前回复中准确表达。 |

## 红旗

- 用“应该、看起来、大概”替代证据
- 把局部通过写成整体完成
- 忽略最新失败或脏工作树
- 在验收证据未齐时声称可发布

出现任一红旗，停止回复并重走门禁。
