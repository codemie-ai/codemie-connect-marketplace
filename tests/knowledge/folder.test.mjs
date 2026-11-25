// Knowledge's folder, read (reply-voice design §8): the pure parsing only — parseFrontmatter,
// personOf, sectionsOf, parseRules, ruleId, styleOf, stripLinks, slug, walkable. No fake ctx is
// needed here: main.js's apply(ctx) is empty in this task (a later one wires the ops), so these
// are exercised directly over invented page text, never a real file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  parseFrontmatter,
  sectionsOf,
  personOf,
  parseRules,
  ruleId,
  styleOf,
  stripLinks,
  slug,
  walkable,
} from '../../plugins/knowledge/main.js';

const here = dirname(fileURLToPath(import.meta.url));
const manifestPath = join(here, '..', '..', 'plugins', 'knowledge', 'echo-plugin.json');

const SETTINGS = {
  profileSections: 'Writing to them, Anti-patterns (do not write), Communication Style, '
    + 'Communication Preferences, Example Exchange, Speech Acts, Shared Shorthand, Vocabulary Cues, Communication Notes',
  aboutSections: 'Overview, Snapshot, Roles And Background, Affiliations And Roles, Working Style, Priorities',
};

test('rules: one per heading, every scope and channel suffix, ids unique, comments left out, unknown headings skipped', () => {
  const text = [
    '## to: priya.n@example.test',
    'Short.',
    '## chat: Platform review',
    'Terse.',
    '## domain: bank.example.test · mail',
    'Formal.',
    '## no-profile · teams',
    '<!-- imported from skill "reply-style" on 2026-11-25 -->',
    'Polite.',
    '## to: priya.n@example.test',
    'Again',
    '## whatever',
    'x',
  ].join('\n');

  const rules = parseRules(text);

  assert.equal(rules.length, 5, 'the unknown "whatever" heading gives no rule');
  assert.deepEqual(
    rules.map((r) => r.applies.kind),
    ['to', 'chat', 'domain', 'no-profile', 'to'],
  );
  assert.deepEqual(rules[0].applies, { kind: 'to', value: 'priya.n@example.test' });
  assert.deepEqual(rules[1].applies, { kind: 'chat', value: 'Platform review' });
  assert.deepEqual(rules[2].applies, { kind: 'domain', value: 'bank.example.test', channel: 'mail' });
  assert.deepEqual(rules[3].applies, { kind: 'no-profile', channel: 'teams' });
  assert.equal(rules[2].text, 'Formal.');
  assert.equal(rules[3].text, 'Polite.', 'the HTML comment line is left out of the rule text');
  assert.equal(rules[4].text, 'Again');

  const ids = rules.map((r) => r.id);
  assert.equal(new Set(ids).size, 5, 'every id is unique');
  assert.equal(rules[0].id, 'to-priya-n-example-test');
  assert.equal(rules[4].id, 'to-priya-n-example-test-2', 'the repeated heading gets -2');
  assert.equal(rules[3].id, 'no-profile-teams');
});

test('ruleId: a slug of the heading, -2 and -3 when it is already taken', () => {
  const taken = new Set();
  const first = ruleId('to: priya.n@example.test', taken);
  taken.add(first);
  const second = ruleId('to: priya.n@example.test', taken);
  taken.add(second);
  const third = ruleId('to: priya.n@example.test', taken);
  assert.equal(first, 'to-priya-n-example-test');
  assert.equal(second, 'to-priya-n-example-test-2');
  assert.equal(third, 'to-priya-n-example-test-3');
});

test("a person page: name from frontmatter, else H1, else first alias, else slug; aliases and emails; ids from teamsIds and Voice/ids.json", () => {
  const withName = [
    '---',
    'id: alex-m',
    'name: Alex Morgan',
    'aliases:',
    '  - Alex',
    '  - A. Morgan',
    'emails: [alex.morgan@example.test]',
    'teamsIds: [29:alexTeamsId]',
    '---',
    '# Ignored Title',
    'Body text.',
  ].join('\n');
  const a = personOf('People/alex-m.md', withName, SETTINGS, { 'alex-m': ['29:fromIdsFile'] });
  assert.equal(a.name, 'Alex Morgan', 'frontmatter name wins over the H1');
  assert.deepEqual(a.names, ['Alex', 'A. Morgan', 'Ignored Title']);
  assert.deepEqual(a.addresses, ['alex.morgan@example.test']);
  assert.deepEqual(new Set(a.ids), new Set(['29:alexTeamsId', '29:fromIdsFile']), 'ids merge teamsIds and Voice/ids.json');
  assert.equal(a.source, 'People/alex-m.md');

  const noName = [
    '---',
    'id: priya-n',
    'aliases: [Priya]',
    'emails: [priya.n@example.test]',
    '---',
    '# Priya Nair',
    'Body.',
  ].join('\n');
  const b = personOf('People/priya-n.md', noName, SETTINGS, {});
  assert.equal(b.name, 'Priya Nair', 'no frontmatter name: the H1 is the name');
  assert.deepEqual(b.names, ['Priya', 'Priya Nair']);

  const aliasOnly = ['---', 'aliases: [Nika]', '---', 'Just body, no heading.'].join('\n');
  const c = personOf('People/nika.md', aliasOnly, SETTINGS, {});
  assert.equal(c.name, 'Nika', 'no name and no H1: the first alias');

  const neither = ['---', 'id:', '---', 'No heading, no aliases.'].join('\n');
  const d = personOf('People/olga-petrova.md', neither, SETTINGS, {});
  assert.equal(d.name, 'Olga Petrova', 'neither name, H1 nor alias: the slug in title case');
  assert.equal(d.id, 'olga-petrova');
});

