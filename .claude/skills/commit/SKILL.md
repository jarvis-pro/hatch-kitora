---
name: commit
description: 按 Kitora 项目约定整理当前改动并提交。始终走分组流程：扫描所有改动 → 按主题分组 → 用 AskUserQuestion 弹窗与用户确认 → 逐组生成 Conventional Commits（中文消息）。先跑 typecheck + lint。
user-invocable: true
---

# /commit — Kitora 分批整理提交

按 Kitora 项目约定（CLAUDE.md 第 6 节）把 working tree 中**全部本地修改**整理为若干语义独立的 commit。**只支持分组提交**：当改动确实只能合为一组时，才相当于单次提交。**不**支持把多主题改动强行合并成一个 commit。

用户参数：`$ARGUMENTS`（可选，作为对整体改动方向的提示，影响分组判断与文案草拟，不改变流程）。

---

## 流程

### 1. 检查改动

并行运行：

- `git status`（**禁止**加 `-uall` flag，会爆内存）
- `git diff`（暂存 + 未暂存）
- `git log -10 --oneline`（参考最近 commit 风格）

无任何改动 → 告知用户并退出，不创建空 commit。

### 2. 必跑预检查（CLAUDE.md 第 6 节硬要求）

并行运行：

- `pnpm typecheck`
- `pnpm lint`

**任一失败：** 贴出关键错误，停止。

- 不要 `--no-verify`
- 不要为绕过检查修改代码
- 不要继续后续步骤

> 注：预检查只在流程开始时跑一次。中间分批提交时不重复跑（lint-staged 的 pre-commit hook 仍会作用于本次 staged 文件）。

### 3. 分组规划

通读 diff 后，把改动按**语义主题**分组。每组应满足：

- **单一意图**：一个 commit message 能讲清楚（不出现"顺便、同时、另外"这种连接词）
- **可独立审阅**：reviewer 不必跨组读懂某一文件
- **影响面同质**：同一 region / 同一 RFC 域 / 同一层（lib vs services vs app）尽量收敛在同组

常见分组依据（择优组合）：

- **目的差异**：bug 修复 / 重构 / 新功能 / 文档 / 工具配置应分开
- **关注点差异**：业务逻辑 vs 类型/注释 vs 构建配置
- **目录边界**：`src/services/orgs/` 与 `src/services/billing/` 通常各成一组
- **可逆性**：删文件、改 schema 等"破坏性"改动单独成组，便于 revert

#### 3.1 与用户确认分组（强制弹窗）

**所有改动天然只能合为一组**时，可不询问直接进入第 4 步；否则必须使用 `AskUserQuestion` 工具弹窗确认，**不要**用纯文本"打印方案 + 等回复"代替。

弹窗前，先把分组方案以下列结构在正文中展示给用户参考：

```
分组方案：
1. <type>: <中文摘要>
   - file/a.ts
   - file/b.ts
2. <type>: <中文摘要>
   - file/c.ts
```

然后调用 `AskUserQuestion`，**只配两个 option**（"Other" 由工具自动注入，对应"自定义补充"通道）：

| 选项            | 含义                                                                   |
| --------------- | ---------------------------------------------------------------------- |
| **同意**        | 按当前方案执行                                                         |
| **不同意**      | 整体方向不对；用户在自动 Other 里写新方向                              |
| _Other_（自动） | 保留大方向但要求具体调整（例如"把 a.ts 拿出来单独成组"），自由文字反馈 |

不要手动加"补充说明""其他"等 option —— 工具会冲突报错。

用户选"不同意"或在 Other 里给反馈时，**按反馈重排分组后再次 `AskUserQuestion` 弹窗确认**，循环直到选"同意"。**未经"同意"不得开始 commit。**

> 说明：用 `AskUserQuestion` 而不是纯文本，是为了让确认动作有明确的"按钮事件"，避免把不相关的下一句用户输入误判成同意。

### 4. 逐组暂存 + 提交

对每一组循环执行：

1. `git reset` 清空暂存区（如果有残留）
2. `git add <具体文件...>` 显式添加本组文件
   - **禁止** `git add -A` / `git add .`
   - 跳过疑似含密文件（`.env*` / `*.key` / `credentials*`）；用户明确要求时先警告
3. （可选）`git diff --cached --stat` 复核本组实际暂存内容
4. 用 HEREDOC 创建 commit（见第 5 节）
5. 若 lint-staged 在 hook 阶段改写了文件，会留下 unstaged diff —— 报告给用户但**不**自动并入下一组

### 5. 起草消息

格式：

```
<type>: <中文摘要>

<可选正文，每行 ≤ 72 字符；可用「-」列点>
```

- **type**：`feat` / `fix` / `refactor` / `docs` / `chore` / `test` / `perf` / `style`
- **摘要**：写「为什么」，不写「什么」（diff 已经说明「什么」）。≤ 50 字
- 与最近几条 git log 的语气、详细程度保持一致
- **不要**附 `Co-Authored-By` 之类 trailer

创建命令：

```bash
git commit -m "$(cat <<'EOF'
<type>: <中文摘要>

<可选正文>
EOF
)"
```

### 6. 验证与汇报

- `git status` 确认 working tree clean（除已知保留的 untracked 工具目录如 `.claude/`）
- 简短回复：每个 commit 一行 `<short-hash> <type>: <摘要>`
- **不要**自动 `git push`，除非用户在请求里明确说要 push

---

## 红线

- ❌ `--no-verify` / `--no-gpg-sign` / 任何跳过 hook 的 flag
- ❌ `git commit --amend`（除非用户明确要求）
- ❌ 提交消息附 `Co-Authored-By` 或其他 trailer
- ❌ 自动 push 到远端
- ❌ 修改 git config
- ❌ `npm` / `yarn` —— 本项目只用 `pnpm`
- ❌ pre-commit hook 失败时 `--amend`：hook 失败说明 commit 没成功，应修复后重新 commit（否则会改到上一个 commit）
- ❌ 跨组合并："顺便把另一处改了"是分组没规划好的信号 —— 应回到第 3 节重排，而不是塞进当前 commit
- ❌ 把多主题改动强行合为一个 commit —— 本 skill 只支持分组提交；唯一能"单 commit"的情况是改动天然只能成一组
- ❌ 用纯文本提问代替 `AskUserQuestion` 弹窗 —— 必须用工具确保确认动作明确
