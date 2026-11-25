// Knowledge's `apply(ctx)`: the six `reply-context` ops (status, export, context, save, remove;
// `facts` is covered in facts.test.mjs) and its page's host commands (`build`, `newPerson`,
// `summary`, `pickFolder`), run over a fake ctx and a real temp folder — no network, no real
// QuickJS host. The sentinel VOICE_SENTINEL_9f3a (reply-voice design §22) must never reach a
// thrown message.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, rootOf } from '../../plugins/knowledge/main.js';
import { fakeCtx } from '../helpers/fake-ctx.mjs';

const SENTINEL = 'VOICE_SENTINEL_9f3a';

function setup({ dir, settings = {}, sent = [], claude, pickFolder } = {}) {
  const root = dir ?? mkdtempSync(join(tmpdir(), 'knowledge-'));
  const ctx = fakeCtx({ dir: root, settings, sent, claude, pickFolder });
  apply(ctx);
  return { ctx, root, run: (op, args) => ctx.run(op, args) };
}

function write(root, rel, text) {
  const abs = join(root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, text);
}

const PERSON_PRIYA = [
  '---',
  'id: priya-n',
  'name: Priya N.',
  'aliases: [Priya, Priya Nair]',
  'emails: [priya.n@example.test]',
  '---',
  '## Writing to them',
  'Short, bullet points.',
].join('\n');

const RULES_TEXT = [
  '## to: priya.n@example.test',
  'Short, bullet points.',
  '## everyone',
  'Never promise a date.',
].join('\n');

const STYLE_TEXT = [
  '---',
  'basedOn: {mail: 12, teams: 140}',
  'built: abc',
  '---',
  'Keep replies short.',
].join('\n');

test('no folder: status, export, context and facts throw needs_setup', async () => {
  const { run } = setup({ dir: mkdtempSync(join(tmpdir(), 'knowledge-empty-')) });
  // No pickFolder call happened, so ctx.fs.folders() is empty in this fakeCtx only when we build
  // one with no dir chosen; fakeCtx always grants `dir` as the one folder once given, so here we
  // simulate "never set up" by using a ctx whose fs.folders() is empty.
  const ctx = fakeCtx({ dir: undefined });
  // fakeCtx grants its root unconditionally for fs/system use, but Knowledge decides "set up" by
  // ctx.fs.folders(); override it to simulate no folder ever picked.
  ctx.fs.folders = () => [];
  apply(ctx);
  for (const op of ['status', 'export', 'context', 'facts']) {
    await assert.rejects(
      () => ctx.run(op, {}),
      (e) => e.message === 'needs_setup: Choose your knowledge folder in Knowledge.',
      op,
    );
  }
});

test('status is needs_setup when the granted folder no longer exists on disk', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'knowledge-gone-'));
  const { run } = setup({ dir });
  const fsMod = await import('node:fs');
  fsMod.rmSync(dir, { recursive: true, force: true });
  await assert.rejects(() => run('status', {}), (e) => e.message.startsWith('needs_setup:'));
});

test('export lists the style card with its head, the rules and the people; a broken page is counted as skipped by status', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'knowledge-export-'));
  write(dir, 'People/priya-n.md', PERSON_PRIYA);
  write(dir, 'People/broken.md', ['---', 'name Priya', '# Broken'].join('\n'));
  write(dir, 'People/me.md', [
    '# Me',
    '## Communication Preferences',
    'Prefer bullet points.',
  ].join('\n'));
  write(dir, 'Voice/rules.md', RULES_TEXT);
  write(dir, 'Voice/style.md', STYLE_TEXT);
  const { run } = setup({ dir, settings: { ownerPage: 'People/me.md' } });

  const status = await run('status', {});
  assert.deepEqual(status, { ok: true, people: 2, rules: 2, style: true, skipped: 1 });

  const exported = await run('export', {});
  assert.equal(exported.style.text, 'Keep replies short.');
  assert.deepEqual(exported.style.basedOn, { mail: 12, teams: 140 });
  assert.equal(exported.style.source, 'Voice/style.md');
  assert.deepEqual(exported.style.head, { text: '## Communication Preferences\n\nPrefer bullet points.', source: 'People/me.md' });
  assert.equal(exported.rules.length, 2);
  assert.equal(exported.rules[0].source, 'Voice/rules.md');
  assert.equal(exported.rules[0].editable, true);
  assert.equal(exported.people.length, 2);
  assert.ok(exported.people.some((p) => p.name === 'Priya N.'));
});

