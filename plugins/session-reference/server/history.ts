import type { PaseoApi, PaseoAgentHandle } from '@getpaseo/client';
import { createHash } from 'node:crypto';
import type { ReadInput, SearchInput, Reference } from '../shared/contracts';
import { referenceSchema } from '../shared/contracts';

export type Page = Awaited<ReturnType<PaseoAgentHandle['timeline']['refetch']>>;
export type Entry = Page['entries'][number];
const TEXT_BUDGET = 6000;
const PAGE_SIZE = 50;
const RESELECT =
  'The referenced history changed or is unavailable. Reattach the source conversation to create a fresh reference.';

export function digest(entry: Entry): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        seq: entry.seqEnd,
        start: entry.seqStart,
        item: entry.item,
        timestamp: entry.timestamp,
        turnId: entry.turnId,
      }),
    )
    .digest('hex');
}
export function encodeReference(reference: Reference): string {
  return Buffer.from(JSON.stringify(referenceSchema.parse(reference))).toString('base64url');
}
export function decodeReference(token: string): Reference {
  if (token.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(token))
    throw new Error('Invalid session reference');
  try {
    return referenceSchema.parse(JSON.parse(Buffer.from(token, 'base64url').toString('utf8')));
  } catch {
    throw new Error('Invalid session reference');
  }
}
export function checkPage(page: Page, agentId: string, epoch?: string): void {
  if (
    page.error ||
    page.agentId !== agentId ||
    !['canonical', 'projected'].includes(page.projection) ||
    page.staleCursor ||
    page.gap ||
    (epoch !== undefined && (page.epoch !== epoch || page.reset))
  ) {
    throw new Error(RESELECT);
  }
  if (page.entries.some((e) => e.seqStart > e.seqEnd)) throw new Error(RESELECT);
}
export function content(entry: Entry, includeTools: boolean): string | null {
  const item = entry.item;
  switch (item.type) {
    case 'user_message':
    case 'assistant_message':
      return item.text;
    case 'todo':
      return item.items
        .map(
          (task) => `[${task.status ?? (task.completed ? 'completed' : 'pending')}] ${task.text}`,
        )
        .join('\n');
    case 'error':
      return item.message;
    case 'tool_call':
      return includeTools
        ? JSON.stringify({
            name: item.name,
            status: item.status,
            detail: item.detail,
            error: item.error,
          })
        : null;
    default:
      return null;
  }
}

type Fragment = {
  seq: number;
  type: string;
  timestamp: string;
  text: string;
  offset: number;
  nextOffset: number | null;
  totalChars: number;
};
function fragment(entry: Entry, text: string, offset: number, size: number): Fragment {
  // Avoid splitting a UTF-16 surrogate pair; offsets use JS string positions throughout.
  let end = Math.min(text.length, offset + size);
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1] ?? '')) end--;
  return {
    seq: entry.seqStart,
    type: entry.item.type,
    timestamp: entry.timestamp,
    text: text.slice(offset, end),
    offset,
    nextOffset: end < text.length ? end : null,
    totalChars: text.length,
  };
}

