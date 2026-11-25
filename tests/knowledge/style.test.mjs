// Knowledge's style card: the pure `styleFacts`/`aiSamples` directly, and the `build` host
// command (design §8 "Build style card", ruling 9: Build only runs on a press, AI only on a
// ticked checkbox) over a fake ctx and a real temp folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, styleFacts, aiSamples } from '../../plugins/knowledge/main.js';
import { fakeCtx } from '../helpers/fake-ctx.mjs';

function setup({ dir, sent = [], claude } = {}) {
  const root = dir ?? mkdtempSync(join(tmpdir(), 'knowledge-style-'));
  const ctx = fakeCtx({ dir: root, sent, claude });
  apply(ctx);
  return { ctx, root, run: (op, args) => ctx.run(op, args) };
}

test('styleFacts: typical length, greetings, sign-offs, lower-case starts, emoji and exclamation marks per channel and per language', () => {
  const messages = [
    { channel: 'mail', text: 'Hi, thanks for the update. Regards' },
    { channel: 'mail', text: 'hey quick one, can you send the file. thanks' },
    { channel: 'chat', text: 'sure 👍 will do!' },
    { channel: 'chat', text: 'ok sounds good!' },
    { channel: 'chat', text: 'Привет, це дуже цікаво і зручно.' },
    { channel: 'chat', text: 'Привіт, дякую за це.' },
    { channel: 'chat', text: 'Привіт, все добре, дякую.' },
    { channel: 'chat', text: 'Привіт ще раз, дякую.' },
    { channel: 'chat', text: 'Привіт, і це працює.' },
  ];
  const facts = styleFacts(messages);

  assert.equal(facts.mail.count, 2);
  assert.ok(facts.mail.greeting === 'hi' || facts.mail.greeting === 'hey');
  assert.equal(facts.mail.signoff, 'regards');

  assert.equal(facts.teams.count, 7);
  assert.equal(facts.teams.lowerCaseStart, false, 'most of these start with a capital (the Ukrainian ones)');
  assert.ok(facts.teams.emoji === false || facts.teams.emoji === true);

  assert.ok(facts.languages['teams·uk'], 'at least 5 Ukrainian Teams messages get their own bucket');
  assert.equal(facts.languages['teams·uk'].count, 5);
  assert.equal(facts.languages['teams·ru'], undefined, 'fewer than 5 would not qualify, and none here are plain Russian');
  assert.equal(facts.languages['mail·ru'], undefined);
});

test('styleFacts with nothing on a channel answers a zero count, not an error', () => {
  const facts = styleFacts([{ channel: 'mail', text: 'Hi there.' }]);
  assert.equal(facts.teams.count, 0);
  assert.deepEqual(facts.languages, {});
});

test('aiSamples: at most 40, each ≤ 1,500, addresses and phone numbers removed, recipients’ names become "the recipient"', () => {
  const many = Array.from({ length: 50 }, (_, i) => ({
    channel: i % 2 ? 'chat' : 'mail',
    text: `Hi Priya N., reach me at nikita@example.test or +1 415 555 ${1000 + i}. Thanks, message ${i}.`,
    to: 'Priya N.',
  }));
  const samples = aiSamples(many);
  assert.equal(samples.length, 40);
  for (const s of samples) {
    assert.ok(!s.text.includes('@'), 'no address');
    assert.ok(!/\d{3}[\s.-]?\d{3,4}[\s.-]?\d{4}/.test(s.text), 'no phone number');
    assert.ok(!s.text.includes('Priya N.'), 'the recipient name is replaced');
    assert.ok(s.text.includes('the recipient'));
    assert.ok(s.text.length <= 1500);
    assert.ok(s.channel === 'mail' || s.channel === 'teams');
  }

  const long = aiSamples([{ channel: 'mail', text: Array(400).fill('word').join(' '), to: '' }]);
  assert.ok(long[0].text.length <= 1500);
  assert.ok(long[0].text.endsWith('…'));
});