// Review I2: the real host's `fs.rs` `mtime_of` answers seconds since 1970, not milliseconds.
// `fullStyleAndRules` must multiply by 1000 before building a Date, and the fake must hand back
// seconds too, or this test would pass against a fake that quietly disagrees with the host.
test('export reads style.updatedAt from the file’s mtime in seconds, not milliseconds', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'knowledge-mtime-'));
  write(dir, 'Voice/style.md', 'Keep replies short.');
  const { run } = setup({ dir });

  const fsMod = await import('node:fs');
  const expectedSeconds = Math.floor(fsMod.statSync(join(dir, 'Voice', 'style.md')).mtimeMs / 1000);
  const exported = await run('export', {});
  const gotSeconds = Math.floor(new Date(exported.style.updatedAt).getTime() / 1000);
  assert.equal(gotSeconds, expectedSeconds);
  assert.ok(
    new Date(exported.style.updatedAt).getUTCFullYear() > 2000,
    `expected a real date, got ${exported.style.updatedAt} (an mtime treated as milliseconds would land in January 1970)`,
  );
});

test('context answers what applies to one person (by address, Teams id or name) and leaves out the rest', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'knowledge-context-'));
  write(dir, 'People/priya-n.md', PERSON_PRIYA);
  write(dir, 'People/jordan.md', [
    '---', 'id: jordan', 'name: Jordan Lee', 'teamsIds: [29:jordanTeams]', '---', '# Jordan Lee',
  ].join('\n'));
  write(dir, 'Voice/rules.md', RULES_TEXT);
  const { run } = setup({ dir });

  const byAddress = await run('context', { person: { name: null, address: 'priya.n@example.test', id: null }, channel: 'mail', subject: 'Hi' });
  assert.equal(byAddress.person.id, 'priya-n');
  assert.equal(byAddress.person.name, 'Priya N.');

  const byId = await run('context', { person: { name: null, address: null, id: '29:jordanTeams' }, channel: 'teams', subject: null });
  assert.equal(byId.person.id, 'jordan');

  const byName = await run('context', { person: { name: 'Nair Priya', address: null, id: null }, channel: 'mail', subject: null });
  assert.equal(byName.person.id, 'priya-n', 'word order folds the same');

  const none = await run('context', { person: { name: 'Nobody Here', address: null, id: null }, channel: 'mail', subject: null });
  assert.equal(none.person, null);
  assert.equal(none.rules.length, 2, 'rules are the same full list, matched natively by Connect itself');
});

test('save writes the style card and a rule through ifSha', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'knowledge-save-'));
  const { run } = setup({ dir });

  const style = await run('save', { kind: 'style', text: 'Be terse.' });
  assert.equal(style.text, 'Be terse.');
  assert.equal(readFileSync(join(dir, 'Voice', 'style.md'), 'utf8').trim(), 'Be terse.');

  const rule = await run('save', {
    kind: 'rule', id: null, applies: { kind: 'everyone' }, text: 'Never promise a date.',
  });
  assert.equal(rule.applies.kind, 'everyone');
  assert.equal(rule.text, 'Never promise a date.');
  assert.ok(rule.id);
  const rulesText = readFileSync(join(dir, 'Voice', 'rules.md'), 'utf8');
  assert.match(rulesText, /## everyone\nNever promise a date\./);

  const edited = await run('save', {
    kind: 'rule', id: rule.id, applies: { kind: 'everyone' }, text: 'Never promise a date, ever.',
  });
  assert.equal(edited.id, rule.id, 'editing keeps the same id when the heading is unchanged');
  const again = readFileSync(join(dir, 'Voice', 'rules.md'), 'utf8');
  assert.match(again, /Never promise a date, ever\./);
  assert.ok(!again.includes('Never promise a date.\n'), 'the old text is gone, not duplicated');
});

