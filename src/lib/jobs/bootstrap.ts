/**
 * RFC 0008 §4.5 — Background jobs 注册表 bootstrap。
 *
 * 每个 jobs/<type>.ts 文件在 import 时通过 `defineJob(...)` / `defineSchedule(...)`
 * 的副作用把自己塞进 registry。本文件是统一的 import barrel —— 调用 `import
 * '@/lib/jobs/bootstrap'` 就触发所有 jobs 的注册。
 *
 * 入口：
 *   - `scripts/run-jobs.ts` (CLI)
 *   - `/api/jobs/tick` (Vercel Cron route，PR-4)
 *   - `tests/e2e/jobs.spec.ts` (e2e，PR-5)
 *
 * **不要**在 Next.js page / RSC 文件里 import 此 barrel —— jobs lib 透传 prisma /
 * pino，会拖垮 client bundle。
 *
 * 新加 job type 时只需在此文件加一行 import；fireSchedules / runWorkerTick
 * 不需要改。
 */

import './jobs/webhook-tick';
import './jobs/export-tick';
import './jobs/deletion-tick';
import './jobs/token-cleanup';
import './jobs/job-prune';
import './jobs/email-send';
