import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pluginRequire } from './bundles.mjs';
import { source } from './dev-plugin.mjs';

// Optional offline check against an existing Paseo v0.15.4 source checkout.
// It compiles code only. It never launches or connects to a daemon.
async function main() {
  const args = process.argv.slice(2).filter((v) => v !== '--');
  if (
    ![2, 4].includes(args.length) ||
    args[0] !== '--source' ||
    !isAbsolute(args[1]) ||
    (args.length === 4 && (args[2] !== '--plugin' || !isAbsolute(args[3])))
  )
    throw new Error(
      'Use --source /absolute/path/to/paseo-v0.15.4 [--plugin /absolute/path/to/plugin]',
    );
  const checkout = args[1];
  const plugin = args[3] ?? source;
  const pkg = JSON.parse(await readFile(resolve(checkout, 'packages/server/package.json'), 'utf8'));
  if (pkg.version !== '0.15.4') throw new Error('This check requires Paseo source version 0.15.4');
  const compiler = await build({
    entryPoints: [resolve(checkout, 'packages/server/src/server/plugins/compiler-build.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    packages: 'external',
    write: false,
    define: {
      'import.meta.url': JSON.stringify(pathToFileURL(resolve(plugin, 'package.json')).href),
    },
  });
  const exported = new Function(
    'require',
    `const module = { exports: {} }; ${compiler.outputFiles[0].text}; return module.exports;`,
  )(pluginRequire);
  const result = await exported.compileDirectoryPlugin(plugin, '0.15.4');
  console.log(
    JSON.stringify(
      {
        compilerVersion: pkg.version,
        manifestId: result.manifest.id,
        clientBytes: Buffer.byteLength(result.clientBundle),
        serverBytes: Buffer.byteLength(result.serverBundle),
      },
      null,
      2,
    ),
  );
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
