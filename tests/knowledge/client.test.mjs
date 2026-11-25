// Knowledge's page logic (review C1, Minor "client.js has no tests"): the state transitions
// `client.js` exports take a plain `{call(name, args)}` and a mutable state object, no DOM at
// all, so they're tested directly here instead of through a browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  initialState, loadSummary, choose, pressBuild, confirmReplace, cancelReplace, setAskAi, addPerson, skippedLine,
} from '../../plugins/knowledge/client.js';

// A minimal `ctx` stand-in: records every `call(name, args)` and answers from `answers[name]`
// (a fixed value, an array of values taken one per call, or a function of the args).
function fakeCtx(answers = {}) {
  const calls = [];
  const counters = {};
  return {
    calls,
    call: async (name, args) => {
      calls.push({ name, args });
      const a = answers[name];
      if (Array.isArray(a)) {
        const i = counters[name] ?? 0;
        counters[name] = i + 1;
        const v = a[Math.min(i, a.length - 1)];
        if (v instanceof Error) throw v;
        return v;
      }
      if (typeof a === 'function') return a(args);
      if (a instanceof Error) throw a;
      return a ?? {};
    },
  };
}

test('pressBuild: a plain write shows the warning and the fresh summary, with exactly one build call', async () => {
  const ctx = fakeCtx({
    build: { warning: 'Only 3 mail previews were available, so the mail part is thin: previews cut greetings and sign-offs.' },
    summary: { folder: '/vault', people: 1, peopleWithProfile: 1, rules: 2, style: true, buildWithAi: false },
  });
  const state = initialState();
  await pressBuild(ctx, state);

  assert.equal(state.pendingAsk, null);
  assert.ok(state.notice.includes('Only 3 mail previews'));
  assert.equal(ctx.calls.filter((c) => c.name === 'build').length, 1);
  assert.deepEqual(ctx.calls[0].args, { ai: false });
  assert.equal(state.summary.people, 1, 'the summary is refreshed after a successful build');
});

// Review C1: the regression itself. The page must never answer its own "Replace…?" question.
test('pressBuild never auto-confirms the replace question: it shows it and makes no second call', async () => {
  const ctx = fakeCtx({ build: { ask: 'Replace the style card you edited?' } });
  const state = initialState();
  await pressBuild(ctx, state);

  assert.equal(state.pendingAsk, 'Replace the style card you edited?');
  assert.equal(state.notice, '', 'no "Style card written." notice until the user actually decides');
  assert.equal(ctx.calls.filter((c) => c.name === 'build').length, 1, 'exactly one build call — the page never confirms on its own');
});

test('confirmReplace is the only path that sends replace: true, and only after the user presses it', async () => {
  const ctx = fakeCtx({
    build: [{ ask: 'Replace the style card you edited?' }, { warning: undefined }],
    summary: { folder: '/vault', people: 0, peopleWithProfile: 0, rules: 0, style: true, buildWithAi: false },
  });
  const state = initialState();
  await pressBuild(ctx, state);
  assert.equal(state.pendingAsk, 'Replace the style card you edited?');

  await confirmReplace(ctx, state);
  assert.equal(state.pendingAsk, null);
  assert.equal(state.notice, 'Style card written.');
  const builds = ctx.calls.filter((c) => c.name === 'build');
  assert.equal(builds.length, 2);
  assert.deepEqual(builds[0].args, { ai: false });
  assert.deepEqual(builds[1].args, { ai: false, replace: true });
});

test('cancelReplace keeps the card and makes no build call at all', async () => {
  const ctx = fakeCtx({ build: { ask: 'Replace the style card you edited?' } });
  const state = initialState();
  await pressBuild(ctx, state);
  const callsBefore = ctx.calls.length;

  cancelReplace(state);
  assert.equal(state.pendingAsk, null);
  assert.equal(state.notice, 'Kept your style card.');
  assert.equal(ctx.calls.length, callsBefore, 'Cancel makes no call at all');
});

test('a failed build shows the error and never sets pendingAsk', async () => {
  const ctx = fakeCtx({ build: new Error('needs_setup: Choose your knowledge folder in Knowledge.') });
  const state = initialState();
  await pressBuild(ctx, state);
  assert.equal(state.pendingAsk, null);
  assert.match(state.error, /needs_setup:/);
});

test('loadSummary reads the remembered "Ask AI" checkbox from summary.buildWithAi', async () => {
  const ctx = fakeCtx({ summary: { folder: '/vault', people: 0, peopleWithProfile: 0, rules: 0, style: false, buildWithAi: true } });
  const state = initialState();
  assert.equal(state.askAi, false);
  await loadSummary(ctx, state);
  assert.equal(state.askAi, true);
});

// Spec gap from the review: "Ask AI … (off until ticked, remembered)".
test('setAskAi persists through the host command and updates state immediately', async () => {
  const ctx = fakeCtx({ setAskAi: {}, summary: { folder: null, people: 0, peopleWithProfile: 0, rules: 0, style: false, buildWithAi: false } });
  const state = initialState();
  await setAskAi(ctx, state, true);
  assert.equal(state.askAi, true);
  assert.deepEqual(ctx.calls.find((c) => c.name === 'setAskAi').args, { value: true });
});

test('choose sets a notice on a folder and refreshes the summary; a cancel sets no notice', async () => {
  const ctx = fakeCtx({
    pickFolder: [{ folder: '/vault' }, { folder: null }],
    summary: { folder: '/vault', people: 0, peopleWithProfile: 0, rules: 0, style: false, buildWithAi: false },
  });
  const state = initialState();
  await choose(ctx, state);
  assert.equal(state.notice, 'Folder chosen.');

  state.notice = '';
  await choose(ctx, state);
  assert.equal(state.notice, '', 'a cancelled pick sets no notice');
});

test('addPerson writes the stub and refreshes the summary', async () => {
  const ctx = fakeCtx({
    newPerson: { id: 'jordan-lee', name: 'Jordan Lee', address: 'jordan@example.test', source: 'People/jordan-lee.md' },
    summary: { folder: '/vault', people: 1, peopleWithProfile: 0, rules: 0, style: false, buildWithAi: false },
  });
  const state = initialState();
  await addPerson(ctx, state, 'Jordan Lee', 'jordan@example.test');
  assert.equal(state.notice, 'Added a page for Jordan Lee.');
  assert.equal(state.summary.people, 1);
  assert.deepEqual(ctx.calls[0], { name: 'newPerson', args: { name: 'Jordan Lee', address: 'jordan@example.test' } });
});

// Final review I2: Knowledge's page says which pages it skipped, by name.
test('skippedLine names the pages the reader could not read, or nothing when there are none', () => {
  assert.equal(skippedLine({ unreadable: [] }), '');
  assert.equal(skippedLine({}), '');
  assert.equal(skippedLine({ unreadable: ['People/broken.md'] }), "Skipped 1 page it couldn't read: People/broken.md");
  assert.equal(
    skippedLine({ unreadable: ['People/a.md', 'People/b.md'] }),
    "Skipped 2 pages it couldn't read: People/a.md, People/b.md",
  );
});
