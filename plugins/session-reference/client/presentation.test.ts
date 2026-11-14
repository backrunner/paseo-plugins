import assert from 'node:assert/strict';
import test from 'node:test';
import { compactTitle, presentSession } from './presentation';

const now = Date.parse('2026-11-15T04:00:00Z');
const item = {
  id: 'source',
  identifier: '#abcd12',
  title: 'Fix login',
  subtitle: 'old',
  url: 'paseo://h/host/agent/source',
  text: 'Full source title and reference token stay unchanged',
  resourceType: 'session-reference',
  details: {
    cwd: '/projects/paseo-plugins',
    timestamp: '2026-11-15T03:48:00Z',
    archived: false,
  },
};

test('compact metadata keeps project and localised time without full paths or ISO timestamps', () => {
  const chinese = presentSession(item, 'zh-CN', now);
  assert.equal(chinese.subtitle, 'paseo-plugins · 12分钟前');
  assert.equal(presentSession(item, 'en', now).subtitle, 'paseo-plugins · 12 min. ago');
  assert.equal(chinese.text, item.text);
  assert.equal(chinese.id, item.id);
  assert.equal(chinese.url, item.url);
});
test('long CJK and Latin titles are bounded and single-line', () => {
  assert.equal(compactTitle(' Short\n title '), 'Short title');
  assert.equal(
    compactTitle('我们需要检查这个非常长的会话标题在窄窗口中是否能够正常展示'),
    '我们需要检查这个非常长的…',
  );
  assert.ok(compactTitle('W'.repeat(100)).length < 20);
});
test('archive and untitled labels follow the client language', () => {
  const archived = { ...item, title: '', details: { ...item.details, archived: true } };
  assert.equal(presentSession(archived, 'zh-CN', now).title, '未命名会话');
  assert.match(presentSession(archived, 'en', now).subtitle!, /Archived$/);
});
test('invalid timestamps, locales and Windows paths remain usable', () => {
  const windows = {
    ...item,
    details: { ...item.details, cwd: 'C:\\projects\\app\\', timestamp: 'bad' },
  };
  assert.equal(presentSession(windows, 'invalid_locale', now).subtitle, 'app');
  assert.equal(presentSession({ ...item, details: undefined }, 'en', now).subtitle, 'old');
});
