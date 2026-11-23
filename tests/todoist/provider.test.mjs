// The Todoist plugin's provider ops (`apply(ctx)` with `ctx.tasks.provide`), run over a fake ctx
// and an in-memory fake Todoist. No network: every fetch goes to the fake. The token is a
// sentinel, and no thrown message or log line may ever carry it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../../plugins/todoist/main.js';
import { fakeCtx } from '../helpers/fake-ctx.mjs';
import { fakeTodoist } from '../helpers/fake-todoist.mjs';

const SENTINEL = 'tk_SENTINEL_do_not_log_0123456789';

// The plugin applied to a fake ctx over a fake Todoist, with the sentinel token (none for `token:
// null`) and the manifest's defaults for project and label.
function setup({ token = SENTINEL, settings = {}, todoist = {} } = {}) {
  const fake = fakeTodoist({ token: SENTINEL, ...todoist });
  const urls = [];
  const ctx = fakeCtx({
    settings: { project: 'Connect', label: 'connect', ...(token === null ? {} : { token }), ...settings },
    fetchHandler: (url, opts) => {
      urls.push(url);
      return fake.handler(url, opts);
    },
  });
  apply(ctx);
  return { ctx, fake, urls, run: (op, args) => ctx.run(op, args) };
}

const posts = (fake, path) => fake.requests.filter((r) => r.method === 'POST' && r.path === path);

// A waiting task as Connect's core sends it (src-tauri wire::to_wire): owner, notes, meeting.
const WAITING = {
  text: 'Send the pilot user list',
  notes: '“I\'ll send you the names by Friday.” — Marek Novak',
  due: '2026-11-20',
  done: false,
  kind: 'waiting',
  owner: { name: 'Marek Novak', address: 'marek.novak@example.test' },
  source: null,
  meetingId: 'mtg-philips',
  labels: [],
};

test('status finds or makes the project once', async () => {
  const { run, fake, ctx } = setup();
  const first = await run('status', {});
  assert.deepEqual(first, { ok: true, account: 'You', project: 'Connect' });
  assert.equal(posts(fake, '/projects').length, 1);
  const kept = JSON.parse(ctx.store.read('project.json'));
  assert.equal(kept.name, 'Connect');
  assert.ok(kept.id);
  await run('status', {});
  assert.equal(posts(fake, '/projects').length, 1, 'the second status makes no project');
});

test('status finds an existing project by name over several pages', async () => {
  const { run, fake } = setup({ todoist: { pageSize: 2 } });
  for (const name of ['Inbox', 'Home', 'Work', 'Connect']) fake.addProject(name);
  const before = fake.addProject('Connect').id;
  await run('status', {});
  assert.equal(posts(fake, '/projects').length, 0);
  // Tasks go to the project that was found.
  await run('create', { key: 'k1', task: { text: 'One', labels: [] }, requestId: 'r1' });
  assert.equal(fake.all()[0].project_id, before);
});

test('a renamed project setting is found again', async () => {
  const { run, fake, ctx } = setup();
  await run('status', {});
  const work = fake.addProject('Work');
  ctx.settings.set('project', 'Work');
  const answer = await run('status', {});
  assert.equal(answer.project, 'Work');
  assert.equal(JSON.parse(ctx.store.read('project.json')).id, work.id);
});

test('create sends a waiting task with its markers, labels, due and request id', async () => {
  const { run, fake } = setup();
  const created = await run('create', { key: 'k1', task: WAITING, requestId: 'entry-1' });
  const [held] = fake.all();
  assert.equal(held.content, 'Marek: Send the pilot user list');
  assert.equal(
    held.description,
    '“I\'ll send you the names by Friday.” — Marek Novak\n\nkey: k1\nmeeting: mtg-philips\nowner: Marek Novak <marek.novak@example.test>',
  );
  assert.deepEqual(new Set(held.labels), new Set(['connect', 'waiting']));
  assert.deepEqual(held.due, { date: '2026-11-20', string: '2026-11-20' });
  const req = fake.requests.find((r) => r.method === 'POST' && r.path === '/tasks');
  assert.ok(req);
  // The answer reads back the same fields Connect sent: nothing for the core to update again.
  for (const k of ['text', 'notes', 'due', 'done', 'kind', 'meetingId']) {
    assert.deepEqual(created[k], WAITING[k], k);
  }
  assert.deepEqual(created.owner, WAITING.owner);
  assert.equal(created.key, 'k1');
  assert.equal(created.adopted, undefined);
});

