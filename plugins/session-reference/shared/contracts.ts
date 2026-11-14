import { defineRpc, PluginAttachmentItemSchema } from '@getpaseo/plugin';
import { z } from 'zod';

export const searchSessions = defineRpc({
  name: 'sessions.search',
  input: z.object({ query: z.string().max(300), locale: z.string().max(50).default('en') }),
  output: z.object({
    items: z.array(
      PluginAttachmentItemSchema.extend({
        details: z
          .object({ cwd: z.string(), timestamp: z.string(), archived: z.boolean() })
          .optional(),
      }),
    ),
  }),
});

export const referenceSchema = z
  .object({
    v: z.literal(1),
    host: z.string().min(1).max(200),
    agent: z.string().min(1).max(200),
    epoch: z.string().min(1).max(200),
    seq: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER - 1),
    anchor: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER - 1),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type Reference = z.infer<typeof referenceSchema>;

const reference = z
  .string()
  .min(1)
  .max(4096)
  .describe('Exact reference token from the Session Reference attachment');
const seq = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER - 1);
export const readInput = z.object({
  reference,
  view: z.enum(['overview', 'page', 'entry']).default('overview'),
  beforeSeq: seq.optional().describe('Exclusive older-page boundary returned by this tool'),
  entrySeq: seq.optional().describe('Required for entry: sequence of one item to read in chunks'),
  offset: z.number().int().nonnegative().default(0).describe('Character offset for entry chunks'),
  includeTools: z
    .boolean()
    .default(false)
    .describe('Include tool calls and results; reasoning is always excluded'),
});
export type ReadInput = z.infer<typeof readInput>;
export const searchInput = z.object({
  reference,
  query: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe('Literal case-insensitive text, not a regular expression'),
  beforeSeq: seq.optional().describe('Continue the bounded scan with the returned nextBeforeSeq'),
  includeTools: z.boolean().default(false),
});
export type SearchInput = z.infer<typeof searchInput>;