test('save kind rules appends every item in one ifSha write with the imported comment, all or nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'knowledge-import-'));
  write(dir, 'Voice/rules.md', '## everyone\nExisting rule.');
  const { run } = setup({ dir });

  const answer = await run('save', {
    kind: 'rules',
    items: [
      { applies: { kind: 'everyone', channel: 'mail' }, text: 'Open with the first name.', from: 'reply-style' },
      { applies: { kind: 'no-profile' }, text: 'Introduce yourself.', from: 'reply-style' },
    ],
  });
  assert.equal(answer.items.length, 2);
  assert.ok(answer.items.every((i) => i.id));
  const text = readFileSync(join(dir, 'Voice', 'rules.md'), 'utf8');
  assert.match(text, /Existing rule\./, 'the old rule is kept');
  assert.match(text, /<!-- imported from skill "reply-style" on \d{4}-\d{2}-\d{2} -->\nOpen with the first name\./);
  assert.match(text, /<!-- imported from skill "reply-style" on \d{4}-\d{2}-\d{2} -->\nIntroduce yourself\./);
});

test('save_refuses_when_the_page_changed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'knowledge-conflict-'));
  write(dir, 'Voice/rules.md', '## everyone\nOriginal.');
  const ctx = fakeCtx({ dir });
  apply(ctx);

  // Simulate a concurrent edit landing between Knowledge's own read and its own write: the first
  // ctx.fs.read of rules.md (Knowledge's read) returns the text it expects, but the file on disk
  // is changed right after, so the write's ifSha no longer matches.
  const originalRead = ctx.fs.read;
  let armed = true;
  ctx.fs.read = (root, rel) => {
    const text = originalRead(root, rel);
    if (armed && rel === 'Voice/rules.md') {
      armed = false;
      writeFileSync(join(dir, 'Voice', 'rules.md'), '## everyone\nSomeone else changed this.');
    }
    return text;
  };

  await assert.rejects(
    () => ctx.run('save', { kind: 'rule', id: null, applies: { kind: 'no-profile' }, text: 'New rule.' }),
    (e) => e.message === 'refused: The page changed in your folder. Refresh and try again.',
  );
  assert.equal(
    readFileSync(join(dir, 'Voice', 'rules.md'), 'utf8'),
    '## everyone\nSomeone else changed this.',
    'the concurrent edit is kept, never overwritten',
  );
});

// Review (task 13): a page Knowledge can't read exactly — bytes that aren't UTF-8, or over the
// host's 1 MB read — is never overwritten, and the refusal says what is wrong and what to do,
// never "The page changed" (a refresh can't help).
test('a page that is not UTF-8 or over 1 MB is never overwritten: every save, remove and build refuses plainly', async () => {
  const notUtf8 = (rel) => `refused: Knowledge can't read ${rel}: it isn't UTF-8 text. Save it as UTF-8 in your folder, then try again.`;
  const tooBig = (rel) => `refused: Knowledge can't read ${rel}: it's over 1 MB. Make it smaller in your folder, then try again.`;
  const cases = [
    ['Voice/rules.md', (ctx) => ctx.run('save', { kind: 'rule', id: null, applies: { kind: 'everyone' }, text: 'Be brief.' })],
    ['Voice/rules.md', (ctx) => ctx.run('save', { kind: 'rules', items: [{ applies: { kind: 'everyone' }, text: 'Be brief.', from: 'reply-style' }] })],
    ['Voice/rules.md', (ctx) => ctx.run('remove', { kind: 'rule', id: 'everyone' })],
    ['Voice/style.md', (ctx) => ctx.run('save', { kind: 'style', text: 'Plain words.' })],
    ['Voice/style.md', (ctx) => ctx.run('build', { ai: false, replace: true })],
  ];
  for (const [rel, act] of cases) {
    for (const [bytes, message] of [
      [Buffer.concat([Buffer.from('## everyone\nCaf'), Buffer.from([0xe9]), Buffer.from(' rules.\n')]), notUtf8(rel)],
      [Buffer.from(`## everyone\n${'a'.repeat(1 << 20)}\n`), tooBig(rel)],
    ]) {
      const { ctx, root } = setup();
      mkdirSync(join(root, 'Voice'), { recursive: true });
      writeFileSync(join(root, rel), bytes);
      await assert.rejects(() => act(ctx), (e) => e.message === message, `${rel}: ${message}`);
      assert.ok(readFileSync(join(root, rel)).equals(bytes), `${rel} is unchanged`);
    }
  }
});