test('the create answer matches what was sent for an owner without a name and untrimmed notes', async () => {
  const { run } = setup();
  const task = { text: 'Chase the contract', notes: '  first line\nsecond line  ', due: null, done: false,
    kind: 'waiting', owner: { name: null, address: 'legal@example.test' }, labels: [] };
  const created = await run('create', { key: 'k2', task, requestId: 'r' });
  assert.equal(created.text, 'Chase the contract');
  assert.equal(created.notes, 'first line\nsecond line');
  assert.equal(created.due, null);
  assert.equal(created.kind, 'waiting');
  assert.equal(created.owner.address, 'legal@example.test');
  assert.ok(!created.owner.name, 'no name reads as none, never "null"');
});

test('create sends the request id as X-Request-Id', async () => {
  const seen = [];
  const fake = fakeTodoist({ token: SENTINEL });
  const ctx = fakeCtx({
    settings: { token: SENTINEL, project: 'Connect', label: 'connect' },
    fetchHandler: (url, opts) => {
      seen.push(opts);
      return fake.handler(url, opts);
    },
  });
  apply(ctx);
  await ctx.run('create', { key: 'k1', task: { text: 'x', labels: [] }, requestId: 'entry-9' });
  const create = seen.find((o) => o.method === 'POST' && JSON.parse(o.body).content === 'x');
  assert.equal(create.headers['X-Request-Id'], 'entry-9');
  assert.equal(create.headers['Content-Type'], 'application/json');
});

test('create adopts an open task with the same key', async () => {
  const { run, fake } = setup();
  const first = await run('create', { key: 'k1', task: { text: 'Send the list', labels: [] }, requestId: 'a' });
  const again = await run('create', { key: 'k1', task: { text: 'Send the list', labels: [] }, requestId: 'a' });
  assert.equal(fake.all().length, 1, 'one task in Todoist');
  assert.equal(again.id, first.id);
  assert.equal(again.adopted, true);
});

test('a create whose answer was lost is adopted on replay', async () => {
  const { run, fake } = setup();
  await run('status', {});
  fake.lose('POST /tasks');
  await assert.rejects(run('create', { key: 'k1', task: WAITING, requestId: 'e1' }), (e) => /^offline:/.test(e.message));
  assert.equal(fake.all().length, 1, 'Todoist made it');
  const replay = await run('create', { key: 'k1', task: WAITING, requestId: 'e1' });
  assert.equal(replay.adopted, true);
  assert.equal(fake.all().length, 1, 'and holds exactly one');
});

test('list answers every open task of the project, paged', async () => {
  const { run, fake } = setup({ todoist: { pageSize: 2 } });
  for (const n of [1, 2, 3, 4, 5]) await run('create', { key: `k${n}`, task: { text: `T${n}`, labels: [] }, requestId: `r${n}` });
  const other = fake.addProject('Elsewhere');
  await fake.handler('https://api.todoist.com/api/v1/tasks', {
    method: 'POST', headers: { Authorization: `Bearer ${SENTINEL}` }, body: JSON.stringify({ content: 'Not ours', project_id: other.id }),
  });
  const { tasks } = await run('list', {});
  assert.deepEqual(tasks.map((t) => t.text).sort(), ['T1', 'T2', 'T3', 'T4', 'T5']);
});

test('changedSince returns changed, done and removed tasks of the project only', async () => {
  const { run, fake } = setup();
  const a = await run('create', { key: 'ka', task: { text: 'A', labels: [] }, requestId: 'ra' });
  const b = await run('create', { key: 'kb', task: { text: 'B', labels: [] }, requestId: 'rb' });
  const c = await run('create', { key: 'kc', task: { text: 'C', labels: [] }, requestId: 'rc' });
  const other = fake.addProject('Elsewhere');
  await fake.handler('https://api.todoist.com/api/v1/tasks', {
    method: 'POST', headers: { Authorization: `Bearer ${SENTINEL}` }, body: JSON.stringify({ content: 'Not ours', project_id: other.id }),
  });

  const full = await run('changedSince', { cursor: null });
  assert.deepEqual(full.tasks.map((t) => t.text).sort(), ['A', 'B', 'C']);
  assert.deepEqual(full.removed, []);
  assert.ok(full.cursor);
  const sync = fake.requests.find((r) => r.path === '/sync');
  assert.match(sync.body, /sync_token=\*/);
  assert.match(decodeURIComponent(sync.body), /resource_types=\["items"\]/);

  fake.edit(a.id, { content: 'A edited' });
  await run('complete', { id: b.id, done: true });
  await run('remove', { id: c.id });
  const delta = await run('changedSince', { cursor: full.cursor });
  assert.deepEqual(delta.tasks.map((t) => [t.text, t.done]).sort(), [['A edited', false], ['B', true]]);
  assert.deepEqual(delta.removed, [c.id]);
  assert.notEqual(delta.cursor, full.cursor);
});

