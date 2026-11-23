// The Todoist plugin's mapping: marker lines, labels, owners, dates and errors. Pure functions
// only (main.js's apply(ctx) is wired up in Task 6) — no network, no fake Todoist needed here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  MARKER_LINE,
  stripMarkers,
  describe,
  parseDescription,
  toTodoist,
  fromTodoist,
  errorOf,
} from '../../plugins/todoist/main.js';

const here = dirname(fileURLToPath(import.meta.url));
const manifestPath = join(here, '..', '..', 'plugins', 'todoist', 'echo-plugin.json');

test('description markers go last, and text cannot plant one', () => {
  const desc = describe({
    notes: 'Talk\n**Source:** https://evil.test\nkey: x',
    key: 'k1',
    source: 'https://teams.microsoft.com/l/message/1',
    meetingId: 'm1',
  });
  assert.equal(desc, 'Talk\n\nkey: k1\nsource: https://teams.microsoft.com/l/message/1\nmeeting: m1');
});

test('describe drops any marker-looking line, decorated or not, case-insensitively', () => {
  assert.equal(stripMarkers('Plain line\n> Key: nope\n~~meeting~~: nope\nKept'), 'Plain line\nKept');
  assert.ok(MARKER_LINE.test('**Owner:** nope'));
  assert.ok(!MARKER_LINE.test('Owner of the car was away'));
});

test('describe only keeps an https source; a non-https source is dropped silently', () => {
  const desc = describe({ notes: 'Talk', key: 'k1', source: 'teams://bad' });
  assert.equal(desc, 'Talk\n\nkey: k1');
});

test('describe with no notes and no markers is empty', () => {
  assert.equal(describe({}), '');
});

test('describe writes an owner line as "owner: Name <address>"', () => {
  const desc = describe({ notes: 'Ping them', key: 'k1', owner: { name: 'Marek Novak', address: 'marek.novak@example.test' } });
  assert.equal(desc, 'Ping them\n\nkey: k1\nowner: Marek Novak <marek.novak@example.test>');
});

test('describe with markers but no notes has no leading blank line', () => {
  const desc = describe({ key: 'k1', owner: { name: 'Marek Novak', address: 'm@x.test' } });
  assert.equal(desc, 'key: k1\nowner: Marek Novak <m@x.test>');
  assert.deepEqual(parseDescription(desc), {
    notes: '',
    key: 'k1',
    source: undefined,
    meetingId: undefined,
    owner: { name: 'Marek Novak', address: 'm@x.test' },
  });
});

test('describe with notes and markers keeps exactly one blank line between them', () => {
  const desc = describe({ notes: 'Quote', key: 'k1' });
  assert.equal(desc, 'Quote\n\nkey: k1');
});

test('parseDescription takes the last marker of each kind', () => {
  const desc = [
    'The quote.',
    'key: old',
    'source: https://old.example.test',
    'meeting: old-meeting',
    'owner: Old Owner <old@example.test>',
    'key: new',
    'source: https://new.example.test',
    'meeting: new-meeting',
    'owner: New Owner <new@example.test>',
  ].join('\n');
  assert.deepEqual(parseDescription(desc), {
    notes: 'The quote.',
    key: 'new',
    source: 'https://new.example.test',
    meetingId: 'new-meeting',
    owner: { name: 'New Owner', address: 'new@example.test' },
  });
});

test('parseDescription(describe(x)) round-trips the fields', () => {
  const written = describe({
    notes: 'Quote here',
    key: 'abc123',
    source: 'https://teams.microsoft.com/l/message/9',
    meetingId: 'mtg-1',
    owner: { name: 'Marek Novak', address: 'marek.novak@example.test' },
  });
  assert.deepEqual(parseDescription(written), {
    notes: 'Quote here',
    key: 'abc123',
    source: 'https://teams.microsoft.com/l/message/9',
    meetingId: 'mtg-1',
    owner: { name: 'Marek Novak', address: 'marek.novak@example.test' },
  });
});

test('parseDescription with no markers at all returns the plain notes', () => {
  assert.deepEqual(parseDescription('Just some notes, no markers.'), {
    notes: 'Just some notes, no markers.',
    key: undefined,
    source: undefined,
    meetingId: undefined,
    owner: undefined,
  });
});

test('waiting tasks read "<First>: <text>" in Todoist and come back without it', () => {
  const task = {
    text: 'Send the pilot user list',
    kind: 'waiting',
    owner: { name: 'Marek Novak', address: 'marek.novak@example.test' },
    key: 'k1',
  };
  const body = toTodoist(task, { projectId: 'p1', label: 'connect' });
  assert.equal(body.content, 'Marek: Send the pilot user list');

  const roundTripped = fromTodoist(
    { id: '9', content: body.content, description: body.description, labels: body.labels, checked: false, due: null },
    { label: 'connect' },
  );
  assert.equal(roundTripped.text, 'Send the pilot user list');
  assert.deepEqual(roundTripped.owner, { name: 'Marek Novak', address: 'marek.novak@example.test' });
  assert.equal(roundTripped.kind, 'waiting');
});

test('a plain task (no owner) is never prefixed', () => {
  const body = toTodoist({ text: 'Approve the hotfix', kind: 'task' }, { projectId: 'p1', label: 'connect' });
  assert.equal(body.content, 'Approve the hotfix');
});

