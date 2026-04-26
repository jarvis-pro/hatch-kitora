import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
// `force-dynamic` rather than `force-static` so the YAML reflects the
// committed file on every redeploy without us having to think about ISR
// invalidation. Disk read is ~1ms; we lean on the Cache-Control below to
// keep CDN load near zero.
export const dynamic = 'force-dynamic';

/**
 * RFC 0003 PR-3 — public OpenAPI spec endpoint.
 *
 * Serves `openapi/v1.yaml` from the project root. The Scalar reference page
 * at `/{locale}/docs/api` fetches this URL client-side, and integrators
 * point their codegen tools (`openapi-typescript`, `kiota`) at the same
 * URL so they always get the latest published shape.
 *
 * Lives outside `[locale]` so the URL is locale-free (`/api/openapi/v1.yaml`)
 * — nobody wants to remember which language code their automation is using.
 */
export async function GET() {
  const file = path.join(process.cwd(), 'openapi', 'v1.yaml');
  const yaml = await readFile(file, 'utf8');
  return new NextResponse(yaml, {
    status: 200,
    headers: {
      // application/yaml is the registered media type since RFC 9512 (2024).
      // Mirror it so Scalar / openapi-typescript pick the right parser.
      'Content-Type': 'application/yaml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600, must-revalidate',
    },
  });
}
