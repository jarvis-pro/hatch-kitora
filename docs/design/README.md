# Design

Kitora 的视觉与交互契约都汇聚在这里。本目录是 **Claude Code、Cowork、Claude Design 三方共享的设计单一事实源**——任何 UI 任务（无论来自人还是 AI）开始前都应该先翻一遍这里。

设计调性来源：[CLAUDE.md §3](../../CLAUDE.md)。代码层 token 落地：[`src/app/globals.css`](../../src/app/globals.css) ↔ [`tailwind.config.ts`](../../tailwind.config.ts)。

## 索引

| 文档                                                                   | 角色                   | 用途                                                                                                                    |
| ---------------------------------------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| [claude-design-getting-started.md](./claude-design-getting-started.md) | **设计契约（权威源）** | 既是 [claude.ai/design](https://claude.ai/design) 的 Onboarding brief，也是 Claude Code / Cowork 写 UI 代码时的实现规范 |

> 当前阶段只维护一份核心契约。新增专题文档（如 `tokens.md`、`motion.md`、`iconography.md`）须遵循下方"何时新增"约定。

## Token 三处同步规则（强约束）

任何**颜色、字号、圆角、间距、动画时长**的变更必须**同时**改三个地方，缺一不可：

```
src/app/globals.css       # 运行时 CSS variables
        ↕
tailwind.config.ts        # 编译期 utility 映射
        ↕
docs/design/claude-design-getting-started.md   # 设计契约 + Onboarding brief
```

任何一处脱节都会让代码、设计稿、AI 三者认知不一致。CI 后续会增加一个轻量 lint 检查这件事，目前靠人为约定。

## 工作约定

- **改设计前先读契约。** 任何对配色、字体、组件视觉语言的改动都先确认契约里是怎么写的；如果要打破契约，那就先改契约再改代码。
- **新组件先看 shadcn/ui 是否已有 primitive。** 业务里只组合不发明。需要扩展时遵循 `class-variance-authority` 变体模式，参考 `src/components/ui/` 现有写法。
- **明暗双主题同步交付。** 任何新页面或组件必须在 light / dark 两套主题下都成立，禁止只交付单主题稿。
- **i18n 留余量。** 设计稿里的文本必须假设有 30% 长度膨胀（中英文混用 + 未来其他语种）。固定宽度按钮和紧贴边缘的标题是反模式。
- **不硬编码 hex。** 代码里只用 token 名（`bg-background`、`text-foreground` 等），设计稿里只用契约里列的 HSL / Hex 表。

## 何时在本目录新增文档

按以下原则决定是不是开新文件：

| 场景                                               | 处理方式                                     |
| -------------------------------------------------- | -------------------------------------------- |
| 调整现有 token 值                                  | 直接改 `claude-design-getting-started.md`    |
| 增加一个全新维度（如 motion 详细规范）             | 新建专题文档（如 `motion.md`）并在本索引登记 |
| 品牌主色最终确定                                   | 更新契约的 §3.2，并在本索引备注品牌色已锁定  |
| 单次 PR 的 UI 设计决策（不影响契约）               | 写在 PR 描述里，不进 `docs/design/`          |
| 跨多 PR / 影响数据模型的视觉决策（如 SaaS 主题化） | 走 RFC 流程，见 [`docs/rfcs/`](../rfcs/)     |

## 上下游

- 项目级 AI 协作契约 → [`CLAUDE.md`](../../CLAUDE.md)
- 代码层 token 实现 → [`src/app/globals.css`](../../src/app/globals.css)、[`tailwind.config.ts`](../../tailwind.config.ts)
- 已有组件 primitives → [`src/components/ui/`](../../src/components/ui)
- 国际化文案池 → [`messages/`](../../messages)
- 架构层 RFC → [`docs/rfcs/`](../rfcs/)