test('remove deletes a rule section; removing one already gone answers removed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'knowledge-remove-'));
  write(dir, 'Voice/rules.md', RULES_TEXT);
  const { run } = setup({ dir });

  const first = await run('remove', { kind: 'rule', id: 'everyone' });
  assert.deepEqual(first, { removed: true });
  const text = readFileSync(join(dir, 'Voice', 'rules.md'), 'utf8');
  assert.ok(!text.includes('Never promise a date.'));
  assert.ok(text.includes('priya.n@example.test'), 'the other rule stays');

  const again = await run('remove', { kind: 'rule', id: 'everyone' });
  assert.deepEqual(again, { removed: true }, 'removing an already-gone rule still answers removed');
});

// Every file under `dir`, relative, '/'-separated, sorted — so a test can assert the whole tree,
// not just that the expected files happen to exist (Minor: the old version of this test never
// proved nothing *else* was written).
async function listTree(dir) {
  const fsMod = await import('node:fs');
  const pathMod = await import('node:path');
  const out = [];
  const visit = (abs, rel) => {
    for (const name of fsMod.readdirSync(abs)) {
      const childAbs = pathMod.join(abs, name);
      const childRel = rel ? `${rel}/${name}` : name;
      if (fsMod.statSync(childAbs).isDirectory()) visit(childAbs, childRel);
      else out.push(childRel);
    }
  };
  visit(dir, '');
  return out.sort();
}

test('no write lands outside the Voice folder except a new person page; .git is never touched', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'knowledge-scope-'));
  write(dir, '.git/config', 'ignore me');
  const { run } = setup({ dir, sent: [] });

  await run('save', { kind: 'style', text: 'x' });
  await run('save', { kind: 'rule', id: null, applies: { kind: 'everyone' }, text: 'y' });
  await run('newPerson', { name: 'Jordan Lee', address: 'jordan@example.test' });

  const fsMod = await import('node:fs');
  assert.equal(fsMod.readFileSync(join(dir, '.git', 'config'), 'utf8'), 'ignore me');
  assert.deepEqual(
    await listTree(dir),
    ['.git/config', 'People/jordan-lee.md', 'Voice/rules.md', 'Voice/style.md'],
    'exactly these files, nothing else, were written',
  );
});

// Review I5: `ctx.fs.folders()` only ever grows and never reorders, so after choosing A, then B,
// then A again, it still answers `[A, B]` — the last-granted root alone can't tell which one the
// user actually wants now.
test('rootOf prefers the explicitly remembered root over the last-granted one', () => {
  const stub = {
    fs: { folders: () => ['/path/A', '/path/B'] },
    store: { read: (file) => (file === 'root.json' ? JSON.stringify({ root: '/path/A' }) : null) },
  };
  assert.equal(rootOf(stub), '/path/A', 'A was explicitly remembered, even though B was granted later');

  const forgotten = {
    fs: { folders: () => ['/path/A', '/path/B'] },
    store: { read: () => null },
  };
  assert.equal(rootOf(forgotten), '/path/B', 'nothing remembered: falls back to the last grant');

  const stale = {
    fs: { folders: () => ['/path/B'] },
    store: { read: () => JSON.stringify({ root: '/path/A' }) },
  };
  assert.equal(rootOf(stale), '/path/B', 'a remembered root no longer granted is ignored');
});

