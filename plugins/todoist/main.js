// Todoist task provider for Connect. Host half only (no client half, no imports — the host loads
// this one script). The first part is the pure mapping between Connect's task shape and
// Todoist's: the marker lines in the description, labels, the owner prefix, due dates and error
// codes. `apply(ctx)` at the end registers the seven provider ops with `ctx.tasks.provide`; they
// call https://api.todoist.com/api/v1 with the token read from the settings on every call.

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
  return m ? { name: m[1] || null, address: m[2] } : { name: raw };
}

// "Name <address>", "<address>" with no name, "Name" with no address; null with neither.
function ownerLine(owner) {
  const name = String(owner?.name ?? '').trim();
  const address = String(owner?.address ?? '').trim();
  if (address) return name ? `${name} <${address}>` : `<${address}>`;
  return name || null;
}

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
  if (!markers.length) return body;
  return body ? [body, '', ...markers].join('\n') : markers.join('\n');
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
    const given = task.labels ?? [];
    const kept = given.filter((l) => l !== label && !KIND_LABELS.includes(l));
    // kind given -> its label (or none, for a plain task); kind omitted (unchanged) -> whichever
    // kind label the given labels already carried, so a labels-only patch never erases it.
    const kindLabel = task.kind !== undefined
      ? LABEL_OF_KIND[task.kind]
      : KIND_LABELS.find((l) => given.includes(l));
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
    return new Error(status ? `offline: Todoist is unreachable (${status})` : 'offline: Todoist is unreachable');
  }
  return new Error(`refused: Todoist didn't accept the change (${status})`);
}

// ------------------------------------------------------------------------------------------------
// The provider ops (design §5's table), registered with `ctx.tasks.provide`.

const API = 'https://api.todoist.com/api/v1';
const NO_TOKEN = 'needs_token: Add your Todoist API token in Settings › Tasks.';
// The project's id, kept as {name, id} and found again when the project setting changes.
const PROJECT_FILE = 'project.json';
const PAGE = 200;
const MAX_PAGES = 100;

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o ?? {}, k);

// `{a: 1, b: 'x y'}` -> "a=1&b=x%20y" (QuickJS has no URLSearchParams).
const formOf = (fields) =>
  Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');

