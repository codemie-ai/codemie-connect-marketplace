// Knowledge: Connect's `reply-context` provider for a folder of plain Markdown (design
// `docs/superpowers/specs/2026-11-25-reply-voice-design.md` §8, rulings 16, 17, 25, 26, 39). The
// folder can be the user's existing knowledge base, so reading is deliberately loose: a page is a
// person however little its frontmatter says; ordinary YAML another tool writes is read for the
// fields Knowledge needs and the rest is skipped; a page's writing-profile is never its whole
// body, only the named sections the user configured, best first; a page with no frontmatter
// block at all is still readable (an empty frontmatter). Only a frontmatter block that opens and
// never closes makes a page unreadable: it is skipped rather than guessed at, and counted.
//
// Each section keeps its pure functions (text already read in, plain data out: the frontmatter
// reader, people, rules, the style card, facts scoring, the style facts) next to the host code
// that uses them. The host half ends in `apply(ctx)`: it reads the granted folder through
// `ctx.fs`, registers the six ops with `ctx.replyContext.provide({...})` and Knowledge's own page
// commands, and writes only in the Voice folder (and a new person page), each write guarded by
// `ifSha` or `createNew`.

// ------------------------------------------------------------------------------------------------
// A small, deterministic, lenient YAML-frontmatter reader: enough for a person page's `id`,
// `name`, `aliases`, `emails`, `email`, `teamsIds`, `updated_at`, `updated`, and a style card's
// `basedOn` and `built`. The folder can be a knowledge base another tool writes, so it reads the
// ordinary YAML such tools use (nested maps, lists of maps, `>` and `|` block scalars, hyphenated
// keys, quoted commas in an inline list) and skips any line it doesn't understand instead of
// giving up on the page. Never a full YAML parser: no anchors, tags or multi-document streams.

const FENCE = /^---\s*$/;
// Key words joined by single spaces, so the key never overlaps the `\s*:` after it (linear).
const KEY_LINE = /^("[^"]*"|'[^']*'|[A-Za-z_][\w.-]*(?: [\w.-]+)*)\s*:(?:\s+(.*)|$)/;
const KEY_TIGHT = /^([A-Za-z_][\w.-]*):(\S.*)$/;
const BLOCK_SCALAR = /^([|>])([+-]?)\d*([+-]?)\s*(?:#.*)?$/;
const LIST_ITEM = /^-(?:\s|$)/;
// A frontmatter nested deeper than this, or with a line longer than this, makes the page
// unreadable: hostile input must never overflow the stack or take long.
const MAX_DEPTH = 16;
const MAX_LINE = 4000;

function tooDeep(depth) {
  if (depth > MAX_DEPTH) throw new Error('frontmatter nested too deep');
}

function indentOf(line) {
  const at = line.search(/\S/);
  return at < 0 ? Infinity : at;
}

// Lines shifted left by their smallest indent (blank lines kept, as blank).
function dedent(lines) {
  const min = Math.min(...lines.map(indentOf));
  if (!Number.isFinite(min)) return lines.map(() => '');
  return lines.map((l) => (l.trim() === '' ? '' : l.slice(min)));
}

// A quoted scalar's inside, with any trailing ` # comment` after the closing quote dropped; an
// unquoted one with its trailing comment dropped.
function unquote(raw) {
  const t = raw.trim();
  const q = t[0];
  if (q === '"' || q === "'") {
    const close = t.indexOf(q, 1);
    if (close > 0 && /^\s*(?:#.*)?$/.test(t.slice(close + 1))) return t.slice(1, close);
  }
  return withoutComment(t);
}

// `t` without a trailing ` # comment` (a `#` after whitespace), in one linear scan.
function withoutComment(t) {
  for (let i = 1; i < t.length; i += 1) {
    if (t[i] === '#' && /\s/.test(t[i - 1])) return t.slice(0, i).trimEnd();
  }
  return t;
}

// A bare scalar: null/blank, a bool, else the (unquoted) string as written — deliberately never a
// JS `Number`, even for digit-only text: an id (a Teams id, a frontmatter `id`) is opaque text,
// and a `Number` round-trip silently rounds anything past `Number.MAX_SAFE_INTEGER` (review fix
// round 1). `basedOn`'s counts are the one place a number is wanted, and `styleOf` converts them
// itself with `Number(...)`.
function scalarOf(raw) {
  const t = raw.trim();
  if (t === '' || t === '~' || t.toLowerCase() === 'null') return null;
  if (t === 'true') return true;
  if (t === 'false') return false;
  return unquote(t);
}

// `inner` split on the commas that sit outside quotes and brackets: `"Nair, Priya", Priya N`
// is two items, not three. A quote opens only at an item's (or a map value's) start, so
// `O'Brien` stays one word.
function splitFlow(inner) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let cur = '';
  for (const ch of inner) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if ((ch === '"' || ch === "'") && /^$|:$/.test(cur.trimEnd())) quote = ch;
    else if (ch === '[' || ch === '{') depth += 1;
    else if (ch === ']' || ch === '}') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  parts.push(cur);
  return parts.filter((p) => p.trim() !== '');
}

// One value written on a line: `[a, b]`, `{a: 1}` (nested either way), else a scalar. A pair of
// an inline map with no `:` is skipped, not fatal.
function valueOf(raw, depth = 0) {
  tooDeep(depth);
  const t = raw.trim();
  if (t.startsWith('[') && t.endsWith(']')) return splitFlow(t.slice(1, -1)).map((v) => valueOf(v, depth + 1));
  if (t.startsWith('{') && t.endsWith('}')) {
    const out = {};
    for (const pair of splitFlow(t.slice(1, -1))) {
      const m = KEY_LINE.exec(pair.trim()) ?? KEY_TIGHT.exec(pair.trim());
      if (!m) continue;
      setKey(out, unquote(m[1]), valueOf(m[2] ?? '', depth + 1));
    }
    return out;
  }
  return scalarOf(t);
}

function setKey(out, key, value) {
  if (key === '__proto__' || key === 'constructor' || key === 'prototype') return;
  out[key] = value;
}

// A `|` or `>` block scalar from its (dedented) lines: `|` keeps the line breaks, `>` folds
// lines into one with spaces (a blank line stays a break); `-` strips the final break, else it
// ends with exactly one (trailing blank lines are already gone, so `+` reads like the default).
function blockScalarOf(style, chomp, all) {
  const start = all.findIndex((l) => l !== '');
  const lines = start < 0 ? [] : all.slice(start);
  let text;
  if (style === '|') {
    text = lines.join('\n');
  } else {
    text = '';
    for (const line of lines) {
      if (line === '') text += '\n';
      else text += text === '' || text.endsWith('\n') ? line : ` ${line}`;
    }
  }
  const body = text.replace(/\n+$/, '');
  if (chomp === '-') return body;
  return body ? `${body}\n` : '';
}

// A key's value from what follows its colon (`rest`) and its indented child lines.
function blockValueOf(rest, children, depth) {
  tooDeep(depth);
  while (children.length && children[children.length - 1].trim() === '') children.pop();
  const kids = dedent(children);
  const block = BLOCK_SCALAR.exec(rest);
  if (block) return blockScalarOf(block[1], block[2] || block[3], kids);
  if (rest.trim() !== '' && !rest.trim().startsWith('#')) {
    // A flow list or a plain scalar that wraps onto indented lines.
    return valueOf([rest, ...kids.map((l) => l.trim())].filter(Boolean).join(' '), depth);
  }
  const first = kids.find((l) => l.trim() !== '' && !l.trimStart().startsWith('#'));
  if (first === undefined) return null;
  return LIST_ITEM.test(first) ? listOf(kids, depth + 1) : mapOf(kids, depth + 1);
}

// A block list's (dedented) lines: each `- ` item with the more-indented lines after it. An item
// that starts with `key:` is a map (a list of maps); a bare `-` takes its block below.
function listOf(lines, depth) {
  tooDeep(depth);
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!LIST_ITEM.test(line)) {
      i += 1;
      continue;
    }
    const after = line.slice(1);
    const pad = 1 + (after.length - after.trimStart().length);
    const first = line.slice(pad);
    const cont = [];
    let j = i + 1;
    while (j < lines.length && (lines[j].trim() === '' || indentOf(lines[j]) > 0)) {
      cont.push(lines[j]);
      j += 1;
    }
    if (first.trim() === '' || first.trimStart().startsWith('#')) {
      out.push(blockValueOf('', cont, depth + 1));
    } else if (!/^["'[{]/.test(first) && KEY_LINE.test(first)) {
      out.push(mapOf(dedent([`${' '.repeat(pad)}${first}`, ...cont]), depth + 1));
    } else {
      out.push(blockValueOf(first, cont, depth + 1));
    }
    i = j;
  }
  return out;
}

// A block map's (dedented) lines -> an object. A line at the map's own indent that isn't
// `key: value` is skipped with its children; nothing here makes the whole page unreadable.
function mapOf(lines, depth = 0) {
  tooDeep(depth);
  const out = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '' || line.trimStart().startsWith('#') || indentOf(line) > 0) {
      i += 1;
      continue;
    }
    const m = KEY_LINE.exec(line) ?? KEY_TIGHT.exec(line);
    const rest = m ? (m[2] ?? '') : '';
    // The key's children: the more-indented lines after it, and — for a key with nothing after
    // its colon — a `- ` list written at the key's own indent.
    const sameIndentList = m && rest.trim() === '';
    const children = [];
    let j = i + 1;
    while (j < lines.length) {
      const next = lines[j];
      if (next.trim() === '' || indentOf(next) > 0 || (sameIndentList && LIST_ITEM.test(next))) {
        children.push(next);
        j += 1;
      } else {
        break;
      }
    }
    if (m) setKey(out, unquote(m[1]), blockValueOf(rest, children, depth + 1));
    i = j;
  }
  return out;
}

