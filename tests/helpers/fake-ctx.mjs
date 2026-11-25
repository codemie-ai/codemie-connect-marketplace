// A small stand-in for the `ctx` a plugin's host half gets from `apply(ctx)` (Connect's plugin
// API, src-tauri/src/plugins/host/prelude.js), enough to exercise a provider plugin without the
// real QuickJS host: `settings`, `http.fetch` routed through a handler, `store`, `log`,
// `tasks.provide`, `replyContext.provide`/`.sent`, `fs` and `system.pickFolder` over a temp
// folder, `claude.run`, `command`/`crypto.sha256` (Knowledge's page commands and its
// read-then-write compare-and-swap, the same `ctx.crypto.sha256` the real prelude.js gives a
// plugin), and `run(op, args)` to call whatever a plugin registered, the way the host would when
// it answers `tasks:<op>`, `replyContext:<op>` or a page's own command.
//
// A subset of echo-plugins' fake-ctx.mjs: only what Todoist's and Knowledge's `apply(ctx)` need.

import { mkdtempSync, existsSync, readdirSync, readFileSync, writeFileSync, appendFileSync,
  mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative, sep, extname } from 'node:path';
import { createHash } from 'node:crypto';

const sha256 = (text) => createHash('sha256').update(String(text)).digest('hex');

// `fs.rs`'s read limits: 1 MB without `max`, never more than 4 MB.
const READ_DEFAULT = 1 << 20;
const READ_MAX = 4 << 20;