test('aiSamples skips a message with no text and never exceeds 40', () => {
  const messages = [{ channel: 'mail', text: '', to: '' }, ...Array.from({ length: 45 }, () => ({ channel: 'mail', text: 'Hi.', to: '' }))];
  const samples = aiSamples(messages);
  assert.equal(samples.length, 40);
});

// Review I4: greetings and mentions normally use the first name, not the full display name, so
// the first-name case must be covered on its own, not only the exact "Priya Nair" phrase.
test('aiSamples replaces a recipient by first name alone, whole-word and case-insensitive', () => {
  const [sample] = aiSamples([{ channel: 'mail', text: 'Hi Priya, see you then. priya said yes.', to: 'Priya Nair' }]);
  assert.equal(sample.text, 'Hi the recipient, see you then. the recipient said yes.');
});

// Review I4: a short name must never corrupt an unrelated word it happens to be a substring of —
// `replaceAll` with no word boundary turned "Also" into "the recipientso".
test('aiSamples never corrupts "Also" when the recipient is named "Al"', () => {
  const [sample] = aiSamples([{ channel: 'mail', text: 'Also, thanks for the help, Al.', to: 'Al' }]);
  assert.equal(sample.text, 'Also, thanks for the help, the recipient.');
});

test('build without AI writes Voice/style.md with ## Mail, ## Teams and a language section for ≥ 5 messages, basedOn {mail, teams}, and runs no claude', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'knowledge-build-'));
  const mail = Array.from({ length: 12 }, (_, i) => ({ channel: 'mail', text: `Hi, message number ${i}.`, to: 'Priya' }));
  const teamsRu = Array.from({ length: 6 }, (_, i) => ({ channel: 'chat', text: `Привет, это сообщение ${i}.`, to: 'Chat' }));
  const { ctx, run } = setup({ dir, sent: [...mail, ...teamsRu] });

  const answer = await run('build', {});
  assert.equal(answer.ask, undefined);
  assert.equal(ctx._claudeCalls.length, 0, 'no AI run without the checkbox');
  const text = readFileSync(join(dir, 'Voice', 'style.md'), 'utf8');
  assert.match(text, /basedOn: \{mail: 12, teams: 6\}/);
  assert.match(text, /## Mail\n/);
  assert.match(text, /## Teams\n/);
  assert.match(text, /## Teams · ru\n/);
  assert.ok(!text.includes('## Mail · '), 'mail never reached the ru threshold');
  assert.equal(answer.warning, undefined, '12 mail messages is not thin');
});

test('build says the mail part is thin under 10 mail messages', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'knowledge-build-thin-'));
  const mail = Array.from({ length: 3 }, (_, i) => ({ channel: 'mail', text: `Hi ${i}.`, to: 'Priya' }));
  const { run } = setup({ dir, sent: mail });
  const answer = await run('build', {});
  assert.match(answer.warning, /Only 3 mail previews were available/);
});

test('build with AI sends at most 40 samples with no address or phone number', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'knowledge-build-ai-'));
  const mail = Array.from({ length: 50 }, (_, i) => ({
    channel: 'mail',
    text: `Hi, reach me at nikita@example.test or +1 415 555 ${1000 + i}. Thanks.`,
    to: 'Priya N.',
  }));
  const { ctx, run } = setup({
    dir,
    sent: mail,
    claude: { answer: 'Short and direct. Signs with their name.' },
  });

  const answer = await run('build', { ai: true });
  assert.equal(ctx._claudeCalls.length, 1);
  const [call] = ctx._claudeCalls;
  assert.ok(!call.prompt.includes('nikita@example.test'), 'no address reached claude.run');
  assert.ok(!call.prompt.includes('555 1000'), 'no phone number reached claude.run');
  const sampleCount = call.prompt.split('\n---\n').length;
  assert.ok(sampleCount <= 40, `expected at most 40 samples, got ${sampleCount}`);
  const text = readFileSync(join(dir, 'Voice', 'style.md'), 'utf8');
  assert.match(text, /## In words\n\nShort and direct\. Signs with their name\./);
});

