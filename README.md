# opencode-skillz

Discover and manage skills from Claude-compatible marketplaces, direct URLs, git repositories and local paths in **OpenCode V2 2.0.24**. Open the manager with **`/skillz`**, not `/skills` (which is an OpenCode built-in).

Core, registration, TUI and scheduling/hardening are implemented. This README documents the implemented contract.

## Install

Requires npm, Node.js **>=26.4.0** (required by the OpenTUI dependency `@opentui/core` 0.5.14), and OpenCode **2.0.24**. Older Node versions fail the `engines` check. Git installs and git skill sources also require git and your existing SSH/credential-helper setup. The plugin API dependency is pinned to 2.0.24; newer CLI APIs are not assumed compatible.

### From git

```sh
opencode plugin add git+ssh://git@github.com/kernelold/opencode-plugin-skillz.git#main
opencode plugin list
```

The git package has an npm `prepare` script that builds `dist` before packaging, provided npm permits its lifecycle scripts. OpenCode records the package under `plugins` in your configuration. Restart OpenCode after adding the plugin; subsequent skill changes do not require `/reload`.

### From a local checkout

```sh
git clone git@github.com:kernelold/opencode-plugin-skillz.git
cd /path/to/opencode-plugin-skillz
npm ci
npm run build
opencode --version
```

`prepare` also runs on `npm ci` and `npm install` in a checkout when lifecycle scripts are allowed; running `npm run build` explicitly again is safe.

Add the checkout to **`plugins`** in `~/.config/opencode/opencode.jsonc` (or `$XDG_CONFIG_HOME/opencode/opencode.jsonc`). Preserve your other settings and existing plugin entries:

```jsonc
{
  "plugins": ["/path/to/opencode-plugin-skillz"],
}
```

Use the absolute path to your checkout if different. One entry loads both server and TUI parts. Do not put this combined plugin in `cli.json` or use V1's `plugin` key. The root `server.js`, `rpc.js` and `tui.js` shims support 2.0.24's local-directory loader; **build before loading** and rebuild after source changes.

Start or restart OpenCode, then type `/skillz` and press Enter:

```sh
opencode --standalone /path/to/your/project
```

The command works from the **home screen without creating a session**, and is also in the command palette (`Ctrl+P` → **Manage skills (Skillz)**). The plugin uses custom OpenTUI dialogs, not a session-only panel or custom route. Action rows and badges use your OpenCode theme's semantic colours: success for install/enable, error for remove/disable/“No, cancel”, warning for updates/overrides, and muted secondary information. The selected row has a highlighted background and a `›` marker, so focus is not conveyed by colour alone.

## Source formats and discovery

Skillz manages skills only, not general plugins. A **source** is an upstream location and the unit of installation/update. A marketplace is a catalog whose entries each become a source. Enable/disable and installed removal can target an entry or an individual skill; individual removals stay excluded from later updates. A **skill** is a folder containing `SKILL.md`, or a single plain `.md` file.

| Input | Behavior |
|---|---|
| `https://host/path/skill.md` | Download one plain skill; ID from frontmatter `name`, otherwise the filename without extension. |
| `https://host/path/archive.zip`, `.tar.gz`, `.tgz` | Download, extract and scan; optional `#sha256=<64 hex characters>` or `SourceOptions.sha256` pin. |
| `https://host/folder/` | Download through an HTTP index, as described below. |
| `git@host:org/repo.git`, `https://host/org/repo.git` | Clone and scan; optional `#ref:subpath`, or typed `ref`, full `sha` and `subpath`. Subpaths use sparse checkout. |
| `https://github.com/org/repo/tree/<ref>/<path>` | Convert to git URL, ref and subpath. |
| Local file/directory, including `file://` | Scan in place; linked, not copied. |
| URL ending in `/marketplace.json`, or git/local source containing `.claude-plugin/marketplace.json` | Read a Claude-compatible catalog; install its entries, not the catalog itself. |

