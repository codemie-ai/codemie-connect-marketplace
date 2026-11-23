// An in-memory stand-in for the Todoist REST API v1 (https://api.todoist.com/api/v1). Never
// touches the network: its `handler` has the same shape as Connect's `ctx.http.fetch` — async
// (url, {method, headers, body}) -> {status, headers, body}, every value text — so it can be
// passed straight to fakeCtx({ fetchHandler: fakeTodoist(...).handler }).
//
// Covers what the Todoist plugin uses: GET /user, GET|POST /projects, GET|POST /tasks,
// GET|POST /tasks/{id}, /tasks/{id}/close, /tasks/{id}/reopen (204), DELETE /tasks/{id}, and
// POST /sync with sync tokens (form or JSON body). Lists are paged (`pageSize`, `next_cursor`).
// Also a bearer-token check, a request log, failure injection (`fail`) and a lost answer (`lose`:
// the work is done, then the call fails as if the connection dropped). As in Todoist, project
// names may repeat, a full sync lists only open tasks, a 429 says `retry_after` in its body (and
// in `Retry-After` when the test gives one), and `hideCompleted` makes a read of a completed task
// answer 404 (as REST v2 did; v1's behaviour is unconfirmed).

const BASE = 'https://api.todoist.com/api/v1';

export function fakeTodoist({ token = 'fake-todoist-token', user = { id: 'u1', email: 'you@example.test', full_name: 'You' }, pageSize = 200, hideCompleted = false } = {}) {
  const projects = new Map(); // id -> {id, name}
  const tasks = new Map(); // id -> Todoist task record (+ internal _rev, _deleted)
  const requests = []; // {method, path, body}
  const failures = new Map(); // "METHOD /path" or "/path" -> {status, retryAfter, body, once}
  const losing = new Set(); // "METHOD /path": the next such call is done, then its answer is lost
  let nextId = 1;
  let rev = 0;

  const newId = () => String(nextId++);
  const bump = (t) => {
    rev += 1;
    t._rev = rev;
    return t;
  };

  function fail(key, status, opts = {}) {
    failures.set(key, { status, ...opts });
  }
  function clearFailure(key) {
    failures.delete(key);
  }
  function takeFailure(method, path) {
    for (const key of [`${method} ${path}`, path]) {
      const f = failures.get(key);
      if (f) {
        if (f.once) failures.delete(key);
        return f;
      }
    }
    return null;
  }

  // One page of `items` from `cursor` (an index), with the next cursor or null.
  function page(items, cursor) {
    const from = Number(cursor) || 0;
    const next = from + pageSize < items.length ? String(from + pageSize) : null;
    return { results: items.slice(from, from + pageSize), next_cursor: next };
  }

  // A /sync body: form-encoded (`sync_token=*&resource_types=["items"]`) or JSON.
  function syncArgs(body) {
    if (!body) return {};
    if (body.trim().startsWith('{')) return JSON.parse(body);
    const out = {};
    for (const pair of body.split('&')) {
      const [k, v = ''] = pair.split('=');
      out[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, ' '));
    }
    return out;
  }

  function respond(status, body, headers = {}) {
    return { status, headers, body: typeof body === 'string' ? body : JSON.stringify(body) };
  }

  function taskView(t) {
    return {
      id: t.id,
      content: t.content,
      description: t.description ?? '',
      project_id: t.project_id,
      labels: t.labels ?? [],
      priority: t.priority ?? 1,
      checked: Boolean(t.checked),
      is_deleted: Boolean(t._deleted),
      due: t.due ?? null,
      added_at: t.added_at,
      updated_at: t.updated_at,
    };
  }

  function findProjectByName(name) {
    for (const p of projects.values()) if (p.name === name && !p._deleted && !p.is_archived) return p;
    return null;
  }
  function makeProject(name) {
    const p = { id: newId(), name, is_archived: false };
    projects.set(p.id, p);
    return p;
  }
  const projectView = (p) => ({ id: p.id, name: p.name, is_archived: Boolean(p.is_archived) });

  async function handler(url, opts = {}) {
    const answer = await serve(url, opts);
    const u = new URL(url);
    const key = `${opts.method ?? 'GET'} ${u.pathname.replace(/^\/api\/v1/, '')}`;
    if (losing.delete(key)) throw new Error('couldn\'t reach api.todoist.com: connection closed (a test)');
    return answer;
  }

  async function serve(url, { method = 'GET', headers = {}, body } = {}) {
    const u = new URL(url);
    const path = u.pathname.startsWith('/api/v1') ? u.pathname.slice('/api/v1'.length) : u.pathname;
    requests.push({ method, path: `${path}${u.search}`, body: body ?? null });

    const auth = headers.Authorization ?? headers.authorization ?? '';
    if (auth !== `Bearer ${token}`) return respond(401, { error: 'Invalid token' });

    const forced = takeFailure(method, path);
    if (forced) {
      const respHeaders = forced.retryAfter != null ? { 'retry-after': String(forced.retryAfter) } : {};
      const extra = forced.retryAfter != null ? { error_extra: { retry_after: forced.retryAfter } } : {};
      return respond(forced.status, forced.body ?? { error: 'forced failure (test)', ...extra }, respHeaders);
    }

    const data = path === '/sync' ? syncArgs(body) : body ? JSON.parse(body) : {};
    const now = new Date().toISOString();

    if (method === 'GET' && path === '/user') {
      return respond(200, user);
    }

    if (method === 'GET' && path === '/projects') {
      const active = [...projects.values()].filter((p) => !p.is_archived && !p._deleted);
      return respond(200, page(active.map(projectView), u.searchParams.get('cursor')));
    }
    if (method === 'POST' && path === '/projects') {
      return respond(200, projectView(makeProject(data.name)));
    }
    const projectMatch = /^\/projects\/([^/]+)$/.exec(path);
    if (projectMatch && method === 'GET') {
      const p = projects.get(projectMatch[1]);
      if (!p || p._deleted) return respond(404, { error: 'project not found' });
      return respond(200, projectView(p));
    }
    // A task can't go to or be listed from a project Todoist no longer has.
    const projectOf = method === 'GET' && path === '/tasks' ? u.searchParams.get('project_id')
      : method === 'POST' && path === '/tasks' ? data.project_id : null;
    if (projectOf != null) {
      const p = projects.get(String(projectOf));
      if (!p || p._deleted) return respond(404, { error: 'project not found' });
      if (p.is_archived) return respond(400, { error: 'project is archived' });
    }

    if (method === 'GET' && path === '/tasks') {
      const projectId = u.searchParams.get('project_id');
      const open = [...tasks.values()].filter((t) => !t.checked && !t._deleted
        && (projectId == null || t.project_id === projectId));
      return respond(200, page(open.map(taskView), u.searchParams.get('cursor')));
    }
    if (method === 'POST' && path === '/tasks') {
      const t = bump({
        id: newId(),
        content: data.content,
        description: data.description ?? '',
        project_id: data.project_id,
        labels: data.labels ?? [],
        priority: data.priority ?? 1,
        checked: false,
        due: data.due_date ? { date: data.due_date, string: data.due_date }
          : data.due_string ? { date: null, string: data.due_string }
            : null,
        added_at: now,
        updated_at: now,
      });
      tasks.set(t.id, t);
      return respond(200, taskView(t));
    }

    const taskMatch = /^\/tasks\/([^/]+)(\/(close|reopen))?$/.exec(path);
    if (taskMatch && method === 'GET' && !taskMatch[3]) {
      const t = tasks.get(taskMatch[1]);
      if (!t || t._deleted || (hideCompleted && t.checked)) return respond(404, { error: 'task not found' });
      return respond(200, taskView(t));
    }
    if (taskMatch && method === 'POST') {
      const [, id, , action] = taskMatch;
      const t = tasks.get(id);
      if (!t || t._deleted) return respond(404, { error: 'task not found' });
      if (action === 'close') {
        t.checked = true;
      } else if (action === 'reopen') {
        t.checked = false;
      } else {
        if (data.content !== undefined) t.content = data.content;
        if (data.description !== undefined) t.description = data.description;
        if (data.labels !== undefined) t.labels = data.labels;
        if (data.priority !== undefined) t.priority = data.priority;
        if ('due_date' in data) t.due = data.due_date ? { date: data.due_date, string: data.due_date } : null;
        if ('due_string' in data) t.due = data.due_string ? { date: null, string: data.due_string } : null;
      }
      t.updated_at = now;
      bump(t);
      return action ? respond(204, '') : respond(200, taskView(t));
    }
    if (taskMatch && method === 'DELETE') {
      const [, id] = taskMatch;
      const t = tasks.get(id);
      if (!t || t._deleted) return respond(404, { error: 'task not found' });
      t._deleted = true;
      t.updated_at = now;
      bump(t);
      return respond(204, '');
    }

    if (method === 'POST' && path === '/sync') {
      const since = data.sync_token && data.sync_token !== '*' ? Number(data.sync_token) : 0;
      const items = [...tasks.values()]
        .filter((t) => t._rev > since && (since > 0 || (!t.checked && !t._deleted)))
        .map((t) => ({ ...taskView(t), is_deleted: Boolean(t._deleted) }));
      return respond(200, { sync_token: String(rev), full_sync: since === 0, items });
    }

    return respond(404, { error: `no such route: ${method} ${path}` });
  }

  return {
    handler,
    fail,
    clearFailure,
    // The next `METHOD /path` call is done, but its answer never arrives.
    lose: (key) => losing.add(key),
    requests,
    // A change made in Todoist itself: `fields` (a task's Todoist fields) merged into task `id`.
    edit: (id, fields) => {
      const t = tasks.get(id);
      Object.assign(t, fields, { updated_at: new Date().toISOString() });
      bump(t);
      return taskView(t);
    },
    // All tasks, open, done and deleted, as Todoist shows them.
    all: () => [...tasks.values()].map(taskView),
    // Test setup helpers: seed a project directly (as if it already existed in Todoist).
    addProject: (name) => findProjectByName(name) ?? makeProject(name),
    // Another project of the same name (Todoist allows it).
    addProjectAlways: (name) => makeProject(name),
    // The user deleted or archived a project in Todoist.
    deleteProject: (id) => {
      projects.get(String(id))._deleted = true;
    },
    archiveProject: (id) => {
      projects.get(String(id)).is_archived = true;
    },
    task: (id) => (tasks.has(id) ? taskView(tasks.get(id)) : null),
  };
}

export const BASE_URL = BASE;