// `text` -> `{front, body}`. No opening `---` line at all: an empty, valid frontmatter (a plain
// knowledge-base page is still readable). Only an opening `---` with no closing one, a line over
// MAX_LINE or nesting past MAX_DEPTH makes `front` `null` — unreadable, the caller skips (and counts) the page; YAML lines the reader
// doesn't understand are skipped, never fatal.
export function parseFrontmatter(text) {
  const src = String(text ?? '');
  const lines = src.split(/\r\n|\n/);
  if (!FENCE.test(lines[0] ?? '')) {
    return { front: {}, body: src };
  }
  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (FENCE.test(lines[i])) {
      end = i;
      break;
    }
  }
  if (end < 0) return { front: null, body: src };
  const block = lines.slice(1, end);
  if (block.some((l) => l.length > MAX_LINE)) return { front: null, body: src };
  let front;
  try {
    front = mapOf(dedent(block));
  } catch {
    // Nested past MAX_DEPTH (or anything else the reader can't survive): unreadable, never fatal.
    return { front: null, body: src };
  }
  return { front, body: lines.slice(end + 1).join('\n') };
}

// ------------------------------------------------------------------------------------------------
// Markdown helpers shared by people, the style card and the rules.

// The page's `## ` sections, in document order, each with its heading text and the lines under it
// up to the next `## ` (so a `### ` sub-heading stays inside its section's text); anything before
// the first `## ` (the H1, an intro paragraph) belongs to no section and is dropped here — the
// "about" and "profile" are never the whole page (ruling 25).
export function sectionsOf(text) {
  const lines = String(text ?? '').split(/\r\n|\n/);
  const sections = [];
  let current = null;
  for (const line of lines) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) {
      if (current) sections.push(current);
      current = { heading: h[1].trim(), lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) sections.push(current);
  return sections.map((s) => ({ heading: s.heading, text: s.lines.join('\n').trim() }));
}

const H1_RE = /^#\s+(.+?)\s*$/m;

function h1Of(body) {
  const m = H1_RE.exec(body);
  return m ? m[1].trim() : null;
}

// The index of the line `h1Of` reads the title from (`-1` when there is none).
function h1LineOf(text) {
  const m = H1_RE.exec(text);
  return m ? text.slice(0, m.index).split('\n').length - 1 : -1;
}

// `[[Page]]` -> "Page"; `[[Page|label]]` -> "label": a link reads as text, never as Markdown.
export function stripLinks(text) {
  return String(text ?? '').replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, page, label) => (label ?? page).trim());
}

