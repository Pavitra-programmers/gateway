import typescript from '@rollup/plugin-typescript';
import terser from '@rollup/plugin-terser';
import json from '@rollup/plugin-json';
import copy from 'rollup-plugin-copy';

export default {
  input: 'src/start-server.ts',
  output: {
    dir: 'build',
    format: 'es',
  },
  external: [
    // Node.js built-ins
    /^node:/,
    'fs',
    'path',
    'url',
    'crypto',
    'child_process',
    'buffer',
    'https',
    'fs/promises',
    // External dependencies that should not be bundled
    'pg',
    'pg-boss',
    'ws',
    '@hono/node-server',
    '@hono/node-ws',
    'hono',
    'hono/streaming',
    'hono/pretty-json',
    'hono/http-exception',
    'hono/compress',
    'hono/adapter',
    'hono/cors',
    'hono/factory',
    '@cfworker/json-schema',
    'jose',
    'zod',
    'ioredis',
    'async-retry',
    '@aws-crypto/sha256-js',
    '@smithy/signature-v4',
  ],
  plugins: [
    typescript({
      exclude: ['**/*.test.ts', 'start-test.js', 'cookbook', 'docs', 'tests'],
    }),
    terser(),
    json(),
    copy({
      targets: [{ src: 'src/public/*', dest: 'build/public' }],
    }),
  ],
};
