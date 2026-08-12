# AI 修图小程序竞品与蓝海判断：来源与方法记录

## 调研问题

- GitHub 是否已有相似的 AI 修图、照片修复、微信小程序项目？
- Project-002 是否处于蓝海？如果不是，哪个细分市场仍值得验证？
- 当前项目的优势、短板和下一阶段动作是什么？

## 方法与边界

- 截止日期：2026-08-12（Asia/Shanghai）。
- 使用 GitHub 公共只读 API、公开仓库页和商业产品官方公开页。
- 未登录 GitHub，未读取 Cookie 或 Token，未克隆、安装或执行第三方仓库代码。
- GitHub 匿名 API 在调研后段触发速率限制，因此结果是代表性样本，不是穷尽式盘点。
- Stars 仅用作开源生态关注度信号，不代表市场份额、活跃用户、收入、产品质量或付费需求。
- 没有微信指数、小程序内部搜索结果、应用商店收入/下载或支付数据，因此不进行 TAM/SAM/SOM 估算。

## GitHub 公开证据

| 项目 | 公开地址 | 截止调研时 Stars | 说明 |
|---|---|---:|---|
| TencentARC/GFPGAN | https://github.com/TencentARC/GFPGAN | 37,653 | 实用人脸修复底层模型 |
| sczhou/CodeFormer | https://github.com/sczhou/CodeFormer | 18,103 | 盲人脸修复 |
| TencentARC/PhotoMaker | https://github.com/TencentARC/PhotoMaker | 10,095 | 个性化人像生成，相邻能力 |
| XPixelGroup/BasicSR | https://github.com/XPixelGroup/BasicSR | 8,364 | 图像/视频恢复工具箱 |
| Fanghua-Yu/SUPIR | https://github.com/Fanghua-Yu/SUPIR | 5,639 | 照片级图像恢复 |
| Nutlope/restorePhotos | https://github.com/Nutlope/restorePhotos | 4,423 | 完整老照片/模糊人脸恢复 Web 产品 |
| 302ai/302_photo_restore | https://github.com/302ai/302_photo_restore | 25 | 照片修复 Web 应用 |
| SamurAIGPT/old-photo-restore | https://github.com/SamurAIGPT/old-photo-restore | 8 | 带账户、积分等 SaaS 结构 |
| Yonghui-Lee/profile_photo_editor_weChatApplet | https://github.com/Yonghui-Lee/profile_photo_editor_weChatApplet | 4 | 微信头像编辑小程序，非忠实 AI 修复 |
| cl973/image-restoration-agent | https://github.com/cl973/image-restoration-agent | 1 | 微信小程序 + Flask 的照片老化/修复项目 |
| FEliuze/tuying-master-iopain | https://github.com/FEliuze/tuying-master-iopain | 0 | 小程序图片/视频/GIF 编辑与 AI 优化后端 |

## 商业替代品官方公开证据

| 产品 | 官方页面 | 可确认能力 |
|---|---|---|
| 美图 | https://www.meitu.com/en/ | AI 驱动的影像、视频与设计产品矩阵，包括美图秀秀、BeautyCam、Wink 等 |
| Remini | https://remini.ai/ | 低质量图像 HD 增强、老照片恢复、AI Photos |
| Adobe Express | https://www.adobe.com/express/feature/image/enhance | AI 增强、背景/对象处理、锐化、亮度、对比度和色彩调整 |
| Canva | https://www.canva.com/features/photo-editor/ | 上传、编辑、滤镜、调整、设计资产和分享 |
| Cutout.pro | https://www.cutout.pro/photo-enhancer-sharpener-upscaler | 一键增强、放大、锐化和去噪 |

PhotoRoom 和 CapCut 的指定功能 URL 在本次读取时返回 404，未将这些失效页面作为功能证据。

## 判断规则

“蓝海”不以 GitHub 仓库数量单独判断。至少需要同时看到：明显未满足需求、较弱替代竞争、可触达用户、可接受的获客成本和真实付费空间。当前只观察到“微信小程序同形态公开项目较少”，同时观察到强替代品和成熟技术供给，因此结论是：

> 通用能力是红海；“微信内重要照片忠实救片”是尚待真实用户与付费实验验证的细分窗口。

## 图表设计说明

未使用 Stars 柱状图。底层模型与小程序仓库的 Stars 相差数个数量级，线性图会压平小样本，log 图又容易让非技术读者误解为市场规模。报告仅使用“本次纳入的代表性公开证据数量”分类柱状图，展示证据覆盖面；图题和副标题明确声明样本非穷尽、不能解释市场规模或份额。Stars 保留在精确表格中供核查。

图表合同：问题是“本次判断覆盖了哪些竞争层”；结论是“同形态小程序虽少，但能力、完整产品和商业替代品均已存在”；使用单序列分类柱状图，4 行同粒度证据类别，纵轴从零开始，不使用冗余颜色图例，最终在自包含 HTML 的桌面和窄屏环境验收。

## 报告结构映射

- Title：报告标题块。
- Executive Summary：直接回答是否蓝海、是否已有同类。
- Key findings with evidence：GitHub、商业替代、竞争层三组证据与表格。
- Recommended next steps：两周市场验证 Sprint 与 GO/NO_GO 门禁。
- Further questions：待验证的场景、忠实边界、价格与渠道问题。
- Caveats and assumptions：GitHub 召回、Stars 解释、商业页证据边界和缺失数据。

## 可信度

**Share with caveats / 中等信心。** 足以支持“停止盲目扩功能、先做市场验证”的阶段决策；不足以支持市场规模、收入预测或正式上线结论。