test('update keeps markers and foreign labels', async () => {
  const { run, fake } = setup();
  const t = await run('create', { key: 'k1', task: { ...WAITING, source: 'https://teams.example.test/m/1' }, requestId: 'r' });
  fake.edit(t.id, { labels: [...fake.task(t.id).labels, 'q4'] });

  const notes = await run('update', { id: t.id, patch: { notes: 'New notes' }, requestId: 'u1' });
  const held = fake.task(t.id);
  assert.equal(
    held.description,
    'New notes\n\nkey: k1\nsource: https://teams.example.test/m/1\nmeeting: mtg-philips\nowner: Marek Novak <marek.novak@example.test>',
  );
  assert.equal(held.content, 'Marek: Send the pilot user list', 'the content is not touched');
  assert.equal(notes.notes, 'New notes');
  assert.equal(notes.key, 'k1');

  // The core's patch names only changed fields (src-tauri sync.rs UPDATABLE: text, notes, due,
  // kind, owner — never labels): a kind change keeps the foreign label, swaps the kind label.
  await run('update', { id: t.id, patch: { kind: 'reply', owner: null }, requestId: 'u2' });
  assert.deepEqual(new Set(fake.task(t.id).labels), new Set(['connect', 'reply', 'q4']));
  assert.equal(fake.task(t.id).content, 'Send the pilot user list', 'no owner, no prefix');
  assert.doesNotMatch(fake.task(t.id).description, /owner:/);
  assert.match(fake.task(t.id).description, /key: k1/);

  // A text-only patch leaves labels and the due date alone (a recurring due string is kept).
  fake.edit(t.id, { due: { date: '2026-11-27', string: 'every friday', is_recurring: true } });
  await run('update', { id: t.id, patch: { text: 'Send the final list' }, requestId: 'u3' });
  const last = fake.requests.filter((r) => r.method === 'POST' && r.path === `/tasks/${t.id}`).at(-1);
  assert.deepEqual(Object.keys(JSON.parse(last.body)), ['content']);
  assert.equal(fake.task(t.id).due.string, 'every friday');
  assert.deepEqual(new Set(fake.task(t.id).labels), new Set(['connect', 'reply', 'q4']));

  // A labels-only patch carries the full current set, so the kind label stays.
  await run('update', { id: t.id, patch: { labels: ['connect', 'reply', 'q4', 'home'] }, requestId: 'u4' });
  assert.deepEqual(new Set(fake.task(t.id).labels), new Set(['connect', 'reply', 'q4', 'home']));

  // A due change: due_date, or "no date" to clear.
  await run('update', { id: t.id, patch: { due: '2026-12-01' }, requestId: 'u5' });
  assert.equal(fake.task(t.id).due.date, '2026-12-01');
  const cleared = await run('update', { id: t.id, patch: { due: null }, requestId: 'u6' });
  assert.equal(cleared.due, null);
});

test('update of a task gone from Todoist is not_found', async () => {
  const { run } = setup();
  await run('status', {});
  await assert.rejects(run('update', { id: '999', patch: { text: 'x' }, requestId: 'u' }), (e) => /^not_found:/.test(e.message));
});

test('complete reopens with done:false; remove deletes', async () => {
  const { run, fake } = setup();
  const t = await run('create', { key: 'k1', task: { text: 'Close me', labels: [] }, requestId: 'r' });
  const done = await run('complete', { id: t.id, done: true });
  assert.equal(done.done, true);
  assert.equal(fake.task(t.id).checked, true);
  const open = await run('complete', { id: t.id, done: false });
  assert.equal(open.done, false);
  assert.equal(fake.task(t.id).checked, false);
  assert.ok(fake.requests.some((r) => r.path === `/tasks/${t.id}/reopen`));
  assert.deepEqual(await run('remove', { id: t.id }), { removed: true });
  assert.equal(fake.task(t.id).is_deleted, true);
  // Already gone: still removed, nothing to retry.
  assert.deepEqual(await run('remove', { id: t.id }), { removed: true });
});