Initial HTTP is also supported, with the redirect/auth restrictions in [Security model](#security-model). Git uses existing non-interactive SSH/credential helpers. HTTP auth is an environment-variable reference only, not an inline header/query secret or secure-store value.

### HTTP folder indexes

Skillz tries `index.json`, `index.yaml`, `index.yml`, then `index.html`, in that order. JSON/YAML share the OpenCode-compatible schema:

```yaml
skills:
  - name: example-release
    version: "3"
    files: [SKILL.md, references/policy.md]
```

Files are fetched from `<base>/<name>/<file>`. Paths must be relative, safe (no `..` or absolute paths) and same-origin. HTML indexes extract relative `href` links to `.md` files (including `SKILL.md`), subfolders and supported archives. No index produces a clear error. There is no general server-generated directory-listing parser.

### Claude-compatible marketplaces

Catalogs require `name`, `owner.name` and `plugins[]`; entries require `name` and `source`. Supported entry sources are a relative path, `github`, `url` (git), `git-subdir`, or `archive` (zip, tar.gz or tgz, optionally SHA-256 pinned). Full git `sha` pins are 40 lowercase hex characters; `ref` pins are also supported. URL catalogs cannot resolve relative entries; git catalogs resolve them against their repository, and local catalogs against their directory.

An entry may declare `skills: ["./a", "./b"]`, including the example-org/skills `source: "./"`, `strict: false` layout; only those paths are discovered. `exclude` is supported as described in [Selective installation](#selective-installation-and-exclude). Unsupported commands, agents, hooks, MCP, LSP and output styles are ignored and reported as “not supported” in Errors. Unknown frontmatter/manifest fields are not errors.

### Discovery precedence and skill identity

1. Explicit `skills` from the source/marketplace entry, otherwise `.claude-plugin/plugin.json`.
2. Root `SKILL.md`: the entire source is one skill, without descending further.
3. Conventional `skills/<name>/SKILL.md` layout; when present, scan that skills tree, including grouped skills.
4. Otherwise recursively find nested `SKILL.md`, stopping at each skill folder, skipping hidden directories and `node_modules`, with depth limit 6.

Nested skill IDs use the folder name. Plain-file and root skills prefer frontmatter `name`; plain files fall back to the filename without extension, and root skills to a stable upstream-derived name. A nonempty description is required; duplicate IDs within a source are validation errors. Whole skill folders, scripts, references, licences and ordinary file modes are preserved. `metadata.version` participates in version identity; `metadata["opencode/autoinvoke"]`, `disable-model-invocation` and `autoinvoke` can control registration's per-skill invocation flag.

## Configuration and automatic updates

Use plugin options in **`opencode.jsonc`**, not `cli.json`:

```jsonc
{
  "plugins": [{
    "package": "/path/to/opencode-plugin-skillz",
    "options": {
      "automaticUpdates": true,
      "updateIntervalMs": 21600000,
      // Optional: override the normal XDG data directory.
      // "dataDir": "/absolute/path/to/skillz-data",
    },
  }],
}
```

| Option | Default | Meaning |
|---|---|---|
| `automaticUpdates` | `true` | Apply available updates without prompting. Set `false` for **manual-only updates**; version checks and Installed sources badges still work. |
| `updateIntervalMs` | `21600000` (6h) | Check/update interval in milliseconds; integer `1000`–`2147483647`. |
| `dataDir` | `$XDG_DATA_HOME/opencode-skillz` or `~/.local/share/opencode-skillz` | Shared per-user state/cache directory. Use an absolute path. |

Startup checks wait for OpenCode's built-in skill discovery, then run when due. One timer is shared by locations in a server; `scheduler.json` claims are serialized under the same `.lock` as state writes across servers. New locations/restarts do not repeat a cycle within the interval. A live running owner prevents overlap; a dead owner is recoverable on the next tick. Timers are unreferenced and stop when the last location unloads. Scheduling runs only while OpenCode is running (not an OS cron service). Use consistent global options: the first active location's options win within a server; the first due claimant wins across servers sharing `dataDir`.

Automatic updates skip sources with `ref`, `sha` or `sha256` pins, including branch-name refs, and abandoned installations. Checks can still show a changed branch ref; explicitly Update to follow it. Automatic new collisions skip the **whole source**, retain its previous installation, and appear in Errors; they never request or infer approval. Failed fetch, validation, registration/reload or state-pointer writes retain the prior version. Historical remote versions are retained; removal deletes only an installed entry's unshared current version directory. Local sources are linked, so upstream local edits themselves cannot be rolled back.

## Use the five tabs

The strip is **[Skills] · Discover · Installed sources · Sources · Errors**, prefixed with `Skillz:` as the manager title, not an extra tab. Opening `/skillz` defaults to Skills when any skill is installed (including disabled or abandoned skills), otherwise Discover. On narrow terminals the strip shows a window of neighbouring tabs, with `‹`/`›` indicating hidden tabs. The active tab stays visible; only extremely narrow terminals shorten its label.

The current tab is bracketed in the dialog title. Core navigation and actions are reachable with plain arrows and Enter; no modifier, letter alias or Tab is required.

| Key | Main menu | Install checklist |
|---|---|---|
| Up / Down | Wrap through tab strip, list rows and footer actions | Wrap through Yes/No, visible checklist rows and bulk actions |
| Left / Right | Switch tabs from any focused section | Collapse/expand a header; move child → parent / expanded header → first child |
| Tab / Shift+Tab | Next/previous section: strip → list → footer | Next/previous section: Yes/No → checklist → bulk actions |
| PageUp / PageDown | Move list focus by one viewport | Move checklist focus by one viewport |
| Home / End | First/last list row | First/last visible checklist row |
| Space | Toggle the focused skill in Skills | Toggle a skill or all skills under a header |
| Enter | Open a row or activate an action; no-op on strip | Confirm Yes/No, fold a header, toggle a skill or activate a bulk action |
| Esc | Close/go back | Cancel without installing |

Tab cycles back to the first section; Shift+Tab reverses. Returning to a list restores its last focused row and scroll position; each main tab remembers its own list and filter. Entering the footer focuses its first action; empty lists are skipped. PageUp/PageDown/Home/End stay within a focused list. The strip has a `›` marker when focused. Refresh / Check updates, Add source and Clear errors are visible, clickable actions. Type to filter, including h/j/k/l as text. Navigation and confirmation keys ignore Ctrl/Alt/Shift/Meta modifiers, except Shift+Tab; there are no hjkl, Ctrl+P/Ctrl+N or Ctrl+T navigation aliases or tab picker. Ctrl+R, Ctrl+A and Ctrl+X remain optional refresh/add/clear shortcuts. Footer hints include **Tab: next section**. See the [complete per-screen key audit](#keyboard-audit) for prompts, details and confirmations.

Dialogs are centered and resize with the terminal, leaving a small margin. All five main tabs pin their title/tab strip, search/status and footer actions/hints outside the scrolling list. Multiline names, descriptions and badges scroll together; arrow navigation, filtering and resizing reveal the focused row using its laid-out height. A row taller than the viewport shows its name first. In install previews, Yes/No and the checklist description stay above the scrolling checklist, while bulk actions and keyboard hints stay below it. Short terminals use less spacing and show bulk actions as **All / None / Expand / Collapse** in one row. Main-menu actions share one row below ten terminal rows. When even the controls cannot fit, the title, hints and actions take priority over search/status and list rows; labels may clip, and Escape still cancels. Prompt descriptions also scroll (PgUp/PgDn), without moving the input or buttons off-screen.

- **Discover:** search marketplace entries and direct sources. Enter fetches a preview with the complete skill list and count, version, upstream location, source trust and licence (or “not declared”). Read-only details appear above **Yes, install**, then **No, cancel**, followed by a blank spacer, a dim “The following skills will be installed:” description and the skill checklist. The description includes the selected/total count when skills are unchecked. **Yes has initial focus**; new sources start with every skill checked, so Enter installs all. Existing exclusions appear unchecked. Checked skills use green `[x]`, unchecked skills red `[ ]`. Plain Up/Down moves across Yes, No and every visible checklist row in one sequence, without Tab; Space toggles a skill, **a** selects all and **n** selects none. Skills in subfolders have foldable category headers: `▸` collapsed / `▾` expanded, green `[x]` all / yellow `[-]` some / red `[ ]` none, then the category name and selected/total count. Space on a header toggles all its skills, even while collapsed. Left collapses an expanded header; on a child it focuses the parent header without collapsing it. Right expands a collapsed header; on an expanded header it focuses its first child. Left on a collapsed header or root skill, and Right on a skill, do nothing. Enter on a header folds it, on a skill toggles it, and on Yes/No confirms that choice. Plain **e**/**c** expand/collapse all, preserving focus or moving a hidden child to its header. All these keys ignore modifier events; **h**/**l** are not aliases. Sources with multiple categories or more than eight skills start collapsed; a single small category starts expanded with indented children. Root skills are always shown, and flat sources have no headers. Yes refuses an empty selection. Escape or No, cancel cancels without installing. Collision and destructive confirmations still default to No, cancel/Cancel.
- **Skills:** a flat, name-sorted list of individual installed skills, not source entries. Each row shows its name, short description, source name/entry ID, category when present, and enabled/disabled, abandoned and update badges. Type to filter names, descriptions, categories, paths and origins. Excluded/removed skills are not listed. Enter opens **View skill details / path / source**, **Enable/Disable skill**, **Update source (all its skills)** when an update is available, **Remove skill**, and **Cancel**. Details are the initially focused, non-mutating choice. Removal defaults to No, cancel. **Space** toggles the focused skill; the same action is reachable as a footer row with arrows and Enter. A disabled source still suppresses all its skills: the menu explains this and offers a separate **Enable source (all eligible skills)** action, never silently enabling siblings. An empty Skills list points to Discover/Sources. Skills shares the cached/background update checks of Installed sources and uses the same scrollable viewport and mutation/inventory refresh path.
- **Installed sources:** source entries you've installed, each with its skills, rather than individual skill rows. The empty state points to Discover. This view renders local installed entries and cached update badges immediately, without waiting for upstream. A dim “checked 3h ago” / “never checked” hint shows freshness. A missing or ten-minute-old check starts a background refresh with “checking…”; **Ctrl+R** forces a check without closing the list. Results update badges in place, retaining search, selection, focus and scroll. Failed checks show a muted badge and appear in Errors, not a blocking dialog. Inspect to see override origins and full versions. Enable/disable and update apply to the entry's skills. Remove installed entry affects only that exact origin and leaves its source available; multi-skill entries also offer **Remove one skill…** and **Enable / disable one skill…**. Individually removed skills stay excluded from updates until the whole entry is removed and installed afresh.
- **Sources:** configured marketplaces and direct sources, whether installed or not. The empty state offers Add source. **Ctrl+A** adds a marketplace or direct source. Refresh with **Ctrl+R**. Enter offers inspection, refresh and removal. Removal previews the source name/location and exact installed skill IDs with their origin IDs and count. With installed skills, choose red **Remove source AND its N installed skills**, yellow **Remove source only — keep the skills (they become abandoned)**, or **Cancel** (default focus; Escape cancels). Nothing changes until chosen. An empty source has a simple Yes / No, cancel confirmation. Marketplace removal includes its recorded child entries, never independent sources pointing at the same upstream. Local source files are never deleted.
- **Errors:** inspect fetch/validation failures, collisions and unsupported content. **Ctrl+X** clears the error log after confirmation; **Ctrl+R** reloads the local error list.

Discover and Sources also render persisted source/catalog metadata first, then refresh in the background (at most once per ten minutes while this manager is open, or immediately with Ctrl+R). An empty Discover list shows “loading…” while fetching. Opening a tab never fetches individual skill previews; Enter on a Discover entry still fetches its full preview before asking to install.

The server stores the last completed update check atomically in `updates.json` beside `installed.json`: `{ checkedAt, updates: [{ sourceId, installedVersion, availableVersion?, updateAvailable, issues }] }`. Startup/interval checks populate the same cache even with `automaticUpdates: false`; manual checks do too. The read-only typed `listUpdateStatus` RPC returns that JSON-safe shape (`checkedAt: null` before a check, or when an installation has no matching result). Cached results are reconciled with current installed versions, so a completed update does not keep an obsolete “update available” badge. Concurrent checks share an in-flight promise across locations on the same server; the existing state lock serializes separate server processes. The TUI never writes these files.

If an action fails, a toast reports it; reopen `/skillz` and inspect Errors. Collision and removal confirmations use read-only details and stacked coloured choices with a safe default. Collision prompts display the existing skill ID and origin. Explicit Yes approves overriding conflicts in that source: the skillz version takes precedence, the original is untouched, and removing the skillz installation restores it. Skills from explicit OpenCode `skills` config paths cannot be overridden. On detail-only screens, Up/Down scrolls the read-only pane and Enter/Esc goes back. PgUp/PgDn and the mouse wheel remain optional scrolling extras; in confirmations the choices remain below the detail pane.

Every text prompt (source location, auth environment-variable name and header/query name) is owned by skillz. Type in the initially focused input; Left/Right edits the cursor there. Up/Down moves to the horizontal Continue/Cancel buttons, initially **Cancel**, or back to the input. Tab and Shift+Tab also jump **input ↔ buttons**, preserving the input text and cursor. Left/Right cycles between the buttons. Enter in the input continues, Enter on a button activates it, and Esc cancels. Other modified navigation does not move between controls. Single-region action menus and confirmations retain Tab's row/button cycling (Shift+Tab reverses); detail-only screens leave Back focused.

### Keyboard audit

Each screen's owned keys are handled in `src/tui/render.ts`, `controller.ts` and `model.ts`; `index.ts` registers `/skillz` with no other navigation handler. The model supplies the five tabs and checklist folding, and the controller supplies menus and actions. There is no Updates tab and no tab picker.

| Screen | Current behavior |
|---|---|
| Main menu — Skills | Same main-menu contract; ↑/↓ wraps strip, individual rows and Check updates / Enable-disable selected skill actions; ←/→ wraps all five tabs; Enter opens skill actions; Space toggles only the list skill; Esc closes; typing filters; Ctrl+R optional check |
| Individual skill actions | ↑/↓/optional Tab wraps Details, Enable/Disable, optional Enable source, optional Update source, Remove skill, Cancel; Enter activates; Esc backs out; Details initial focus; Remove confirms with safe No default |
| Main menu — Discover | ↑/↓ → wrap strip + rows + Refresh/Add source; Tab/Shift+Tab → next/previous region (strip/list/footer); PgUp/PgDn/Home/End → list focus; ←/→ → tabs everywhere; Enter → row/action (strip no-op); Esc → close; typing → filter; Ctrl+R/A optional action shortcuts |
| Main menu — Installed sources | Same main-menu contract; stacked Check updates; Ctrl+R optional; Enter on entry → details |
| Main menu — Sources | Same main-menu contract; stacked Refresh/Add source; Ctrl+R/A optional; Enter on source → action menu |
| Main menu — Errors | Same main-menu contract; stacked Refresh/Clear errors; Ctrl+R/X optional; Enter on error → details |
| Source action menu (direct / marketplace) | Unchanged plain row navigation; no horizontal buttons or tabs |
| Installed sources action menu (active / abandoned) | Unchanged plain row navigation; Update absent for abandoned; per-skill choices only for multi-skill entries |
| Per-skill removal / enable-disable lists | Unchanged plain row navigation |
| Add-source kind / HTTP auth transport | Unchanged plain row navigation |
| Source / marketplace location prompt | Type → edit; ↑/↓ or Tab/Shift+Tab → input ↔ buttons (Cancel default); ←/→ → cursor in input / wrap Continue-Cancel; Enter → submit input / activate button; Esc → cancel; PgUp/PgDn scroll description |
| Optional auth env-name / header-name / query-name prompts | Same custom prompt contract; blank auth name continues without auth |
| Install preview | ↑/↓ still wraps Yes/No, checklist rows, bulk actions; Tab/Shift+Tab → next/previous region (Yes/No → whole checklist → bulk actions → Yes/No); restore last checklist row or collapsed parent; PgUp/PgDn/Home/End → checklist focus; other keys unchanged; initial Yes; empty selection refused |
| Collision override / installed entry removal / individual skill removal / empty-source removal / clear-errors confirmation | Unchanged stacked choices and safe No default |
| Remove source with installed skills | Unchanged stacked choices and safe Cancel default |
| Installed source details / source inspection / error details / cannot-override alert | ↑/↓ → scroll details; Enter/Esc → back; optional Tab leaves Back focused |
| Tab picker / Updates tab | Not implemented or required; five main tabs accessed directly with ←/→ |

Single-region action menus, per-skill lists, add-kind/auth-transport menus and Yes/No/removal confirmations keep Tab's row/button cycling; Shift+Tab cycles backwards. Detail-only Tab/Shift+Tab is a no-op. Plain PgUp/PgDn/Home/End navigates focus in searchable lists and install checklists, not their non-list regions. Detail and confirmation panes retain PgUp/PgDn scrolling; prompts retain description scrolling. Mouse wheel scrolling and row/action clicks remain supported. All modified navigation/confirmation keys are rejected except Shift+Tab (additional modifiers on Shift+Tab are also rejected). Unbound hjkl are filter text in searchable lists and ignored in non-input confirmations. No core navigation or action requires a modifier, letter alias or Tab.

Host integration (OpenCode 2.0.24): the host dialog pushes modal input mode and binds only Escape/Ctrl+C, not Tab. Skillz uses the public `context.keymap.layer` API in its custom dialog, not a separate `useKeyboard` listener. Its global priority-1000 layer owns Tab/Shift+Tab while mounted. The host's `agent.cycle` binding is Shift+Tab, outside modal mode. Named section commands receive the actual KeyEvent and call preventDefault/stopPropagation; inline commands in 2.0.24 do not receive the event, so section bindings must be named. The isolated real-CLI smoke verifies forward/reverse Tab handling rather than relying only on mocked dispatch.

### Abandoned skills and safe removal

Keeping skills when deleting their source makes them **abandoned**: Installed sources shows an `[abandoned]` badge and dim **source removed** hint. They retain their enabled/disabled setting, registration precedence, resolved upstream/version, cached skill bodies and supporting files. They remain usable and can be disabled/enabled or removed individually, but have no manual updates, update checks or scheduled updates. Linked local skills still use their original local files; skillz does not freeze files edited outside the tool.

Re-add the **same source** to re-adopt automatically, without downloading or moving the installed version. For marketplaces, refresh must rediscover the same entry. Re-adoption requires the same recorded origin ID, upstream type/location/subpath/pins, skill selection and declared version; a same-name entry retargeted to a different upstream is not adopted. Re-adoption preserves enablement and override order.

Removal matches recorded source IDs, not skill names. Same-ID skills from other skillz sources, independently added identical upstreams, external skill directories and config paths are untouched. Only an entry's own `cache/<source-id>/<version>/` directory is eligible for deletion, and it survives while any remaining or abandoned installation references it. Cleanup never follows symlinks or deletes local-source files. Registration is reloaded and verified in every active location on this server; failures roll back before deleting cache. A post-commit cache cleanup failure is reported in Errors and leaves the skills unregistered rather than restoring pointers to potentially deleted files. Historical/unowned cache folders are conservatively retained, not recursively swept.

Typed RPC: `previewRemoveSource({ sourceId })` returns `{ sourceId, source?, entries, skillCount, revision }`. `removeSource({ sourceId, skills: 'remove' | 'keep', revision? })` requires an explicit policy; the TUI passes the revision so a changed preview must be reviewed again. `remove({ sourceId, skillId? })` removes only that installed entry, or one skill in it, without forgetting its source or cascading to siblings. `setEnabled({ sourceId, enabled, skillId?, options? })` also supports toggling a single skill; an entry-level disable still suppresses all its skills. The core facade likewise requires an explicit removal policy.

`installed.json` retains its source-ID-keyed, scope-ready entries. New optional fields are `upstream` (resolved source record), `abandoned: true`, `formerSource` (deleted origin record), `excludedSkills` (individual removals), and `disabledSkills` (individual toggles). The retained `sourceId` is immutable provenance, not a live update link. All state writes use the state lock and atomic replacement. A short-lived `removal.json` journal recovers interrupted source/installation metadata transactions before the next writer or plugin startup; interrupted cache cleanup may leave unused files.

### Selective installation and `exclude`

Illustrative install preview (not a live-terminal capture):

```text
› [ Yes, install ]
  [ No, cancel ]

The following skills will be installed (4 of 6 selected):
  ▸ [-] group-a (3/5)
  ▸ [x] testing (1/1)
```

Expand a header with plain Right or Enter to inspect its indented skills; press Right again to focus the first child. Left from a child focuses its header; Left again collapses it. Folding changes only visibility, never the saved selection.

Below the checklist, **Select all skills**, **Select no skills**, and (for grouped sources) **Expand all categories / Collapse all categories** actions are also reachable with Up/Down and Enter. They are stacked except in short terminals. Tab jumps **Yes/No → whole checklist → bulk actions → Yes/No**; Shift+Tab reverses. The checklist remembers its last row, including falling back to a category header if that child is collapsed. PageUp/PageDown/Home/End move focus only within the checklist. The a/n/e/c keys are optional shortcuts, never required. Left/Right and Space do nothing on these action rows; they only operate on checklist rows.

Unchecked skills are saved in the source's `options.exclude` list in `sources.json`. A wholly unchecked category is saved compactly as `<category>/`; partial selections use skill IDs. Exclusions survive refreshes and updates. New upstream skills are installed unless they match an exclusion. Categories use the skill directory's parent path relative to the discovered root (the conventional leading `skills/` is omitted); directly contained skills have no category.

The core API and `addSource` RPC accept `SourceOptions.exclude?: string[]`, alongside `skills`. Exclusions support exact IDs or frontmatter names, `*` globs, and category prefixes ending in `/`. They take precedence over the `skills` inclusion list. Marketplace plugin entries also accept `exclude`. For example:

```ts
const source = await skillz.addSource(
  'https://github.com/org/repo.git#main:skills/group-a',
  { exclude: ['some-category/', 'legacy-*', 'one-skill-id'] },
);
await skillz.install(source.id);
```

`install` also accepts `{ exclude: [...] }` in its options (the same shape over RPC) to replace the saved selection atomically with a successful installation. Failed validation or registration keeps the previous source options and installed skills. Stored sources without `exclude` retain their previous behavior. Catalog refreshes retain selections edited by the user.

In **Sources**, Inspect displays saved exclusions. Choose **Inspect / install skills** to see excluded skills unchecked and re-include them; confirming replaces the selection. Individually removed skills also appear unchecked here and can be restored. Existing per-skill enable/disable settings remain independent and are preserved. Clearing exclusions does not enable a previously disabled skill. An all-excluded installation is rejected by both the dialog and core.

### Source trust

**Skills can contain scripts; adding a source means you trust it.** Skill-source installation executes nothing (unlike installing this plugin from git, which runs npm's build). Review the displayed source, skill list and licence before installing.

- A source you explicitly add in Sources (marketplace, git, URL, local path or archive) displays **“Trusted — you added this source”** in the theme's success colour. This is source provenance, not a per-skill rating or a claim that code is sandboxed.
- A marketplace's generated entries were not individually added by you. They display their actual source URL/path and **“Not added by you — from marketplace X”** in the theme's warning colour, even when they share the marketplace's host. Adding a marketplace does not silently mark every referenced repository trusted. An entry displays trusted if its exact source identity (type, location, subpath and any pins) is also present as an explicitly added source.
- Removing the explicitly added source removes that trust/provenance record; removing a marketplace also removes its generated source entries, with an explicit choice to remove or abandon their installed skills. Disabling only stops registration; it does not remove source trust. There is no separate trust switch, allowlist or per-skill permission feature.

Skillz state is user-scoped at `$XDG_DATA_HOME/opencode-skillz` (default `~/.local/share/opencode-skillz`); configure the plugin globally to make it available in every project.

### When sessions see changes

Install, update, enable, disable and remove refresh every active location using the same skillz data directory **on the connected server**. OpenCode's native skill inventory (the skill picker) is refreshed right after each change, so you do not need `/reload`. Existing sessions see the change on their **next model step**; you do not need to create a new session. A request already in flight is not rewritten.

OpenCode 2.0.24 preserves the initial system instructions and announces later changes in a `<system-reminder>` instead. **“New skills are available in addition to those previously listed” means the current session has received the new skill**, not that it is limited to new sessions. Changed descriptions replace the advertised list; disable/remove announce unavailable IDs. Earlier instructions and already-loaded skill bodies remain conversation history, not a live registry view.

Skills without a description, with `autoinvoke: false`, or denied by the agent's skill permissions are not advertised. Installing a skill does not force the model to invoke it. Separate standalone servers do not receive each other's registry changes; reload/restart the other server's plugin, or use the same shared server.

### Try a marketplace

1. Run `/skillz`, use **Up/Down** to focus **Add source**, press **Enter**, then choose **Marketplace** with arrows and Enter.
2. Enter the URL of a Claude-compatible `marketplace.json`, for example `https://host/path/marketplace.json`.
3. Leave the optional auth env-var name **blank** for a public catalog.
4. Sources refresh automatically. Browse Discover, search an entry, and press Enter to inspect its actual skills before deciding whether to install.

A public catalog does not imply public entry repositories. Entries using private git remotes still need your normal git credentials.

### Optional HTTP authentication

The add-source dialog accepts only an **environment-variable name**, never a secret value. Choose Bearer auth, a custom header, or a query-parameter name. Only the reference and transport names are stored. Set the variable securely in the **server's environment before starting OpenCode**; with a managed background service, changing only the client's environment will not change the server's environment. Git sources use existing git credentials instead.

## Security model

- Source trust is your decision, not a sandbox or security audit. Review the preview/source/licence before installing. Skillz never runs downloaded scripts, hooks, package managers or git smudge/process filters. Existing git credentials/SSH are trusted local configuration; authentication is non-interactive.
- Archive traversal, symlinks, hardlinks and special entries are rejected. Existing extraction/index destination symlinks are rejected even if they point inside the destination. Discovery rejects supporting-file or explicit `SKILL.md` symlinks escaping the source. Linked local sources and skillz's private state directory must remain under your control; this is not protection against another process with your UID racing filesystem changes.
- Defaults: **32 MiB/download**, **128 MiB extracted payload**, **10,000 archive entries/index files**, **5 redirects**; indexes also have depth/aggregate-size limits. Tar decompression includes a bounded metadata/header allowance. These core-library limits are not plugin options. Unknown components are reported, never executed.
- Initial HTTP URLs are supported (and are not transport-secure); **every redirect must use HTTPS**, including loopback redirects. Index requests/redirects stay same-origin. HTTP auth is never sent to another origin; query credentials are stripped before redirects. No credential values belong in source URLs/config. Env references only; known auth values are redacted from persisted errors and echoed HTTP/archive bodies containing them are rejected before caching.
- Archive SHA-256 and full git SHA pins are verified and mismatch/unavailable commits fail closed. Ref pins suppress automatic movement; they are not immutable cryptographic pins. Use a full SHA/SHA-256 for reproducibility.
- Downloaded bytes, supporting files and per-skill licences are preserved; executable permission bits are retained, archive privilege bits are not. Frontmatter is stripped only from the OpenCode registration body, not the cached `SKILL.md`.
- The pinned OpenCode SDK still has transitive **moderate** npm advisories. Local high/critical Zod/Seroval findings were remediated with a scoped Zod override and compatible Solid update; upgrading the SDK is a separate compatibility decision. Do not treat this implementation as a dependency-audit certification.

## Isolated manual trial

This gives OpenCode and skillz disposable state and does not change your normal config. Exit OpenCode before removing the demo directory. An isolated HOME may not have your normal SSH configuration for private git sources.

```sh
cd /path/to/opencode-plugin-skillz
npm ci && npm run build
demo=$(mktemp -d)
mkdir -p "$demo/project" "$demo/config/opencode"
cat > "$demo/project/opencode.jsonc" <<EOF
{
  "plugins": [{
    "package": "/path/to/opencode-plugin-skillz",
    "options": { "dataDir": "$demo/skillz-data" }
  }]
}
EOF
cp "$demo/project/opencode.jsonc" "$demo/config/opencode/opencode.jsonc"
env HOME="$demo" XDG_CONFIG_HOME="$demo/config" \
  XDG_DATA_HOME="$demo/data" XDG_STATE_HOME="$demo/state" \
  XDG_CACHE_HOME="$demo/cache" OPENCODE_CONFIG_CONTENT='{}' \
  OPENCODE_CONFIG="$demo/project/opencode.jsonc" \
  opencode --standalone "$demo/project"
# In OpenCode: /skillz
# After exiting: rm -rf "$demo"
```

## Development and verification

### Architecture and state

The plain TypeScript core (`./core`) handles parsing, fetching, discovery and state without OpenCode imports. The server plugin (`.`, `@opencode/plugin`) owns mutations, scheduling and registration; the TUI (`./tui`, `@opencode/plugin/tui`) uses the typed `./rpc` contract, never direct state-file access. The package exports all four entrypoints and pins the SDK to 2.0.24. Git package preparation builds these entrypoints through `prepare`; successfully building a checkout is not proof that OpenCode's git-package installer or a published npm install works in every environment.

Installation fetches into staging, validates and moves remote content into `cache/<source-id>/<version>/` before activation and the atomic installed-pointer commit. Version identity prioritizes git commit SHA, archive SHA-256, declared source/index version, skill `metadata.version`, then a content digest. Multiple declared skill versions are combined deterministically. Unsafe version directory names are hashed. Linked local sources stay outside this copy lifecycle.

`ctx.skill.transform` synchronously registers pre-read `{ id, name, description, path, content, autoinvoke? }` snapshots. `path` is the absolute `SKILL.md` path, preserving the supporting-file base directory; `content` is the body without YAML frontmatter. Replacement disposes the previous transform, reloads and verifies visibility, with rollback on failure. Skillz never links into `~/.agents/skills` or another tool's directory. Collision checks use the post-discovery `ctx.skill.list()` and explicit config-path classification, since initial user transforms precede built-in discovery. Colon IDs were accepted in the 2.0.24 runtime probe but are not needed by skillz.

```text
$XDG_DATA_HOME/opencode-skillz/     # default: ~/.local/share/opencode-skillz/
  sources.json                    # source/options/pins and auth references
  installed.json                  # versions, skills, enablement, overrides, scope
  errors.json                     # persisted, redacted issues
  updates.json                    # last completed version check
  scheduler.json                  # next-run and cross-process owner claims
  removal.json                    # transient metadata recovery journal
  .lock                           # cross-process writer lock
  cache/<source-id>/<version>/
  staging/
```

JSON replacement uses temporary files and rename. The server/core serialize writers with a shared in-process mutex and file lock; scheduler claims use that same lock. State has a `scope` field but currently supports only `user`. Project/local scopes, non-skill marketplace components, npm/command skill sources, source dependencies, writing Claude state and a standalone shell CLI are outside the product contract. Secure auth storage beyond env references and cross-standalone-server registration reconciliation remain future work, not completed features.

### Checks

```sh
npm run typecheck
npm test
npm run build
# Optional real-terminal integration smoke (requires tmux and OpenCode 2.0.24):
OPENCODE_TUI_SMOKE=1 npm test -- test/tui-runtime.test.ts
# Optional existing-session refresh smoke (local mock provider; no LLM account):
OPENCODE_SESSION_SMOKE=1 npm test -- test/session-runtime.test.ts
# Optional live catalog + scheduler check/update (requires access to its git entry):
SKILLZ_LIVE_MARKETPLACE=1 SKILLZ_MARKETPLACE_URL=https://host/path/marketplace.json npm test -- test/live-scheduler.test.ts
```

Pure view-model tests cover tab order/defaults, individual Skills rows across origins/categories/states, filtering, metadata/trust formatting, cache freshness, update badges and overrides. Controller tests exercise the typed RPC adapter, slow background refreshes, deduplication, closed-dialog results and safe confirmations; renderer tests verify every menu/prompt layout's arrow-only reachability, tab-strip/list/action focus, modifier rejection, detail scrolling, bulk checklist actions, in-place updates, theme tokens, No/Cancel default focus, cancellation and filtering without loading native bindings in Node. A controller/renderer test opens Skills, enables/disables and removes an individual skill with arrows/Enter, and verifies safe Cancel/No/Escape. Safe-removal tests cover exact origins, shared caches, local/symlink boundaries, rollback, recovery, scheduler races and re-adoption. The opt-in smoke starts a private OpenCode instance with isolated HOME/XDG directories and a dedicated tmux server, invokes `/skillz` from home, traverses all five tabs with plain arrows, checks the Skills empty state and installed source list, disables a skill through its menu and enables it with Space, and verifies the native picker refreshes without `/reload`. It also moves between tab strip and content, reaches refresh/add/check-updates/clear actions with arrows and Enter (no action shortcuts), installs a colliding local skill only after explicit approval, verifies Installed sources renders while a real HTTP check is deliberately held pending, observes badges after releasing it, updates, disables/enables, checks removal default Cancel/Escape, keeps skills as abandoned, re-adds to re-adopt, then explicitly removes source and skills and clears Errors. It never uses an LLM or the user's skillz state. It writes plain-text and ANSI-colour screen captures, then deletes its isolated runtime state.

The session-refresh smoke loads the plugin from isolated **global** config, opens a real session, installs through `/skillz` in a separate TUI process attached to that session, and inspects actual outgoing model requests at a local mock provider. It verifies next-step addition, description update, disable/enable and removal in that same session, including mutations from another active location. It uses no real provider credentials and cleans up its own server, terminal and HOME/XDG state.

The TUI smoke also expands 37 skills in seven categories in a private 24-row tmux terminal, walks every checklist row, then resizes to 12 and 48 rows. It checks that Yes/No, the description and footer hints remain visible through navigation, folding and bulk selection.

The main-menu smoke installs 37 disposable local entries and records 37 fixture errors. At 24×80 it visits every tab, verifies Tab jumps directly from a remembered list row to the footer, then the strip and back to that row without scrolling through the list, and repeats in reverse with Shift+Tab. It also checks Home/PageDown, walks every multiline row, wraps through the strip/actions, filters to the last entry and resizes to 12×60 and 48×100. The install smoke checks the same three-region cycle with 37 expanded skills.

Scheduler/adversarial tests cover singleton claims, manual mode, pins, collision skips, mid-update failures and registration rollback; zip-slip, tar links/decompression bombs, index traversal/symlinks, HTTPS/origin/redirect limits, sha verification, git filter suppression, unchanged licences/modes and sentinel-token scans of persisted files. The live smoke fetches a real marketplace catalog and git entry in disposable HOME/XDG state. It forces only its disposable installed-version marker stale to deterministically exercise startup check → automatic update without modifying upstream or the user's state.

## License

MIT. See [LICENSE](LICENSE).
