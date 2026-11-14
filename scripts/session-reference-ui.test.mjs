import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

test('real host attachment adapter applies current locale and compact presentation', async () => {
  const source = fileURLToPath(new URL('../plugins/session-reference', import.meta.url));
  const require = createRequire(resolve(source, 'package.json'));
  const host = require('@getpaseo/plugin/client/host');
  let locale = 'zh-CN';
  const i18n = new host.PluginTranslationRuntime({
    getLocale: () => locale,
    subscribe: () => () => {},
  });
  const buildResult = await build({
    entryPoints: [resolve(source, 'index.client.tsx')],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    write: false,
    external: ['@getpaseo/plugin', '@getpaseo/plugin/client', 'zod'],
  });
  const contribute = new Function(
    'require',
    `const module={exports:{}}; ${buildResult.outputFiles[0].text}; return module.exports.default;`,
  )(require);
  let contribution;
  const cleanup = contribute({
    i18n,
    addAttachmentSource(value) {
      contribution = value;
      return () => {};
    },
  });
  const invoke = async (name, input) => {
    assert.equal(name, 'sessions.search');
    assert.equal(input.locale, locale);
    return {
      items: [
        {
          id: 'source',
          identifier: '#abcd12',
          title: 'A long conversation title that cannot fit into a narrow attachment picker',
          url: 'paseo://h/host/agent/source',
          text: 'reference-data',
          resourceType: 'session-reference',
          details: {
            cwd: '/long/path/paseo-plugins',
            timestamp: new Date().toISOString(),
            archived: true,
          },
        },
      ],
    };
  };
  try {
    for (const language of ['zh-CN', 'en']) {
      locale = language;
      const output = await host.searchPluginAttachments(contribution, invoke, 'login');
      assert.ok(output.items[0].title.endsWith('…'));
      assert.equal(output.items[0].text, 'reference-data');
      assert.ok(!output.items[0].subtitle.includes('/long/path'));
      assert.match(
        output.items[0].subtitle,
        language === 'zh-CN' ? /刚刚.*已归档/ : /Just now.*Archived/,
      );
      assert.equal(
        i18n.resolve(contribution.searchPlaceholder, language),
        language === 'zh-CN' ? '搜索会话' : 'Search conversations',
      );
    }
  } finally {
    cleanup();
    i18n.dispose();
  }
});