test('after choosing A, then B, then A again, pickFolder remembers A as the chosen root', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'knowledge-repick-'));
  const ctx = fakeCtx({ dir });
  apply(ctx);

  ctx.system.pickFolder = async () => '/path/A';
  await ctx.run('pickFolder', {});
  ctx.system.pickFolder = async () => '/path/B';
  await ctx.run('pickFolder', {});
  ctx.system.pickFolder = async () => '/path/A';
  await ctx.run('pickFolder', {});

  assert.deepEqual(JSON.parse(ctx.store.read('root.json')), { root: '/path/A' });
});

// Spec gap from the review: "Ask AI ... (off until ticked, remembered)".
test('"Ask AI" is remembered across page loads, through setAskAi and summary', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'knowledge-askai-'));
  const { run } = setup({ dir });

  assert.equal((await run('summary', {})).buildWithAi, false, 'off until ticked');
  await run('setAskAi', { value: true });
  assert.equal((await run('summary', {})).buildWithAi, true, 'remembered after being ticked');

  await run('setAskAi', { value: false });
  assert.equal((await run('summary', {})).buildWithAi, false);
});

test('no error message carries page text', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'knowledge-sentinel-'));
  write(dir, 'People/leaky.md', ['---', 'id: leaky', '---', `# ${SENTINEL}`, `## Writing to them`, SENTINEL].join('\n'));
  write(dir, 'Voice/rules.md', `## everyone\n${SENTINEL}`);
  write(dir, 'Voice/style.md', `---\nbuilt: abc\n---\n${SENTINEL}`);
  const { run } = setup({ dir });

  const results = [];
  try {
    await run('save', { kind: 'rule', id: 'does-not-exist', applies: { kind: 'everyone' }, text: SENTINEL });
  } catch (e) {
    results.push(e.message);
  }
  try {
    await run('build', {});
  } catch (e) {
    results.push(e.message);
  }
  try {
    const ctx2 = fakeCtx({ dir: undefined });
    ctx2.fs.folders = () => [];
    apply(ctx2);
    await ctx2.run('status', {});
  } catch (e) {
    results.push(e.message);
  }
  for (const message of results) {
    assert.ok(!message.includes(SENTINEL), message);
  }
});

test('the catalog lists knowledge, featured, categories replies', async () => {
  const { readFileSync: read } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join: joinPath } = await import('node:path');
  const here = dirname(fileURLToPath(import.meta.url));
  const catalog = JSON.parse(read(joinPath(here, '..', '..', 'echo-marketplace.json'), 'utf8'));
  assert.ok(catalog.featured.includes('knowledge'));
  const entry = catalog.plugins.find((p) => p.id === 'knowledge');
  assert.ok(entry, 'knowledge is listed');
  assert.equal(entry.source, './plugins/knowledge');
  assert.deepEqual(entry.categories, ['replies']);
  const manifest = JSON.parse(read(joinPath(here, '..', '..', 'plugins', 'knowledge', 'echo-plugin.json'), 'utf8'));
  assert.equal(manifest.version, '1.0.0');
});

// Final review I2: a page the reader still can't read is counted, never dropped silently —
// `status` keeps its count, and Knowledge's own page names them through `summary`.
test('summary names the people pages it could not read; status keeps the count in the same shape', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'knowledge-unreadable-'));
  write(dir, 'People/priya-n.md', PERSON_PRIYA);
  write(dir, 'People/yaml-heavy.md', ['---', 'date-created: 2026-01-12', 'sources:', '  - url: https://example.test/a', '    title: A', '---', '# Dana K'].join('\n'));
  write(dir, 'People/broken.md', ['---', 'name: Broken', '# Never closed'].join('\n'));
  const { run } = setup({ dir });

  assert.deepEqual(await run('status', {}), { ok: true, people: 2, rules: 0, style: false, skipped: 1 });
  const summary = await run('summary', {});
  assert.equal(summary.people, 2);
  assert.deepEqual(summary.unreadable, ['People/broken.md']);
});