test('the profile is the known sections in setting order, never the body; about is separate', () => {
  const text = [
    '---',
    'id: sam-lee',
    '---',
    '# Sam Lee',
    '## Overview',
    'Role: Engineer.',
    '## Projects',
    'Atlas rollout.',
    '## Communication Style',
    'Direct and short.',
    '## Anti-patterns (do not write)',
    'Never use emojis.',
  ].join('\n');
  const person = personOf('People/sam-lee.md', text, SETTINGS, {});

  assert.ok(person.text.startsWith('## Anti-patterns (do not write)'), person.text);
  assert.ok(
    person.text.indexOf('## Communication Style') > person.text.indexOf('Anti-patterns'),
    'Anti-patterns comes first in the setting, so it comes first in the text',
  );
  assert.ok(!person.text.includes('Projects'), 'an unlisted section never joins the profile');
  assert.ok(!person.about.includes('Projects'), 'nor the about');
  assert.ok(person.about.startsWith('## Overview'));
  assert.ok(person.about.includes('Role: Engineer.'));
});

test('a knowledge-base-shaped page works', () => {
  const text = [
    '# Kai Stone',
    '## Key facts',
    'Role: Lead.',
    '## Writing to them',
    'Keep it casual. See [[Projects/Atlas|the Atlas project]] for context.',
    '## Communication Notes',
    'Short replies.',
  ].join('\n');
  const person = personOf('people/kai-stone.md', text, SETTINGS, {});

  assert.equal(person.name, 'Kai Stone', 'no frontmatter at all: the H1 is the name');
  assert.deepEqual(person.names, ['Kai Stone']);
  assert.deepEqual(person.addresses, []);
  assert.deepEqual(person.ids, []);
  assert.ok(person.text.startsWith('## Writing to them'));
  assert.ok(person.text.includes('the Atlas project'), 'the [[link|label]] reads as its label');
  assert.ok(!person.text.includes('[['), 'never the raw link syntax');
  assert.ok(person.text.includes('## Communication Notes'));
  assert.ok(!person.text.includes('Key facts'), 'the facts block is not a configured section');
  assert.equal(person.about, '', 'none of the about sections are on the page');
});

test('a page with none of the profile sections has no profile text', () => {
  const text = ['# Jo Martins', '## Unrelated', 'Nothing here matches a known section.'].join('\n');
  const person = personOf('People/jo-martins.md', text, SETTINGS, {});
  assert.equal(person.text, '');
});

test('a page with broken frontmatter is skipped', () => {
  const text = ['---', 'id: broken', 'name Priya', '# Title (the frontmatter is never closed)'].join('\n');
  assert.equal(personOf('People/broken.md', text, SETTINGS, {}), null);
  assert.equal(parseFrontmatter(text).front, null);
});

// Review fix round 1: a bare digit-only scalar must never be coerced to a JS Number — a Teams id
// is an opaque string, and a Number round-trip silently corrupts one past Number.MAX_SAFE_INTEGER.
test('a Teams id longer than Number.MAX_SAFE_INTEGER is kept exact, never rounded', () => {
  const longId = '19999999999999999999'; // 20 digits: well past 2^53, would round as a float
  const text = ['---', 'id: dana-k', `teamsIds: [${longId}]`, '---', '# Dana K'].join('\n');
  const person = personOf('People/dana-k.md', text, SETTINGS, {});
  assert.deepEqual(person.ids, [longId]);
  assert.equal(typeof person.ids[0], 'string');
});

// Review fix round 1: ids/addresses must dedupe on their string form, not on the YAML scalar's
// own type — a numeric-looking id can arrive as a bare number from the frontmatter and as a
// string from Voice/ids.json, and the two must still collapse to one entry.
test('a numeric id duplicated between the front matter and Voice/ids.json dedupes to one', () => {
  const text = ['---', 'id: evan-r', 'teamsIds: [778899001122]', '---', '# Evan R'].join('\n');
  const person = personOf('People/evan-r.md', text, SETTINGS, { 'evan-r': ['778899001122'] });
  assert.deepEqual(person.ids, ['778899001122']);
});

