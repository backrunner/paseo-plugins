import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  PaseoApi,
  PaseoAgentHandle,
  PaseoAgent,
  PaseoAgentListResult,
} from '@getpaseo/client';
import {
  History,
  type Entry,
  type Page,
  digest,
  encodeReference,
  decodeReference,
} from './history';
import { searchCatalog } from './catalog';
import { readInput, searchInput } from '../shared/contracts';

function entry(
  seq: number,
  text = `message ${seq}`,
  type: 'user_message' | 'assistant_message' | 'reasoning' = 'assistant_message',
): Entry {
  return {
    seqStart: seq,
    seqEnd: seq,
    sourceSeqRanges: [{ startSeq: seq, endSeq: seq }],
    collapsed: [],
    provider: 'codex',
    timestamp: '2026-11-15T00:00:00Z',
    item: { type, text },
  };
}
function fixture(count = 20) {
  const entries = Array.from({ length: count }, (_, i) =>
    entry(i + 1, `message ${i + 1}`, i === 0 ? 'user_message' : 'assistant_message'),
  );
  const calls: Parameters<PaseoAgentHandle['timeline']['refetch']>[0][] = [];
  const agent = {
    id: 'source',
    title: 'Fix login',
    cwd: '/project',
    provider: 'codex',
    status: 'idle',
    internal: false,
  } as PaseoAgent;
  const state = {
    epoch: 'epoch',
    gap: false,
    staleCursor: false,
    error: null as string | null,
    wrongAgent: false,
    noProgress: false,
  };
  const handle = {
    address: { agentId: agent.id, serverId: 'host' },
    timeline: {
      refetch: async (options: Parameters<PaseoAgentHandle['timeline']['refetch']>[0] = {}) => {
        calls.push(options);
        const all =
          options.direction === 'before'
            ? entries.filter((e) => e.seqStart < options.cursor!.seq)
            : options.direction === 'after'
              ? entries.filter((e) => e.seqEnd > options.cursor!.seq)
              : entries;
        const selected =
          options.direction === 'after'
            ? all.slice(0, options.limit)
            : all.slice(-(options.limit ?? 50));
        return {
          agentId: state.wrongAgent ? 'other' : agent.id,
          agent,
          entries: state.noProgress && options.limit !== 1 ? [] : selected,
          projection: 'projected',
          epoch: state.epoch,
          reset: false,
          gap: state.gap,
          staleCursor: state.staleCursor,
          error: state.error,
          hasOlder: state.noProgress || (selected.length > 0 && selected[0]!.seqEnd > 1),
          hasNewer: false,
          startCursor: null,
          endCursor: null,
          window: {
            minSeq: 1,
            maxSeq: entries.at(-1)?.seqEnd ?? 0,
            nextSeq: (entries.at(-1)?.seqEnd ?? 0) + 1,
          },
          direction: options.direction ?? 'tail',
          requestId: 'test',
        } satisfies Page;
      },
    },
  };
  const paseo = {
    agents: {
      ref: () => handle as PaseoAgentHandle,
      list: async () =>
        ({
          entries: [{ agent }],
          pageInfo: { hasMore: false, nextCursor: null, prevCursor: null },
          requestId: 'test',
        }) as PaseoAgentListResult,
    },
  } as unknown as PaseoApi;
  const token = () =>
    encodeReference({
      v: 1,
      host: 'host',
      agent: agent.id,
      epoch: 'epoch',
      seq: entries.at(-1)!.seqEnd,
      anchor: entries.at(-1)!.seqStart,
      hash: digest(entries.at(-1)!),
    });
  const controller = new AbortController();
  return {
    entries,
    calls,
    state,
    agent,
    paseo,
    token,
    controller,
    history: new History(paseo, controller.signal),
  };
}
test('overview identifies excerpts and includes initial request without copying the transcript', async () => {
  const f = fixture(80);
  const output = await f.history.read(readInput.parse({ reference: f.token() }));
  assert.ok('initialRequest' in output);
  assert.equal(output.initialRequest?.[0]?.seq, 1);
  assert.deepEqual(
    output.entries.map((e) => e.seq),
    [73, 74, 75, 76, 77, 78, 79, 80],
  );
  assert.equal(output.nextBeforeSeq, 73);
  assert.match(output.note!, /not a complete handoff summary/);
});
test('older pages cover every message exactly once', async () => {
  const f = fixture(120);
  let beforeSeq: number | undefined;
  const found: number[] = [];
  for (let i = 0; i < 30; i++) {
    const output = await f.history.read(
      readInput.parse({ reference: f.token(), view: 'page', beforeSeq }),
    );
    found.push(...output.entries.map((e) => e.seq));
    if (output.nextBeforeSeq === null) break;
    beforeSeq = output.nextBeforeSeq;
  }
  assert.deepEqual(
    found.sort((a, b) => a - b),
    Array.from({ length: 120 }, (_, i) => i + 1),
  );
});
test('a saved reference excludes subsequently appended messages', async () => {
  const f = fixture();
  const reference = f.token();
  f.entries.push(entry(21, 'NEW REQUIREMENT'));
  const output = await f.history.read(readInput.parse({ reference }));
  assert.equal(output.source.cutoffSeq, 20);
  assert.equal(JSON.stringify(output).includes('NEW REQUIREMENT'), false);
  await assert.rejects(
    f.history.read(readInput.parse({ reference, view: 'entry', entrySeq: 21 })),
    /within/,
  );
  await assert.rejects(
    f.history.search(searchInput.parse({ reference, query: 'x', beforeSeq: 22 })),
    /cutoff/,
  );
});
test('long entries can be reconstructed without losing characters', async () => {
  const f = fixture(1);
  const text = 'a'.repeat(5999) + '😸' + '后续'.repeat(8000);
  f.entries[0] = entry(1, text, 'user_message');
  let offset = 0;
  let result = '';
  do {
    const output = await f.history.read(
      readInput.parse({ reference: f.token(), view: 'entry', entrySeq: 1, offset }),
    );
    const part = output.entries[0]!;
    assert.ok(part.text.length <= 6000);
    result += part.text;
    if (part.nextOffset === null) break;
    assert.ok(part.nextOffset > offset);
    offset = part.nextOffset;
  } while (true);
  assert.equal(result, text);
});
test('large recent messages stay bounded and expose continuation offsets', async () => {
  const f = fixture();
  for (const e of f.entries) e.item = { type: 'assistant_message', text: 'a'.repeat(20000) };
  const output = await f.history.read(readInput.parse({ reference: f.token(), view: 'page' }));
  assert.ok(output.entries.reduce((n, e) => n + e.text.length, 0) <= 6000);
  assert.ok(output.entries.every((e) => e.nextOffset !== null));
});
for (const change of ['epoch', 'gap', 'stale', 'anchor', 'error', 'agent'] as const) {
  test(`rejects invalid history: ${change}`, async () => {
    const f = fixture();
    const reference = f.token();
    if (change === 'epoch') f.state.epoch = 'replaced';
    if (change === 'gap') f.state.gap = true;
    if (change === 'stale') f.state.staleCursor = true;
    if (change === 'anchor')
      f.entries.at(-1)!.item = { type: 'assistant_message', text: 'mutated' };
    if (change === 'error') f.state.error = 'missing';
    if (change === 'agent') f.state.wrongAgent = true;
    await assert.rejects(f.history.read(readInput.parse({ reference })), /Reattach/);
  });
}
test('rejects another host before fetching history', async () => {
  const f = fixture();
  const reference = encodeReference({ ...decodeReference(f.token()), host: 'other' });
  await assert.rejects(f.history.read(readInput.parse({ reference })), /different Paseo host/);
  assert.equal(f.calls.length, 0);
});
test('excludes reasoning and defaults to excluding tool results', async () => {
  const f = fixture(3);
  f.entries[1] = entry(2, 'private thought', 'reasoning');
  f.entries[2]!.item = {
    type: 'tool_call',
    name: 'shell',
    callId: 'tool',
    status: 'completed',
    error: null,
    detail: { type: 'plain_text', text: 'test passed' },
  };
  const input = { reference: f.token(), query: 'test passed' };
  assert.equal((await f.history.search(searchInput.parse(input))).matches.length, 0);
  assert.equal(
    (await f.history.search(searchInput.parse({ ...input, includeTools: true }))).matches.length,
    1,
  );
  await assert.rejects(
    f.history.read(
      readInput.parse({ reference: f.token(), view: 'entry', entrySeq: 2, includeTools: true }),
    ),
    /excluded/,
  );
});
test('search is literal, case insensitive, and locates matches beyond message prefixes', async () => {
  const f = fixture(2);
  f.entries[0] = entry(1, 'x'.repeat(12000) + 'HELLO [world].*', 'user_message');
  const output = await f.history.search(
    searchInput.parse({ reference: f.token(), query: 'hello [world].*' }),
  );
  assert.equal(output.matches.length, 1);
  assert.ok(output.matches[0]!.offset > 11000);
  assert.match(output.matches[0]!.text, /HELLO/);
});
test('search stops after 300 events and continues until a distant result is found', async () => {
  const f = fixture(650);
  f.entries[0] = entry(1, 'ancient decision', 'user_message');
  const first = await f.history.search(
    searchInput.parse({ reference: f.token(), query: 'ancient' }),
  );
  assert.equal(first.scanned, 300);
  assert.equal(first.matches.length, 0);
  assert.equal(first.complete, false);
  const second = await f.history.search(
    searchInput.parse({ reference: f.token(), query: 'ancient', beforeSeq: first.nextBeforeSeq }),
  );
  const last = await f.history.search(
    searchInput.parse({ reference: f.token(), query: 'ancient', beforeSeq: second.nextBeforeSeq }),
  );
  assert.equal(last.complete, true);
  assert.equal(last.matches[0]!.seq, 1);
});
test('ten-match search limit does not skip unprocessed entries', async () => {
  const f = fixture(25);
  const found: number[] = [];
  let beforeSeq: number | undefined;
  for (let i = 0; i < 4; i++) {
    const output = await f.history.search(
      searchInput.parse({ reference: f.token(), query: 'message', beforeSeq }),
    );
    found.push(...output.matches.map((m) => m.seq));
    if (output.nextBeforeSeq === null) break;
    beforeSeq = output.nextBeforeSeq;
  }
  assert.deepEqual(
    found,
    Array.from({ length: 25 }, (_, i) => 25 - i),
  );
});
test('excluded-only pages still return a usable continuation', async () => {
  const f = fixture(200);
  for (let i = 1; i < 200; i++) f.entries[i] = entry(i + 1, 'thought', 'reasoning');
  const output = await f.history.read(readInput.parse({ reference: f.token(), view: 'page' }));
  assert.equal(output.entries.length, 0);
  assert.equal(output.nextBeforeSeq, 51);
});
test('pagination with no progress fails rather than loops', async () => {
  const f = fixture();
  f.state.noProgress = true;
  await assert.rejects(
    f.history.search(searchInput.parse({ reference: f.token(), query: 'hello' })),
    /no progress/,
  );
});
test('cancellation prevents new fetches', async () => {
  const f = fixture();
  f.controller.abort();
  await assert.rejects(f.history.read(readInput.parse({ reference: f.token() })), /abort/i);
  assert.equal(f.calls.length, 0);
});
test('malformed reference and oversized inputs are rejected', () => {
  assert.throws(() => decodeReference('garbage'));
  assert.throws(() => decodeReference('a'.repeat(5000)));
  assert.equal(readInput.safeParse({ reference: 'x', beforeSeq: -1 }).success, false);
  assert.equal(searchInput.safeParse({ reference: 'x', query: ' ' }).success, false);
});
test('native attachment contains a short reference and no transcript', async () => {
  const f = fixture(1);
  f.entries[0] = entry(1, 'SENSITIVE SOURCE CONTENT', 'user_message');
  const output = await searchCatalog(f.paseo, 'login /project', f.controller.signal);
  assert.equal(output.items.length, 1);
  const item = output.items[0]!;
  assert.match(item.url, /^paseo:\/\/h\/host\/agent\/source$/);
  assert.equal(item.text.includes('SENSITIVE SOURCE CONTENT'), false);
  const reference = item.text.match(/Reference: (\S+)/)![1]!;
  assert.equal(
    (await f.history.read(readInput.parse({ reference }))).entries[0]!.text,
    'SENSITIVE SOURCE CONTENT',
  );
  assert.equal(
    (await searchCatalog(f.paseo, 'does not exist', f.controller.signal)).items.length,
    0,
  );
});
test('empty history is omitted and unreadable history is reported', async () => {
  const f = fixture(0);
  assert.equal((await searchCatalog(f.paseo, '', f.controller.signal)).items.length, 0);
  f.state.error = 'unavailable';
  await assert.rejects(
    searchCatalog(f.paseo, '', f.controller.signal),
    /Could not read conversations/,
  );
});