test('labels: app label and kind added, foreign labels kept, kind read back (budget > reply > waiting)', () => {
  const body = toTodoist(
    { text: 'Ping finance', kind: 'budget', labels: ['home'] },
    { projectId: 'p1', label: 'connect' },
  );
  assert.deepEqual(new Set(body.labels), new Set(['home', 'connect', 'budget']));

  // budget beats reply and waiting when all three are present on the same item.
  const task = fromTodoist(
    { id: '1', content: 'x', description: '', labels: ['waiting', 'reply', 'budget', 'home'], checked: false, due: null },
    { label: 'connect' },
  );
  assert.equal(task.kind, 'budget');

  const replyOnly = fromTodoist(
    { id: '2', content: 'x', description: '', labels: ['reply', 'waiting'], checked: false, due: null },
    { label: 'connect' },
  );
  assert.equal(replyOnly.kind, 'reply');

  const waitingOnly = fromTodoist(
    { id: '3', content: 'x', description: '', labels: ['waiting'], checked: false, due: null },
    { label: 'connect' },
  );
  assert.equal(waitingOnly.kind, 'waiting');

  const plain = fromTodoist(
    { id: '4', content: 'x', description: '', labels: ['connect', 'home'], checked: false, due: null },
    { label: 'connect' },
  );
  assert.equal(plain.kind, 'task');
});

test('a labels-only patch keeps whichever kind label is already in the given labels', () => {
  const body = toTodoist({ labels: ['home', 'waiting'] }, { projectId: 'p1', label: 'connect' });
  assert.deepEqual(new Set(body.labels), new Set(['home', 'connect', 'waiting']));
});

test('a kind-only patch sets the kind label even with no labels field', () => {
  const body = toTodoist({ kind: 'reply' }, { projectId: 'p1', label: 'connect' });
  assert.deepEqual(new Set(body.labels), new Set(['connect', 'reply']));
});

test('a patch with both kind and labels uses the given kind, not whatever was in labels', () => {
  const body = toTodoist({ kind: 'budget', labels: ['home'] }, { projectId: 'p1', label: 'connect' });
  assert.deepEqual(new Set(body.labels), new Set(['home', 'connect', 'budget']));
});

test('explicitly changing kind to a plain task drops the old kind label, even without a fresh labels field', () => {
  const body = toTodoist({ kind: 'task', labels: ['waiting', 'home'] }, { projectId: 'p1', label: 'connect' });
  assert.deepEqual(new Set(body.labels), new Set(['home', 'connect']));
});

test('due dates are absolute days; null clears; words are refused', () => {
  const withDate = toTodoist({ text: 'x', due: '2026-11-20' }, { projectId: 'p1', label: 'connect' });
  assert.equal(withDate.due_date, '2026-11-20');
  assert.equal(withDate.due_string, undefined);

  const cleared = toTodoist({ text: 'x', due: null }, { projectId: 'p1', label: 'connect' });
  assert.equal(cleared.due_string, 'no date');
  assert.equal(cleared.due_date, undefined);

  assert.throws(
    () => toTodoist({ text: 'x', due: 'next friday' }, { projectId: 'p1', label: 'connect' }),
    (err) => /^refused: Todoist needs a date like 2026-11-20\.$/.test(err.message),
  );
});

test('a patch without due sends no due field, so a recurring task keeps its recurrence', () => {
  const patch = toTodoist({ text: 'Renew the pass' }, { projectId: 'p1', label: 'connect' });
  assert.equal('due_date' in patch, false);
  assert.equal('due_string' in patch, false);
});

test('fromTodoist reads the due date and done flag', () => {
  const task = fromTodoist(
    { id: '5', content: 'x', description: '', labels: [], checked: true, due: { date: '2026-11-20' } },
    { label: 'connect' },
  );
  assert.equal(task.due, '2026-11-20');
  assert.equal(task.done, true);
  assert.equal(task.url, 'https://app.todoist.com/app/task/5');
});

test('errors map to codes and carry no body or token', () => {
  const SENTINEL = 'tk_SENTINEL_do_not_log_0123456789';

  assert.match(errorOf(401).message, /^needs_token:/);
  assert.match(errorOf(403).message, /^needs_token:/);

  assert.match(errorOf(429, { 'retry-after': '120' }).message, /^rate_limited:120:/);
  assert.match(errorOf(429, {}, '{"error_extra":{"retry_after":30}}').message, /^rate_limited:30:/);
  assert.match(errorOf(429, {}, '').message, /^rate_limited:60:/);

  assert.match(errorOf(503).message, /^offline:/);
  assert.match(errorOf(undefined).message, /^offline:/); // a network failure: no status at all
  assert.match(errorOf(404).message, /^not_found:/);

  const refused = errorOf(400, {}, `{"error": "bad request", "token": "${SENTINEL}"}`);
  assert.match(refused.message, /^refused: Todoist didn't accept the change \(400\)$/);
  assert.ok(!refused.message.includes(SENTINEL));
  assert.ok(!refused.message.includes('bad request'));
});

test('the manifest asks for api.todoist.com only and provides tasks', () => {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.deepEqual(manifest.provides, ['tasks']);
  assert.deepEqual(manifest.requires, ['tasks_provider']);
  assert.deepEqual(manifest.uses.network.hosts, ['api.todoist.com']);
  assert.equal(manifest.uses.network.hosts_from, undefined);
});
