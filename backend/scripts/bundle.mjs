import * as esbuild from 'esbuild';
import { rmSync } from 'node:fs';
import { LAMBDA_ENTRIES } from './lambda-manifest.mjs';

// Clean before rebuilding: a renamed/removed manifest entry's old output
// directory would otherwise linger and still satisfy lambdaCode()'s
// fs.existsSync check for a stale service/function key.
rmSync('dist', { recursive: true, force: true });

await Promise.all(
  LAMBDA_ENTRIES.map(({ service, function: fn, entry }) =>
    esbuild.build({
      entryPoints: [entry],
      outfile: `dist/${service}/${fn}/index.mjs`,
      bundle: true,
      platform: 'node',
      target: 'node22',
      format: 'esm',
      sourcemap: true,
      minify: true,
      // Handlers report error.constructor.name (e.g. the authorizer's deny reason separating a
      // JWKS outage from token expiry); minification would mangle every class name.
      keepNames: true,
      external: ['@aws-sdk/*'],
      banner: {
        js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
      },
    }),
  ),
);