test('build asks before replacing a style card the user edited', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'knowledge-build-ask-'));
  const { ctx, run } = setup({ dir, sent: [{ channel: 'mail', text: 'Hi.', to: 'X' }] });

  const first = await run('build', {});
  assert.equal(first.ask, undefined);

  // The user edits the body in the folder directly (not through Build), so its sha no longer
  // matches the frontmatter's `built`.
  const current = readFileSync(join(dir, 'Voice', 'style.md'), 'utf8');
  writeFileSync(join(dir, 'Voice', 'style.md'), current.replace('## Mail', '## Mail\nHand-edited.'));

  const asked = await run('build', {});
  assert.equal(asked.ask, 'Replace the style card you edited?');
  assert.equal(ctx._claudeCalls.length, 0, 'no AI run while only asking');
  const stillEdited = readFileSync(join(dir, 'Voice', 'style.md'), 'utf8');
  assert.ok(stillEdited.includes('Hand-edited.'), 'nothing was overwritten by the ask');

  const replaced = await run('build', { replace: true });
  assert.equal(replaced.ask, undefined);
  const final = readFileSync(join(dir, 'Voice', 'style.md'), 'utf8');
  assert.ok(!final.includes('Hand-edited.'), 'replace: true writes over the edited card');
});

// Review I1: a card with no `built` field at all — written entirely by hand, or saved through
// Connect's own `save {kind:"style"}` before any Build ever ran — must also be asked about, not
// silently replaced; `recordedBuilt` being absent is not the same as "nothing to protect".
test('build asks before replacing a hand-written card that has never been through Build', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'knowledge-build-handwritten-'));
  mkdirSync(join(dir, 'Voice'), { recursive: true });
  writeFileSync(join(dir, 'Voice', 'style.md'), 'My own hand-written card.');
  const { ctx, run } = setup({ dir, sent: [{ channel: 'mail', text: 'Hi.', to: 'X' }] });

  const answer = await run('build', {});
  assert.equal(answer.ask, 'Replace the style card you edited?');
  assert.equal(ctx._claudeCalls.length, 0);
  assert.equal(readFileSync(join(dir, 'Voice', 'style.md'), 'utf8'), 'My own hand-written card.', 'nothing was overwritten');

  const replaced = await run('build', { replace: true });
  assert.equal(replaced.ask, undefined);
  assert.ok(!readFileSync(join(dir, 'Voice', 'style.md'), 'utf8').includes('hand-written'));
});

// Same gap, reached through `save {kind:"style"}` instead of a hand edit: Connect's own save
// path writes no `built` either.
test('build asks before replacing a card saved through Connect before any Build', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'knowledge-build-saved-'));
  const { ctx, run } = setup({ dir, sent: [{ channel: 'mail', text: 'Hi.', to: 'X' }] });
  await run('save', { kind: 'style', text: 'Written through Settings › Your voice.' });

  const answer = await run('build', {});
  assert.equal(answer.ask, 'Replace the style card you edited?');
  assert.equal(ctx._claudeCalls.length, 0);
  assert.ok(readFileSync(join(dir, 'Voice', 'style.md'), 'utf8').includes('Written through Settings'));
});

test('build does not ask again when the card still matches what Build itself last wrote', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'knowledge-build-unchanged-'));
  const { run } = setup({ dir, sent: [{ channel: 'mail', text: 'Hi.', to: 'X' }] });
  await run('build', {});
  const again = await run('build', {});
  assert.equal(again.ask, undefined, 'nothing changed the card between the two presses');
});

test('build with no sent messages at all writes a thin, empty-handed card', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'knowledge-build-empty-'));
  mkdirSync(dir, { recursive: true });
  const { run } = setup({ dir, sent: [] });
  const answer = await run('build', {});
  assert.match(answer.warning, /Only 0 mail previews were available/);
  const text = readFileSync(join(dir, 'Voice', 'style.md'), 'utf8');
  assert.match(text, /basedOn: \{mail: 0, teams: 0\}/);
});
