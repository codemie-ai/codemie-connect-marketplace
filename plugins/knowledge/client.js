// Knowledge's page (design §8 "Its page"): the chosen folder, Build style card (with the
// "Ask AI" checkbox, off and remembered), the counts Settings › Your voice also shows, and a
// stub "New person page". Every value that reaches the DOM goes through `esc`; the page calls
// only its own host commands (`pickFolder`, `build`, `newPerson`, `summary`) — it never reads
// Connect's copy of the voice.
export function apply(ctx) {
  const { esc, setRow, setCard } = ctx.ui;

  let summary = { folder: null, people: 0, peopleWithProfile: 0, rules: 0, style: false };
  let askAi = false;
  let busy = false;
  let notice = '';
  let error = '';

  async function refresh() {
    try {
      summary = await ctx.call('summary', {});
    } catch (e) {
      error = e.message;
    }
    ctx.render();
  }

  async function choose() {
    busy = true;
    error = '';
    ctx.render();
    try {
      const { folder } = await ctx.call('pickFolder', {});
      if (folder) notice = 'Folder chosen.';
    } catch (e) {
      error = e.message;
    }
    busy = false;
    await refresh();
  }

  async function build() {
    busy = true;
    error = '';
    notice = '';
    ctx.render();
    try {
      const answer = await ctx.call('build', { ai: askAi });
      if (answer.ask) {
        notice = answer.ask;
        const again = await ctx.call('build', { ai: askAi, replace: true });
        notice = again.warning || 'Style card written.';
      } else {
        notice = answer.warning || 'Style card written.';
      }
    } catch (e) {
      error = e.message;
    }
    busy = false;
    await refresh();
  }

  async function newPerson(name, address) {
    busy = true;
    error = '';
    notice = '';
    ctx.render();
    try {
      await ctx.call('newPerson', { name, address });
      notice = `Added a page for ${name}.`;
    } catch (e) {
      error = e.message;
    }
    busy = false;
    await refresh();
  }

  ctx.activities.add({
    id: 'home',
    label: 'Knowledge',
    render() {
      const folderLine = summary.folder
        ? `<code>${esc(summary.folder)}</code>`
        : 'No folder yet';
      const styleLine = summary.style ? 'a style card' : 'no style card yet';
      return `<div class="kn-page">
        <h1>Knowledge</h1>
        ${setCard('Folder', [
          setRow('Folder', folderLine, '<button class="btn" data-kn-choose>Choose folder…</button>'),
        ])}
        ${setCard('Style card', [
          setRow(
            'Build style card',
            'Reads the messages you sent and writes Voice/style.md.',
            `<label class="kn-ai"><input type="checkbox" data-kn-ai ${askAi ? 'checked' : ''}> `
              + 'Ask AI to describe my style (uses Knowledge’s row in Settings › AI)</label> '
              + `<button class="btn primary" data-kn-build ${busy ? 'disabled' : ''}>Build style card</button>`,
          ),
        ])}
        ${setCard('Counts', [
          setRow('People', `${summary.people} (${summary.peopleWithProfile} with a profile)`, ''),
          setRow('Instructions', String(summary.rules), ''),
          setRow('Style card', styleLine, ''),
          setRow('', 'See and edit what Connect adds in Settings › Your voice.', ''),
        ])}
        ${setCard('New person page', [
          setRow(
            'Name and address',
            '',
            '<input class="inp" type="text" placeholder="Name" data-kn-name> '
              + '<input class="inp" type="text" placeholder="Address (optional)" data-kn-address> '
              + `<button class="btn" data-kn-new-person ${busy ? 'disabled' : ''}>Add</button>`,
          ),
        ])}
        <div class="kn-out">
          ${notice ? `<p class="set-ok">${esc(notice)}</p>` : ''}
          ${error ? `<p class="error">${esc(error)}</p>` : ''}
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
    if ('knChoose' in el.dataset) choose();
    else if ('knBuild' in el.dataset) build();
    else if ('knNewPerson' in el.dataset && page) {
      const name = page.querySelector('[data-kn-name]')?.value?.trim() ?? '';
      const address = page.querySelector('[data-kn-address]')?.value?.trim() ?? '';
      if (name) newPerson(name, address);
    } else if ('knOpen' in el.dataset) {
      ctx.go('knowledge:home');
    }
  });

  ctx.listen('change', (ev) => {
    if ('knAi' in (ev.target.dataset || {})) {
      askAi = ev.target.checked;
    }
  });

  refresh();
}
