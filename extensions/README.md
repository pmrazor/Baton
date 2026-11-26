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
| `contributes` | Map of contribution kinds; `languages` today. |

A language needs `id`, `name`, optional `extensions` (`.go`), `filenames`
(`Dockerfile`), `comments` (`line`, `block`), `indentUnit`, and a `grammar`:

- `{ "legacyMode": { "mode": "go" } }` — a mode bundled with Baton from
  `@codemirror/legacy-modes` (`mode` is the module under `mode/`; add `export`
  when the exported name differs, e.g. `{ "mode": "clike", "export": "kotlin" }`).
- `{ "simpleMode": "dotenv.json" }` — a JSON file in the extension folder in
  CodeMirror simple-mode form: `states.start` is required, regexes are strings,
  only the `i` flag is allowed.

## Adding a language extension

1. Create `extensions/lang-<name>/extension.json` with the manifest above and a
   language entry using a legacy mode or a simple-mode JSON file.
2. For a legacy mode, confirm the module and export exist:
   `grep -n "^export" node_modules/@codemirror/legacy-modes/mode/<mode>.js`.
3. Run `npm run extensions:index` to regenerate `extensions/index.json`.
4. Commit the folder and the regenerated index.

Use ids like `lang-<name>`; the index sorts extensions by id.
