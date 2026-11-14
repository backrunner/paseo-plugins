import { spawnSync } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const source = resolve(root, 'plugins/subscription-evo');
export const pluginId = 'subscription-evo';

export function plan(argv) {
  const [action, ...flags] = argv.filter((x) => x !== '--');
  if (!['install', 'update'].includes(action)) throw new Error('Use install or update');
  let home,
    dryRun = false;
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] === '--dry-run') dryRun = true;
    else if (flags[i] === '--home' && !home) home = flags[++i];
    else throw new Error(`Unknown or duplicate option: ${flags[i]}`);
  }
  if (!home || !isAbsolute(home) || !home.trim())
    throw new Error('An explicit absolute --home path is required. There is no default target.');
  home = resolve(home);
  return {
    action,
    home,
    dryRun,
    commands: [
      ['pnpm', ['verify:evo']],
      ['paseo', ['plugin', 'ls', '--home', home, '--json']],
      [
        'paseo',
        [
          'plugin',
          action === 'install' ? 'install' : 'reload',
          action === 'install' ? source : pluginId,
          '--home',
          home,
          '--json',
        ],
      ],
      ['paseo', ['plugin', 'ls', pluginId, '--home', home, '--json']],
    ],
  };
}
function execute(command, args, capture = false) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    shell: false,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    timeout: 180_000,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `${command} failed${capture ? `: ${result.stderr?.trim() || result.error?.message || result.status}` : ''}`,
    );
  return capture ? result.stdout : '';
}
export async function run(argv, dependencies = {}) {
  const p = plan(argv);
  const print = dependencies.print ?? console.log;
  // A dry run does not even read target files, invoke the CLI, or open a connection.
  if (p.dryRun) {
    print(JSON.stringify({ targetHome: p.home, plugin: pluginId, commands: p.commands }, null, 2));
    return;
  }
  const read = dependencies.read ?? ((path) => readFile(path, 'utf8'));
  const canonical = dependencies.realpath ?? realpath;
  const exec = dependencies.exec ?? execute;
  const targetHome = await canonical(p.home);
  const config = JSON.parse(await read(join(targetHome, 'config.json')));
  if (config.pluginsEnabled !== true)
    throw new Error(
      'Plugins are disabled for this home. Enable them yourself before installing trusted plugin code. This command does not change that setting.',
    );
  const pid = JSON.parse(await read(join(targetHome, 'paseo.pid')));
  if (!Number.isInteger(pid.pid) || !/^(127\.0\.0\.1|\[::1\]):\d+$/.test(pid.listen ?? ''))
    throw new Error('The selected local daemon is not running on a verified loopback endpoint');
  exec('pnpm', ['verify:evo']);
  const list = JSON.parse(exec('paseo', ['plugin', 'ls', '--home', targetHome, '--json'], true));
  if (!Array.isArray(list)) throw new Error('Unexpected plugin list response');
  const existing = list.find((p) => p.id === pluginId);
  if (existing && (await canonical(existing.path)) !== (await canonical(source)))
    throw new Error('This plugin ID belongs to a different source directory. No changes made.');
  if (p.action === 'update' && !existing)
    throw new Error('Development plugin is not installed on this host. Run plugin:install first.');
  if (p.action === 'install' && existing)
    throw new Error('Development plugin is already installed. Use plugin:update.');
  if (p.action === 'update' && existing.enabled !== true)
    throw new Error('The plugin is disabled. Enable it explicitly before updating.');
  exec('paseo', [
    'plugin',
    p.action === 'install' ? 'install' : 'reload',
    p.action === 'install' ? source : pluginId,
    '--home',
    targetHome,
    '--json',
  ]);
  const after = JSON.parse(
    exec('paseo', ['plugin', 'ls', pluginId, '--home', targetHome, '--json'], true),
  );
  const loaded = Array.isArray(after) ? after.find((p) => p.id === pluginId) : undefined;
  if (
    !loaded ||
    loaded.status !== 'running' ||
    loaded.error ||
    (await canonical(loaded.path)) !== (await canonical(source))
  )
    throw new Error('Plugin did not reach running. Inspect its logs; do not restart the daemon.');
  print(
    `SubscriptionEvo ${p.action === 'install' ? 'installed' : 'reloaded'} from ${source}\nTarget home: ${targetHome}`,
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  run(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
