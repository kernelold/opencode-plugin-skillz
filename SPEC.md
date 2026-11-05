# opencode-skillz: specification

Status: M1–M4 implemented and tested on OpenCode 2.0.24; remaining limitations/assumptions are tracked in OPEN_QUESTIONS.md. Command name: `/skillz`. `/skills` is an OpenCode built-in and is NOT used.

## 1. Goal

`skillz` is a skills manager for OpenCode V2. It must:

1. **Add skills to OpenCode.** Installed skills appear in OpenCode's normal skill list (`skill` tool, `@skill-id`).
2. **Manage skills from upstreams.** Install them, keep them up to date, and remove them properly.

It manages skills only. It is not a general plugin manager.

## 2. Concepts

- **Source:** one upstream location. It is the unit of install, update, remove and enable/disable.
- **Skill:** a folder containing `SKILL.md` (or a single plain `.md` skill file).
- A source delivers one or more skills. Install, update and enable/disable operate on a source entry. Installed removal can target that entry or one skill within it; individual removals remain excluded from later updates. A single file is a source with one skill.
- A marketplace entry is also one source.

## 3. Source types

| Input | Meaning |
|---|---|
| `https://host/path/skill.md` | One plain skill. ID from frontmatter `name`, else file name. |
| `https://host/path/archive.zip`, `.tar.gz`, `.tgz` | Download, extract, scan for skills. Optional `sha256` pin. |
| `https://host/folder/` | HTTP folder. Requires an index file (see 3.1). |
| Git URL (`git@host:org/repo.git`, `https://host/org/repo.git`) with optional `#ref` and optional subpath | Clone (sparse where possible) and scan. |
| GitHub `https://github.com/org/repo/tree/<ref>/<path>` | Converted to git URL + ref + subpath. |
| Local path (file or directory) | Scan in place (linked, not copied). |
| Marketplace: URL to a Claude-format `marketplace.json`, or a git repo / local path containing `.claude-plugin/marketplace.json` | Catalog of entries; each entry is one source. |

Authentication: git sources use the user's existing git setup (SSH keys, credential helpers); skillz never prompts interactively for git credentials. HTTP sources accept an optional header or `?key=` query value, stored by reference (env var name or secure store), never written into committed files.

### 3.1 HTTP folder index

A plain web server has no standard folder listing, so skillz looks for an index file in the folder, in this order:

1. `index.json`
2. `index.yaml` / `index.yml`
3. `index.html` (links are extracted: same-origin relative `href`s pointing to `.md` files, `SKILL.md`, subfolders, or archives)

JSON and YAML share one schema, compatible with OpenCode's HTTP skill catalogs:

```yaml
skills:
  - name: git-release
    version: "3"
    files: [SKILL.md, references/policy.md]
```

Rules: file paths must be relative, safe (no `..`, no absolute paths) and same-origin. Each skill is downloaded from `<base>/<name>/<file>`. If no index is found, the source fails with a clear error. Auto-parsing server-generated directory listings is not supported.

### 3.2 Marketplace format (Claude-compatible)

Read `marketplace.json` with `name`, `owner.name`, `plugins[]`. Each plugin entry needs `name` and `source`. Supported entry source types: relative path, `github`, `url` (git), `git-subdir`, `archive` (HTTPS zip, optional `sha256`). `ref` and `sha` pins are honored (`sha` is a full 40-char commit). A marketplace given by URL cannot resolve relative paths. Entries may list `skills: ["./a", "./b"]` (anthropics/skills style, with `source: "./"` and `strict: false`); only those subdirectories are skills. Unknown or unsupported components (commands, agents, hooks, MCP, LSP, output styles) are ignored and reported in the Errors tab as "not supported". Unknown frontmatter fields are never an error.

## 4. Finding skills inside a source

In order:

1. A `skills` list from the marketplace entry or `.claude-plugin/plugin.json`.
2. `SKILL.md` at the source root: the whole source is one skill.
3. `skills/<name>/SKILL.md` (Claude default layout).
4. Recursive scan for any nested `SKILL.md` (needed for layouts like `skills/<domain>/<category>/<skill>/SKILL.md`). Scanning does not descend into a folder once it contains a `SKILL.md`; hidden folders and `node_modules` are skipped; depth limit 6.

