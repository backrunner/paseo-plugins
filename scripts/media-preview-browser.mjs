// Real browser/decoder checks with the actual React Native Web panel. The file
// handle and translation context are fixtures, not a running Paseo connection.
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, writeFile, copyFile, open } from 'node:fs/promises';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const plugin = resolve(root, 'plugins/media-preview');
const require = createRequire(join(plugin, 'package.json'));
const { chromium } = require('playwright');
const output = await mkdtemp(join(tmpdir(), 'media-preview-qa-'));
function ffmpeg(args) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    encoding: 'utf8',
  });
  if (r.error || r.status !== 0) throw new Error(r.error?.message ?? r.stderr);
}
ffmpeg([
  '-f',
  'lavfi',
  '-i',
  'testsrc2=size=640x360:rate=24',
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=440:sample_rate=44100',
  '-t',
  '15',
  '-c:v',
  'libx264',
  '-pix_fmt',
  'yuv420p',
  '-c:a',
  'aac',
  '-movflags',
  '+faststart',
  join(output, 'sample.mp4'),
]);
ffmpeg([
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=440:sample_rate=44100',
  '-t',
  '15',
  join(output, 'sample.wav'),
]);
ffmpeg(['-i', join(output, 'sample.wav'), join(output, 'sample.mp3')]);
ffmpeg([
  '-i',
  join(output, 'sample.mp4'),
  '-c:v',
  'libvpx-vp9',
  '-c:a',
  'libopus',
  join(output, 'sample.webm'),
]);
await writeFile(join(output, 'broken.mp4'), 'This is not a valid video');
// A valid MP4 with a trailing ISO BMFF free box exercises a real transfer above
// the old limit without spending time encoding a long video.
const largeBytes = 96 * 1024 * 1024;
await copyFile(join(output, 'sample.mp4'), join(output, 'large.mp4'));
const largeFile = await open(join(output, 'large.mp4'), 'r+');
try {
  const { size } = await largeFile.stat();
  const header = Buffer.alloc(8);
  header.writeUInt32BE(largeBytes - size);
  header.write('free', 4);
  await largeFile.write(header, 0, 8, size);
  await largeFile.truncate(largeBytes);
} finally {
  await largeFile.close();
}
const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { MediaPanel } from './client/panel';
import { Platform } from 'react-native';
const query = new URLSearchParams(location.search);
if (query.has('native')) Platform.OS = query.get('native');
let listeners = new Set(), urls = [], readCount = 0;
const file = { path: '/fixtures/sample.mp4', name: 'sample.mp4', extension: 'mp4', size: 1000,
  async url() { readCount++; const data = await (await fetch('/fixture/' + file.name)).arrayBuffer();
    const url = URL.createObjectURL(new Blob([data], {type: 'application/octet-stream'})); urls.push(url); return url; },
  watch(cb) { listeners.add(cb); return () => listeners.delete(cb); }
};
const root = createRoot(document.getElementById('root'));
let dark = true;
function render() { root.render(<MediaPanel file={file} params={{path:file.path}} revision={0} workspaceId="fixture"
  tab={{ setModified(){}, setState(){}, state:null }} host={{id:'fixture',label:'Fixture'}}
  layout={{compact: innerWidth < 600, platform:Platform.OS}}
  theme={{colors:{surface0:dark?'#17191c':'#ffffff',surface1:dark?'#202328':'#f5f5f5',surface2:dark?'#2b3036':'#eeeeee',
    foreground:dark?'#f4f4f5':'#18181b',foregroundMuted:dark?'#a1a1aa':'#63636b',accent:'#2563eb',accentForeground:'#ffffff',statusDanger:'#e5484d'}}} />); }
window.qa = { file, reads:()=>readCount, theme(value){dark=value;render()},
  change(name,size=1000) { file.name=name; file.extension=name.split('.').pop(); file.size=size; listeners.forEach(cb=>cb({type:'changed'})); },
  deleted(){ listeners.forEach(cb=>cb({type:'deleted'})); },
  unmount(){ root.unmount(); urls.forEach(url=>URL.revokeObjectURL(url)); }
};
render();
`;
const result = await build({
  stdin: { contents: entry, loader: 'tsx', resolveDir: plugin },
  bundle: true,
  write: false,
  jsx: 'automatic',
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"production"' },
  alias: {
    'react-native': require.resolve('react-native-web'),
    react: resolve(require.resolve('react'), '..'),
    'react-dom/client': require.resolve('react-dom/client'),
  },
  plugins: [
    {
      name: 'fixture-context',
      setup(b) {
        b.onResolve({ filter: /^@getpaseo\/plugin\/client$/ }, () => ({
          path: 'fixture',
          namespace: 'fixture',
        }));
        b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
          contents:
            'export const defineTranslations=x=>({...x,message:key=>key}); export const useTranslation=x=>({locale:"zh-CN",t:(key,args={})=>Object.entries(args).reduce((s,[k,v])=>s.replace("{{"+k+"}}",v),x.resources["zh-CN"][key])});',
          loader: 'js',
        }));
      },
    },
  ],
});
const server = createServer(async (req, res) => {
  try {
    if (req.url === '/app.js') {
      res.setHeader('content-type', 'text/javascript');
      res.end(result.outputFiles[0].contents);
    } else if (req.url?.startsWith('/fixture/')) {
      const name = req.url.slice('/fixture/'.length);
      if (
        ![
          'sample.mp4',
          'sample.wav',
          'sample.mp3',
          'sample.webm',
          'broken.mp4',
          'large.mp4',
        ].includes(name)
      ) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.end(await readFile(join(output, name)));
    } else {
      res.setHeader('content-type', 'text/html');
      res.end(
        '<html><meta charset="utf-8"><style>html,body,#root{margin:0;width:100%;height:100%;display:flex;flex-direction:column}</style><div id="root"></div><script src="/app.js"></script></html>',
      );
    }
  } catch {
    res.writeHead(500);
    res.end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({
  channel: process.env.MEDIA_TEST_BROWSER ?? 'chrome',
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const url = `http://127.0.0.1:${server.address().port}`;
const ready = () =>
  page.waitForFunction(() => {
    const m = document.querySelector('video,audio');
    return m && m.readyState >= 2;
  });
