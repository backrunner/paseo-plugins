// Opt-in local integration check. Invokes only the installed search RPC and read
// operations. No agent is created, prompted, stopped, reloaded or archived.
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const args = process.argv.slice(2);
if (
  args.length !== 4 ||
  args[0] !== '--home' ||
  !isAbsolute(args[1]) ||
  args[2] !== '--query' ||
  !args[3]
) {
  throw new Error('Use --home /absolute/paseo/home --query title-or-directory');
}
const home = realpathSync(args[1]);
const root = fileURLToPath(new URL('../', import.meta.url));
const source = resolve(root, 'plugins/session-reference');
const require = createRequire(resolve(source, 'package.json'));
const { createHostClient } = require('@getpaseo/client/node');
const { createPaseoApi } = require('@getpaseo/client');
const { assertPluginCompatibility } = require('@getpaseo/protocol/plugin-requirements');
const manifest = require(resolve(source, 'paseo-plugin.json'));
const appVersion = require(resolve(source, 'package.json')).devDependencies['@getpaseo/client'];
const pid = JSON.parse(readFileSync(resolve(home, 'paseo.pid'), 'utf8'));
assert.match(pid.listen, /^(127\.0\.0\.1|\[::1\]):\d+$/);
const credentialPath = resolve(home, 'local-credential');
const stat = lstatSync(credentialPath);
assert.ok(stat.isFile() && !stat.isSymbolicLink());
if (process.platform !== 'win32') {
  assert.equal(stat.uid, process.getuid());
  assert.equal(stat.mode & 0o077, 0);
}
const client = createHostClient(pid.listen, {
  clientId: 'session-reference-integration-check',
  clientType: 'cli',
  appVersion,
  // Paseo classifies all plugin RPC invocations as daemon.manage, even read-only ones.
  sessionPermissions: ['daemon.read', 'workspace.read', 'daemon.manage'],
  localCredential: () => {
    assert.equal(JSON.parse(readFileSync(resolve(home, 'paseo.pid'), 'utf8')).listen, pid.listen);
    const credential = readFileSync(credentialPath, 'utf8').trim();
    assert.match(credential, /^[A-Za-z0-9_-]{43}$/);
    return credential;
  },
  reconnect: { enabled: false },
  connectTimeoutMs: 5000,
});
let api;
let cleanup;
try {
  await client.connect();
  const info = client.getLastServerInfoMessage();
  assert.equal(info.serverId, pid.serverId);
  assertPluginCompatibility({ ...manifest, version: info.version, runtime: 'daemon' });
  api = createPaseoApi(client);
  const catalog = await client.invokePluginRpc('session-reference', 'sessions.search', {
    query: args[3],
  });
  assert.equal(catalog.error, undefined, 'The daemon could not read matching conversation history');
  assert.ok(catalog.items.length > 0, 'No readable source found');
  let selected;
  for (const item of catalog.items) {
    const token = item.text.match(/Reference: (\S+)/)?.[1];
    assert.ok(token);
    const ref = JSON.parse(Buffer.from(token, 'base64url').toString());
    const handle = api.agents.ref(ref.agent);
    await handle.refresh();
    if (handle.status !== 'running' && handle.status !== 'initializing') {
      selected = { token, ref, item };
      break;
    }
  }
  assert.ok(selected, 'Use a query matching an idle source for repeatable checks');
  const compiled = await build({
    entryPoints: [resolve(source, 'index.server.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    write: false,
    external: ['@getpaseo/plugin', '@getpaseo/plugin/server', 'zod'],
    logLevel: 'silent',
  });
  const contribute = new Function(
    'require',
    `const module={exports:{}}; ${compiled.outputFiles[0].text}; return module.exports.default;`,
  )(require);
  let hook;
  cleanup = contribute({
    handle() {},
    addHook(name, callback) {
      assert.equal(name, 'agent.open.before');
      hook = callback;
      return () => {};
    },
  });
  assert.equal(await hook({ request: { purpose: 'history', tools: [] } }), undefined);
  const launch = await hook({ request: { purpose: 'interactive', tools: [] } });
  assert.deepEqual(
    launch.tools.map((t) => t.name),
    ['session_reference_read', 'session_reference_search'],
  );
  const context = { paseo: api, signal: AbortSignal.timeout(20000) };
  const call = async (name, input) => {
    const tool = launch.tools.find((t) => t.name === name);
    const output = await tool.execute(tool.input.parse(input), context);
    assert.ok(!output.isError, output.text);
    return JSON.parse(output.text);
  };
  const overview = await call('session_reference_read', { reference: selected.token });
  assert.ok(overview.entries.length > 0);
  assert.equal(overview.source.agentId, selected.ref.agent);
  const first = overview.entries[0];
  const detail = await call('session_reference_read', {
    reference: selected.token,
    view: 'entry',
    entrySeq: first.seq,
  });
  assert.ok(detail.entries[0].text.startsWith(first.text));
  let olderCount = 0;
  if (overview.nextBeforeSeq !== null) {
    const older = await call('session_reference_read', {
      reference: selected.token,
      view: 'page',
      beforeSeq: overview.nextBeforeSeq,
    });
    assert.ok(older.entries.every((e) => e.seq < overview.nextBeforeSeq));
    olderCount = older.entries.length;
  }
  const query = first.text.trim().slice(0, 24);
  const found = await call('session_reference_search', { reference: selected.token, query });
  assert.ok(
    found.matches.some((m) => m.seq === first.seq),
    'Recent excerpt must be searchable',
  );
  const wrong = Buffer.from(JSON.stringify({ ...selected.ref, host: 'wrong-host' })).toString(
    'base64url',
  );
  const rejected = await launch.tools[0].execute(
    launch.tools[0].input.parse({ reference: wrong }),
    context,
  );
  assert.equal(rejected.isError, true);
  console.log(
    JSON.stringify(
      {
        result: 'passed',
        serverId: info.serverId,
        daemonVersion: info.version,
        candidates: catalog.items.length,
        sourceAgentId: selected.ref.agent,
        attachmentChars: selected.item.text.length,
        overviewEntries: overview.entries.length,
        overviewChars: overview.entries.reduce((n, e) => n + e.text.length, 0),
        olderEntries: olderCount,
        searchMatches: found.matches.length,
        registeredTools: launch.tools.length,
        modelMessagesSent: 0,
        agentsCreated: 0,
        evidence:
          'Installed search RPC plus local compiled tool handlers against live SDK history; not a provider-driven tool call.',
      },
      null,
      2,
    ),
  );
} finally {
  cleanup?.();
  await api?.dispose();
  await client.close();
}
