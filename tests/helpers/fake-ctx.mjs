// A small stand-in for the `ctx` a plugin's host half gets from `apply(ctx)` (Connect's plugin
// API, src-tauri/src/plugins/host/prelude.js), enough to exercise a task-provider plugin without
// the real QuickJS host: `settings`, `http.fetch` routed through a handler, `store`, `log`, and
// `tasks.provide` plus `run(op, args)` to call whatever the plugin registered, the way the host
// would when it answers `tasks:<op>`.
//
// A subset of echo-plugins' fake-ctx.mjs: only what the Todoist plugin's `apply(ctx)` needs.

export function fakeCtx({ settings = {}, fetchHandler } = {}) {
  const log = [];
  const storeFiles = new Map();
  const providedOps = {};

  const ctx = {
    settings: {
      get: (key) => (key in settings ? settings[key] : undefined),
      set: (key, value) => {
        settings[key] = value;
      },
    },

    http: {
      // (url, {method, headers, body}) -> {status, headers, body}, the same shape Connect's real
      // ctx.http.fetch answers with (PLUGIN-ENGINE.md §4.1). Never touches the network: every call
      // goes through the handler the test supplied (typically a fakeTodoist()).
      fetch: async (url, opts = {}) => {
        if (typeof fetchHandler !== 'function') {
          throw new Error('fakeCtx: no fetchHandler was given');
        }
        return fetchHandler(url, opts);
      },
    },

    store: {
      read: (path) => (storeFiles.has(path) ? storeFiles.get(path) : null),
      write: (path, text) => {
        storeFiles.set(path, text);
        return text;
      },
      remove: (path) => {
        storeFiles.delete(path);
      },
    },

    log: (...parts) => {
      log.push(parts.map(String).join(' '));
    },

    // ctx.tasks.provide({status, list, changedSince, create, update, complete, remove}): records
    // the ops a plugin registered, so `run(op, args)` can call them as the host would.
    tasks: {
      provide: (ops) => {
        if (!ops || typeof ops !== 'object') {
          throw new TypeError('ctx.tasks.provide needs an object of functions');
        }
        Object.assign(providedOps, ops);
      },
    },

    // Test-only: calls the function the plugin gave `ctx.tasks.provide` for `op`, as the host
    // would when the core asks `tasks:<op>`.
    run: (op, args) => {
      const fn = providedOps[op];
      if (typeof fn !== 'function') {
        throw new Error(`fakeCtx: the plugin didn't provide a "${op}" task op`);
      }
      return fn(args);
    },

    // Test-only inspection, never part of the real ctx.
    _log: log,
    _store: storeFiles,
  };

  return ctx;
}
