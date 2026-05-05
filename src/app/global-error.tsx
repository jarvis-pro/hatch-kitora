'use client';

import * as Sentry from '@sentry/nextjs';
import NextError from 'next/error';
import { useEffect } from 'react';

/**
 * 顶级错误边界——仅当错误逃逸每个区域范围的 error.tsx 时
 * 才会触发，例如 `[locale]/layout.tsx` 本身的失败。
 * 必须呈现自己的 <html><body>，因为失败的布局已经消失。
 *
 * `error.digest` 由 Next 在生产环境给服务端错误附加，用于关联服务端日志；
 * 开发环境通常缺省。
 */
export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html>
      <body>
        <NextError statusCode={0} />
      </body>
    </html>
  );
}
