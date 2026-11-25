import { build } from 'esbuild';
import { readdir, readFile } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pluginRequire } from './bundles.mjs';
import { root, source } from './dev-plugin.mjs';

// Optional offline check against an existing Paseo source checkout.
// It compiles code only. It never launches or connects to a daemon.
async function main() {
  const args = process.argv.slice(2).filter((v) => v !== '--');
  if (
    ![2, 4].includes(args.length) ||
    args[0] !== '--source' ||
    !isAbsolute(args[1]) ||
    (args.length === 4 && (args[2] !== '--plugin' || !isAbsolute(args[3])))
  )
    throw new Error('Use --source /absolute/path/to/paseo [--plugin /absolute/path/to/plugin]');
  const checkout = args[1];
  const pluginsRoot = resolve(root, 'plugins');
  const plugins = args[3]
    ? [args[3]]
    : (await readdir(pluginsRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => resolve(pluginsRoot, entry.name));
  const pkg = JSON.parse(await readFile(resolve(checkout, 'packages/server/package.json'), 'utf8'));
  const compiler = await build({
    entryPoints: [resolve(checkout, 'packages/server/src/server/plugins/compiler-build.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    packages: 'external',
    write: false,
    define: {
      'import.meta.url': JSON.stringify(pathToFileURL(resolve(source, 'package.json')).href),
    },
  });
  const exported = new Function(
    'require',
    `const module = { exports: {} }; ${compiler.outputFiles[0].text}; return module.exports;`,
  )(pluginRequire);
  for (const plugin of plugins) {
    const result = await exported.compileDirectoryPlugin(plugin, pkg.version);
    console.log(
      JSON.stringify({
        compilerVersion: pkg.version,
        manifestId: result.manifest.id,
        clientBytes: Buffer.byteLength(result.clientBundle ?? ''),
        serverBytes: Buffer.byteLength(result.serverBundle ?? ''),
      }),
    );
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
