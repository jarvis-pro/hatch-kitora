/**
 * RFC 0008 §4.3 / §4.6 — `webhook.tick` wrapper job。
 *
 * 每分钟由 `fireSchedules()` 投递一行；run handler 仅调既有
 * `runWebhookCronTick()`（src/lib/webhooks/cron.ts）—— RFC §2「借坡下驴, 不重写
 * 历史」: webhook 状态机 / 8 阶退避 / endpoint 自禁用全部领域逻辑保持原样。
 *
 * `maxAttempts: 1` —— sweep tick 不重试。失败时下一分钟会再触发新一轮，
 * 没必要在同一行上指数退避。`retentionDays: 1` —— sweep 行历史价值低，留 1 天
 * 够 admin 当天看跑了什么；过期由 PR-3 的 `job.prune` 清理。
 */

import { z } from 'zod';

import { defineJob, defineSchedule } from '@/lib/jobs/define';
import { runWebhookCronTick } from '@/lib/webhooks/cron';

export const webhookTickJob = defineJob({
  type: 'webhook.tick',
  payloadSchema: z.object({}).strict(),
  maxAttempts: 1,
  retentionDays: 1,
  retry: 'fixed',
  // 单次允许跑久一点 —— webhook 投递可能涉及上百行 update 与外网 fetch；
  // 50s 是 RFC 0008 §5 写的 tick 总预算，单 job 占大半合理。
  timeoutMs: 45_000,
  async run() {
    await runWebhookCronTick();
    return null;
  },
});

defineSchedule({
  name: 'webhook-sweep',
  cron: '* * * * *', // 每分钟
  jobType: 'webhook.tick',
});