// Review fix round 1 (minor): `cut`'s own comment promises "never mid-word"; a single matched
// about-section with no internal line break at all must still back off to a word boundary instead
// of hard-truncating at exactly 2,000 characters.
test('about backs off to the last space, never cutting a word in half, when the matched section has no internal line break', () => {
  const words = Array(400).fill('alphabet').join(' '); // one unbroken line, far over the 2,000 cap
  const text = ['---', 'id: wordy', '---', '# Wordy', '## Overview', words].join('\n');
  const person = personOf('People/wordy.md', text, SETTINGS, {});
  assert.ok(person.about.endsWith('…'));
  assert.ok(
    person.about.length > 1900,
    `should cut near the 2,000 limit, not fold back to the heading's own blank line: ${person.about.length}`,
  );
  const body = person.about.replace(/^## Overview\n\n/, '').slice(0, -1);
  for (const w of body.split(/\s+/).filter(Boolean)) {
    assert.equal(w, 'alphabet', `found a partial word: "${w}"`);
  }
});

// Review fix round 1 (minor): a broken (unclosed) Voice/style.md frontmatter must be treated as
// unreadable, the way personOf treats the same condition — never leaking the raw, un-parsed
// frontmatter text as if it were the style card's own text.
test('styleOf treats a broken Voice/style.md frontmatter as unreadable, never leaking its raw text', () => {
  const broken = ['---', 'basedOn: {mail: 12, teams: 140}', 'Keep replies short. (frontmatter never closes)'].join('\n');
  const result = styleOf(broken, null, null);
  assert.equal(result.text, '', 'the raw, unclosed frontmatter is never surfaced as the style card');
  assert.equal(result.basedOn, null);
  assert.equal(result.built, null);
  assert.equal(result.head, null);
});

test('style: frontmatter basedOn {mail, teams} and built; a bare basedOn number reads as null; the owner page sections become the head', () => {
  const style = [
    '---',
    'basedOn: {mail: 12, teams: 140}',
    'built: sha-abc123',
    '---',
    'Keep replies short.',
    '## Mail',
    'Mail style notes.',
    '## Teams',
    'Teams style notes.',
  ].join('\n');
  const owner = [
    '# Me',
    '## Communication Preferences',
    'Prefer bullet points.',
    '## Something Else',
    'Ignored.',
  ].join('\n');

  const withHead = styleOf(style, owner, 'People/me.md');
  assert.deepEqual(withHead.basedOn, { mail: 12, teams: 140 });
  assert.equal(withHead.built, 'sha-abc123');
  assert.ok(withHead.text.startsWith('Keep replies short.'));
  assert.ok(withHead.text.includes('## Mail'));
  assert.deepEqual(withHead.head, { text: '## Communication Preferences\n\nPrefer bullet points.', source: 'People/me.md' });
  assert.ok(!withHead.head.text.includes('Something Else'));

  const bareNumber = ['---', 'basedOn: 12', '---', 'Written by you.'].join('\n');
  const withoutOwner = styleOf(bareNumber, null, null);
  assert.equal(withoutOwner.basedOn, null, 'a bare number (an older shape) reads as null');
  assert.equal(withoutOwner.built, null);
  assert.equal(withoutOwner.head, null, 'no owner page: no head');
});

test('the walk skips .git, hidden folders and the Voice folder for reading notes', () => {
  assert.equal(walkable('.git/config'), false);
  assert.equal(walkable('.obsidian/app.json'), false);
  assert.equal(walkable('Voice/style.md'), false);
  assert.equal(walkable('voice/rules.md'), false, 'matched without regard to case, as People/people is');
  assert.equal(walkable('People/priya-n.md'), true);
  assert.equal(walkable('notes/atlas.md'), true);
});

test('sectionsOf keeps a sub-heading with its own section and drops text before the first "## "', () => {
  const text = ['# Title', 'Intro, not a section.', '## A', 'a1', '### A.1', 'a1.1', '## B', 'b1'].join('\n');
  const sections = sectionsOf(text);
  assert.deepEqual(sections.map((s) => s.heading), ['A', 'B']);
  assert.equal(sections[0].text, 'a1\n### A.1\na1.1');
});

test('stripLinks and slug', () => {
  assert.equal(stripLinks('See [[Projects/Atlas]] and [[Projects/Atlas|the Atlas project]].'), 'See Projects/Atlas and the Atlas project.');
  assert.equal(slug('Nair Priya (Contoso)'), 'nair-priya-contoso');
  assert.equal(slug('  Olga Petrova  '), 'olga-petrova');
});

test('the manifest provides reply-context, requires reply_context_provider, asks for no network, and has the five settings', () => {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.id, 'knowledge');
  assert.deepEqual(manifest.provides, ['reply-context']);
  assert.deepEqual(manifest.requires, ['reply_context_provider']);
  assert.equal(manifest.uses.network, undefined);
  assert.equal(manifest.uses.web, undefined);
  assert.equal(manifest.uses.signin, undefined);
  assert.equal(manifest.uses.deliver, undefined);
  assert.equal(manifest.uses.folders.write, true);
  const keys = manifest.settings.map((s) => s.key);
  assert.deepEqual(keys, ['peopleFolder', 'voiceFolder', 'ownerPage', 'profileSections', 'aboutSections']);
  assert.equal(manifest.settings.length, 5);
});