export function fakeCtx({
  settings = {},
  fetchHandler,
  // `ctx.fs` / `ctx.system.pickFolder` operate over this folder; a fresh temp one when omitted,
  // so a test can either hand in a folder it seeded with real files, or let one be made.
  dir,
  // What `ctx.system.pickFolder` answers: a folder path, or `null`/`false` for "the user
  // cancelled". Defaults to `dir` itself (as if the user had already chosen it).
  pickFolder,
  // `ctx.replyContext.sent`'s messages: an array, or a function `(filter) => messages`.
  sent = [],
  // `ctx.claude.run`: `{script: (opts) => string | answer}` (recorded in `_claudeCalls`) or
  // `{answer: string}` for a fixed reply; omitted, it answers an empty string.
  claude,
  // The fake clock's starting value (ms since epoch); `ctx.fs.write`/`.append` stamp the files
  // they touch with it, so a test controls "now" instead of the real filesystem's mtime
  // resolution. Advance it with the returned `_clock.advance(ms)` / `.set(ms)`.
  now,
} = {}) {
  const log = [];
  const storeFiles = new Map();
  const providedOps = {}; // ctx.tasks.provide
  const replyOps = {}; // ctx.replyContext.provide
  const commands = {}; // ctx.command (a page's own host commands, called through ctx.call)
  const claudeCalls = [];
  const clock = { value: now ?? Date.UTC(2026, 10, 25) };
  const mtimes = new Map(); // relative, '/'-separated path -> ms (the clock's own unit), for
  // files this ctx wrote; `statOf`/`walkFiles` convert to seconds before handing it to a plugin
  // (review I2: the real host's `fs.rs` `mtime_of` answers seconds since 1970, not milliseconds).

  const root = dir ?? mkdtempSync(join(tmpdir(), 'connect-plugin-'));
  const toAbs = (rel) => join(root, rel ?? '');
  const toRel = (abs) => relative(root, abs).split(sep).join('/');

  function statOf(rel) {
    const abs = toAbs(rel);
    if (!existsSync(abs)) return null;
    const st = statSync(abs);
    const kind = st.isDirectory() ? 'dir' : 'file';
    return {
      kind,
      size: kind === 'file' ? st.size : 0,
      mtime: Math.floor((mtimes.get(rel) ?? st.mtimeMs) / 1000),
      real: rel,
    };
  }

  // Files under `path` (default the root), hidden names skipped unless `hidden`, filtered to
  // `ext` when given — the same shape as `fs.rs`'s `walk_files`, minus the link checks a fake
  // folder doesn't need.
  function walkFiles({ path = '', ext = [], hidden = false } = {}) {
    const extSet = new Set((ext ?? []).map((e) => String(e).replace(/^\./, '').toLowerCase()));
    const out = [];
    const visit = (absDir) => {
      let entries;
      try {
        entries = readdirSync(absDir, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      const dirs = [];
      for (const e of entries) {
        if (!hidden && e.name.startsWith('.')) continue;
        const abs = join(absDir, e.name);
        if (e.isDirectory()) {
          dirs.push(abs);
        } else if (e.isFile()) {
          const rel = toRel(abs);
          const fileExt = extname(rel).slice(1).toLowerCase();
          if (extSet.size && !extSet.has(fileExt)) continue;
          const st = statSync(abs);
          out.push({ path: rel, size: st.size, mtime: Math.floor((mtimes.get(rel) ?? st.mtimeMs) / 1000) });
        }
      }
      for (const d of dirs) visit(d);
    };
    visit(toAbs(path));
    return out;
  }

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

    // `ctx.fs.*` over the fake root (fs.rs §"ctx.fs and ctx.system"): `root` is accepted and
    // ignored as the first argument everywhere a real call takes one (a fake has exactly one
    // granted folder), so a plugin written against the real ctx needs no change to run here.
    fs: {
      folders: () => [root],
      list: (_root, relPath = '') => readdirSync(toAbs(relPath), { withFileTypes: true })
        .map((e) => ({ name: e.name, dir: e.isDirectory() })),
      // As `fs.rs`'s `read_text`: 1 MB unless `max` asks for more (never over 4 MB); lossy
      // UTF-8 unless `{strict: true}`, which refuses `not UTF-8: <rel>` (an unfinished character
      // at the very end of a cut read is dropped, not refused).
      read: (_root, rel, o) => {
        const asked = typeof o === 'number' ? o : o?.max;
        const max = Math.min(asked > 0 ? asked : READ_DEFAULT, READ_MAX);
        const bytes = readFileSync(toAbs(rel));
        const buf = bytes.subarray(0, max);
        if (!o?.strict) return buf.toString('utf8');
        try {
          return new TextDecoder('utf-8', { fatal: true }).decode(buf, { stream: bytes.length > max });
        } catch {
          throw new Error(`not UTF-8: ${rel}`);
        }
      },
      readMany: async (_root, rels = []) => rels.map((rel) => {
        try {
          return readFileSync(toAbs(rel), 'utf8');
        } catch {
          return null;
        }
      }),
      walk: async (_root, o = {}) => walkFiles(o),
      stat: (_root, rel) => statOf(rel),
      search: async (_root, q, o = {}) => {
        const needle = o?.caseSensitive ? q : String(q).toLowerCase();
        const hits = [];
        const max = o?.max ?? 200;
        for (const f of walkFiles(o)) {
          const text = readFileSync(toAbs(f.path), 'utf8');
          const lines = text.split(/\r\n|\n/);
          for (let i = 0; i < lines.length; i += 1) {
            const hay = o?.caseSensitive ? lines[i] : lines[i].toLowerCase();
            if (hay.includes(needle)) {
              hits.push({ path: f.path, line: i + 1, text: lines[i].slice(0, 300) });
              if (hits.length >= max) return hits;
            }
          }
        }
        return hits;
      },
      append: (_root, rel, text) => {
        mkdirSync(dirname(toAbs(rel)), { recursive: true });
        appendFileSync(toAbs(rel), text.endsWith('\n') ? text : `${text}\n`);
        mtimes.set(rel, clock.value);
      },
      copyIn: async () => {
        throw new Error('fakeCtx: fs.copyIn is not faked');
      },
      // `guard`: `{ifSha}` (the write applies only over that exact text) or `{createNew: true}`
      // (only where nothing is yet) — the same two guards `fs.rs`'s CAS gives, with the same
      // wording a plugin's `save` can match against to answer Knowledge's own "The page changed
      // in your folder." refusal.
      write: (_root, rel, text, guard) => {
        const abs = toAbs(rel);
        const existed = existsSync(abs);
        if (guard?.createNew && existed) {
          throw new Error(`"${rel}" is there already`);
        }
        if (guard && Object.prototype.hasOwnProperty.call(guard, 'ifSha') && guard.ifSha !== null) {
          const current = existed ? readFileSync(abs, 'utf8') : null;
          if (current === null || sha256(current) !== guard.ifSha) {
            throw new Error(`"${rel}" changed since you read it`);
          }
        }
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, text);
        mtimes.set(rel, clock.value);
      },
      move: (_root, from, to) => {
        mkdirSync(dirname(toAbs(to)), { recursive: true });
        renameSync(toAbs(from), toAbs(to));
        mtimes.delete(from);
        mtimes.set(to, clock.value);
      },
      remove: (_root, rel) => {
        rmSync(toAbs(rel), { recursive: false, force: false });
        mtimes.delete(rel);
      },
      forget: () => {},
    },

    system: {
      // Answers the folder the test says the user chose (default `dir`/`root`), or `null` for
      // "cancelled" when `pickFolder` is explicitly `null` or `false`.
      pickFolder: async () => {
        if (pickFolder === null || pickFolder === false) return null;
        return pickFolder ?? root;
      },
    },

    // `ctx.crypto.sha256(text)`: the same sha256-in-hex the real prelude.js gives a plugin (it
    // bridges to the host's `crypto.sha256`), so a plugin can compute an `ifSha` guard from text
    // it read, without any crypto of its own — exactly how the host's own `store.update` does it.
    crypto: { sha256 },

    // `ctx.claude.run(opts)`: records every call's input in `_claudeCalls` and answers through
    // `claude.script(opts)` (a string, taken as `answer`, or a whole answer object) when given,
    // else `claude.answer` (default ""). The shape matches `claude.rs`'s real answer closely
    // enough for a plugin to read `answer` from it.
    claude: {
      run: async (opts) => {
        claudeCalls.push(opts);
        const script = claude?.script;
        const result = typeof script === 'function' ? script(opts) : (claude?.answer ?? '');
        const extra = typeof result === 'string' ? { answer: result } : (result ?? {});
        return {
          model: 'claude-sonnet-4',
          actions: [],
          usage: { input_tokens: 0, output_tokens: 0, cost_usd: 0 },
          ...extra,
        };
      },
    },

    // `ctx.replyContext.provide({status, export, context, facts, save, remove})`: records the
    // ops a provider registered, called through `run(op, args)` like `ctx.tasks.provide`'s.
    // `ctx.replyContext.sent(filter)` answers `{messages}` from `sent` (an array, or a function
    // of the filter).
    replyContext: {
      provide: (ops) => {
        if (!ops || typeof ops !== 'object') {
          throw new TypeError('ctx.replyContext.provide needs an object of functions');
        }
        Object.assign(replyOps, ops);
      },
      sent: async (filter) => ({ messages: typeof sent === 'function' ? sent(filter) : sent }),
    },

    // `ctx.tasks.provide({status, list, changedSince, create, update, complete, remove})`:
    // records the ops a plugin registered, so `run(op, args)` can call them as the host would.
    tasks: {
      provide: (ops) => {
        if (!ops || typeof ops !== 'object') {
          throw new TypeError('ctx.tasks.provide needs an object of functions');
        }
        Object.assign(providedOps, ops);
      },
    },

    // `ctx.command(name, fn)`: a page's own host command (Knowledge's `pickFolder`, `build`,
    // `newPerson`, `summary`), called back through `ctx.call(name, args)` from its client half.
    // There is no fake client half here, so a test calls it the same way `run` calls a provided
    // op, below.
    command: (name, fn) => {
      commands[name] = fn;
    },

    // Test-only: calls the function a plugin gave `ctx.tasks.provide`, `ctx.replyContext.provide`
    // or `ctx.command` for `op`/`name`, as the host would when the core asks `tasks:<op>`,
    // `replyContext:<op>`, or the page calls `ctx.call(name, args)`.
    run: (op, args) => {
      const fn = replyOps[op] ?? providedOps[op] ?? commands[op];
      if (typeof fn !== 'function') {
        throw new Error(`fakeCtx: the plugin didn't provide a "${op}" op`);
      }
      return fn(args);
    },

    // Test-only inspection, never part of the real ctx.
    _log: log,
    _store: storeFiles,
    _root: root,
    _claudeCalls: claudeCalls,
    _clock: {
      now: () => clock.value,
      advance: (ms) => {
        clock.value += ms;
      },
      set: (ms) => {
        clock.value = ms;
      },
    },
  };

  return ctx;
}
