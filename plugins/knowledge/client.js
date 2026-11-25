// Knowledge's page (design §8 "Its page"): the chosen folder, Build style card (with the
// "Ask AI" checkbox, off and remembered), the counts Settings › Your voice also shows, and a
// stub "New person page". Every value that reaches the DOM goes through `esc`; the page calls
// only its own host commands (`pickFolder`, `build`, `newPerson`, `summary`, `setAskAi`) — it
// never reads Connect's copy of the voice.
//
// The state transitions below (`pressBuild`, `confirmReplace`, `cancelReplace`, …) take a plain
// `{call(name, args)}` and a mutable state object, with no DOM at all, so they're exported and
// unit-tested directly (`tests/knowledge/client.test.mjs`) without a browser. `apply(ctx)`, at
// the bottom, is the only part that touches the DOM.

export function initialState() {
  return {
    summary: { folder: null, people: 0, peopleWithProfile: 0, rules: 0, style: false, buildWithAi: false, unreadable: [] },
    askAi: false,
    busy: false,
    notice: '',
    error: '',
    // The text of Build's own "Replace the style card you edited?" question (design §8 step 4),
    // while Connect waits for the user's own Replace or Cancel — never answered by the page
    // itself (review C1: the page must never call `build {replace: true}` on its own).
    pendingAsk: null,
  };
}

export async function loadSummary(ctx, state) {
  try {
    state.summary = await ctx.call('summary', {});
    state.askAi = Boolean(state.summary.buildWithAi);
  } catch (e) {
    state.error = e.message;
  }
  return state;
}

export async function choose(ctx, state) {
  state.busy = true;
  state.error = '';
  try {
    const { folder } = await ctx.call('pickFolder', {});
    if (folder) state.notice = 'Folder chosen.';
  } catch (e) {
    state.error = e.message;
  }
  state.busy = false;
  await loadSummary(ctx, state);
  return state;
}

// Build style card, pressed: review C1's fix. When `build` answers `{ask}`, that question is put
// in `state.pendingAsk` and shown to the user with Replace and Cancel — this function makes
// exactly one `build` call and never answers the question itself, however it comes back.
export async function pressBuild(ctx, state) {
  state.busy = true;
  state.error = '';
  state.notice = '';
  state.pendingAsk = null;
  try {
    const answer = await ctx.call('build', { ai: state.askAi });
    if (answer.ask) {
      state.pendingAsk = answer.ask;
    } else {
      state.notice = answer.warning || 'Style card written.';
    }
  } catch (e) {
    state.error = e.message;
  }
  state.busy = false;
  await loadSummary(ctx, state);
  return state;
}

// The user presses Replace on the question `pressBuild` showed: the only path that ever sends
// `{replace: true}`.
export async function confirmReplace(ctx, state) {
  state.busy = true;
  state.error = '';
  state.pendingAsk = null;
  try {
    const answer = await ctx.call('build', { ai: state.askAi, replace: true });
    state.notice = answer.warning || 'Style card written.';
  } catch (e) {
    state.error = e.message;
  }
  state.busy = false;
  await loadSummary(ctx, state);
  return state;
}

// The user presses Cancel: no further call at all, the existing card is kept untouched.
export function cancelReplace(state) {
  state.pendingAsk = null;
  state.notice = 'Kept your style card.';
  return state;
}

// The "Ask AI" checkbox, remembered across page loads (spec §8) through Knowledge's own
// `setAskAi` command.
export async function setAskAi(ctx, state, value) {
  state.askAi = Boolean(value);
  try {
    await ctx.call('setAskAi', { value: state.askAi });
  } catch (e) {
    state.error = e.message;
  }
  return state;
}

export async function addPerson(ctx, state, name, address) {
  state.busy = true;
  state.error = '';
  state.notice = '';
  try {
    await ctx.call('newPerson', { name, address });
    state.notice = `Added a page for ${name}.`;
  } catch (e) {
    state.error = e.message;
  }
  state.busy = false;
  await loadSummary(ctx, state);
  return state;
}