Skill ID is the folder name (for plain files: file name without extension). Whole skill folders are installed, including `scripts/`, `references/` and other supporting files, preserving file modes. Names should be unique; see section 7 for collisions.

## 5. TUI (`/skillz`)

Tabs:

- **Discover:** search across marketplaces and show their entries. Details: skills inside, version, source, licence. Action: install.
- **Installed:** list sources and their skills. Actions: enable/disable, update, remove. "Update available" badge. Shows overridden skills.
- **Sources:** add (marketplace or direct source), refresh, remove. Optional auth reference.
- **Errors:** fetch failures, invalid skills, collisions, unsupported content.

## 6. Install, update, remove

- **Install:** fetch into `cache/<source>/<version>/`, discover skills, validate, register with OpenCode, write state.
- **Registration:** via the OpenCode V2 plugin API: `ctx.skill.transform` adds `{ id, name, description, path, content }` per skill, `ctx.skill.reload()` re-applies after changes, `registration.dispose()` removes all skills of a registration (used for disable/remove). `path` is the absolute path of the cached `SKILL.md`, so the skill's base directory and supporting files (`scripts/`, `references/`) resolve correctly. `content` must be the skill body with the YAML frontmatter stripped (verified: OpenCode does not strip it). Transform callbacks are synchronous, so `SKILL.md` files are read before registering. `autoinvoke` can be set per skill. No symlinks into `~/.agents/skills` or any other tool's folder.
- **Version identity:** git commit SHA, archive SHA-256, or the marketplace/`metadata.version` where declared. Pins (`ref`, `sha`, `sha256`) are honored; a pinned source never moves on its own.
- **Updates:** automatic on a configurable schedule (default on, e.g. at start and every `6h`). Can be disabled, which makes updates manual. An "update available" badge is shown in both modes. An update installs into a new version folder and switches atomically; the previous version is kept until the new one is active, so a failed update rolls back. Auto-updates never show prompts: a new collision during an auto-update is skipped and reported in Errors.
- **Remove source:** preview source name/location, exact installed origin/skill IDs and count. With installed skills, present three stacked choices: remove source AND installed skills (red), remove source only and keep skills as abandoned (yellow), Cancel (default focus; Escape cancels). With none, use Yes/No, default No. The typed RPC requires `skills: 'remove' | 'keep'`; the TUI passes a preview revision and stale previews are refused. Catalog removal includes only recorded child source IDs, never matching by skill name or upstream similarity.
- **Abandoned:** retain installed version, resolved upstream record, files, enablement and registration/override order, but detach from updates/checks/scheduling. Installed shows an abandoned badge and dim “source removed” hint; enable/disable and removal still work, including individual skills within an entry. Re-adding the same origin/upstream/selection/version automatically re-adopts; marketplace entries must first be rediscovered by refresh. Local links stay linked and are not immutable snapshots.
- **Remove installed:** removes only the specified installed source entry (or `skillId` within it), keeping source configuration and other entries. Reload and verify registration in all active server locations, restoring external/other-source fallbacks. State/activation failures roll back before cache deletion. Delete only exact owned current `cache/<source-id>/<version>/` directories with no remaining/abandoned references; never follow symlinks or delete local/external files. Historical caches are retained. Cleanup failures after commit report a consistent unregistered state, not pointers to partially deleted files. Removal and scheduler writes share the lock; automatic updates recheck source/abandoned state inside it.
- **Scope:** `user` only (skills are active in every OpenCode session of the user). Project and local scopes may be added later; the state format must leave room for a scope field.

## 7. Collisions

If an install would register a skill ID that already exists (from another skillz source, or from outside skillz such as `~/.agents/skills`, `.opencode/skills`, or `agent-skills link` symlinks):