try {
  await page.goto(url);
  await ready();
  assert.equal((await page.locator('body').innerText()).includes('·'), false);
  assert.equal(await page.locator('video').evaluate((m) => m.paused), true);
  await page.locator('video').evaluate(async (m) => {
    m.muted = true;
    await m.play();
  });
  await page.waitForFunction(() => document.querySelector('video').currentTime > 0.2);
  await page.locator('video').evaluate((m) => m.pause());
  await page.getByRole('button', { name: '前进 10 秒', exact: true }).click();
  assert.ok(await page.locator('video').evaluate((m) => m.currentTime >= 10));
  await page.getByRole('button', { name: '后退 10 秒', exact: true }).click();
  assert.ok(await page.locator('video').evaluate((m) => m.currentTime < 1));
  await page.getByRole('button', { name: '速度 1×', exact: true }).click();
  assert.equal(await page.locator('video').evaluate((m) => m.playbackRate), 1.25);
  await page.getByRole('button', { name: '循环', exact: true }).click();
  assert.equal(await page.locator('video').evaluate((m) => m.loop), true);
  await page.screenshot({ path: join(output, 'video-dark-wide.png') });
  await page.setViewportSize({ width: 375, height: 667 });
  await page.evaluate(() => qa.theme(false));
  await page.screenshot({ path: join(output, 'video-light-compact.png') });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  for (const name of ['sample.wav', 'sample.mp3', 'sample.webm']) {
    await page.evaluate((name) => qa.change(name), name);
    await ready();
    const m = page.locator('video,audio');
    assert.equal(await m.evaluate((m) => m.paused), true);
    await m.evaluate(async (m) => {
      m.muted = true;
      await m.play();
    });
    await page.waitForFunction(() => document.querySelector('video,audio').currentTime > 0.2);
    await m.evaluate((m) => m.pause());
    await page.screenshot({ path: join(output, name + '.png') });
  }
  await page.evaluate(() => {
    window.oldMedia = document.querySelector('video');
    qa.deleted();
  });
  await page.getByRole('alert').filter({ hasText: '文件已被删除' }).waitFor();
  assert.equal(await page.evaluate(() => oldMedia.paused), true);
  await page.evaluate(() => qa.change('sample.mp4'));
  await ready();
  await page.evaluate(() => qa.change('broken.mp4'));
  await page.getByRole('alert').filter({ hasText: '无法播放这个媒体文件' }).waitFor();
  await page.screenshot({ path: join(output, 'decode-error.png') });
  await page.evaluate(() => qa.change('sample.mp4'));
  await ready();
  await page.evaluate((size) => qa.change('large.mp4', size), largeBytes);
  await ready();
  await page.locator('video').evaluate(async (m) => {
    m.muted = true;
    await m.play();
  });
  await page.waitForFunction(() => document.querySelector('video').currentTime > 0.2);
  await page.locator('video').evaluate((m) => m.pause());
  await page.screenshot({ path: join(output, 'large-video.png') });
  const reads = await page.evaluate(() => qa.reads());
  await page.evaluate(() => qa.change('sample.mp4', 1024 ** 3 + 1));
  await page.getByRole('alert').filter({ hasText: '1 GiB' }).waitFor();
  assert.equal(await page.evaluate(() => qa.reads()), reads);
  await page.evaluate(() => qa.change('sample.wav'));
  await ready();
  await page.locator('audio').evaluate(async (m) => {
    window.oldMedia = m;
    m.muted = true;
    await m.play();
  });
  await page.evaluate(() => qa.unmount());
  assert.equal(await page.evaluate(() => oldMedia.paused), true);
  for (const platform of ['ios', 'android']) {
    await page.goto(url + '?native=' + platform);
    await page.getByRole('alert').filter({ hasText: '桌面端或网页版' }).waitFor();
    assert.equal(await page.evaluate(() => qa.reads()), 0);
    assert.equal(await page.locator('audio,video').count(), 0);
  }
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        result: 'passed',
        browser: await browser.version(),
        output,
        checks: [
          'MP4/H.264/AAC',
          'WebM/VP9/Opus',
          'PCM WAV',
          'MP3',
          'no autoplay',
          'seek',
          'speed',
          'loop',
          'dark/light',
          '375px layout',
          'delete/recreate',
          'decode error',
          'size guard',
          '96 MiB MP4 transfer and playback',
          'unmount pauses',
          'native fallback without reads',
        ],
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