// The people pages Knowledge couldn't read (a frontmatter that opens and never closes, or a file
// it can't open), by name, so a page never drops out of the counts silently; `''` when none.
export function skippedLine(summary) {
  const names = Array.isArray(summary?.unreadable) ? summary.unreadable : [];
  if (!names.length) return '';
  const pages = names.length === 1 ? 'page' : 'pages';
  return `Skipped ${names.length} ${pages} it couldn't read: ${names.join(', ')}`;
}

export function apply(ctx) {
  const { esc, setRow, setCard } = ctx.ui;
  const state = initialState();

  async function act(fn) {
    await fn();
    ctx.render();
  }

  ctx.activities.add({
    id: 'home',
    label: 'Knowledge',
    render() {
      const folderLine = state.summary.folder
        ? `<code>${esc(state.summary.folder)}</code>`
        : 'No folder yet';
      const styleLine = state.summary.style ? 'a style card' : 'no style card yet';
      const buildControls = state.pendingAsk
        ? `<p class="kn-ask">${esc(state.pendingAsk)}</p>`
          + `<button class="btn primary" data-kn-replace ${state.busy ? 'disabled' : ''}>Replace</button> `
          + `<button class="btn" data-kn-cancel-replace ${state.busy ? 'disabled' : ''}>Cancel</button>`
        : `<label class="kn-ai"><input type="checkbox" data-kn-ai ${state.askAi ? 'checked' : ''}> `
            + 'Ask AI to describe my style (uses Knowledge’s row in Settings › AI)</label> '
            + `<button class="btn primary" data-kn-build ${state.busy ? 'disabled' : ''}>Build style card</button>`;
      return `<div class="kn-page">
        <h1>Knowledge</h1>
        ${setCard('Folder', [
          setRow('Folder', folderLine, '<button class="btn" data-kn-choose>Choose folder…</button>'),
        ])}
        ${setCard('Style card', [
          setRow('Build style card', 'Reads the messages you sent and writes Voice/style.md.', buildControls),
        ])}
        ${setCard('Counts', [
          setRow('People', `${state.summary.people} (${state.summary.peopleWithProfile} with a profile)`, ''),
          ...(skippedLine(state.summary) ? [setRow('', esc(skippedLine(state.summary)), '')] : []),
          setRow('Instructions', String(state.summary.rules), ''),
          setRow('Style card', styleLine, ''),
          setRow('', 'See and edit what Connect adds in Settings › Your voice.', ''),
        ])}
        ${setCard('New person page', [
          setRow(
            'Name and address',
            '',
            '<input class="inp" type="text" placeholder="Name" data-kn-name> '
              + '<input class="inp" type="text" placeholder="Address (optional)" data-kn-address> '
              + `<button class="btn" data-kn-new-person ${state.busy ? 'disabled' : ''}>Add</button>`,
          ),
        ])}
        <div class="kn-out">
          ${state.notice ? `<p class="set-ok">${esc(state.notice)}</p>` : ''}
          ${state.error ? `<p class="error">${esc(state.error)}</p>` : ''}
        </div>
      </div>`;
    },
  });

  ctx.settings.add({
    render: () => setCard('', [
      setRow('Knowledge', 'Your voice and facts for Connect’s reply drafts.', '<button class="btn" data-kn-open>Open Knowledge</button>'),
    ]),
  });

  ctx.listen('click', (ev) => {
    const el = ev.target.closest('button');
    if (!el) return;
    const page = ev.target.closest('.kn-page');
    if ('knChoose' in el.dataset) act(() => choose(ctx, state));
    else if ('knBuild' in el.dataset) act(() => pressBuild(ctx, state));
    else if ('knReplace' in el.dataset) act(() => confirmReplace(ctx, state));
    else if ('knCancelReplace' in el.dataset) act(() => cancelReplace(state));
    else if ('knNewPerson' in el.dataset && page) {
      const name = page.querySelector('[data-kn-name]')?.value?.trim() ?? '';
      const address = page.querySelector('[data-kn-address]')?.value?.trim() ?? '';
      if (name) act(() => addPerson(ctx, state, name, address));
    } else if ('knOpen' in el.dataset) {
      ctx.go('knowledge:home');
    }
  });

  ctx.listen('change', (ev) => {
    if ('knAi' in (ev.target.dataset || {})) {
      act(() => setAskAi(ctx, state, ev.target.checked));
    }
  });

  act(() => loadSummary(ctx, state));
}
