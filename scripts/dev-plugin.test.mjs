import test from 'node:test';
import assert from 'node:assert/strict';
import { plan, run, source } from './dev-plugin.mjs';

test('development commands require an explicit absolute target and reject alternate selectors', () => {
  for (const args of [
    ['install'],
    ['install', '--home', 'relative'],
    ['update', '--host', 'elsewhere'],
    ['install', '--home', '/a', '--home', '/b'],
  ])
    assert.throws(() => plan(args));
  const p = plan(['update', '--home', '/test home', '--dry-run']);
  assert.equal(p.commands[2][1][1], 'reload');
  assert.ok(p.commands.filter((c) => c[0] === 'paseo').every((c) => c[1].includes('/test home')));
  assert.ok(!JSON.stringify(p.commands).includes('restart'));
});
test('dry run never reads target files, invokes Paseo or changes configuration', async () => {
  let printed = false;
  const forbidden = () => {
    throw new Error('Must not be called');
  };
  await run(['install', '--home', '/nonexistent', '--dry-run'], {
    read: forbidden,
    realpath: forbidden,
    exec: forbidden,
    print: () => {
      printed = true;
    },
  });
  assert.equal(printed, true);
});
function fake({
  enabled = true,
  existing = false,
  path = source,
  status = 'running',
  verifyFails = false,
} = {}) {
  const calls = [];
  let lists = 0;
  return {
    calls,
    dependencies: {
      print() {},
      realpath: async (p) => p,
      read: async (p) =>
        JSON.stringify(
          p.endsWith('config.json')
            ? { pluginsEnabled: enabled }
            : { pid: 123, listen: '127.0.0.1:9999' },
        ),
      exec: (name, args) => {
        calls.push([name, args]);
        if (name === 'pnpm' && verifyFails) throw new Error('verification failed');
        if (name === 'paseo' && args[1] === 'ls')
          return JSON.stringify(
            lists++ || existing ? [{ id: 'subscription-evo', enabled: true, path, status }] : [],
          );
        return '';
      },
    },
  };
}
test('simulated installation and update use only the selected source and home', async () => {
  const install = fake();
  await run(['install', '--home', '/isolated'], install.dependencies);
  assert.equal(install.calls.find((c) => c[0] === 'paseo' && c[1][1] === 'install')[1][2], source);
  const update = fake({ existing: true });
  await run(['update', '--home', '/isolated'], update.dependencies);
  assert.ok(update.calls.some((c) => c[1][1] === 'reload'));
  assert.ok(!update.calls.some((c) => c[1].includes('restart')));
});
test('disabled plugins, different source, absent installation, failed checks and failed reload abort', async () => {
  for (const [options, action] of [
    [{ enabled: false }, 'install'],
    [{ existing: true, path: '/someone-else' }, 'update'],
    [{}, 'update'],
    [{ verifyFails: true }, 'install'],
  ]) {
    const f = fake(options);
    await assert.rejects(run([action, '--home', '/isolated'], f.dependencies));
    assert.ok(!f.calls.some((c) => ['install', 'reload'].includes(c[1][1])));
  }
  const failure = fake({ status: 'failed' });
  await assert.rejects(
    run(['install', '--home', '/isolated'], failure.dependencies),
    /did not reach running/,
  );
});