test('no token asks for one before any request', async () => {
  const { run, urls } = setup({ token: null });
  for (const op of ['status', 'list', 'changedSince', 'create']) {
    await assert.rejects(run(op, { key: 'k', task: { text: 'x' } }), (e) =>
      e.message === 'needs_token: Add your Todoist API token in Settings › Tasks.');
  }
  assert.deepEqual(urls, []);
});

test('errors map to codes the core understands', async () => {
  const { run, fake } = setup();
  await run('status', {});
  fake.fail('GET /tasks', 429, { retryAfter: 5, once: true });
  await assert.rejects(run('list', {}), (e) => /^rate_limited:5:/.test(e.message));
  fake.fail('GET /tasks', 503, { once: true });
  await assert.rejects(run('list', {}), (e) => /^offline:/.test(e.message));
  fake.fail('POST /tasks', 400, { once: true });
  await assert.rejects(run('create', { key: 'k', task: { text: 'x' } }), (e) => /^refused:/.test(e.message));
  fake.fail('GET /user', 401, { once: true });
  await assert.rejects(run('status', {}), (e) => /^needs_token:/.test(e.message));
});

test('no message carries the token', async () => {
  const { run, fake, ctx } = setup();
  await run('status', {});
  const echo = { error: `bad token ${SENTINEL}`, request: { headers: { Authorization: `Bearer ${SENTINEL}` } } };
  const messages = [];
  const cases = [
    ['GET /user', 401], ['GET /user', 403], ['GET /tasks', 429], ['GET /tasks', 500],
    ['POST /tasks', 400], ['POST /sync', 502],
  ];
  for (const [route, status] of cases) {
    fake.fail(route, status, { once: true, body: echo });
    const op = route === 'GET /user' ? 'status' : route === 'GET /tasks' ? 'list'
      : route === 'POST /sync' ? 'changedSince' : 'create';
    await run(op, { key: 'k', task: { text: 'x' }, cursor: null }).catch((e) => messages.push(String(e.message), String(e)));
  }
  fake.lose('GET /user');
  await run('status', {}).catch((e) => messages.push(String(e.message), String(e)));
  await run('update', { id: '999', patch: { text: 'x' } }).catch((e) => messages.push(String(e.message)));
  await run('create', { key: 'k', task: { text: 'x', due: 'next friday' } }).catch((e) => messages.push(String(e.message)));
  assert.ok(messages.length >= 9, messages.join('\n'));
  for (const m of [...messages, ...ctx._log]) assert.ok(!m.includes(SENTINEL), m);
  for (const m of messages) assert.ok(!m.includes('bad token'), m);
});

test('only api.todoist.com is fetched', async () => {
  const { run, urls } = setup();
  const t = await run('create', { key: 'k1', task: WAITING, requestId: 'r' });
  await run('status', {});
  await run('list', {});
  await run('changedSince', { cursor: null });
  await run('update', { id: t.id, patch: { text: 'y' }, requestId: 'u' });
  await run('complete', { id: t.id, done: true });
  await run('remove', { id: t.id });
  assert.ok(urls.length > 8);
  for (const url of urls) assert.ok(url.startsWith('https://api.todoist.com/api/v1/'), url);
});

// ---------------------------------------------------------------- review fixes (round 1)

test('status notices a deleted project and makes it again once, saying so', async () => {
  const { run, fake, ctx } = setup();
  await run('status', {});
  const first = JSON.parse(ctx.store.read('project.json')).id;
  fake.deleteProject(first);
  const again = await run('status', {});
  assert.equal(again.ok, true);
  assert.equal(again.project, 'Connect');
  assert.match(again.message, /made the Todoist project “Connect” again/);
  const second = JSON.parse(ctx.store.read('project.json')).id;
  assert.notEqual(second, first);
  assert.equal(posts(fake, '/projects').length, 2);
  const third = await run('status', {});
  assert.equal(third.message, undefined);
  assert.equal(posts(fake, '/projects').length, 2, 'made once');
});

test('status notices an archived project and finds or makes the named one', async () => {
  const { run, fake, ctx } = setup();
  await run('status', {});
  fake.archiveProject(JSON.parse(ctx.store.read('project.json')).id);
  const other = fake.addProjectAlways('Connect');
  const again = await run('status', {});
  assert.equal(again.message, undefined, 'found, not made');
  assert.equal(JSON.parse(ctx.store.read('project.json')).id, other.id);
});

