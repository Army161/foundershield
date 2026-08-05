import path from 'node:path';
import type { NextConfig } from 'next';

const config: NextConfig = {
  // Pin the trace root to the monorepo, otherwise Next walks up and finds an
  // unrelated lockfile in the user's home directory.
  outputFileTracingRoot: path.join(import.meta.dirname, '../..'),
  // The shared package ships raw TypeScript so the edge worker and the
  // dashboard compile it with their own settings rather than sharing a build.
  transpilePackages: ['@foundershield/shared'],
  eslint: { ignoreDuringBuilds: true },
};

export default config;
