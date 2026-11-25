# Knowledge

Your voice for Connect's reply drafts, kept as plain Markdown in a folder you choose: a style
card built from your sent messages, per-person profiles, instructions for who or what you're
replying to, and facts it can look up in your own notes.

Choosing Knowledge in Settings › Your voice makes Connect ask it for a style card, a person's
profile and instructions before every reply draft — manual or automation-made — and, when turned
on, for short notes from your folder that bear on the thread. Turning the voice off, or removing
Knowledge, never touches your folder: Knowledge only ever reads it, except for the style card,
your instructions and a new person's stub page.

## What it reads

- **People** — every page under the People folder (its name matched without regard to case, so
  `people/` works too) whose frontmatter parses, however little it says. A page's name comes from
  its frontmatter `name`, else its `# ` heading, else its first alias, else its file name. Its
  *profile* (how you write to them) is the sections named in the "Sections on how to write to
  someone" setting, best first — never the whole page. Its *about* (a few facts about them) is the
  "Sections about the person" setting, the same way. A page with none of the listed sections has
  no profile or about text; it still counts as a person.
- **The style card** — `Voice/style.md`'s body. When "Your own page" names a page, its
  Communication Preferences / Communication Style / Writing style sections become the card's
  read-only head, shown above the editable card in Settings › Your voice.
- **Instructions** — `Voice/rules.md`: one instruction per `## ` heading (`to:`, `chat:`,
  `domain:`, `topic:`, `no-profile`, `everyone`, each optionally followed by ` · mail` or
  ` · teams`). Anything else is skipped, not an error.
- **Teams ids** — `Voice/ids.json`, `{"<person file name>": ["<Teams user id>", …]}`, merged with
  a page's own `teamsIds`.
- **Facts** — see below.

## What it writes

- `Voice/style.md` and `Voice/rules.md`, only when you edit them in Settings › Your voice, import
  skills there, or press Build style card on Knowledge's own page — always as a compare-and-swap
  write over the exact text it last read, so an edit made in the folder at the same time is never
  overwritten: Connect sees "The page changed in your folder. Refresh and try again." instead.
- A new person's stub page (name and, if given, an address) under the People folder, when you use
  "New person page". Knowledge never writes a profile's or an about's *text* with AI; that waits
  for a later skill runner.

Nothing else in your folder is ever changed, and no file over 200 KB or past the first 2,000
people pages is read at all (the rest just count as skipped).

## Privacy

Everything above happens on this Mac, inside the folder you chose. Knowledge's manifest asks for
no network, no web, no sign-in and no "deliver" — Connect refuses any reply-context plugin that
does. The only places anything leaves this plugin are the drafts your Mail replies and Teams
replies profile already makes (Settings › AI), and, only when you tick "Ask AI to describe my
style", Knowledge's own Settings › AI row for its wording pass — at most 40 of your sent messages,
addresses and phone numbers removed, recipients' names replaced by "the recipient".

## The folder

```
<folder>/
  People/<name>.md       a person page (any file name; "People" matched without regard to case)
  Voice/style.md         the style card: frontmatter basedOn {mail, teams} and built (Build's own sha)
  Voice/rules.md         instructions, one "## " section each
  Voice/ids.json         optional: {"<person file name>": ["<Teams user id>", …]}
  <any other folder>     your notes — read for facts, never written
```

## Settings

| Setting | Type | Default | What it's for |
|---|---|---|---|
| People folder | string | `People` | Where person pages live. |
| Voice folder | string | `Voice` | Where the style card and instructions live. |
| Your own page | string | *(none)* | A page whose Communication Preferences / Style / Writing style sections become the style card's read-only head. |
| Sections on how to write to someone, best first | string | *(a built-in list)* | The headings, in priority order, that make up a person's profile. |
| Sections about the person | string | *(a built-in list)* | The headings, in priority order, that make up a person's "about". |

## Facts

With "Add facts from Knowledge" on, Connect sends Knowledge the key names, codes and amounts it
found in a message (never the message itself) and the matched person's page id, so Knowledge can
leave that person's own page out. Knowledge walks its folder — skipping hidden folders, `.git`,
the Voice folder, that one page, anything over 200 KB, and anything past the first 5,000 pages —
and scores each remaining page: a term in its `# ` heading or an alias is worth 5, in a `## `
heading or a frontmatter value 3, in the body 1. The best five pages (by score, then by how many
distinct terms matched, then newest first) each give a short snippet: their heading as the title,
the lines that held a term with their nearest `## ` heading, frontmatter removed and `[[links]]`
read as text, cut to 500 characters. The whole search stops after 2.5 seconds and answers what it
has by then. Facts are never written anywhere by Knowledge, and Connect never keeps them past the
draft they were found for.

## Git

Knowledge never runs git and never reads inside `.git/` or any hidden folder. If your folder is a
git repository you already keep with your own tools, Knowledge's writes (the style card, your
instructions, a new person's stub) simply show up as uncommitted changes for you to commit or
ignore as you like.

## Skills

Knowledge 1.0.0 never reads a skills folder on its own. The reply-shaping rules in a skill become
ordinary instructions only after you import them in Settings › Your voice › Import from skills…,
where you see a preview and choose what to add; a skill whose value is a *procedure* (building a
profile, writing to the knowledge base) is listed as waiting for a later skill runner, not
imported. A future version of Knowledge may read a `Skills/<name>/SKILL.md` with `applies:` in
its frontmatter as a read-only instruction, without any change needed in Connect.

## Changelog

- 1.0.0: the six `reply-context` ops (`status`, `export`, `context`, `facts`, `save`, `remove`),
  a deterministic facts search over this folder, a style card Build (with an optional, opt-in AI
  wording pass), and Knowledge's own page. Published to the `replies` category, featured.
