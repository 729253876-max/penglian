# Task 3：预览页拖动比较与渐进披露报告

## RED / GREEN

- RED：先新增预览页行为测试，`npm.cmd test -w @photo-ai/miniprogram -- pages.test.ts` 失败 2 项：默认 `comparePercent` 不存在，且 `adjustAgain()` 仍返回未带场景参数的路径。
- GREEN：实现 `comparePercent` 边界钳制、默认折叠详情、详情切换和返回旅行人像方案后，聚焦测试通过。

## 验证

- `npm.cmd test -w @photo-ai/miniprogram -- pages.test.ts`：通过，1 个测试文件、19 个测试。
- `npm.cmd run build:wechat -w @photo-ai/miniprogram`：通过，TypeScript 编译产出同步更新 `pages/preview/index.js`。
- `git diff --check`：通过，无空白错误。

## 改动

- 预览页改为相同位置叠放的原图/精修后示例图，滑杆以 0–100 裁切原图图层，并保留文字标签与 `aria-label`。
- 信息顺序为：比较、保留本人/姿势/构图、水印预览不可保存、返回调整、折叠精修详情。
- 新增行为测试覆盖默认状态、两端边界、详情展开及返回调整场景。

## 自审与关注点

- 未加入价格、解锁、真实上传、供应商调用或网络动作；未改动加载、失败、成功流程。
- JS 仅由 `build:wechat` 生成，未手工编辑。
- 自动化验证覆盖逻辑和编译；未在微信开发者工具中做真机视觉验收。需在后续 UI 验收时确认各设备宽度下的叠层裁切观感。