test('merged projected replies page by start sequence and remain individually readable', async () => {
  const f = fixture(12);
  for (let i = 0; i < f.entries.length; i++) {
    const e = f.entries[i]!;
    e.seqStart = i * 10 + 1;
    e.seqEnd = i * 10 + 10;
    e.sourceSeqRanges = [{ startSeq: e.seqStart, endSeq: e.seqEnd }];
    e.collapsed = ['assistant_merge'];
  }
  const reference = f.token();
  const first = await f.history.read(readInput.parse({ reference, view: 'page' }));
  assert.equal(first.nextBeforeSeq, 41);
  const older = await f.history.read(
    readInput.parse({ reference, view: 'page', beforeSeq: first.nextBeforeSeq }),
  );
  assert.deepEqual(
    older.entries.map((e) => e.seq),
    [1, 11, 21, 31],
  );
  assert.equal(older.nextBeforeSeq, null);
  const detail = await f.history.read(readInput.parse({ reference, view: 'entry', entrySeq: 91 }));
  assert.equal(detail.entries[0]!.text, 'message 10');
  const found = await f.history.search(searchInput.parse({ reference, query: 'message 10' }));
  assert.equal(found.matches[0]!.seq, 91);
});

test('an in-progress reply merged across the cutoff invalidates its reference', async () => {
  const f = fixture();
  const reference = f.token();
  f.entries.at(-1)!.seqEnd = 21;
  await assert.rejects(f.history.read(readInput.parse({ reference })), /Reattach/);
});

test('an older tool updated past the cutoff cannot leak future data', async () => {
  const f = fixture(3);
  const reference = f.token();
  f.entries[0]!.seqEnd = 4;
  f.entries[0]!.item = {
    type: 'tool_call',
    name: 'shell',
    callId: 'tool',
    status: 'completed',
    error: null,
    detail: { type: 'plain_text', text: 'FUTURE RESULT' },
  };
  await assert.rejects(
    f.history.read(readInput.parse({ reference, includeTools: true })),
    /Reattach/,
  );
});
