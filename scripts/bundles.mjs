import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { createRequire, isBuiltin } from 'node:module';
import { resolve, relative } from 'node:path';
import vm from 'node:vm';
import { source } from './dev-plugin.mjs';

export const pluginRequire = createRequire(resolve(source, 'package.json'));
const ts = pluginRequire('typescript');
const host = [
  '@getpaseo/plugin',
  '@getpaseo/plugin/client',
  '@getpaseo/plugin/client/ui',
  '@getpaseo/plugin/server',
  '@getpaseo/plugin/server/provider',
  '@getpaseo/plugin/server/acp',
  '@getpaseo/plugin/server/usage',
  'zod',
];
const cache = new Map();
export async function bundle(target) {
  if (!cache.has(target))
    cache.set(
      target,
      (async () => {
        // Mirrors 0.15.4's CJS evaluation and host modules. This is an offline simulation,
        // not a substitute for the daemon's compiler or the native client renderer.
        const result = await build({
          entryPoints: [
            resolve(source, target === 'client' ? 'index.client.tsx' : 'index.server.ts'),
          ],
          bundle: true,
          format: 'cjs',
          jsx: 'automatic',
          platform: target === 'server' ? 'node' : 'neutral',
          target: target === 'server' ? 'node20' : 'es2020',
          mainFields: target === 'client' ? ['module', 'main'] : undefined,
          supported: target === 'client' ? { 'async-await': false } : undefined,
          external:
            target === 'client'
              ? [...host, 'react', 'react/jsx-runtime', 'react-native', '@tanstack/react-query']
              : host,
          metafile: true,
          logLevel: 'silent',
          treeShaking: true,
          write: false,
        });
        if (result.warnings.length) throw new Error(result.warnings.map((w) => w.text).join('\n'));
        for (const [path, details] of Object.entries(result.metafile.inputs)) {
          const local = relative(source, resolve(path));
          if (local.startsWith('..') || local.includes('node_modules')) continue;
          const owner = local.startsWith('shared/') ? 'shared' : target;
          if (target === 'client' && local.startsWith('server/'))
            throw new Error('Server code in client');
          if (target === 'server' && local.startsWith('client/'))
            throw new Error('Client code in server');
          for (const edge of details.imports) {
            if (owner !== 'server' && isBuiltin(edge.path))
              throw new Error('Node dependency in client/shared code');
            if (
              owner !== 'client' &&
              /^(react|react-native|@tanstack\/react-query)(\/|$)/.test(edge.path)
            )
              throw new Error('UI dependency in server/shared code');
          }
          if (owner === 'client') {
            const code = await readFile(resolve(path), 'utf8');
            if (/document\.|window\.|localStorage|navigator\.|className=|onClick=/.test(code))
              throw new Error(`Browser-only UI in ${local}`);
            const ast = ts.createSourceFile(
              path,
              code,
              ts.ScriptTarget.Latest,
              true,
              ts.ScriptKind.TSX,
            );
            const visit = (node) => {
              if (
                (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
                /^[a-z]/.test(node.tagName.getText(ast))
              )
                throw new Error(`HTML in ${local}`);
              ts.forEachChild(node, visit);
            };
            visit(ast);
          }
        }
        return result.outputFiles[0].text.replaceAll('get: () => from[key]', 'value: from[key]');
      })(),
    );
  return cache.get(target);
}
export async function evaluate(target, requireModule = pluginRequire) {
  const code = await bundle(target);
  // Keep timer globals, but do not expose __dirname/__filename: Paseo also evaluates
  // its bundle as a function rather than loading it as a Node file.
  const context = {
    console,
    process,
    Buffer,
    URL,
    TextEncoder,
    TextDecoder,
    AbortController,
    structuredClone,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
  };
  context.global = context;
  const factory = vm.runInNewContext(
    `(function(require) { const module = { exports: {} }; const exports = module.exports; ${code}\nreturn module.exports; })`,
    context,
  );
  return factory(requireModule).default;
}
