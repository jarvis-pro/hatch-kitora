import { defineConfig, devices } from '@playwright/test';

// 端口与基地址 —— 都允许通过环境变量覆盖，方便：
//   1. 本地手动指定别的端口避免冲突（E2E_PORT=4000 pnpm test:e2e）
//   2. 在预发布/Staging 环境上跑 e2e（E2E_BASE_URL=https://staging.example.com pnpm test:e2e）
const PORT = Number(process.env.E2E_PORT ?? 3000);
const BASE_URL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;

/**
 * Playwright 配置 —— 对接真实的 Next.js dev/prod 服务器，
 * 连接真实的（测试用）Postgres 实例。邮件和 Stripe 调用通过 mock
 * 或直接写 DB 的方式驱动（见 `tests/e2e/fixtures`）。
 *
 * Playwright 是一个浏览器端 E2E 测试框架，会启动真实浏览器（默认 Chromium）
 * 模拟用户点击、输入、跳转，验证整条链路是否符合预期。
 * 官方文档：https://playwright.dev/docs/test-configuration
 */
export default defineConfig({
  // 测试文件根目录。Playwright 只会从这里及其子目录里找测试。
  testDir: './tests/e2e',

  // 哪些文件被识别为"测试文件"。这里只认 *.spec.ts —— 与 vitest 用的 *.test.ts 区分开，
  // 避免单测和 e2e 互相误触发。
  testMatch: '**/*.spec.ts',

  // 并行策略。
  // true  = 同一个文件内的多个 test() 也并行跑（最快，但要求测试间完全独立）
  // false = 同一个文件内串行，文件之间仍可能并行（受 workers 限制）
  // 我们这里所有 e2e 都共享一个 Postgres 测试库，串行执行保证不会互相踩数据。
  fullyParallel: false,

  // CI 上禁止使用 test.only / describe.only —— 防止有人调试后忘删 .only，
  // 导致 PR 合并后线上 CI 只跑一个 case 还显示绿。
  forbidOnly: !!process.env.CI,

  // 失败重试次数。CI 上重试 2 次抗 flaky（网络抖动、容器冷启动等），
  // 本地不重试 —— 让你立刻看到失败，便于排查。
  retries: process.env.CI ? 2 : 0,

  // 同时跑多少个 worker（每个 worker 一个浏览器进程）。
  // 与 fullyParallel:false 配合，1 个 worker 即"全局串行"。
  // 想加速时要先解决数据库隔离问题（每 worker 独立 schema）。
  workers: 1,

  // 测试报告器 —— 决定测试结果以什么形式呈现。
  // 一次可以叠加多个 reporter，互不冲突。
  reporter: [
    // list：在终端实时打印每个 case 的 ✓/✗ 与耗时，最直观。
    ['list'],
    // html：生成可交互的 HTML 报告（含失败截图、视频、trace 时间线）。
    // 本地查看：`npx playwright show-report`（会起一个本地 server）
    // CI 由 .github/workflows/ci.yml 的 "Upload Playwright report" 步骤打包上传到 artifacts。
    // open: 'never' —— 默认 Playwright 测试一结束就自动打开浏览器看报告，
    //                  CI 上没有 GUI 会卡住进程，本地连续跑也很烦，所以关掉自动打开。
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    // github：把失败用例以行内注释（annotations）形式贴到 PR 的 "Files changed" 页面。
    // 仅 CI 启用 —— 本地没意义。
    // 这里用 `as const` 是为了让 TypeScript 把 `[['github']]` 推断成元组而不是 string[][]，
    // 否则与上面两个 reporter 的字面量元组类型不匹配。
    ...(process.env.CI ? ([['github']] as const) : []),
  ],

  // 全局测试上下文配置 —— 每个 test 默认继承这些设置（个别 test 可在内部 override）。
  use: {
    // 测试里 page.goto('/dashboard') 这种相对路径会拼到 baseURL 后面。
    baseURL: BASE_URL,

    // Trace 是 Playwright 的"时间旅行"调试工具：
    // 记录每一步的 DOM 快照、网络请求、console 输出、点击位置等，
    // 失败后用 `npx playwright show-trace trace.zip` 可逐帧回放。
    // 'on-first-retry' = 仅在第一次重试时录制（首次跑过就不浪费磁盘）。
    // 其他可选：'on'（每次都录）/ 'off' / 'retain-on-failure'。
    trace: 'on-first-retry',

    // 失败时自动截图（保存到 test-results/）。'on' 会每步都截图，开销大。
    screenshot: 'only-on-failure',

    // 失败时保留视频录像。'on' 会保留所有录像（极占空间），
    // 'retain-on-failure' 在测试通过时自动删掉录像。
    video: 'retain-on-failure',
  },

  // Projects = 在哪些浏览器/设备组合上跑测试。
  // 数组里每一项都会让所有 test 完整跑一遍。
  // 想加 Firefox/WebKit 时在这里追加即可，例如：
  //   { name: 'firefox', use: { ...devices['Desktop Firefox'] } }
  projects: [
    {
      name: 'chromium',
      // devices['Desktop Chrome'] 提供了一组预设：viewport 1280x720、
      // 桌面 Chrome 的 User-Agent、touch=false 等。
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  // webServer 让 Playwright 在跑测试前自动启动被测应用，
  // 测试结束后自动关掉。省去手动开两个终端的麻烦。
  // 设 E2E_NO_SERVER=1 跳过 —— 用于"我已经在另一个终端起了 dev server"的场景。
  webServer: process.env.E2E_NO_SERVER
    ? undefined
    : {
        // `next start` 跑的是已经构建好的产物（NODE_ENV=production），
        // 所以它要求事先执行 `next build`。CI 在测试 job 里先 build 再调用此配置。
        // 本地如果想用 dev server（带 HMR、错误更直观），就在另一个终端 `pnpm dev`
        // 然后 `E2E_NO_SERVER=1 pnpm test:e2e`。
        command: `pnpm start --port ${PORT}`,

        // Playwright 会轮询这个 URL，直到收到 2xx 才认为服务就绪、开始跑测试。
        // 这里用 /api/health 端点 —— 比根路径轻量、且不依赖前端 hydration 完成。
        url: `${BASE_URL}/api/health`,

        // 本地：如果 url 已经能访问（比如你已经手动起了 server），就复用它，不重启。
        // CI：始终强制由 Playwright 启动新进程，避免遗留状态污染。
        reuseExistingServer: !process.env.CI,

        // 启动超时（毫秒）。Next.js production server + Postgres 连接 + 预热路由
        // 在 CI 上的冷启动可能要 1 分多钟，给到 120s 比较稳。
        timeout: 120_000,

        // Playwright 默认 ignore 服务端 stdout / stderr，e2e 失败时拿不到
        // 服务端的 logger.warn / console.warn / [auth][error] 这些根因信号。
        // 改成 pipe 让它们和测试输出混在一起；调试 SSO / cookie 类失败时
        // 能直接在终端看到服务端到底走了哪条分支。
        stdout: 'pipe',
        stderr: 'pipe',

        // 注入到 `pnpm start` 子进程的环境变量。
        env: {
          // `next start` 以 NODE_ENV=production 运行，Auth.js 在此模式下
          // 默认 `useSecureCookies: true`。在纯 HTTP 下 session cookie 会
          // 被丢弃，导致所有需要认证的测试失败。AUTH_URL 的协议头控制该标志；
          // 非 Vercel 环境下还需要 AUTH_TRUST_HOST。
          AUTH_URL: BASE_URL,
          AUTH_TRUST_HOST: 'true',
          // 在任何框架模块加载之前预加载 stderr 过滤器 ——
          // 在 `instrumentation.ts` 里打补丁太晚了，因为 Next.js 在自身
          // 模块初始化时就已经接管了 `process.stderr.write`。
          NODE_OPTIONS: '-r ./scripts/silence-auth-noise.cjs',
        },
      },
});
