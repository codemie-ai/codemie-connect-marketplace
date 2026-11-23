// An in-memory stand-in for the Todoist REST API v1 (https://api.todoist.com/api/v1). Never
// touches the network: its `handler` has the same shape as Connect's `ctx.http.fetch` — async
// (url, {method, headers, body}) -> {status, headers, body}, every value text — so it can be
// passed straight to fakeCtx({ fetchHandler: fakeTodoist(...).handler }).
//
// Covers what the Todoist plugin uses: GET /user, GET|POST /projects, GET|POST /tasks,
// POST /tasks/{id}, /tasks/{id}/close, /tasks/{id}/reopen, DELETE /tasks/{id}, and POST /sync
// with sync tokens. Also a bearer-token check, a request log, and failure injection (`fail`).

const BASE = 'https://api.todoist.com/api/v1';

export function fakeTodoist({ token = 'fake-todoist-token', user = { id: 'u1', email: 'you@example.test', full_name: 'You' } } = {}) {
  const projects = new Map(); // id -> {id, name}
  const tasks = new Map(); // id -> Todoist task record (+ internal _rev, _deleted)
  const requests = []; // {method, path, body}
  const failures = new Map(); // "METHOD /path" or "/path" -> {status, retryAfter, body, once}
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
    for (const p of projects.values()) if (p.name === name) return p;
    return null;
  }

  async function handler(url, { method = 'GET', headers = {}, body } = {}) {
    const u = new URL(url);
    const path = u.pathname.startsWith('/api/v1') ? u.pathname.slice('/api/v1'.length) : u.pathname;
    requests.push({ method, path: `${path}${u.search}`, body: body ?? null });

    const auth = headers.Authorization ?? headers.authorization ?? '';
    if (auth !== `Bearer ${token}`) return respond(401, { error: 'Invalid token' });

    const forced = takeFailure(method, path);
    if (forced) {
      const respHeaders = forced.retryAfter != null ? { 'retry-after': String(forced.retryAfter) } : {};
      return respond(forced.status, forced.body ?? { error: 'forced failure (test)' }, respHeaders);
    }

    const data = body ? JSON.parse(body) : {};
    const now = new Date().toISOString();

    if (method === 'GET' && path === '/user') {
      return respond(200, user);
    }

    if (method === 'GET' && path === '/projects') {
      return respond(200, { results: [...projects.values()], next_cursor: null });
    }
    if (method === 'POST' && path === '/projects') {
      if (findProjectByName(data.name)) return respond(400, { error: 'project already exists' });
      const p = { id: newId(), name: data.name };
      projects.set(p.id, p);
      return respond(200, p);
    }

    if (method === 'GET' && path === '/tasks') {
      const projectId = u.searchParams.get('project_id');
      const open = [...tasks.values()].filter((t) => !t.checked && !t._deleted
        && (projectId == null || t.project_id === projectId));
      return respond(200, { results: open.map(taskView), next_cursor: null });
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
      return respond(200, taskView(t));
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
        .filter((t) => t._rev > since)
        .map((t) => ({ ...taskView(t), is_deleted: Boolean(t._deleted) }));
      return respond(200, { sync_token: String(rev), full_sync: since === 0, items });
    }

    return respond(404, { error: `no such route: ${method} ${path}` });
  }

  return {
    handler,
    fail,
    clearFailure,
    requests,
    // Test setup helpers: seed a project directly (as if it already existed in Todoist).
    addProject: (name) => {
      const existing = findProjectByName(name);
      if (existing) return existing;
      const p = { id: newId(), name };
      projects.set(p.id, p);
      return p;
    },
    task: (id) => (tasks.has(id) ? taskView(tasks.get(id)) : null),
  };
}

export const BASE_URL = BASE;
