// Todoist task provider for Connect. Host half only (no client half, no imports — the host loads
// this one script). This file holds the pure mapping between Connect's task shape and Todoist's:
// the marker lines in the description, labels, the owner prefix, due dates and error codes.
// `apply(ctx)` (reading settings, calling the Todoist API, registering `ctx.tasks.provide`) is
// added in a later step; everything below has no side effect and no network access.

// The marker-line rule: any line that merely *looks* like one of Connect's marker lines (any
// case, Markdown-decorated: "**Source:** …", "> key: …") is dropped from free text before it is
// written, so a message or a note can never plant a key, a link or an owner.
export const MARKER_LINE = /^[\s*_`>#~|-]*(source|key|meeting|owner)[\s*_`~]*:/i;

export const stripMarkers = (text) =>
  String(text ?? '')
    .split('\n')
    .filter((line) => !MARKER_LINE.test(line))
    .join('\n');

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const HTTPS = /^https:\/\//i;

// Todoist labels Connect owns by kind, read back with this priority (first match wins).
const KIND_BY_LABEL = [
  ['budget', 'budget'],
  ['reply', 'reply'],
  ['waiting', 'waiting'],
];
const KIND_LABELS = KIND_BY_LABEL.map(([label]) => label);
const LABEL_OF_KIND = { reply: 'reply', waiting: 'waiting', budget: 'budget' };

const firstName = (name) => String(name ?? '').trim().split(/\s+/)[0] || null;

const field = (name) => new RegExp(`^${name}:\\s*(.*)$`, 'gim');
const KEY_FIELD = field('key');
const SOURCE_FIELD = field('source');
const MEETING_FIELD = field('meeting');
const OWNER_FIELD = field('owner');

// The last match of a field regex over the whole text (how Connect reads a marker line: the last
// one wins), or undefined when the field is absent.
function lastMatch(text, re) {
  let out;
  let m;
  re.lastIndex = 0;
  // eslint-disable-next-line no-cond-assign
  while ((m = re.exec(text))) out = m[1].trim();
  return out === undefined || out === '' ? undefined : out;
}

// "Marek Novak <marek.novak@example.test>" -> {name, address}; a bare name with no "<address>"
// keeps just the name.
function parseOwnerLine(raw) {
  const m = /^(.*?)\s*<([^>]*)>\s*$/.exec(raw);
  return m ? { name: m[1], address: m[2] } : { name: raw };
}

const ownerLine = (owner) =>
  owner?.address ? `${owner.name} <${owner.address}>` : owner?.name ? `${owner.name}` : null;

// The notes without marker-looking lines, a blank line, then Connect's own marker lines (last),
// one per line, each only when present: key, source (https only), meeting, owner.
export function describe({ notes, key, source, meetingId, owner } = {}) {
  const body = stripMarkers(notes ?? '').trim();
  const markers = [];
  if (key) markers.push(`key: ${key}`);
  if (source && HTTPS.test(source)) markers.push(`source: ${source}`);
  if (meetingId) markers.push(`meeting: ${meetingId}`);
  const owl = ownerLine(owner);
  if (owl) markers.push(`owner: ${owl}`);
  return markers.length ? [body, '', ...markers].join('\n') : body;
}

// The inverse of describe(): the notes (every marker-looking line dropped) plus the last marker
// of each kind, wherever in the text it appears.
export function parseDescription(desc) {
  const text = String(desc ?? '');
  const notes = text
    .split('\n')
    .filter((line) => !MARKER_LINE.test(line))
    .join('\n')
    .trim();
  const key = lastMatch(text, KEY_FIELD);
  const source = lastMatch(text, SOURCE_FIELD);
  const meetingId = lastMatch(text, MEETING_FIELD);
  const ownerRaw = lastMatch(text, OWNER_FIELD);
  const owner = ownerRaw ? parseOwnerLine(ownerRaw) : undefined;
  return { notes, key, source, meetingId, owner };
}

// Connect's task (or a patch of one) -> the Todoist REST body. Only fields the caller actually
// gave are set, so a patch that omits `due` sends no due field at all (ruling 20: a recurring
// task's due string is never touched unless the user changed the date).
export function toTodoist(task = {}, { projectId, label } = {}) {
  const body = {};
  if (projectId !== undefined) body.project_id = projectId;

  if (task.text !== undefined) {
    const prefix = task.kind === 'waiting' && task.owner?.name ? `${firstName(task.owner.name)}: ` : '';
    body.content = `${prefix}${task.text}`;
  }

  if (task.notes !== undefined || task.key !== undefined || task.source !== undefined
    || task.meetingId !== undefined || task.owner !== undefined) {
    body.description = describe({
      notes: task.notes, key: task.key, source: task.source, meetingId: task.meetingId, owner: task.owner,
    });
  }

  if (task.kind !== undefined || task.labels !== undefined || label !== undefined) {
    const kept = (task.labels ?? []).filter((l) => l !== label && !KIND_LABELS.includes(l));
    const kindLabel = LABEL_OF_KIND[task.kind];
    body.labels = [...new Set([...kept, label, kindLabel].filter(Boolean))];
  }

  if (Object.prototype.hasOwnProperty.call(task, 'due')) {
    if (task.due === null) {
      body.due_string = 'no date';
    } else if (ISO_DATE.test(String(task.due))) {
      body.due_date = task.due;
    } else {
      throw new Error('refused: Todoist needs a date like 2026-11-20.');
    }
  }

  return body;
}

// A Todoist task item (REST `GET`/`POST /tasks` shape) -> Connect's task shape (§5 of the design).
export function fromTodoist(item, { label } = {}) {
  const labels = item.labels ?? [];
  const { notes, key, source, meetingId, owner } = parseDescription(item.description);
  const kindEntry = KIND_BY_LABEL.find(([l]) => labels.includes(l));
  const kind = kindEntry ? kindEntry[1] : 'task';

  let text = item.content ?? '';
  if (owner?.name) {
    const prefix = `${firstName(owner.name)}: `;
    if (text.startsWith(prefix)) text = text.slice(prefix.length);
  }

  return {
    id: item.id,
    key,
    text,
    notes,
    due: item.due?.date ?? null,
    done: Boolean(item.checked),
    kind,
    owner: owner ?? null,
    source: source ?? null,
    meetingId: meetingId ?? null,
    url: `https://app.todoist.com/app/task/${item.id}`,
    labels,
    updatedAt: item.updated_at ?? item.added_at ?? null,
  };
}

// A failed Todoist call -> the coded Error the core understands (design doc §5/§7). The response
// body and the token are never part of the message.
export function errorOf(status, headers = {}, bodyText = '') {
  if (status === 401 || status === 403) {
    return new Error('needs_token: Todoist rejected the token');
  }
  if (status === 429) {
    const header = Number(headers?.['retry-after'] ?? headers?.['Retry-After']);
    let retryAfter = header > 0 ? header : undefined;
    if (retryAfter === undefined) {
      try {
        const extra = Number(JSON.parse(bodyText).error_extra?.retry_after);
        retryAfter = extra > 0 ? extra : undefined;
      } catch {
        // no usable body
      }
    }
    if (retryAfter === undefined) retryAfter = 60;
    return new Error(`rate_limited:${retryAfter}: Todoist asked Connect to slow down`);
  }
  if (status === 404) {
    return new Error('not_found: the Todoist task is gone');
  }
  if (status >= 500 || !status) {
    return new Error(`offline: Todoist is unreachable (${status})`);
  }
  return new Error(`refused: Todoist didn't accept the change (${status})`);
}
