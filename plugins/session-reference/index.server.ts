import {
  defineAgentTool,
  type PluginServerContext,
  type AgentToolResult,
} from '@getpaseo/plugin/server';
import { readInput, searchInput, searchSessions } from './shared/contracts';
import { searchCatalog } from './server/catalog';
import { History } from './server/history';

async function result(operation: () => Promise<unknown>): Promise<AgentToolResult> {
  try {
    return { text: JSON.stringify(await operation()) };
  } catch (error) {
    return {
      isError: true,
      text: error instanceof Error ? error.message : 'Could not read the referenced history',
    };
  }
}
export default function contribute(server: PluginServerContext) {
  const lifetime = new AbortController();
  const read = defineAgentTool({
    name: 'session_reference_read',
    description:
      'Read a Session Reference attachment on demand. Start with overview (verbatim initial request and recent excerpts, not a summary). Use page + nextBeforeSeq for older history; entry + entrySeq + offset for complete long messages. Only the referenced cutoff is readable. Check actual files and current user requirements before continuing.',
    input: readInput,
    execute: (input, { paseo, signal }) => result(() => new History(paseo, signal).read(input)),
  });
  const search = defineAgentTool({
    name: 'session_reference_search',
    description:
      'Search a referenced conversation for literal text. Each call scans at most 300 timeline items and returns at most 10 excerpts. Continue with nextBeforeSeq when non-null; zero matches in a partial scan is not proof of absence. Tool results are opt-in. Use session_reference_read entry for surrounding text.',
    input: searchInput,
    execute: (input, { paseo, signal }) => result(() => new History(paseo, signal).search(input)),
  });
  server.handle(searchSessions, ({ query, locale }, { paseo }) =>
    searchCatalog(
      paseo,
      query,
      AbortSignal.any([lifetime.signal, AbortSignal.timeout(20000)]),
      locale,
    ),
  );
  const remove = server.addHook('agent.open.before', async ({ request }) => {
    if (request.purpose === 'history') return;
    return { ...request, tools: [...request.tools, read, search] };
  });
  return () => {
    lifetime.abort();
    remove();
  };
}
