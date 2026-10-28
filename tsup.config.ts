import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { cli: 'src/cli.ts' },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  splitting: false,
  sourcemap: true,
  clean: true,
  banner: { js: '#!/usr/bin/env node' },
  // Dependencies stay external (installed by npm); scripts/build-binary.sh bundles them for standalone builds.
});
