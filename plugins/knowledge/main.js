// Knowledge: Connect's `reply-context` provider for a folder of plain Markdown (design
// `docs/superpowers/specs/2026-11-25-reply-voice-design.md` §8, rulings 16, 17, 25, 26, 39). The
// folder can be the user's existing knowledge base, so reading is deliberately loose: a page is a
// person once its frontmatter parses, however little it says; a page's writing-profile is never
// its whole body, only the named sections the user configured, best first; a page with no
// frontmatter block at all is still readable (an empty frontmatter), only a frontmatter block
// that opens and never closes (or whose YAML the small parser below can't read) makes a page
// unreadable, so it is skipped rather than guessed at.
//
// This file is the pure half: no file is opened here, no git is run, nothing is written. The
// functions below take text Connect (or a test) already read and answer plain data; `apply(ctx)`
// — the host half that walks the folder and registers `ctx.replyContext.provide({...})` — is a
// later task's job and is left empty here on purpose.

// ------------------------------------------------------------------------------------------------
// A small, deterministic YAML-frontmatter reader: just enough for a person page's `id`, `name`,
// `aliases`, `emails`, `email`, `teamsIds`, `sources`, `updated_at`, `updated`, `confidence`, and
// a style card's `basedOn` and `built`. Never a full YAML parser (no nesting beyond one level, no
// anchors, no multi-line scalars): a knowledge base's own tools write richer YAML at their peril,
// but these fields are all plain scalars or flat lists.

const FENCE = /^---\s*$/;

function unquote(raw) {
  const t = raw.trim();
  if (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

// A bare scalar: null/blank, a bool, else the (unquoted) string as written — deliberately never a
// JS `Number`, even for digit-only text: an id (a Teams id, a frontmatter `id`) is opaque text,
// and a `Number` round-trip silently rounds anything past `Number.MAX_SAFE_INTEGER` (review fix
// round 1). `basedOn`'s counts are the one place a number is wanted, and `styleOf` converts them
// itself with `Number(...)`, which works the same over a string or a bare number either way.
function scalarOf(raw) {
  const t = raw.trim();
  if (t === '' || t === '~' || t.toLowerCase() === 'null') return null;
  if (t === 'true') return true;
  if (t === 'false') return false;
  return unquote(t);
}

// `[a, b, c]` -> ["a", "b", "c"]; `{a: 1, b: 2}` -> {a: 1, b: 2} (one level, comma-separated;
// `null` for a pair that doesn't split cleanly, so the caller can treat the whole value as
// unreadable rather than guess).
function inlineListOf(raw) {
  const inner = raw.trim().replace(/^\[/, '').replace(/\]\s*$/, '');
  if (!inner.trim()) return [];
  return inner.split(',').map((item) => scalarOf(item));
}

function inlineMapOf(raw) {
  const inner = raw.trim().replace(/^\{/, '').replace(/\}\s*$/, '');
  if (!inner.trim()) return {};
  const out = {};
  for (const pair of inner.split(',')) {
    const at = pair.indexOf(':');
    if (at < 0) return null;
    out[pair.slice(0, at).trim()] = scalarOf(pair.slice(at + 1));
  }
  return out;
}

// The frontmatter's lines (without the `---` fences) as a flat object, or `null` when a line
// isn't `key: value` (a block list's `- item` lines aside): the page's frontmatter doesn't parse,
// and `parseFrontmatter` turns that into "this page is unreadable" for its caller.
function parseYamlLines(lines) {
  const out = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '' || line.trimStart().startsWith('#')) {
      i += 1;
      continue;
    }
    const m = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (!m) return null;
    const [, key, rest] = m;
    if (rest.trim() === '') {
      // Maybe a block list: indented "- item" lines right after the key.
      const items = [];
      let j = i + 1;
      while (j < lines.length && /^\s*-\s*/.test(lines[j]) && /\S/.test(lines[j]) && lines[j].search(/\S/) > 0) {
        items.push(scalarOf(lines[j].replace(/^\s*-\s*/, '')));
        j += 1;
      }
      out[key] = items.length ? items : null;
      i = j;
    } else if (rest.trim().startsWith('[')) {
      out[key] = inlineListOf(rest);
      i += 1;
    } else if (rest.trim().startsWith('{')) {
      const map = inlineMapOf(rest);
      if (map === null) return null;
      out[key] = map;
      i += 1;
    } else {
      out[key] = scalarOf(rest);
      i += 1;
    }
  }
  return out;
}

// `text` -> `{front, body}`. No opening `---` line at all: an empty, valid frontmatter (a plain
// knowledge-base page is still readable). An opening `---` with no closing one, or YAML
// `parseYamlLines` can't read: `front` is `null` — unreadable, the caller skips the page.
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
  const front = parseYamlLines(lines.slice(1, end));
  if (front === null) return { front: null, body: src };
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

function h1Of(body) {
  const m = /^#\s+(.+?)\s*$/m.exec(body);
  return m ? m[1].trim() : null;
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
export function personOf(path, text, settings = {}, ids = {}) {
  const { front, body } = parseFrontmatter(text);
  if (front === null) return null;

  const h1 = h1Of(body);
  const aliases = (Array.isArray(front.aliases) ? front.aliases : [])
    .filter((a) => a !== null && a !== undefined && String(a).trim() !== '')
    .map(String);
  const fileSlug = slug(baseNameOf(path));

  const name = (front.name && String(front.name).trim())
    || h1
    || aliases[0]
    || titleCaseOf(fileSlug);

  const names = [...new Set([...aliases, h1].filter((n) => n && String(n).trim() !== ''))];

  // Dedup on the *string* form, not the YAML scalar's own type (review fix round 1): a numeric-
  // looking id can arrive as a bare number from one source and a string from another (`Voice/
  // ids.json` is always JSON strings), and `Set` treats `123` and `"123"` as distinct unless the
  // values are normalized first.
  const emails = Array.isArray(front.emails) ? front.emails : (front.emails ? [front.emails] : []);
  const singleEmail = front.email ? [front.email] : [];
  const addresses = [...new Set(
    [...emails, ...singleEmail]
      .filter((a) => a !== null && a !== undefined && String(a).trim() !== '')
      .map(String),
  )].slice(0, 10);

  const teamsIds = Array.isArray(front.teamsIds) ? front.teamsIds : [];
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
    id: (front.id && String(front.id).trim()) || slug(name) || fileSlug,
    name,
    names,
    addresses,
    ids: personIds,
    text: profileText,
    about: aboutText,
    updatedAt: front.updated_at ?? front.updated ?? null,
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
    rules.push({ id, applies, text: withoutCommentLines(body) });
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
 * `walkable(path)`: whether a folder-relative path (`/`-separated) may be read for notes — `false`
 * inside `.git`, inside any hidden folder (a name starting with `.`), or inside the Voice folder
 * (matched without regard to case, as the people folder is).
 */
export function walkable(path) {
  const segments = String(path ?? '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .split('/')
    .filter(Boolean);
  if (segments.some((s) => s.startsWith('.'))) return false;
  if (segments[0] && segments[0].toLowerCase() === 'voice') return false;
  return true;
}

// ------------------------------------------------------------------------------------------------
// `apply(ctx)`: the host half. Left empty in this task on purpose (plan step "Implement the pure
// functions; no apply(ctx) yet beyond an empty export") — a later task walks the chosen folder
// with the functions above and registers `ctx.replyContext.provide({status, export, context,
// facts, save, remove})`.
export function apply(_ctx) {
  // Intentionally empty: see the plan's later tasks for Knowledge's ops.
}