export function apply(ctx) {
  const setting = (key, fallback) => {
    const v = ctx.settings.get(key);
    return typeof v === 'string' && v.trim() ? v.trim() : fallback;
  };
  const appLabel = () => setting('label', 'connect');
  const projectName = () => setting('project', 'Connect');

  // One Todoist call. The token is read here, on every call, and kept nowhere else; a failure
  // becomes a coded Error whose message never holds the token or the response body.
  async function call(method, path, { json, form, requestId } = {}) {
    const token = setting('token', null);
    if (!token) throw new Error(NO_TOKEN);
    const headers = { Authorization: `Bearer ${token}` };
    const opts = { method, headers };
    if (form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      opts.body = formOf(form);
    } else if (json !== undefined) {
      headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(json);
    }
    if (requestId) headers['X-Request-Id'] = String(requestId);
    let res;
    try {
      res = await ctx.http.fetch(`${API}${path}`, opts);
    } catch {
      // The host couldn't reach Todoist, or it didn't answer in time.
      throw errorOf(undefined);
    }
    const status = Number(res?.status);
    if (!(status >= 200 && status < 300)) throw errorOf(status, res?.headers, res?.body);
    if (!res.body) return null;
    try {
      return JSON.parse(res.body);
    } catch {
      throw new Error("offline: Todoist's answer couldn't be read");
    }
  }

  // Every item of a paged list (`{results, next_cursor}`).
  async function paged(path, query = {}) {
    const out = [];
    let cursor = null;
    for (let i = 0; i < MAX_PAGES; i += 1) {
      const page = await call('GET', `${path}?${formOf({ ...query, limit: PAGE, cursor })}`);
      out.push(...(page?.results ?? []));
      cursor = page?.next_cursor ?? null;
      if (!cursor) break;
    }
    return out;
  }

  // The project's id: kept in the store while the setting names the same project; otherwise
  // found by name, and made once when Todoist has none by that name.
  async function projectId() {
    const name = projectName();
    let kept = null;
    try {
      kept = JSON.parse(ctx.store.read(PROJECT_FILE) ?? 'null');
    } catch {
      kept = null;
    }
    if (kept?.name === name && kept.id) return String(kept.id);
    const found = (await paged('/projects')).find((p) => p.name === name);
    const project = found ?? (await call('POST', '/projects', { json: { name } }));
    if (!project?.id) throw new Error('offline: Todoist answered without a project');
    const id = String(project.id);
    ctx.store.write(PROJECT_FILE, JSON.stringify({ name, id }));
    return id;
  }

  const read = (item) => fromTodoist(item, { label: appLabel() });
  const taskPath = (id) => `/tasks/${encodeURIComponent(String(id))}`;

  async function status() {
    const user = await call('GET', '/user');
    await projectId();
    return { ok: true, account: user?.full_name || user?.email || '', project: projectName() };
  }

  async function list() {
    const pid = await projectId();
    return { tasks: (await paged('/tasks', { project_id: pid })).map(read) };
  }

  // What changed since `cursor` (null: everything open): the project's tasks only, done ones
  // included, and the ids deleted in Todoist. A task moved to another project is left out.
  async function changedSince({ cursor = null } = {}) {
    const pid = await projectId();
    const full = !cursor;
    const answer = await call('POST', '/sync', {
      form: { sync_token: cursor ?? '*', resource_types: JSON.stringify(['items']) },
    });
    const tasks = [];
    const removed = [];
    for (const item of answer?.items ?? []) {
      if (String(item.project_id) !== pid) continue;
      if (item.is_deleted) {
        if (!full) removed.push(String(item.id));
      } else if (!(full && item.checked)) {
        tasks.push(read(item));
      }
    }
    return { tasks, removed, cursor: answer?.sync_token ?? cursor };
  }

  // An open task of the project already holding `key` is adopted (a replayed create whose answer
  // was lost); only then is the task made, with the outbox entry's id as X-Request-Id.
  async function create({ key, task = {}, requestId } = {}) {
    const pid = await projectId();
    const open = await paged('/tasks', { project_id: pid });
    const found = key ? open.find((item) => parseDescription(item.description).key === key) : null;
    if (found) return { ...read(found), adopted: true };
    const body = toTodoist({ ...task, key }, { projectId: pid, label: appLabel() });
    // A new task with no date has none to clear.
    if (body.due_string === 'no date') delete body.due_string;
    return read(await call('POST', '/tasks', { json: body, requestId }));
  }

  // `patch` holds only the changed fields. The task is read first, so the description is rebuilt
  // with its marker lines, the content keeps or drops the owner prefix, and labels Connect doesn't
  // own are kept; a field the patch doesn't name is never sent (a recurring due string stays).
  async function update({ id, patch = {}, requestId } = {}) {
    const current = read(await call('GET', taskPath(id)));
    const has = (k) => hasOwn(patch, k);
    const merged = { ...current, ...patch };
    if (!has('due')) delete merged.due;
    if (!has('labels')) merged.labels = current.labels;
    const full = toTodoist(merged, { label: appLabel() });
    const body = {};
    if (has('text') || has('kind') || has('owner')) body.content = full.content;
    if (has('notes') || has('owner')) body.description = full.description;
    if (has('kind') || has('labels')) body.labels = full.labels;
    if (has('due')) {
      if (hasOwn(full, 'due_date')) body.due_date = full.due_date;
      if (hasOwn(full, 'due_string')) body.due_string = full.due_string;
    }
    if (!Object.keys(body).length) return current;
    return read(await call('POST', taskPath(id), { json: body, requestId }));
  }

  // Closes the task, or reopens it with `done: false`; answers it as Todoist now has it.
  async function complete({ id, done } = {}) {
    await call('POST', `${taskPath(id)}/${done === false ? 'reopen' : 'close'}`);
    return read(await call('GET', taskPath(id)));
  }

  // Deletes the task; one already gone counts as removed.
  async function remove({ id } = {}) {
    try {
      await call('DELETE', taskPath(id));
    } catch (e) {
      if (!/^not_found:/.test(e.message)) throw e;
    }
    return { removed: true };
  }

  ctx.tasks.provide({ status, list, changedSince, create, update, complete, remove });
}