test('a create into a project deleted in Todoist finds the project again and is made there', async () => {
  const { run, fake, ctx } = setup();
  await run('status', {});
  fake.deleteProject(JSON.parse(ctx.store.read('project.json')).id);
  const made = await run('create', { key: 'k1', task: { text: 'After the delete', labels: [] }, requestId: 'r' });
  const pid = JSON.parse(ctx.store.read('project.json')).id;
  assert.equal(fake.task(made.id).project_id, pid);
  assert.equal(posts(fake, '/projects').length, 2);
});

test('a refused create in a living project keeps the project', async () => {
  const { run, fake } = setup();
  await run('status', {});
  fake.fail('POST /tasks', 400, { once: true });
  await assert.rejects(run('create', { key: 'k', task: { text: 'x' } }), (e) => /^refused:/.test(e.message));
  assert.equal(posts(fake, '/projects').length, 1);
});

test('duplicate project names: the first is used and none is made', async () => {
  const { run, fake, ctx } = setup();
  const a = fake.addProjectAlways('Connect');
  fake.addProjectAlways('Connect');
  await run('status', {});
  assert.equal(posts(fake, '/projects').length, 0);
  assert.equal(JSON.parse(ctx.store.read('project.json')).id, a.id);
});

test('complete succeeds when Todoist hides completed tasks from a read', async () => {
  const { run, fake } = setup({ todoist: { hideCompleted: true } });
  const t = await run('create', { key: 'k1', task: WAITING, requestId: 'r' });
  const done = await run('complete', { id: t.id, done: true });
  assert.equal(done.done, true);
  assert.equal(done.text, WAITING.text, 'a full task, not a partial one');
  assert.equal(done.key, 'k1');
  assert.equal(fake.task(t.id).checked, true);
  const open = await run('complete', { id: t.id, done: false });
  assert.equal(open.done, false);
  assert.equal(open.text, WAITING.text);
});

test('429 with retry_after only in the body', async () => {
  const { run, fake } = setup();
  await run('status', {});
  fake.fail('GET /tasks', 429, { once: true, body: { error: 'Too many requests', error_extra: { retry_after: 7 } } });
  await assert.rejects(run('list', {}), (e) => /^rate_limited:7:/.test(e.message));
  fake.fail('GET /tasks', 429, { once: true, retryAfter: 9 });
  const res = await fake.handler('https://api.todoist.com/api/v1/tasks', { headers: { Authorization: `Bearer ${SENTINEL}` } });
  assert.equal(res.headers['retry-after'], '9');
  assert.equal(JSON.parse(res.body).error_extra.retry_after, 9, 'the fake sends both, as Todoist may');
});

test('copying 50 tasks makes at most 50 creates plus a few lookups', async () => {
  const { run, fake } = setup({ todoist: { pageSize: 200 } });
  for (let n = 0; n < 300; n += 1) {
    await run('create', { key: `old${n}`, task: { text: `Old ${n}`, labels: [] }, requestId: `o${n}` });
  }
  const before = fake.requests.length;
  for (let n = 0; n < 50; n += 1) {
    await run('create', { key: `new${n}`, task: { text: `New ${n}`, labels: [] }, requestId: `n${n}` });
  }
  const used = fake.requests.length - before;
  assert.ok(used <= 50 + 3, `${used} requests for 50 creates`);
  assert.equal(fake.all().length, 350);
});

test('the key index learns from changedSince, so a task made elsewhere is adopted', async () => {
  const { run, fake } = setup();
  await run('create', { key: 'k0', task: { text: 'Warm the index', labels: [] }, requestId: 'r0' });
  const { cursor } = await run('changedSince', { cursor: null });
  // Made by another device with the same key, after the index was built.
  const other = await fake.handler('https://api.todoist.com/api/v1/tasks', {
    method: 'POST', headers: { Authorization: `Bearer ${SENTINEL}` },
    body: JSON.stringify({ content: 'Same', description: 'key: k9', project_id: fake.all()[0].project_id }),
  });
  await run('changedSince', { cursor });
  const again = await run('create', { key: 'k9', task: { text: 'Same', labels: [] }, requestId: 'r9' });
  assert.equal(again.adopted, true);
  assert.equal(again.id, JSON.parse(other.body).id);
});
