# CodeMie Connect marketplace

Plugins for [CodeMie Connect](https://github.com/codemie-ai/codemie-connect). Connect lists this marketplace as a built-in source, so its plugins show in Settings › Plugins without adding anything.

## Layout

The layout follows Echo's `onetest-ai/echo-plugins`, which Connect's plugin engine reads:

- `echo-marketplace.json` at the root: `{name, owner, featured: [id], plugins: [{id, source: "./plugins/<id>", categories}]}`.
- `plugins/<id>/`: one folder per plugin with its manifest and `main.js`.

## Plugins

| Plugin | What it does | Status |
|---|---|---|
| Todoist | Task provider: replaces Connect's built-in tasks while it is on, showing your open tasks from every Todoist project (or one) | available |
| Knowledge | Your voice for Connect's reply drafts — people, a style card from your sent messages, instructions and facts — kept as Markdown in a folder you choose | available |
| Podervianskyi notes | An informal meeting analysis in Russian, in Les Podervianskyi's style | planned |

## Use it in Connect while developing

Settings › Plugins › Marketplaces › Add, then this repository's folder path, or `codemie-ai/codemie-connect-marketplace`.