- Show a confirmation dialog: "Skill `<id>` already exists (from `<where>`). Override?" The default is **No**.
- **No** (default): the install fails and an entry is added to Errors.
- **Yes** (explicit): skillz's skill takes precedence in OpenCode's registry. The other skill's files are never modified or deleted. Installed shows the skill as "overrides `<where>`" so it can be reverted (removing the source restores the other skill).
- **Precedence (verified on OpenCode 2.0.24):** a user plugin's initial transform runs before filesystem and config skills are visible. Collision detection therefore uses `ctx.skill.list()` (or a later transform) at install time. For the same ID, a skill from an explicit `skills` path in the OpenCode config beats a plugin-registered skill, so skillz cannot override it: the dialog must say so and the install fails with an Errors entry. Skills discovered from project or global skill folders can be overridden by skillz.

## 8. State

```
~/.local/share/opencode-skillz/      (XDG_DATA_HOME respected)
  sources.json     # added sources, type, url/ref/sha pins, auth reference (never secrets)
  installed.json   # source -> skills, version, enabled, overrides, scope; optional upstream, abandoned, formerSource, excludedSkills, disabledSkills
  removal.json     # transient recovery journal for source/installation removal metadata
  cache/<source-id>/<version>/
  staging/
```

Writes are atomic (write temp, rename). Shared state may be touched by several OpenCode locations; serialize access with a lock.

## 9. Architecture

Combined OpenCode V2 package:

- **Server plugin** (`@opencode/plugin`): fetching, caching, state, scheduling, registration, typed RPC (`@opencode/plugin/rpc`).
- **TUI plugin** (`@opencode/plugin/tui`): `/skillz` slash command, tabs, dialogs, toasts.
- Package exports: `.`, `./tui`, `./rpc`. Declared under `plugins` in `opencode.jsonc`.
- The core (parsing, fetching, discovery, state) is a plain TypeScript library with no OpenCode dependency, so it can be tested alone.
- The plugin package needs its own `package.json` with `@opencode/plugin` pinned to the installed OpenCode version (a bare import fails otherwise).
- Concurrency: the server plugin is the only writer of state. Writes are atomic (temp file + rename), guarded by an in-process mutex and a lock file for the case of several servers. The update scheduler is a singleton guarded by the same lock, so it runs once per user, not once per location (`setup` runs per location).
- Auth for HTTP sources is an environment-variable reference only (for example `SKILLZ_TOKEN_<NAME>`) plus git's own credentials; skillz never stores a secret value (`ctx.storage` is not a secret store and the TUI has no masked input).

## 10. Security

- Downloaded skills are untrusted prompts and may contain executable scripts; show the source and skill list before installing, and never execute anything during install.
- Prevent path traversal and symlink escape on extract and on index file paths.
- Limit archive size, file count and download redirects; restrict redirects to https and keep same-origin for index files.
- Verify `sha256`/`sha` when pinned.
- Never write auth values to disk in plain files inside caches or committed config.
- Preserve per-skill licences; do not reformat or modify downloaded content.

## 11. Out of scope

Commands, agents, hooks, MCP, LSP, output styles, npm/command marketplace sources, dependencies between sources, project/local scopes, writing Claude's own state files, a standalone shell CLI.

## 12. Open questions

Resolved by documentation and a runtime probe on OpenCode 2.0.24: `ctx.skill.transform` registration, reload and dispose work as documented; colon IDs are accepted (not needed); frontmatter must be stripped from `content`; config `skills` paths beat plugin skills; storage and concurrency decisions are in section 9.

Still open:

- Secure storage for auth values beyond environment-variable references (OpenCode's `ctx.integration` credential API may fit; not evaluated).
- Behaviour of `ctx.skill.list()` for skills from config paths vs project folders when reporting the 'where' in the collision dialog.
- Whether the TUI plugin can run `/skillz` from the home screen (outside a session) with a custom route versus dialogs only.

## 13. Milestones

1. **M1 core library — done:** source parsing, fetchers (git, archive, md, index json/yaml/html, marketplace), skill discovery, cache, state; tests including a real marketplace and an agent-shed-shaped fixture.
2. **M2 registration — done:** server plugin, `ctx.skill.transform`, enable/disable, remove, atomic update, collision handling.
3. **M3 TUI — done:** `/skillz` tabs, dialogs, badges, toasts.
4. **M4 scheduler and hardening — done:** startup/6h scheduled updates, manual-only option, shared-lock singleton claims, rollback/adversarial tests, security limits, docs. See README for configuration and OPEN_QUESTIONS.md for residual dependency/cross-process limitations.
