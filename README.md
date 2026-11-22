# CodeMie Connect marketplace

Plugins for [CodeMie Connect](https://github.com/codemie-ai/codemie-connect). Connect lists this marketplace as a built-in source, so its plugins show in Settings › Plugins without adding anything.

## Layout

The layout follows Echo's `onetest-ai/echo-plugins`, which Connect's plugin engine reads:

- `echo-marketplace.json` at the root: `{name, owner, featured: [id], plugins: [{id, source: "./plugins/<id>", categories}]}`.
- `plugins/<id>/`: one folder per plugin with its manifest and `main.js`.

## Planned plugins

| Plugin | What it does |
|---|---|
| Todoist | Task provider: replaces Connect's built-in tasks while it is on |
| Reply context | Per-person profiles and the user's style card for drafting replies |
| Podervianskyi notes | An informal meeting analysis in Russian, in Les Podervianskyi's style |

## Use it in Connect while developing

Settings › Plugins › Marketplaces › Add, then this repository's folder path, or `codemie-ai/codemie-connect-marketplace`.
