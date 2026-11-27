# Extensions

Phase 1 extensions are **data-only**: a manifest plus data files, never code that
runs in the app. This folder is the registry — serve it from a static host (the
default registry is this folder on GitHub raw URLs).

## Layout

```
extensions/
  index.json              generated registry index (do not edit by hand)
  README.md
  <id>/extension.json     manifest (folder name must equal the manifest id)
  <id>/<other files>      e.g. simple-mode grammars; listed in index.json with sha256
```

## Manifest

`extension.json` is an `ExtensionManifest`:

| Field | Meaning |
| --- | --- |
| `id` | Unique id, `[a-z0-9-]+`, also the install folder name. |
| `name` | Display name. |
| `version` | Semver `x.y.z`. |
| `description` | Short English description. |
| `publisher` | Publisher id, e.g. `baton`. |
| `baton` | Optional minimum Baton version. |
| `license` | SPDX id of the original work's license, e.g. `MIT`. |
| `author` | Original author or project credited. |
| `homepage` | Project page of the original work. |
| `contributes` | Map of contribution kinds; `languages` and `themes`. |

A language needs `id`, `name`, optional `extensions` (`.go`), `filenames`
(`Dockerfile`), `comments` (`line`, `block`), `indentUnit`, and a `grammar`:

- `{ "legacyMode": { "mode": "go" } }` — a mode bundled with Baton from
  `@codemirror/legacy-modes` (`mode` is the module under `mode/`; add `export`
  when the exported name differs, e.g. `{ "mode": "clike", "export": "kotlin" }`).
- `{ "simpleMode": "dotenv.json" }` — a JSON file in the extension folder in
  CodeMirror simple-mode form: `states.start` is required, regexes are strings,
  only the `i` flag is allowed.

## Themes

A theme extension contributes `contributes.themes`, an array of themes:

| Field | Meaning |
| --- | --- |
| `id` | `[a-z0-9-]+`, unique within the extension, e.g. `mocha`. |
| `name` | Display name, e.g. `Catppuccin Mocha`. |
| `type` | `light` or `dark`; missing colors fall back to Baton's built-in theme of that type. |
| `colors` | Required object; keys are `THEME_COLOR_KEYS` (`bg`, `surface`, `text`, `accent`, …) in `src/extensions/api.ts`. |
| `syntax` | Optional `THEME_SYNTAX_KEYS` (`keyword`, `string`, `comment`, …). |
| `terminal` | Optional `THEME_TERMINAL_KEYS`: the 16 ANSI colors plus `background`, `foreground`, `cursor`, `selection`. |

Values must be `#rrggbb`, `#rrggbbaa` or `rgb(r g b / NN%)`
(space-separated RGB, optional percentage alpha). Use `rgb(... / 6%)` for
`hover` and `rgb(... / 14%)` for soft tokens such as `accent-soft`.

Credit the palette's original project with the manifest's `license`, `author`
and `homepage` fields; the index carries them, and theme keywords include
`theme`, `light`/`dark` and the theme names. Use ids like `theme-<name>`.

## Adding a language extension

1. Create `extensions/lang-<name>/extension.json` with the manifest above and a
   language entry using a legacy mode or a simple-mode JSON file.
2. For a legacy mode, confirm the module and export exist:
   `grep -n "^export" node_modules/@codemirror/legacy-modes/mode/<mode>.js`.
3. Run `npm run extensions:index` to regenerate `extensions/index.json`.
4. Commit the folder and the regenerated index.

Use ids like `lang-<name>`; the index sorts extensions by id.