// A filesystem- and id-friendly slug: lower case, diacritics folded off, anything that isn't a
// letter or digit becomes one hyphen, no leading or trailing hyphen. Shared by a person's
// fallback id, a rule's id and a page's fallback name (title-cased back).
export function slug(name) {
  return String(name ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function titleCaseOf(slugged) {
  return slugged
    .split('-')
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

function baseNameOf(path) {
  const file = String(path ?? '').split('/').pop() ?? '';
  return file.replace(/\.[^./]+$/, '');
}

function foldHeading(h) {
  return String(h ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// A part cut from its end at a line break, with "…", never mid-word — the same rule Connect's own
// budget cuts use (design §4), applied here only where §8 names a limit of its own (a person's
// `about`, ≤ 2,000). Cuts at whichever of the last line break or the last space is closer to the
// limit: a single matched section with no internal line break at all (review fix round 1) still
// backs off to its last word boundary, instead of a line break found so early (a heading's own
// blank line, say) that backing off to it would throw away nearly the whole cut part. Only a
// single unbroken run with no space and no line break at all falls back to a hard cut.
function cut(text, limit) {
  if (text.length <= limit) return text;
  const slice = text.slice(0, limit);
  const at = Math.max(slice.lastIndexOf('\n'), slice.lastIndexOf(' '));
  const base = (at > 0 ? slice.slice(0, at) : slice).trimEnd();
  return `${base}…`;
}

// The sections named in `names` (a page's settings string, comma-separated), in that order, each
// matched without regard to case or spacing; a page can have the same heading only once per slot
// (the first one found wins). Links read as text; the result is each matched section's own
// heading and text, in the settings' order — never the page's own order, never its other
// sections.
function sectionsNamed(sections, namesSetting) {
  const names = String(namesSetting ?? '')
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean);
  if (!names.length) return [];
  const bySection = new Map();
  for (const s of sections) {
    const key = foldHeading(s.heading);
    if (!bySection.has(key)) bySection.set(key, s);
  }
  return names
    .map((n) => bySection.get(foldHeading(n)))
    .filter(Boolean)
    .map((s) => ({ heading: s.heading, text: stripLinks(s.text) }));
}

function joinSections(picked) {
  return picked.map((s) => `## ${s.heading}\n\n${s.text}`).join('\n\n').trim();
}

// ------------------------------------------------------------------------------------------------
// People (design §8 "Reading a person page").

/**
 * `personOf(path, text, settings, ids)`: `path` is the page's path relative to the folder (its
 * `source`, and — by its file name, slugged — the key `Voice/ids.json` uses for it); `text` is
 * the whole file as read; `settings` is the plugin's settings object (`profileSections`,
 * `aboutSections` as their comma-separated strings); `ids` is the parsed `Voice/ids.json` object
 * (or `{}`/`null` when there is none). `null` when the page's frontmatter doesn't parse.
 */
// A frontmatter field's scalar, or `null` when it is a map or a list (another tool's richer shape
// for a field Knowledge reads as plain text).
function plainOf(v) {
  return v !== null && typeof v === 'object' ? null : v;
}

// A field written as one scalar or a list, as its non-blank scalars (maps inside it left out).
function plainsOf(v, { single = true } = {}) {
  const list = Array.isArray(v) ? v : (single && v !== null && v !== undefined ? [v] : []);
  return list
    .map(plainOf)
    .filter((a) => a !== null && a !== undefined && String(a).trim() !== '');
}

export function personOf(path, text, settings = {}, ids = {}) {
  const { front, body } = parseFrontmatter(text);
  if (front === null) return null;

  const h1 = h1Of(body);
  const aliases = plainsOf(front.aliases, { single: false }).map(String);
  const fileSlug = slug(baseNameOf(path));

  const frontName = plainOf(front.name);
  const name = (frontName && String(frontName).trim())
    || h1
    || aliases[0]
    || titleCaseOf(fileSlug);

  const names = [...new Set([...aliases, h1].filter((n) => n && String(n).trim() !== ''))];

  // Dedup on the *string* form, not the YAML scalar's own type (review fix round 1): a numeric-
  // looking id can arrive as a bare number from one source and a string from another (`Voice/
  // ids.json` is always JSON strings), and `Set` treats `123` and `"123"` as distinct unless the
  // values are normalized first.
  const addresses = [...new Set(
    [...plainsOf(front.emails), ...plainsOf(front.email)].map(String),
  )].slice(0, 10);

  const teamsIds = plainsOf(front.teamsIds, { single: false });
  const fromIdsFile = ids && Array.isArray(ids[fileSlug]) ? ids[fileSlug] : [];
  const personIds = [...new Set(
    [...teamsIds, ...fromIdsFile]
      .filter((i) => i !== null && i !== undefined && String(i).trim() !== '')
      .map(String),
  )].slice(0, 10);

  const sections = sectionsOf(body);
  const profileText = joinSections(sectionsNamed(sections, settings.profileSections));
  const aboutText = cut(joinSections(sectionsNamed(sections, settings.aboutSections)), 2000);

  return {
    id: (plainOf(front.id) && String(front.id).trim()) || slug(name) || fileSlug,
    name,
    names,
    addresses,
    ids: personIds,
    text: profileText,
    about: aboutText,
    updatedAt: plainOf(front.updated_at ?? front.updated ?? null),
    source: path,
  };
}

// ------------------------------------------------------------------------------------------------
// Instructions (design §8 "Reading the rules").

const SCOPED_KINDS = ['to', 'chat', 'domain', 'topic'];
const CHANNEL_SUFFIX = /\s*·\s*(mail|teams)\s*$/i;

// A `## ` heading of `Voice/rules.md` -> `{kind, value?, channel?}`, or `null` for a heading
// that isn't one of the six kinds (it is then skipped, not an error).
function headingScopeOf(heading) {
  let h = String(heading ?? '').trim();
  let channel;
  const chan = CHANNEL_SUFFIX.exec(h);
  if (chan) {
    channel = chan[1].toLowerCase();
    h = h.slice(0, chan.index).trim();
  }
  if (/^no-profile$/i.test(h)) return { kind: 'no-profile', channel };
  if (/^everyone$/i.test(h)) return { kind: 'everyone', channel };
  for (const kind of SCOPED_KINDS) {
    const m = new RegExp(`^${kind}\\s*:\\s*(.+)$`, 'i').exec(h);
    if (m) {
      const value = m[1].trim();
      if (!value) return null;
      return { kind, value, channel };
    }
  }
  return null;
}

// An HTML comment line (`<!-- … -->`, its own whole line) is left out of a rule's text — that's
// how an imported instruction's "imported from skill …" note stays out of what the model sees.
function withoutCommentLines(text) {
  return text
    .split(/\r\n|\n/)
    .filter((line) => !/^\s*<!--.*-->\s*$/.test(line))
    .join('\n')
    .trim();
}

// A rule text line that would read as a "## " heading is written with one more leading
// backslash (`\## …`), so a saved text can never start a new section or rule; reading takes one
// off again, so the text reads back as typed (an already escaped line round-trips too).
const HEADING_LIKE = /^(\\*)(##\s)/;

function escapeRuleLines(lines) {
  return lines.map((line) => line.replace(HEADING_LIKE, '\\$1$2'));
}

function unescapeRuleText(text) {
  return text
    .split('\n')
    .map((line) => line.replace(/^\\(\\*##\s)/, '$1'))
    .join('\n');
}

/**
 * `ruleId(heading, taken)`: a slug of the heading, made unique against the ids already `taken`
 * (a `Set`) by appending `-2`, `-3`, …. Pure: the caller adds the id it gets back to `taken`
 * before asking for the next one.
 */
export function ruleId(heading, taken) {
  const base = slug(heading) || 'rule';
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

/**
 * `parseRules(text)`: `Voice/rules.md`'s body -> `[{id, applies: {kind, value?, channel?}, text}]`,
 * one rule per `## ` heading that names one of the six kinds; any other heading is skipped
 * entirely (no rule, no id spent on it).
 */
export function parseRules(text) {
  const rules = [];
  const taken = new Set();
  for (const { heading, text: body } of sectionsOf(text)) {
    const scope = headingScopeOf(heading);
    if (!scope) continue;
    const id = ruleId(heading, taken);
    taken.add(id);
    const applies = { kind: scope.kind };
    if (scope.value !== undefined) applies.value = scope.value;
    if (scope.channel) applies.channel = scope.channel;
    rules.push({ id, applies, text: unescapeRuleText(withoutCommentLines(body)) });
  }
  return rules;
}

// ------------------------------------------------------------------------------------------------
// The style card (design §8 "Reading the style card").

const HEAD_SECTIONS = 'Communication Preferences, Communication Style, Writing style';

/**
 * `styleOf(text, ownerText, ownerPath)`: `text` is `Voice/style.md` as read (frontmatter and
 * body); `ownerText` is the `ownerPage` setting's page as read (or `null`/`undefined` when there
 * is none), `ownerPath` its path (the head's `source`). `basedOn` is `{mail, teams}` from the
 * frontmatter, or `null` when it's absent or (an older shape) a bare number. `built` is the
 * frontmatter sha Build last wrote, or `null`.
 */
export function styleOf(text, ownerText, ownerPath) {
  const { front, body } = parseFrontmatter(String(text ?? ''));
  // A broken (opened-but-never-closed) frontmatter is unreadable the same way personOf treats it:
  // parseFrontmatter then hands back the *whole* original text as `body` (fence included), so
  // without this check a broken style card would leak its raw "---"/frontmatter lines as if they
  // were the style text itself (review fix round 1).
  const readable = front !== null;
  const fm = readable ? front : {};
  const rawBasedOn = fm.basedOn;
  const basedOn = (rawBasedOn && typeof rawBasedOn === 'object' && !Array.isArray(rawBasedOn))
    ? { mail: Number(rawBasedOn.mail) || 0, teams: Number(rawBasedOn.teams) || 0 }
    : null;
  const built = (fm.built && String(fm.built).trim()) || null;

  let head = null;
  if (ownerText) {
    const ownerSections = sectionsOf(parseFrontmatter(String(ownerText)).body);
    const headText = joinSections(sectionsNamed(ownerSections, HEAD_SECTIONS));
    if (headText) head = { text: headText, source: ownerPath ?? null };
  }

  return { text: readable ? body.trim() : '', basedOn, built, head };
}

// ------------------------------------------------------------------------------------------------
// The walk (design §8's folder layout, ruling 39): never `.git`, never any hidden folder, never
// the Voice folder, when reading notes for people or facts.

/**
 * `walkable(path, voiceFolder)`: whether a folder-relative path (`/`-separated) may be read for
 * notes — `false` inside `.git`, inside any hidden folder (a name starting with `.`), or inside
 * the configured Voice folder (`voiceFolder`, `Voice` by default, nested or not, matched without
 * regard to case, as the people folder is).
 */
export function walkable(path, voiceFolder = DEFAULT_VOICE_FOLDER) {
  const segmentsOf = (p) => String(p ?? '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .split('/')
    .filter(Boolean);
  const segments = segmentsOf(path);
  if (segments.some((s) => s.startsWith('.'))) return false;
  const voice = segmentsOf(voiceFolder).map((s) => s.toLowerCase());
  if (voice.length && voice.every((s, i) => segments[i] && segments[i].toLowerCase() === s)) {
    return false;
  }
  return true;
}

// ------------------------------------------------------------------------------------------------
// Settings and the folder (design §8): defaults mirror echo-plugin.json's, since `ctx.settings.get`
// answers `undefined` for a setting the user never touched.

const DEFAULT_PEOPLE_FOLDER = 'People';
const DEFAULT_VOICE_FOLDER = 'Voice';
const DEFAULT_PROFILE_SECTIONS = 'Writing to them, Anti-patterns (do not write), Communication '
  + 'Style, Communication Preferences, Example Exchange, Speech Acts, Shared Shorthand, '
  + 'Vocabulary Cues, Communication Notes';
const DEFAULT_ABOUT_SECTIONS = 'Overview, Snapshot, Roles And Background, Affiliations And '
  + 'Roles, Working Style, Priorities';

const NEEDS_SETUP = 'needs_setup: Choose your knowledge folder in Knowledge.';
const PAGE_CHANGED = 'refused: The page changed in your folder. Refresh and try again.';

// At most this many people pages are read (design §8's "Known limits"); the rest count as
// skipped.
const MAX_PEOPLE_PAGES = 2000;
// Facts (design §10): the walk stops past this many files, skips anything over this size, and
// the whole search stops after this budget, answering what it has.
const FACTS_WALK_MAX = 5000;
const FACTS_FILE_MAX = 200 * 1024;
const FACTS_BUDGET_MS = 2500;
const FACTS_ANSWER_MAX = 5;

// Bookkeeping files in Knowledge's own plugin-data store (`ctx.store`) — never in the user's
// folder, never shown as a setting: which root is "the" chosen folder (review I5), and the
// remembered "Ask AI" checkbox (spec §8: "off until ticked, remembered").
const ROOT_FILE = 'root.json';
const PREFS_FILE = 'prefs.json';

function setting(ctx, key, fallback) {
  const v = ctx.settings.get(key);
  return typeof v === 'string' && v.trim() ? v.trim() : fallback;
}

// Reads the remembered "Ask AI" checkbox (spec §8); `false` until the user ever ticks it.
function readAskAi(ctx) {
  return Boolean(readJsonFile(ctx, PREFS_FILE, {}).buildWithAi);
}

function writeAskAi(ctx, value) {
  ctx.store.write(PREFS_FILE, JSON.stringify({ buildWithAi: Boolean(value) }));
}

function readJsonFile(ctx, file, fallback) {
  try {
    const raw = ctx.store.read(file);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

// The folder Knowledge reads and writes: the one the user last picked through `pickFolder`
// (remembered in `ctx.store`, review I5), as long as it is still among the granted roots —
// `ctx.fs.folders()` never forgets an earlier grant, or reorders them, so picking A, then B,
// then A again leaves `ctx.fs.folders()` as `[A, B]` and only this remembered value tells the
// two apart. Falls back to the most recently *granted* root (the old behaviour) when nothing was
// ever remembered, or the remembered one is no longer granted; `null` when none was ever chosen.
export function rootOf(ctx) {
  const folders = ctx.fs.folders() || [];
  if (!folders.length) return null;
  const remembered = readJsonFile(ctx, ROOT_FILE, null)?.root;
  if (typeof remembered === 'string' && folders.includes(remembered)) return remembered;
  return folders[folders.length - 1];
}

// No folder chosen -> `needs_setup`, as every op that needs the folder throws it (design §1,
// §8's "Errors").
function requireRoot(ctx) {
  const root = rootOf(ctx);
  if (!root) throw new Error(NEEDS_SETUP);
  return root;
}

// The folder's top-level entries, or `needs_setup` when the folder itself is gone (design §8's
// "Errors": "no folder chosen, or the folder is gone").
async function listDirsOrThrow(ctx, root) {
  try {
    return await ctx.fs.list(root, '');
  } catch {
    throw new Error(NEEDS_SETUP);
  }
}

// `People`/`people`, `Voice`/`voice`, … matched without regard to case (design §8: "the folder
// name matched without regard to case, so people/ works"); `null` when no such top-level folder
// exists yet.
function matchFolder(entries, name) {
  const lower = String(name ?? '').toLowerCase();
  const hit = (entries ?? []).find((e) => e.dir && e.name.toLowerCase() === lower);
  return hit ? hit.name : null;
}

// A file's text, or `null` when it isn't there (or can't be read) — never an error a caller has
// to guard against on every read.
async function safeRead(ctx, root, rel) {
  try {
    return await ctx.fs.read(root, rel);
  } catch {
    return null;
  }
}

// A page Knowledge writes over (Voice/style.md, Voice/rules.md) is read exactly, or not at all:
// strict UTF-8 within the host's own 1 MB read, so the `ifSha` it writes with is the sha of the
// bytes on disk. A page it can't read that way is refused with what is wrong and what to do —
// never written over, and never "The page changed" (a refresh can't help). `null` when there is
// no page yet. The sentence names the file, never its text (ruling 22).
const PAGE_READ_MAX = 1 << 20;

async function readPage(ctx, root, rel) {
  let st;
  try {
    st = await ctx.fs.stat(root, rel);
  } catch {
    // Its folder isn't there yet (the host's stat resolves the folder first): no page.
    return null;
  }
  if (!st) return null;
  const cant = (why) => new Error(`refused: Knowledge can't read ${rel}${why}`);
  if (st.kind !== 'file') throw cant('. Check it in your folder, then try again.');
  if (st.size > PAGE_READ_MAX) {
    throw cant(": it's over 1 MB. Make it smaller in your folder, then try again.");
  }
  try {
    return await ctx.fs.read(root, rel, { strict: true });
  } catch (e) {
    if (/UTF-8/.test(String(e?.message))) {
      throw cant(": it isn't UTF-8 text. Save it as UTF-8 in your folder, then try again.");
    }
    throw cant('. Check it in your folder, then try again.');
  }
}

// Voice/style.md read exactly (`readPage`), and also refused when its frontmatter opens and never
// closes: Connect then shows an empty card, so a save or a Build would replace text the user
// never saw.
async function readStylePage(ctx, root, rel) {
  const current = await readPage(ctx, root, rel);
  if (current !== null && parseFrontmatter(current).front === null) {
    throw new Error(`refused: Knowledge can't read ${rel}: its frontmatter opens with --- and never closes. Close it in your folder, then try again.`);
  }
  return current;
}

// Every `ctx.fs.write` conflict Knowledge can hit (the fake's and the real host's own wording
// differ slightly) becomes this one canned refusal — never the raw error, so a page's own text
// can never reach it (ruling 22).
async function guardedWrite(ctx, root, rel, content, sha) {
  const guard = sha ? { ifSha: sha } : { createNew: true };
  try {
    await ctx.fs.write(root, rel, content, guard);
  } catch {
    throw new Error(PAGE_CHANGED);
  }
}

// `Voice/ids.json` (design §8): `{"<person slug>": ["<Teams id>", …]}`, or `{}` when there is
// none or it doesn't parse.
async function readIds(ctx, root, voiceFolder) {
  if (!voiceFolder) return {};
  const raw = await safeRead(ctx, root, `${voiceFolder}/ids.json`);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// Every readable person page under the people folder, design §8's "Reading a person page", at
// most `MAX_PEOPLE_PAGES`; a page whose frontmatter can't be read, or past that cap, counts as
// `skipped` (`status`'s own count, ruling "Known limits"). `unreadable` names the pages that
// couldn't be read, for Knowledge's own page.
async function readAllPeople(ctx, root, entries) {
  const peopleFolder = matchFolder(entries, setting(ctx, 'peopleFolder', DEFAULT_PEOPLE_FOLDER));
  if (!peopleFolder) return { people: [], skipped: 0, unreadable: [] };
  const voiceFolder = matchFolder(entries, setting(ctx, 'voiceFolder', DEFAULT_VOICE_FOLDER));
  const ids = await readIds(ctx, root, voiceFolder);
  const settingsObj = {
    profileSections: setting(ctx, 'profileSections', DEFAULT_PROFILE_SECTIONS),
    aboutSections: setting(ctx, 'aboutSections', DEFAULT_ABOUT_SECTIONS),
  };
  const files = await ctx.fs.walk(root, { path: peopleFolder, ext: ['md'] });
  const all = files ?? [];
  const capped = all.slice(0, MAX_PEOPLE_PAGES);
  let skipped = Math.max(0, all.length - MAX_PEOPLE_PAGES);
  const people = [];
  const unreadable = [];
  for (const f of capped) {
    const text = await safeRead(ctx, root, f.path);
    let person = null;
    try {
      if (text !== null) person = personOf(f.path, text, settingsObj, ids);
    } catch {
      // One page the reader can't survive is unreadable; the rest of the folder still reads.
    }
    if (person) {
      people.push(person);
    } else {
      skipped += 1;
      unreadable.push(f.path);
    }
  }
  return { people, skipped, unreadable };
}

// The style card and the rules as `context` and `export` answer them (design §1's shapes):
// `styleOf`/`parseRules`'s own records, filled in with `source` and (for the style) `updatedAt`
// and a fixed `editable: true` for every rule (Knowledge is the sole writer of its own
// Voice/rules.md; there is no read-only rule at 1.0.0, ruling 17).
async function fullStyleAndRules(ctx, root, entries) {
  const voiceFolder = matchFolder(entries, setting(ctx, 'voiceFolder', DEFAULT_VOICE_FOLDER));
  let styleRel = null;
  let rulesRel = null;
  let styleText = '';
  let rulesText = '';
  if (voiceFolder) {
    styleRel = `${voiceFolder}/style.md`;
    rulesRel = `${voiceFolder}/rules.md`;
    styleText = (await safeRead(ctx, root, styleRel)) ?? '';
    rulesText = (await safeRead(ctx, root, rulesRel)) ?? '';
  }
  const ownerPage = setting(ctx, 'ownerPage', '');
  const ownerText = ownerPage ? await safeRead(ctx, root, ownerPage) : null;
  const style = styleOf(styleText, ownerText, ownerPage || null);

  let updatedAt = null;
  if (styleRel) {
    const st = await ctx.fs.stat(root, styleRel);
    // `fs.rs`'s `mtime_of` answers seconds since 1970, not milliseconds (review I2): treating it
    // as milliseconds showed every style card as updated in January 1970.
    if (st && st.kind === 'file') updatedAt = new Date(st.mtime * 1000).toISOString();
  }
  const fullStyle = {
    text: style.text,
    updatedAt,
    source: styleRel,
    basedOn: style.basedOn,
    head: style.head,
  };
  const rules = (rulesText ? parseRules(rulesText) : [])
    .map((r) => ({ ...r, source: rulesRel, editable: true }));
  return { style: fullStyle, rules };
}

// ------------------------------------------------------------------------------------------------
// Matching one person (design §4's algorithm, run here so `context`'s own answer already names
// the right person; ruling 26): Teams id first, then mail address, then a folded, order-free
// name; an ambiguous match (more than one person) matches nobody.

// A fold for comparing names "without regard to" case, diacritics, a trailing parenthesised
// part, punctuation or word order (design §4: "so 'Nair Priya' matches 'Priya Nair'").
export function foldName(name) {
  return String(name ?? '')
    .replace(/\s*\([^)]*\)\s*$/, '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(' ');
}

export function matchPerson(people, who = {}) {
  const list = Array.isArray(people) ? people : [];
  const id = who?.id ? String(who.id) : null;
  if (id) {
    const hits = list.filter((p) => p.ids.includes(id));
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) return null;
  }
  const address = who?.address ? String(who.address).toLowerCase() : null;
  if (address) {
    const hits = list.filter((p) => p.addresses.some((a) => a.toLowerCase() === address));
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) return null;
  }
  const folded = who?.name ? foldName(who.name) : '';
  if (folded) {
    const hits = list.filter((p) => [p.name, ...p.names].some((n) => foldName(n) === folded));
    if (hits.length === 1) return hits[0];
  }
  return null;
}

// ------------------------------------------------------------------------------------------------
// Writing a rule into Voice/rules.md (the inverse of parseRules/headingScopeOf): a heading for
// one `applies`, and the file's "## " blocks kept as raw text so an edit touches only its own
// block, never another rule's (its import comment line included).

function headingOf(applies = {}) {
  let h;
  if (applies.kind === 'no-profile') h = 'no-profile';
  else if (applies.kind === 'everyone') h = 'everyone';
  // A line break in the value would end the heading and start a new section on read-back.
  else h = `${applies.kind}: ${String(applies.value ?? '').replace(/\s+/g, ' ').trim()}`;
  if (applies.channel) h += ` · ${applies.channel}`;
  return h;
}

// `text` -> `{preamble, blocks: [{heading, lines}]}`: every "## " block, raw, in document order;
// `preamble` is whatever came before the first one (Voice/rules.md has none in practice, but a
// hand-edited file might).
function parseBlocks(text) {
  const lines = String(text ?? '').split(/\r\n|\n/);
  const preamble = [];
  const blocks = [];
  let current = null;
  for (const line of lines) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) {
      if (current) blocks.push(current);
      current = { heading: h[1].trim(), lines: [] };
    } else if (current) {
      current.lines.push(line);
    } else {
      preamble.push(line);
    }
  }
  if (current) blocks.push(current);
  return { preamble: preamble.join('\n'), blocks };
}

function renderBlocks(preamble, blocks) {
  const parts = [];
  const pre = String(preamble ?? '').trim();
  if (pre) parts.push(pre);
  for (const b of blocks) {
    const body = b.lines.join('\n').trim();
    parts.push(body ? `## ${b.heading}\n${body}` : `## ${b.heading}`);
  }
  return parts.length ? `${parts.join('\n\n')}\n` : '';
}

// The id `parseRules`/`ruleId` would give each block, in order (so a save or a remove finds the
// same id a read would report).
function idsOfBlocks(blocks) {
  const taken = new Set();
  return blocks.map((b) => {
    const scope = headingScopeOf(b.heading);
    const rid = scope ? ruleId(b.heading, taken) : null;
    if (rid) taken.add(rid);
    return rid;
  });
}

// A minimal YAML-frontmatter writer: just enough to round-trip what Knowledge itself writes
// (`basedOn: {mail, teams}`, `built: <sha>`, a person's `name`/`emails`) — never a full writer.
function renderFrontmatter(fm) {
  const entries = Object.entries(fm ?? {}).filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (!entries.length) return '';
  const lines = ['---'];
  for (const [k, v] of entries) {
    if (Array.isArray(v)) {
      lines.push(`${k}: [${v.map(String).join(', ')}]`);
    } else if (v && typeof v === 'object') {
      lines.push(`${k}: {${Object.entries(v).map(([kk, vv]) => `${kk}: ${vv}`).join(', ')}}`);
    } else {
      lines.push(`${k}: ${v}`);
    }
  }
  lines.push('---', '');
  return lines.join('\n');
}

// ------------------------------------------------------------------------------------------------
// Facts (design §10 "Knowledge's search"): deterministic, no AI, over this folder only.

function foldText(s) {
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Whole-word, case- and diacritic-folded: `termFolded` must sit between two non-letter-or-digit
// characters (or the ends), so "budget" never matches inside "budgetary".
function wordIncludes(haystackFolded, termFolded) {
  if (!termFolded) return false;
  const re = new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRegex(termFolded)}(?:$|[^\\p{L}\\p{N}])`, 'u');
  return re.test(` ${haystackFolded} `);
}

/**
 * `scorePage({path, text}, terms)`: design §10's score — a term in the H1 or an alias is worth
 * 5, in a "## " heading or a frontmatter value 3, in the body 1 (a term's *best* location counts
 * once, never added twice); `null` when the page is unreadable or no term is found at all (it
 * then takes no part in the ranking). `updatedAt` is the page's own frontmatter field, for the
 * ranking's "newest first" tiebreak.
 */
// Every scalar inside a frontmatter value, however deep its maps and lists go.
function leavesOf(v) {
  if (v === null || v === undefined) return [];
  if (Array.isArray(v)) return v.flatMap(leavesOf);
  if (typeof v === 'object') return Object.values(v).flatMap(leavesOf);
  return [v];
}

export function scorePage(page, terms) {
  const raw = String(page?.text ?? '');
  const { front, body } = parseFrontmatter(raw);
  if (front === null) return null;
  const h1 = h1Of(body);
  const aliases = plainsOf(front.aliases, { single: false }).map(String);
  const headings = sectionsOf(body).map((s) => s.heading);
  const frontValues = leavesOf(front).map(String);
  const topFolded = foldText([h1, ...aliases].filter(Boolean).join(' '));
  const midFolded = foldText([...headings, ...frontValues].join(' '));
  const bodyFolded = foldText(stripLinks(body));

  let score = 0;
  let distinct = 0;
  for (const term of terms ?? []) {
    const tf = foldText(term);
    if (!tf) continue;
    let weight = 0;
    if (wordIncludes(topFolded, tf)) weight = 5;
    else if (wordIncludes(midFolded, tf)) weight = 3;
    else if (wordIncludes(bodyFolded, tf)) weight = 1;
    if (weight > 0) {
      score += weight;
      distinct += 1;
    }
  }
  if (distinct === 0) return null;
  return { score, distinct, updatedAt: plainOf(front.updated_at ?? front.updated ?? null) || null };
}

// Cuts `s` to at most `max` characters, no ellipsis — Connect's own `facts.rs` cuts a fact's
// `title` the same plain way (unlike `text`, which gets `cut()`'s line-end-and-"…" treatment).
function cutChars(s, max) {
  const str = String(s ?? '');
  return str.length <= max ? str : str.slice(0, max);
}

/**
 * `snippetOf({path, text}, terms)`: the page's H1 (else its slugged file name, title-cased) as
 * `title` (cut to 120 characters, as Connect's own `facts.rs` would cut it anyway); `text` the
 * lines holding a term, each with its nearest "## " heading, frontmatter removed and
 * `[[links]]` read as text, cut to 500 characters (design §10's "The answer and its limits").
 *
 * A page can score (design §10's 5/3 weights) purely on its H1, an alias, a "## " heading's own
 * text, or a frontmatter value, with no term anywhere in its body — review I3: such a page must
 * still give *some* useful text (Connect's `facts.rs` `from_answer` drops any fact with empty
 * text outright, so an empty snippet silently loses that page's slot to nothing). When no body
 * line holds a term, this falls back to the matched "## " heading's own first lines, or, failing
 * that, the body's first non-heading lines — never an empty string while the page has any text
 * at all.
 */
export function snippetOf(page, terms) {
  const raw = String(page?.text ?? '');
  const { body } = parseFrontmatter(raw);
  const h1 = h1Of(body);
  const title = cutChars(h1 || titleCaseOf(slug(baseNameOf(page?.path ?? ''))), 120);
  const termsFolded = (terms ?? []).map(foldText).filter(Boolean);
  const sections = sectionsOf(body);
  const stripped = stripLinks(body);
  const lines = stripped.split(/\r\n|\n/);
  // Only the very line the title came from is skipped: a second "# " line, or one inside a code
  // fence, is ordinary text.
  const titleLine = h1LineOf(stripped);
  let heading = null;
  let lastEmitted = null;
  const out = [];
  for (const [i, rawLine] of lines.entries()) {
    const h = /^##\s+(.+?)\s*$/.exec(rawLine);
    if (h) {
      heading = h[1].trim();
      continue;
    }
    const line = rawLine.trim();
    // The "# " title is the fact's `title`, never a line of its text.
    if (!line || i === titleLine) continue;
    const folded = foldText(line);
    if (termsFolded.some((t) => wordIncludes(folded, t))) {
      if (heading && heading !== lastEmitted) {
        out.push(`## ${heading}`);
        lastEmitted = heading;
      }
      out.push(line);
    }
  }
  if (out.length === 0) {
    const headingHit = sections.find((s) => termsFolded.some((t) => wordIncludes(foldText(s.heading), t)));
    if (headingHit) {
      out.push(`## ${headingHit.heading}`);
      out.push(...stripLinks(headingHit.text).split(/\r\n|\n/).map((l) => l.trim()).filter(Boolean).slice(0, 3));
    } else {
      out.push(...stripLinks(body).split(/\r\n|\n/)
        .map((l) => l.trim())
        .filter((l) => l && !/^#{1,6}\s/.test(l))
        .slice(0, 3));
    }
  }
  const text = cut(out.join('\n').trim(), 500);
  return { title, text };
}

// The `facts` op itself: the walk, the scoring, the 2.5 s budget and the top-5 ranking (design
// §10).
async function searchFacts(ctx, root, entries, args) {
  // The deadline starts here, before the walk or the personId lookup (Minor: a large folder's
  // walk, or up to 2,000 people pages read to resolve `personId`, must count against the 2.5 s
  // budget too, not just the scoring loop after them).
  const deadline = Date.now() + FACTS_BUDGET_MS;

  const terms = Array.isArray(args?.terms)
    ? args.terms.map((t) => String(t ?? '').trim()).filter(Boolean)
    : [];
  if (!terms.length) return { facts: [] };

  let excludePath = null;
  if (args?.personId) {
    const { people } = await readAllPeople(ctx, root, entries);
    const match = people.find((p) => p.id === args.personId);
    if (match) excludePath = match.source;
  }

  if (Date.now() > deadline) return { facts: [] };

  const files = (await ctx.fs.walk(root, {})) ?? [];
  const voiceFolder = setting(ctx, 'voiceFolder', DEFAULT_VOICE_FOLDER);
  const candidates = [];
  for (const f of files.slice(0, FACTS_WALK_MAX)) {
    if (!walkable(f.path, voiceFolder)) continue;
    if (!/\.md$/i.test(f.path)) continue;
    if (excludePath && f.path === excludePath) continue;
    if (f.size > FACTS_FILE_MAX) continue;
    candidates.push(f);
  }

  const scored = [];
  for (const f of candidates) {
    if (Date.now() > deadline) break;
    const text = await safeRead(ctx, root, f.path);
    if (text === null) continue;
    let result = null;
    try {
      result = scorePage({ path: f.path, text }, terms);
    } catch {
      continue;
    }
    if (!result) continue;
    scored.push({ path: f.path, text, ...result });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.distinct !== a.distinct) return b.distinct - a.distinct;
    const at = a.updatedAt ? Date.parse(a.updatedAt) : -Infinity;
    const bt = b.updatedAt ? Date.parse(b.updatedAt) : -Infinity;
    return bt - at;
  });

  // Review I3: a page with no usable snippet text (Connect's own `facts.rs` would drop it
  // anyway) never takes one of the 5 slots — the next-ranked, populated page does instead.
  const out = [];
  for (const p of scored) {
    if (out.length >= FACTS_ANSWER_MAX) break;
    const snip = snippetOf({ path: p.path, text: p.text }, terms);
    if (!snip.text) continue;
    const fact = { id: p.path, title: snip.title, text: snip.text };
    if (p.updatedAt) fact.updatedAt = p.updatedAt;
    out.push(fact);
  }
  return { facts: out };
}

// ------------------------------------------------------------------------------------------------
// Build style card (design §8 "Build style card"): local facts, pure and tested, from the user's
// sent messages; the AI wording is optional and never runs on its own (ruling 9).

const GREETINGS = ['hi', 'hello', 'hey', 'dear', 'привет', 'здравствуйте', 'вітаю', 'привіт'];
const SIGNOFFS = [
  'regards', 'best', 'thanks', 'thank you', 'cheers',
  'спасибо', 'с уважением', 'дякую', 'з повагою', 'з найкращими',
];
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const PHONE_RE = /\+?\d[\d().\s-]{6,}\d/g;

function wordsOf(text) {
  return String(text ?? '').trim().split(/\s+/).filter(Boolean);
}

function firstLine(text) {
  return String(text ?? '').split(/\r?\n/).find((l) => l.trim()) ?? '';
}

// Whether `text` ends with `phrase` (design §8: "sign-offs ... mail only from what the previews
// hold" — a cut preview often has no line break at all before its sign-off, so this checks the
// end of the whole text, not just its last line), allowing one trailing punctuation mark.
function endsWithPhrase(text, phrase) {
  const t = String(text ?? '').trim().toLowerCase();
  const p = phrase.toLowerCase();
  return t.endsWith(p) || /[.,!]$/.test(t.slice(-1)) && t.slice(0, -1).trimEnd().endsWith(p);
}

// The language rule (design §4): mostly Latin -> "en"; Cyrillic with і/ї/є/ґ -> "uk"; other
// Cyrillic -> "ru"; anything else -> "none".
export function languageOf(text) {
  const t = String(text ?? '');
  if (!/[Ѐ-ӿ]/.test(t)) return /[A-Za-z]/.test(t) ? 'en' : 'none';
  if (/[іїєґІЇЄҐ]/.test(t)) return 'uk';
  return 'ru';
}

function startsLower(text) {
  const ch = firstLine(text).trimStart()[0];
  return Boolean(ch) && ch === ch.toLowerCase() && ch !== ch.toUpperCase();
}

function mostCommon(counts) {
  let best = null;
  let bestN = 0;
  for (const [k, n] of counts) {
    if (n > bestN) {
      best = k;
      bestN = n;
    }
  }
  return best;
}

function statsOf(messages) {
  if (!messages.length) return { count: 0 };
  const wordCounts = messages.map((m) => wordsOf(m.text).length).sort((a, b) => a - b);
  const typicalWords = wordCounts[Math.floor(wordCounts.length / 2)] ?? 0;
  const greetingCounts = new Map();
  const signoffCounts = new Map();
  let lowerStarts = 0;
  let emojiCount = 0;
  let exclaimCount = 0;
  for (const m of messages) {
    const text = String(m.text ?? '');
    const first = firstLine(text).trim().toLowerCase();
    const greet = GREETINGS.find((g) => first.startsWith(g));
    if (greet) greetingCounts.set(greet, (greetingCounts.get(greet) ?? 0) + 1);
    const signoff = SIGNOFFS.find((g) => endsWithPhrase(text, g));
    if (signoff) signoffCounts.set(signoff, (signoffCounts.get(signoff) ?? 0) + 1);
    if (startsLower(text)) lowerStarts += 1;
    if (EMOJI_RE.test(text)) emojiCount += 1;
    if (text.includes('!')) exclaimCount += 1;
  }
  const n = messages.length;
  return {
    count: n,
    typicalWords,
    greeting: mostCommon(greetingCounts),
    signoff: mostCommon(signoffCounts),
    lowerCaseStart: lowerStarts * 2 > n,
    emoji: emojiCount * 2 > n,
    exclamation: exclaimCount * 2 > n,
  };
}

/**
 * `styleFacts(messages)`: `messages` as `ctx.replyContext.sent` answers them (`{channel: "mail" |
 * "chat", text, …}`) -> `{mail, teams, languages}`, each a `statsOf` record — the typical length
 * in words, the greeting and sign-off used most, whether most start lower-case, use emoji or an
 * exclamation mark. `languages` holds one entry per `"mail·ru"`/`"teams·uk"` … combination with
 * at least 5 messages (design §8's Build step 4: a language section needs that many to be
 * written); English (the implicit default already in `mail`/`teams`) and "none" never get their
 * own entry.
 */
export function styleFacts(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const mailMsgs = list.filter((m) => m?.channel === 'mail');
  const teamsMsgs = list.filter((m) => m?.channel === 'chat');
  const byLangKey = new Map();
  for (const m of list) {
    const lang = languageOf(m?.text);
    if (lang === 'en' || lang === 'none') continue;
    const bucket = m?.channel === 'mail' ? 'mail' : 'teams';
    const key = `${bucket}·${lang}`;
    if (!byLangKey.has(key)) byLangKey.set(key, []);
    byLangKey.get(key).push(m);
  }
  const languages = {};
  for (const [key, msgs] of byLangKey) {
    if (msgs.length >= 5) languages[key] = statsOf(msgs);
  }
  return { mail: statsOf(mailMsgs), teams: statsOf(teamsMsgs), languages };
}

// A whole-word, case-insensitive replace (review I4): `word` must sit between two
// non-letter-or-digit characters (or the ends), via zero-width look-around so nothing needs
// reconstructing — the same boundary rule `wordIncludes` already uses for facts terms, here so a
// short name like "Al" never corrupts "Also" into "the recipientso".
function replaceWholeWord(text, word, replacement) {
  if (!word) return text;
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(word)}(?![\\p{L}\\p{N}])`, 'giu');
  return text.replace(re, replacement);
}

// Every string worth matching against a `to` field: the full name(s) as given, and each of
// their words of 2 or more letters (so "Hi Priya," matches on the first name alone, not only the
// full display name "Priya Nair") — longest first, so a full name is tried whole before its
// parts (review I4: greetings and mentions normally use the first name).
function recipientCandidates(toField) {
  const names = String(toField ?? '').split(',').map((n) => n.trim()).filter(Boolean);
  const set = new Set();
  for (const name of names) {
    if (name) set.add(name);
    for (const w of name.split(/\s+/)) {
      if (w.length >= 2) set.add(w);
    }
  }
  return [...set].sort((a, b) => b.length - a.length);
}

/**
 * `aiSamples(messages)`: at most 40 of `messages`, newest first (the order `sent` already gives),
 * each cut to 1,500 characters with e-mail addresses and phone numbers removed and every name in
 * `to` — the full name and each of its words, whole-word and case-insensitive — replaced by "the
 * recipient" (design §8 step 3) -> `[{channel, text}]`.
 */
export function aiSamples(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const out = [];
  for (const m of list) {
    if (out.length >= 40) break;
    let text = String(m?.text ?? '');
    if (!text.trim()) continue;
    for (const candidate of recipientCandidates(m?.to)) {
      text = replaceWholeWord(text, candidate, 'the recipient');
    }
    text = text.replace(EMAIL_RE, '').replace(PHONE_RE, (match) => (/^\d{4}-\d{2}-\d{2}$/.test(match) ? match : ''));
    text = cut(text.trim(), 1500);
    if (!text) continue;
    out.push({ channel: m?.channel === 'mail' ? 'mail' : 'teams', text });
  }
  return out;
}

function proseOf(stats, label) {
  if (!stats || !stats.count) return `No ${label.toLowerCase()} messages were available yet.`;
  const bits = [`Typically about ${stats.typicalWords} words.`];
  bits.push(stats.greeting ? `Often opens with "${stats.greeting}".` : 'No common greeting found.');
  bits.push(stats.signoff ? `Often signs off with "${stats.signoff}".` : 'No common sign-off found.');
  bits.push(stats.lowerCaseStart ? 'Often starts in lower case.' : 'Usually starts with a capital letter.');
  bits.push(stats.emoji ? 'Uses emoji sometimes.' : 'Rarely uses emoji.');
  bits.push(stats.exclamation ? 'Uses exclamation marks sometimes.' : 'Rarely uses exclamation marks.');
  return bits.join(' ');
}

function buildAiPrompt(samples) {
  const lines = samples.map((s) => `[${s.channel}] ${s.text}`).join('\n---\n');
  return [
    'These are short samples of messages someone sent. In at most 12 short lines, describe how',
    'they write: length, tone, habits. Quote at most five words at a time, and never name anyone.',
    '',
    lines,
  ].join('\n');
}

// Caps the AI's "## In words" answer to at most 12 lines and 1,500 characters (the prompt already
// asks for 12 short lines; this is the backstop so one unruly answer can't push the whole style
// card toward its own 8,000-character limit).
function capWords(answer) {
  const lines = String(answer ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 12);
  return cut(lines.join('\n').trim(), 1500);
}

async function buildImpl(ctx, args = {}) {
  const root = requireRoot(ctx);
  const entries = await listDirsOrThrow(ctx, root);
  const voiceFolder = matchFolder(entries, setting(ctx, 'voiceFolder', DEFAULT_VOICE_FOLDER))
    ?? setting(ctx, 'voiceFolder', DEFAULT_VOICE_FOLDER);
  const rel = `${voiceFolder}/style.md`;

  const current = await readStylePage(ctx, root, rel);
  const sha = current === null ? null : ctx.crypto.sha256(current);
  const { front, body: currentBody } = current === null
    ? { front: {}, body: '' }
    : parseFrontmatter(current);
  const recordedBuilt = front && front.built ? String(front.built) : null;
  const bodyNonEmpty = current !== null && front !== null && String(currentBody).trim() !== '';
  const bodySha = bodyNonEmpty ? ctx.crypto.sha256(String(currentBody).trim()) : null;

  // Review I1: a card is "the one Build itself last wrote" only when its body's sha matches the
  // recorded `built` — a hand-written card, or one saved through Connect's own `save
  // {kind:"style"}` before any Build ever ran (`saveStyleImpl` writes no `built`), has no
  // recorded sha at all and must still be asked about, not silently replaced.
  const changedSinceBuild = bodyNonEmpty && (!recordedBuilt || bodySha !== recordedBuilt);
  if (changedSinceBuild && !args.replace) {
    return { ask: 'Replace the style card you edited?' };
  }

  const { messages } = await ctx.replyContext.sent({ channel: 'all', days: 90, limit: 200 });
  const list = Array.isArray(messages) ? messages : [];
  const facts = styleFacts(list);
  const mailCount = list.filter((m) => m?.channel === 'mail').length;
  const teamsCount = list.filter((m) => m?.channel === 'chat').length;

  const sections = [
    `## Mail\n\n${proseOf(facts.mail, 'Mail')}`,
    `## Teams\n\n${proseOf(facts.teams, 'Teams')}`,
  ];
  for (const [key, stats] of Object.entries(facts.languages ?? {})) {
    const [bucket, lang] = key.split('·');
    const label = bucket === 'mail' ? 'Mail' : 'Teams';
    sections.push(`## ${label} · ${lang}\n\n${proseOf(stats, label)}`);
  }

  let warning;
  if (mailCount < 10) {
    warning = `Only ${mailCount} mail previews were available, so the mail part is thin: previews cut greetings and sign-offs.`;
  }

  if (args.ai) {
    const samples = aiSamples(list);
    const answer = await ctx.claude.run({ prompt: buildAiPrompt(samples), title: 'Knowledge: how you write' });
    const words = capWords(answer?.answer);
    if (words) sections.push(`## In words\n\n${words}`);
  }

  const bodyText = sections.join('\n\n');
  const builtSha = ctx.crypto.sha256(bodyText.trim());
  const fm = { basedOn: { mail: mailCount, teams: teamsCount }, built: builtSha };
  const content = `${renderFrontmatter(fm)}${bodyText}\n`;
  await guardedWrite(ctx, root, rel, content, sha);

  const answer = { style: { text: bodyText, basedOn: fm.basedOn } };
  if (warning) answer.warning = warning;
  return answer;
}

// ------------------------------------------------------------------------------------------------
// `save`, `remove` (design §1, §8): `save {kind: "style", text}`, `save {kind: "rule", id,
// applies, text}` and `save {kind: "rules", items}` (the import, every item in one write),
// `remove {kind: "rule", id}` — each with `ifSha`, so an edit made in the folder meanwhile is
// never overwritten (design §8, ruling "a refused save keeps the editor text").

async function saveStyleImpl(ctx, root, entries, args) {
  const voiceFolder = matchFolder(entries, setting(ctx, 'voiceFolder', DEFAULT_VOICE_FOLDER))
    ?? setting(ctx, 'voiceFolder', DEFAULT_VOICE_FOLDER);
  const rel = `${voiceFolder}/style.md`;
  const current = await readStylePage(ctx, root, rel);
  const sha = current === null ? null : ctx.crypto.sha256(current);
  const { front } = current === null ? { front: {} } : parseFrontmatter(current);
  const fm = front ?? {};
  const body = String(args.text ?? '');
  const content = `${renderFrontmatter(fm)}${body}${body.endsWith('\n') ? '' : '\n'}`;
  await guardedWrite(ctx, root, rel, content, sha);

  const ownerPage = setting(ctx, 'ownerPage', '');
  const ownerText = ownerPage ? await safeRead(ctx, root, ownerPage) : null;
  const parsed = styleOf(content, ownerText, ownerPage || null);
  return {
    text: parsed.text,
    updatedAt: new Date().toISOString(),
    source: rel,
    basedOn: parsed.basedOn,
    head: parsed.head,
  };
}

async function saveRuleImpl(ctx, root, entries, args) {
  const voiceFolder = matchFolder(entries, setting(ctx, 'voiceFolder', DEFAULT_VOICE_FOLDER))
    ?? setting(ctx, 'voiceFolder', DEFAULT_VOICE_FOLDER);
  const rel = `${voiceFolder}/rules.md`;
  const current = await readPage(ctx, root, rel);
  const sha = current === null ? null : ctx.crypto.sha256(current);
  const { preamble, blocks } = parseBlocks(current ?? '');

  const ids = idsOfBlocks(blocks);
  const heading = headingOf(args.applies);
  const newLines = String(args.text ?? '').trim().split(/\r\n|\n/);

  // An id that doesn't match any current block — a rule deleted in the folder meanwhile — is
  // refused, never silently turned into a new rule (Minor: a stale edit must not resurrect a
  // removed instruction under a different id).
  if (args.id && !ids.includes(args.id)) {
    throw new Error('refused: This instruction is no longer there. Refresh and try again.');
  }

  const nextBlocks = blocks.map((b) => ({ heading: b.heading, lines: b.lines.slice() }));
  let targetIndex = args.id ? ids.findIndex((rid) => rid === args.id) : -1;
  if (targetIndex >= 0) {
    nextBlocks[targetIndex] = { heading, lines: escapeRuleLines(newLines) };
  } else {
    nextBlocks.push({ heading, lines: escapeRuleLines(newLines) });
    targetIndex = nextBlocks.length - 1;
  }

  const finalIds = idsOfBlocks(nextBlocks);
  const content = renderBlocks(preamble, nextBlocks);
  await guardedWrite(ctx, root, rel, content, sha);

  return {
    id: finalIds[targetIndex],
    applies: args.applies,
    text: newLines.join('\n').trim(),
    source: rel,
    editable: true,
  };
}

async function saveRulesImpl(ctx, root, entries, args) {
  const voiceFolder = matchFolder(entries, setting(ctx, 'voiceFolder', DEFAULT_VOICE_FOLDER))
    ?? setting(ctx, 'voiceFolder', DEFAULT_VOICE_FOLDER);
  const rel = `${voiceFolder}/rules.md`;
  const current = await readPage(ctx, root, rel);
  const sha = current === null ? null : ctx.crypto.sha256(current);
  const { preamble, blocks } = parseBlocks(current ?? '');

  const items = Array.isArray(args.items) ? args.items : [];
  const today = new Date().toISOString().slice(0, 10);
  const newBlocks = items.map((it) => ({
    heading: headingOf(it.applies),
    lines: [
      `<!-- imported from skill "${it.from}" on ${today} -->`,
      ...escapeRuleLines(String(it.text ?? '').trim().split(/\r\n|\n/)),
    ],
  }));

  const nextBlocks = [...blocks, ...newBlocks];
  const finalIds = idsOfBlocks(nextBlocks);
  const content = renderBlocks(preamble, nextBlocks);
  await guardedWrite(ctx, root, rel, content, sha);

  const savedItems = items.map((it, i) => ({
    id: finalIds[blocks.length + i],
    applies: it.applies,
    text: String(it.text ?? '').trim(),
    source: rel,
    editable: true,
  }));
  return { items: savedItems };
}

async function removeRuleImpl(ctx, root, entries, args) {
  const voiceFolder = matchFolder(entries, setting(ctx, 'voiceFolder', DEFAULT_VOICE_FOLDER));
  if (!voiceFolder) return { removed: true };
  const rel = `${voiceFolder}/rules.md`;
  const current = await readPage(ctx, root, rel);
  if (current === null) return { removed: true };
  const sha = ctx.crypto.sha256(current);
  const { preamble, blocks } = parseBlocks(current);
  const ids = idsOfBlocks(blocks);
  const idx = ids.findIndex((rid) => rid === args.id);
  if (idx < 0) return { removed: true };
  const remaining = blocks.filter((_, i) => i !== idx);
  const content = renderBlocks(preamble, remaining);
  await guardedWrite(ctx, root, rel, content, sha);
  return { removed: true };
}

// ------------------------------------------------------------------------------------------------
// The page's host commands (design §8's "Its page"): `pickFolder`, `build`, `newPerson` and
// `summary`.

async function newPersonImpl(ctx, root, entries, args) {
  const peopleFolder = matchFolder(entries, setting(ctx, 'peopleFolder', DEFAULT_PEOPLE_FOLDER))
    ?? setting(ctx, 'peopleFolder', DEFAULT_PEOPLE_FOLDER);
  const name = String(args?.name ?? '').trim();
  if (!name) throw new Error('bad_request: A name is needed.');
  const fileSlug = slug(name) || 'person';
  const rel = `${peopleFolder}/${fileSlug}.md`;
  const address = String(args?.address ?? '').trim();
  const fm = { name };
  if (address) fm.emails = [address];
  const content = `${renderFrontmatter(fm)}# ${name}\n`;
  try {
    await ctx.fs.write(root, rel, content, { createNew: true });
  } catch {
    throw new Error(`refused: There is already a page for "${name}".`);
  }
  return { id: fileSlug, name, address: address || null, source: rel };
}

async function summaryImpl(ctx) {
  const root = rootOf(ctx);
  const buildWithAi = readAskAi(ctx);
  if (!root) return { folder: null, people: 0, peopleWithProfile: 0, rules: 0, style: false, buildWithAi };
  let entries;
  try {
    entries = await ctx.fs.list(root, '');
  } catch {
    return { folder: root, people: 0, peopleWithProfile: 0, rules: 0, style: false, buildWithAi };
  }
  const { people, unreadable } = await readAllPeople(ctx, root, entries);
  const full = await fullStyleAndRules(ctx, root, entries);
  return {
    folder: root,
    people: people.length,
    unreadable,
    peopleWithProfile: people.filter((p) => p.text).length,
    rules: full.rules.length,
    style: Boolean(full.style.text),
    buildWithAi,
  };
}

// ------------------------------------------------------------------------------------------------
// `apply(ctx)`: the host half. Registers the six `reply-context` ops (design §1, §2) and
// Knowledge's own page commands (design §8). Every op that touches the folder checks it first
// (`requireRoot`/`listDirsOrThrow`); `facts` reads only this folder, never Connect's copy or any
// other plugin's.
export function apply(ctx) {
  async function status() {
    const root = requireRoot(ctx);
    const entries = await listDirsOrThrow(ctx, root);
    const { people, skipped } = await readAllPeople(ctx, root, entries);
    const full = await fullStyleAndRules(ctx, root, entries);
    return { ok: true, people: people.length, rules: full.rules.length, style: Boolean(full.style.text), skipped };
  }

  async function doExport() {
    const root = requireRoot(ctx);
    const entries = await listDirsOrThrow(ctx, root);
    const { people } = await readAllPeople(ctx, root, entries);
    const full = await fullStyleAndRules(ctx, root, entries);
    return { style: full.style, rules: full.rules, people };
  }

  async function context(args = {}) {
    const root = requireRoot(ctx);
    const entries = await listDirsOrThrow(ctx, root);
    const { people } = await readAllPeople(ctx, root, entries);
    const full = await fullStyleAndRules(ctx, root, entries);
    const matched = matchPerson(people, args.person ?? {});
    return { style: full.style, person: matched ?? null, rules: full.rules };
  }

  async function facts(args = {}) {
    const root = requireRoot(ctx);
    const entries = await listDirsOrThrow(ctx, root);
    return searchFacts(ctx, root, entries, args);
  }

  async function save(args = {}) {
    const root = requireRoot(ctx);
    const entries = await listDirsOrThrow(ctx, root);
    if (args.kind === 'style') return saveStyleImpl(ctx, root, entries, args);
    if (args.kind === 'rule') return saveRuleImpl(ctx, root, entries, args);
    if (args.kind === 'rules') return saveRulesImpl(ctx, root, entries, args);
    throw new Error('bad_request: Unknown save kind.');
  }

  async function remove(args = {}) {
    const root = requireRoot(ctx);
    const entries = await listDirsOrThrow(ctx, root);
    if (args.kind === 'rule') return removeRuleImpl(ctx, root, entries, args);
    throw new Error('bad_request: Unknown remove kind.');
  }

  async function build(args = {}) {
    return buildImpl(ctx, args);
  }

  async function newPerson(args = {}) {
    const root = requireRoot(ctx);
    const entries = await listDirsOrThrow(ctx, root);
    return newPersonImpl(ctx, root, entries, args);
  }

  async function summary() {
    return summaryImpl(ctx);
  }

  // Remembers the chosen root explicitly (review I5): `ctx.fs.folders()` only ever grows, and
  // never reorders, so re-picking an earlier folder would otherwise leave Knowledge reading and
  // writing whichever one was granted last, not the one just chosen.
  async function pickFolder() {
    const chosen = await ctx.system.pickFolder('Choose your knowledge folder');
    if (chosen) ctx.store.write(ROOT_FILE, JSON.stringify({ root: chosen }));
    return { folder: chosen ?? null };
  }

  // The "Ask AI" checkbox is remembered across page loads (spec §8: "off until ticked,
  // remembered"), in Knowledge's own plugin-data store — never a manifest setting, since it is
  // Knowledge's own page's preference, not one of Settings › Your voice's rows.
  async function setAskAi(args = {}) {
    writeAskAi(ctx, args?.value);
    return { buildWithAi: readAskAi(ctx) };
  }

  ctx.replyContext.provide({ status, export: doExport, context, facts, save, remove });
  ctx.command('pickFolder', pickFolder);
  ctx.command('build', build);
  ctx.command('newPerson', newPerson);
  ctx.command('summary', summary);
  ctx.command('setAskAi', setAskAi);
}
