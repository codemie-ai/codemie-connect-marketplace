# Todoist

Keeps Connect's tasks in your Todoist: one project, consistent labels, no duplicates.

Turning this plugin on in Settings › Plugins and choosing it in Settings › Tasks makes Todoist
the place every task in Connect lives: the Tasks page, Today's Tasks widget, every "add a task",
and the meeting column's "Add N to Todoist". Turning it off brings Connect's own tasks back —
nothing in Todoist, or in Connect's cache, is ever deleted by switching.

## Settings

| Setting | Type | Default | What it's for |
|---|---|---|---|
| API token | secret | — | Your Todoist API token (Todoist › Settings › Integrations › Developer). Write-only: Connect stores it, never shows it again, and never sends it anywhere but `api.todoist.com`. |
| Project | string | `Connect` | The Todoist project Connect reads and writes. Created once if it doesn't exist yet. Point it at an existing project to share it with however else you use Todoist. |
| App label | string | `connect` | Added to every task Connect makes, so Connect can tell its own tasks from ones you add directly in Todoist. |

## Labels

- The app label (above) on every task Connect makes.
- `reply`, `waiting` or `budget` by the task's kind. A plain task carries none of these.
- Labels Connect doesn't own (anything else already on the task) are kept on every update.
- Reading a task back: `budget` beats `reply` beats `waiting` beats a plain task, when more than
  one of these labels is present.

## Markers

The description holds your notes, then a blank line, then Connect's own marker lines, written
last and read as the last one of each kind:

```
<notes, with the quote and who said it>

key: <16 hex characters, Connect's idempotency key>
source: <https link, when the task came from a message — never a meeting join link>
meeting: <meeting id, when the task came from meeting notes>
owner: <Name> <<address>>   (only when the task is someone else's)
```

Any line of free text that merely *looks* like one of these markers — any case, Markdown-decorated
("**Source:** …", "> key: …") — is dropped before it's written, so a message or a note can never
plant a key, a link or an owner.

A task that is someone else's reads `<First name>: <text>` in Todoist; the prefix is stripped
again when it's read back.

Dates are always an absolute day (`YYYY-MM-DD`); Connect never sends a recurring task's due string
back, so its recurrence stays Todoist's.

## Changelog

- 1.0.0: first version.