export class History {
  constructor(
    private readonly paseo: PaseoApi,
    private readonly signal: AbortSignal,
  ) {}
  private alive() {
    this.signal.throwIfAborted();
  }
  private async page(
    handle: PaseoAgentHandle,
    ref: Reference,
    before: number,
    limit: number,
  ): Promise<Page> {
    this.alive();
    const page = await handle.timeline.refetch({
      direction: 'before',
      cursor: { epoch: ref.epoch, seq: before },
      limit,
      projection: 'projected',
    });
    this.alive();
    checkPage(page, ref.agent, ref.epoch);
    if (page.entries.some((e) => e.seqStart >= before || e.seqEnd > ref.seq))
      throw new Error(RESELECT);
    return page;
  }
  private async open(token: string) {
    this.alive();
    const ref = decodeReference(token);
    if (ref.anchor > ref.seq) throw new Error('Invalid session reference boundary');
    const handle = this.paseo.agents.ref(ref.agent);
    if (handle.address.serverId !== ref.host)
      throw new Error('This reference belongs to a different Paseo host');
    const page = await this.page(handle, ref, ref.anchor + 1, 1);
    const anchor = page.entries.find((entry) => entry.seqStart === ref.anchor);
    if (!anchor || digest(anchor) !== ref.hash) throw new Error(RESELECT);
    return {
      ref,
      handle,
      anchor,
      source: {
        host: ref.host,
        agentId: ref.agent,
        title: page.agent?.title ?? null,
        cwd: page.agent?.cwd ?? null,
        status: page.agent?.status ?? null,
        cutoffSeq: ref.seq,
        cutoffTime: anchor.timestamp,
      },
    };
  }
  private before(ref: Reference, value?: number) {
    const before = value ?? ref.seq + 1;
    if (before > ref.seq + 1) throw new Error('beforeSeq is past the reference cutoff');
    return before;
  }
  async read(input: ReadInput) {
    const { ref, handle, source } = await this.open(input.reference);
    if (input.view === 'entry') {
      if (input.entrySeq === undefined || input.entrySeq > ref.seq)
        throw new Error('entrySeq must be within the referenced history');
      const page = await this.page(handle, ref, input.entrySeq + 1, 1);
      const entry = page.entries.find((e) => e.seqStart === input.entrySeq);
      if (!entry) throw new Error('History entry is unavailable');
      const text = content(entry, input.includeTools);
      if (text === null)
        throw new Error(
          'Entry is excluded. Tool results require includeTools; reasoning and plugin rows are not exposed.',
        );
      if (input.offset > text.length) throw new Error('offset exceeds the entry length');
      return { source, entries: [fragment(entry, text, input.offset, TEXT_BUDGET)] };
    }
    if (input.entrySeq !== undefined || input.offset !== 0)
      throw new Error('entrySeq and offset require view: entry');
    let before = this.before(ref, input.beforeSeq);
    const entries: Fragment[] = [];
    let remaining = TEXT_BUDGET;
    let nextBeforeSeq: number | null = before;
    let scanned = 0;
    // Return a continuation even when a page consists entirely of excluded events.
    for (let pages = 0; pages < 3 && nextBeforeSeq !== null; pages++) {
      const page = await this.page(handle, ref, before, PAGE_SIZE);
      const ordered = [...page.entries].sort((a, b) => b.seqStart - a.seqStart);
      if (!ordered.length) {
        if (page.hasOlder) throw new Error('History pagination made no progress');
        nextBeforeSeq = null;
        break;
      }
      for (const entry of ordered) {
        scanned++;
        nextBeforeSeq = entry.seqStart;
        const text = content(entry, input.includeTools);
        if (text !== null && text.length > 0) {
          const excerpt = fragment(entry, text, 0, Math.min(1600, remaining));
          entries.push(excerpt);
          remaining -= excerpt.text.length;
        }
        if (entries.length >= 8 || remaining < 200) break;
      }
      const reachedStart = nextBeforeSeq === ordered.at(-1)!.seqStart;
      if (reachedStart && !page.hasOlder) nextBeforeSeq = null;
      if (entries.length >= 8 || remaining < 200) break;
      if (nextBeforeSeq !== null) before = nextBeforeSeq;
    }
    const initial: Fragment[] = [];
    if (input.view === 'overview' && input.beforeSeq === undefined) {
      // Bounded initial request lookup; never pretend this is a generated summary.
      this.alive();
      const head = await handle.timeline.refetch({
        direction: 'after',
        cursor: { epoch: ref.epoch, seq: 0 },
        limit: PAGE_SIZE,
        projection: 'projected',
      });
      this.alive();
      checkPage(head, ref.agent, ref.epoch);
      const first = head.entries.find((e) => e.seqEnd <= ref.seq && e.item.type === 'user_message');
      if (first && !entries.some((e) => e.seq === first.seqStart))
        initial.push(fragment(first, content(first, false)!, 0, 1200));
    }
    return {
      source,
      note: 'These are verbatim excerpts, not a complete handoff summary. Earlier requirements may be missing. Follow the current user request; check the working directory, branch and actual files before continuing. Read truncated entries with view=entry and nextOffset. Use nextBeforeSeq to read older history.',
      initialRequest: initial,
      entries: entries.reverse(),
      scanned,
      nextBeforeSeq,
    };
  }
  async search(input: SearchInput) {
    const { ref, handle, source } = await this.open(input.reference);
    const pattern = new RegExp(input.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu');
    const matches: Fragment[] = [];
    let before = this.before(ref, input.beforeSeq);
    let nextBeforeSeq: number | null = before;
    let scanned = 0;
    for (let pages = 0; pages < 3 && nextBeforeSeq !== null; pages++) {
      const page = await this.page(handle, ref, before, 100);
      const ordered = [...page.entries].sort((a, b) => b.seqStart - a.seqStart);
      if (!ordered.length) {
        if (page.hasOlder) throw new Error('History pagination made no progress');
        nextBeforeSeq = null;
        break;
      }
      for (const entry of ordered) {
        this.alive();
        scanned++;
        nextBeforeSeq = entry.seqStart;
        const text = content(entry, input.includeTools);
        const found = text === null ? null : pattern.exec(text);
        if (text !== null && found)
          matches.push(fragment(entry, text, Math.max(0, found.index - 120), 500));
        if (matches.length === 10) break;
      }
      if (nextBeforeSeq === ordered.at(-1)!.seqStart && !page.hasOlder) nextBeforeSeq = null;
      if (matches.length === 10) break;
      if (nextBeforeSeq !== null) before = nextBeforeSeq;
    }
    return {
      source,
      query: input.query,
      matches,
      scanned,
      nextBeforeSeq,
      complete: nextBeforeSeq === null,
      note: 'One excerpt per matching entry. Use view=entry to read the match in context. A non-null nextBeforeSeq means older history has not been searched yet.',
    };
  }
}
