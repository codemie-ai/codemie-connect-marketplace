// Knowledge's facts search (reply-voice design §10): the pure `scorePage`/`snippetOf` directly,
// and the `facts` op end to end over a real temp folder through a fake ctx. No network, no AI —
// facts are deterministic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, scorePage, snippetOf } from '../../plugins/knowledge/main.js';
import { fakeCtx } from '../helpers/fake-ctx.mjs';

function write(root, rel, text) {
  const abs = join(root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, text);
}

function setup(dir) {
  const ctx = fakeCtx({ dir });
  apply(ctx);
  return { ctx, run: (op, args) => ctx.run(op, args) };
}

test('scorePage: the H1/alias, a heading or frontmatter, and the body score 5, 3 and 1; a page with no term scores null', () => {
  const page = {
    path: 'projects/atlas-rollout.md',
    text: [
      '---',
      'tags: [budget]',
      '---',
      '# Atlas rollout',
      '## Status',
      'On track for EPM-1234.',
    ].join('\n'),
  };
  const top = scorePage(page, ['Atlas rollout']);
  assert.equal(top.score, 5);
  assert.equal(top.distinct, 1);

  const mid = scorePage(page, ['Status']);
  assert.equal(mid.score, 3);

  const body = scorePage(page, ['EPM-1234']);
  assert.equal(body.score, 1);

  const tag = scorePage(page, ['budget']);
  assert.equal(tag.score, 3, 'a frontmatter value scores like a heading');

  assert.equal(scorePage(page, ['nothing-here']), null);
  assert.equal(scorePage({ path: 'x.md', text: '---\nname Priya\n# Broken' }, ['Atlas']), null, 'unreadable page');
});

test('scorePage: a term counts once per page even when it appears in several places', () => {
  const page = { path: 'p.md', text: '# Budget\nBudget notes about the budget.' };
  const result = scorePage(page, ['Budget']);
  assert.equal(result.distinct, 1);
  assert.equal(result.score, 5, 'the best location (the H1) is the one that counts, not every hit added up');
});

test('scorePage: whole words only, case- and diacritic-folded', () => {
  const page = { path: 'p.md', text: '# Notes\nThis is budgetary planning.' };
  assert.equal(scorePage(page, ['budget']), null, '"budget" never matches inside "budgetary"');
  const accented = { path: 'p.md', text: '# Nôtes\nSee PRIYA for details.' };
  assert.equal(scorePage(accented, ['notes']).score, 5);
  assert.equal(scorePage(accented, ['priya']).score, 1);
});

test('snippetOf: the H1 as title, lines holding a term with their nearest heading, frontmatter and links stripped, cut to 500', () => {
  const page = {
    path: 'projects/atlas-rollout.md',
    text: [
      '---',
      'owner: me',
      '---',
      '# Atlas rollout',
      'Intro text, no term here.',
      '## Status',
      'On track for EPM-1234, see [[Projects/Atlas|the plan]].',
      '## Unrelated',
      'Nothing to do with it.',
    ].join('\n'),
  };
  const snip = snippetOf(page, ['EPM-1234']);
  assert.equal(snip.title, 'Atlas rollout');
  assert.ok(snip.text.includes('## Status'));
  assert.ok(snip.text.includes('EPM-1234'));
  assert.ok(snip.text.includes('the plan'), '[[link|label]] reads as its label');
  assert.ok(!snip.text.includes('[['));
  assert.ok(!snip.text.includes('owner: me'), 'frontmatter is never part of the snippet');
  assert.ok(!snip.text.includes('Unrelated'), 'a section with no matching line is left out');

  const noH1 = snippetOf({ path: 'notes/weekly-sync.md', text: 'Just a note about EPM-1234.' }, ['EPM-1234']);
  assert.equal(noH1.title, 'Weekly Sync', 'no H1: the slugged file name, title-cased');

  const long = snippetOf({ path: 'p.md', text: `# T\n${'word '.repeat(200)}EPM-1234` }, ['EPM-1234']);
  assert.ok(long.text.length <= 500);
  assert.ok(long.text.endsWith('…'));
});

test('facts ranks pages by the §10 scores and answers at most 5 snippets of ≤ 500 with page ids and titles', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'knowledge-facts-rank-'));
  write(dir, 'projects/atlas-rollout.md', '# Atlas rollout\nTracking EPM-1234 this sprint.');
  write(dir, 'finances/budget-2026.md', '# Budget 2026\nSee EPM-1234 for the allocation.');
  write(dir, 'meetings/2026-11-20-sync.md', '# Weekly sync\nNo mention of the ticket.');
  const { run } = setup(dir);

  const answer = await run('facts', { terms: ['EPM-1234', 'Atlas Rollout'], personId: null });
  assert.ok(answer.facts.length >= 2);
  assert.equal(answer.facts[0].id, 'projects/atlas-rollout.md', 'the H1 match ranks first');
  assert.equal(answer.facts[0].title, 'Atlas rollout');
  for (const f of answer.facts) {
    assert.ok(f.text.length <= 500);
    assert.ok(f.id);
    assert.ok(f.title);
  }
  assert.ok(!answer.facts.some((f) => f.id.includes('meetings')), 'the unrelated page never matches');
});

test('facts leaves out the Voice folder, .git, the page of personId, files over 200 KB and answers [] when nothing matches', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'knowledge-facts-exclude-'));
  write(dir, 'Voice/style.md', '# Atlas\nAtlas notes that would otherwise match.');
  write(dir, '.git/atlas.md', '# Atlas\nShould never be read.');
  write(dir, 'People/priya-n.md', '---\nid: priya-n\n---\n# Priya N.\nAtlas is her project.');
  write(dir, 'notes/huge.md', `# Atlas\n${'x'.repeat(210 * 1024)}`);
  write(dir, 'notes/kept.md', '# Atlas rollout\nThe real match.');
  const { run } = setup(dir);

  const answer = await run('facts', { terms: ['Atlas'], personId: 'priya-n' });
  const ids = answer.facts.map((f) => f.id);
  assert.ok(!ids.some((id) => id.startsWith('Voice/')), 'the Voice folder is excluded');
  assert.ok(!ids.some((id) => id.startsWith('.git')), '.git is never read');
  assert.ok(!ids.includes('People/priya-n.md'), "the draft's own person page is excluded");
  assert.ok(!ids.includes('notes/huge.md'), 'a file over 200 KB is excluded');
  assert.ok(ids.includes('notes/kept.md'));

  const empty = await run('facts', { terms: ['Nonexistent Term Xyz'], personId: null });
  assert.deepEqual(empty, { facts: [] });
});

test('no term given asks nothing (no facts ask with no terms)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'knowledge-facts-noterm-'));
  write(dir, 'notes/a.md', '# A\nSomething.');
  const { run } = setup(dir);
  assert.deepEqual(await run('facts', { terms: [], personId: null }), { facts: [] });
});

test('facts stops at 2.5 s and answers what it has', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'knowledge-facts-budget-'));
  for (let i = 0; i < 4; i += 1) {
    write(dir, `notes/page-${i}.md`, `# Page ${i}\nAtlas rollout notes here.`);
  }
  const { run } = setup(dir);

  const base = 1_700_000_000_000;
  const sequence = [base, base + 500, base + 1000, base + 1500, base + 3000, base + 3500];
  let i = 0;
  const realNow = Date.now;
  Date.now = () => sequence[Math.min(i++, sequence.length - 1)];
  try {
    const answer = await run('facts', { terms: ['Atlas'], personId: null });
    assert.equal(answer.facts.length, 3, 'the budget stopped the scan after the third page');
  } finally {
    Date.now = realNow;
  }
});
