---
name: explain-file
description: 讲解指定代码文件的含义、作用与项目语境。适合"这个文件是干嘛的 / 这一段什么意思 / 帮我读一下 xxx.ts"这类问题。参数为目标文件路径（相对或绝对）；为空时使用当前 IDE 选中的文件。
user-invocable: true
allowed-tools:
  - Read
  - Bash(grep *)
  - Bash(rg *)
  - Bash(find *)
---

# /explain-file — Kitora 代码文件讲解

按下面的方法论给用户讲清楚一个文件**是什么、做什么、与项目其他部分如何衔接**。目标读者：刚接触这部分代码、想快速建立心智模型的开发者。

用户参数：`$ARGUMENTS`

- 非空 → 视为目标文件路径（可相对、可绝对）
- 为空 → 使用 IDE 当前打开/选中的文件；都没有就反问"要讲解哪个文件？"

---

## 步骤

### 1. 读目标文件

用 `Read` 把整个文件读完，不要只读片段。文件超过 800 行才考虑分段。

### 2. 顺藤摸瓜

扫一遍 import 和文件内引用的"关键依赖"，**只读**真正影响理解的那几个，不要全展开：

- 框架级约定文件（如 `next.config.*`、`tailwind.config.ts`、Prisma schema）
- 同模块内被直接引用的 config / routing / factory（如 sitemap.ts → `@/i18n/routing`）
- 显式的类型定义 / Zod schema
- 同目录的"配对文件"（robots.ts ↔ sitemap.ts、`page.tsx` ↔ `layout.tsx` ↔ `loading.tsx`）

跳过：通用工具库、UI primitive、显然不影响语义的 import。

### 3. 输出结构

按下面的骨架组织讲解。**不是每节都必须**——没内容就省掉，不要硬凑。

#### 顶部一句话

"这个文件生成 X / 注册 Y / 实现 Z"——一句话点题，让读者知道文件在系统里扮演什么角色。如果有"配对文件"或"上下游"，在这里点出来（例：robots 划红线，sitemap 给白名单）。

#### 工作原理

框架是怎么发现并使用这个文件的？比如：

- Next.js App Router 约定（`page.tsx` / `layout.tsx` / `route.ts` / `sitemap.ts` / `robots.ts` / `metadata` / `middleware.ts`）
- Prisma 的 schema → 生成 client
- Auth.js v5 的 `auth.ts` 入口
- next-intl 的 `routing.ts` / `request.ts`

#### 逐段拆解

按文件自然分段（顶层声明 → 主函数 → 导出），每段：

- 用 markdown 链接到具体行：`[file.ts:行号](路径#L行号)` 或区间 `#L12-L20`
- 说"这段在做什么"，而不是逐行翻译代码
- 字段密集的对象（sitemap 条目、Stripe 配置、Prisma 模型）用**表格**列字段含义和取值

#### 注意点 & 可改进

列 2–5 条，不堆砌。重点关注：

- **配置不一致**：例如 sitemap 强制加 locale 前缀，但 `localePrefix: 'as-needed'` 表示默认 locale 不该有前缀
- **运行时假设**：`new Date()` 是构建时刻不是内容更新时刻；`env.X` 在某 region 可能没配
- **i18n / a11y / SEO 漏点**：缺 `hreflang`、缺 `alt`、缺 ARIA、文案硬编码未走 `next-intl`
- **安全 / 信任边界**：是否在 server-only / client 边界放对了东西、是否信任了用户输入
- **性能**：N+1 查询、不必要的 `'use client'`、未缓存的同步 IO

只列**有依据**的问题，不要为了凑数空泛建议。

#### 与项目语境的连接（重要）

若适用，把文件接到 `CLAUDE.md` 的对应条款上：

- **第 3 节 设计系统**：UI 文件 → 是否走 token、是否双主题、是否 i18n key 化
- **第 4 节 区域感知**：是否走 `currentRegion()` / `src/lib/region/providers.ts` factory，而不是直接 import region-bound SDK
- **第 5 节 代码约束**：业务逻辑应在 `src/services/` 而非 `src/lib/`；ESM only；脚本用 `.ts`
- **第 7 节 RFC**：涉及 orgs / 安全 / webhook / SSO / 区域 / WebAuthn / 后台任务时，链到对应 RFC

不强行套——文件无关就不提。

---

## 风格约束

- **中文优先**，专业术语保留英文（component、token、middleware、Server Action 等）。
- **链接到行号**：所有文件引用一律 `[name.ts:N](path#LN)`，不要用反引号或 HTML。
- **简洁优先**：表格能讲清就别写散文；一句能说完的别拆三段。
- **不复述代码**：读者能看到代码，你的价值是讲"为什么这样写"和"它和谁有关"。
- **配对要点出**：如果存在明显的兄弟文件（同目录同主题、约定上成对），开头就提，让读者建立"这是一族"的认知。
- **回答末尾**不写 "希望对你有帮助" 之类客套，直接结束。

---

## 反模式（不要做）

- 把整个文件贴回来再"逐行翻译"——浪费篇幅，不增信息。
- 只讲"是什么"不讲"为什么这样安排 / 怎么和别处对齐"。
- 在没读相关 RFC / 配置的情况下断言架构问题。
- 给出"建议引入 XX 库 / 重构成 YY 模式"这类与本次讲解无关的扩张。
- 硬塞 CLAUDE.md 条款——不相关就不提。
