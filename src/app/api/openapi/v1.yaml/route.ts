import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
// `force-dynamic` 而不是 `force-static`，以便 YAML 在每次重新部署时都反映提交的文件，
// 而无需我们考虑 ISR 失效。磁盘读取约 1ms；我们依靠下面的 Cache-Control 来使 CDN 负载接近零。
export const dynamic = 'force-dynamic';

/**
 * RFC 0003 PR-3 — 公共 OpenAPI 规范端点。
 *
 * 从项目根目录提供 `openapi/v1.yaml`。`/{locale}/docs/api` 上的 Scalar 参考页面
 * 客户端获取此 URL，集成商将其代码生成工具（`openapi-typescript`、`kiota`）指向相同 URL，
 * 以便他们始终获得最新发布的形状。
 *
 * 位于 `[locale]` 之外，因此 URL 是无区域设置的（`/api/openapi/v1.yaml`）
 * — 没有人想记住他们的自动化使用哪个语言代码。
 */
export async function GET() {
  const file = path.join(process.cwd(), 'openapi', 'v1.yaml');
  const yaml = await readFile(file, 'utf8');
  return new NextResponse(yaml, {
    status: 200,
    headers: {
      // application/yaml 是自 RFC 9512（2024）以来的注册媒体类型。
      // 镜像它以便 Scalar / openapi-typescript 选择正确的解析器。
      'Content-Type': 'application/yaml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600, must-revalidate',
    },
  });
}
