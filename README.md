# opencode-skillz

Discover and manage skills from Claude-compatible marketplaces, direct URLs, git repositories and local paths in **OpenCode V2 2.0.24**. Open the manager with **`/skillz`**, not `/skills` (which is an OpenCode built-in).

M1 core, M2 registration, M3 TUI and M4 scheduling/hardening are implemented. See [SPEC.md](SPEC.md) and [OPEN_QUESTIONS.md](OPEN_QUESTIONS.md) for verification and remaining limitations.

## Install from this checkout

Requires Node.js 20+, npm and OpenCode **2.0.24**. Git sources also require git and your existing SSH/credential-helper setup. The plugin API dependency is pinned to 2.0.24; newer CLI APIs are not assumed compatible.

```sh
cd /path/to/opencode-plugin-skillz
npm ci
npm run build
opencode --version
```

Add the checkout to **`plugins`** in `~/.config/opencode/opencode.jsonc` (or `$XDG_CONFIG_HOME/opencode/opencode.jsonc`). Preserve your other settings and existing plugin entries:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/path/to/opencode-plugin-skillz"],
}
```

Use the absolute path to your checkout if different. One entry loads both server and TUI parts. Do not put this combined plugin in `cli.json` or use V1's `plugin` key. The root `server.js`, `rpc.js` and `tui.js` shims support 2.0.24's local-directory loader; **build before loading** and rebuild after source changes.

Start or restart OpenCode, then type `/skillz` and press Enter:

```sh
opencode --standalone /path/to/your/project
```

The command works from the **home screen without creating a session**, and is also in the command palette (`Ctrl+P` → **Manage skills (Skillz)**). The plugin uses custom OpenTUI dialogs, not a session-only panel or custom route. Action rows and badges use your OpenCode theme's semantic colours: success for install/enable, error for remove/disable/No, warning for updates/overrides, and muted secondary information. The selected row has a highlighted background and a `›` marker, so focus is not conveyed by colour alone.

## Configuration and automatic updates

Use plugin options in **`opencode.jsonc`**, not `cli.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
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
| `automaticUpdates` | `true` | Apply available updates without prompting. Set `false` for **manual-only updates**; version checks and Installed badges still work. |
| `updateIntervalMs` | `21600000` (6h) | Check/update interval in milliseconds; integer `1000`–`2147483647`. |
| `dataDir` | `$XDG_DATA_HOME/opencode-skillz` or `~/.local/share/opencode-skillz` | Shared per-user state/cache directory. Use an absolute path. |

Startup checks wait for OpenCode's built-in skill discovery, then run when due. One timer is shared by locations in a server; `scheduler.json` claims are serialized under the same `.lock` as state writes across servers. New locations/restarts do not repeat a cycle within the interval. A live running owner prevents overlap; a dead owner is recoverable on the next tick. Timers are unreferenced and stop when the last location unloads. Scheduling runs only while OpenCode is running (not an OS cron service). Use consistent global options: the first active location's options win within a server; the first due claimant wins across servers sharing `dataDir`.

Automatic updates skip sources with `ref`, `sha` or `sha256` pins, including branch-name refs, and abandoned installations. Checks can still show a changed branch ref; explicitly Update to follow it. Automatic new collisions skip the **whole source**, retain its previous installation, and appear in Errors; they never request or infer approval. Failed fetch, validation, registration/reload or state-pointer writes retain the prior version. Historical remote versions are retained; removal deletes only an installed entry's unshared current version directory. Local sources are linked, so upstream local edits themselves cannot be rolled back.

## Use the four tabs

The current tab is bracketed in the dialog title. Use **Ctrl+Left / Ctrl+Right** to switch tabs, or **Ctrl+T** to pick one. Footer actions can also be clicked or focused using Tab and activated with Enter. Type to filter, use arrows to select, Enter to inspect, and Escape to close/go back. Very narrow terminals may wrap the tab strip/footer.

- **Discover:** search marketplace entries and direct sources. Enter fetches a preview with the complete skill list and count, version, upstream location, source trust and licence (or “not declared”). These are read-only details above exactly two stacked choices: **Yes, install**, then **No**. No is selected by default; Enter accepts the focused choice, arrows/Tab change focus, and Escape means No. There is no separate warning screen to dismiss.
- **Installed:** renders local installations and cached update badges immediately, without waiting for upstream. A dim “checked 3h ago” / “never checked” hint shows freshness. A missing or ten-minute-old check starts a background refresh with “checking…”; **Ctrl+R** forces a check without closing the list. Results update badges in place, retaining search, selection, focus and scroll. Failed checks show a muted badge and appear in Errors, not a blocking dialog. Inspect to see override origins and full versions. Enable/disable and update apply to the entry's skills. Remove installed entry affects only that exact origin and leaves its source available; multi-skill entries also offer **Remove one skill…** and **Enable / disable one skill…**. Individually removed skills stay excluded from updates until the whole entry is removed and installed afresh.
- **Sources:** **Ctrl+A** adds a marketplace or direct source. Refresh with **Ctrl+R**. Enter offers inspection, refresh and removal. Removal previews the source name/location and exact installed skill IDs with their origin IDs and count. With installed skills, choose red **Remove source AND its N installed skills**, yellow **Remove source only — keep the skills (they become abandoned)**, or **Cancel** (default focus; Escape cancels). Nothing changes until chosen. An empty source has a simple Yes/No confirmation. Marketplace removal includes its recorded child entries, never independent sources pointing at the same upstream. Local source files are never deleted.
- **Errors:** inspect fetch/validation failures, collisions and unsupported content. **Ctrl+X** clears the error log after confirmation; **Ctrl+R** reloads the local error list.

Discover and Sources also render persisted source/catalog metadata first, then refresh in the background (at most once per ten minutes while this manager is open, or immediately with Ctrl+R). An empty Discover list shows “loading…” while fetching. Opening a tab never fetches individual skill previews; Enter on a Discover entry still fetches its full preview before asking to install.

The server stores the last completed update check atomically in `updates.json` beside `installed.json`: `{ checkedAt, updates: [{ sourceId, installedVersion, availableVersion?, updateAvailable, issues }] }`. Startup/interval checks populate the same cache even with `automaticUpdates: false`; manual checks do too. The read-only typed `listUpdateStatus` RPC returns that JSON-safe shape (`checkedAt: null` before a check, or when an installation has no matching result). Cached results are reconciled with current installed versions, so a completed update does not keep an obsolete “update available” badge. Concurrent checks share an in-flight promise across locations on the same server; the existing state lock serializes separate server processes. The TUI never writes these files.

If an action fails, a toast reports it; reopen `/skillz` and inspect Errors. Confirmations use read-only details and stacked coloured choices with a safe default. Collision prompts display the existing skill ID and origin. Explicit Yes approves overriding conflicts in that source: the skillz version takes precedence, the original is untouched, and removing the skillz installation restores it. Skills from explicit OpenCode `skills` config paths cannot be overridden. Use PgUp/PgDn or the mouse wheel to scroll long details; the choices remain below the detail pane.

### Abandoned skills and safe removal

Keeping skills when deleting their source makes them **abandoned**: Installed shows an `[abandoned]` badge and dim **source removed** hint. They retain their enabled/disabled setting, registration precedence, resolved upstream/version, cached skill bodies and supporting files. They remain usable and can be disabled/enabled or removed individually, but have no manual updates, update checks or scheduled updates. Linked local skills still use their original local files; skillz does not freeze files edited outside the tool.

Re-add the **same source** to re-adopt automatically, without downloading or moving the installed version. For marketplaces, refresh must rediscover the same entry. Re-adoption requires the same recorded origin ID, upstream type/location/subpath/pins, skill selection and declared version; a same-name entry retargeted to a different upstream is not adopted. Re-adoption preserves enablement and override order.

Removal matches recorded source IDs, not skill names. Same-ID skills from other skillz sources, independently added identical upstreams, external skill directories and config paths are untouched. Only an entry's own `cache/<source-id>/<version>/` directory is eligible for deletion, and it survives while any remaining or abandoned installation references it. Cleanup never follows symlinks or deletes local-source files. Registration is reloaded and verified in every active location on this server; failures roll back before deleting cache. A post-commit cache cleanup failure is reported in Errors and leaves the skills unregistered rather than restoring pointers to potentially deleted files. Historical/unowned cache folders are conservatively retained, not recursively swept.

Typed RPC: `previewRemoveSource({ sourceId })` returns `{ sourceId, source?, entries, skillCount, revision }`. `removeSource({ sourceId, skills: 'remove' | 'keep', revision? })` requires an explicit policy; the TUI passes the revision so a changed preview must be reviewed again. `remove({ sourceId, skillId? })` removes only that installed entry, or one skill in it, without forgetting its source or cascading to siblings. `setEnabled({ sourceId, enabled, skillId?, options? })` also supports toggling a single skill; an entry-level disable still suppresses all its skills. The core facade likewise requires an explicit removal policy.

`installed.json` retains its source-ID-keyed, scope-ready entries. New optional fields are `upstream` (resolved source record), `abandoned: true`, `formerSource` (deleted origin record), `excludedSkills` (individual removals), and `disabledSkills` (individual toggles). The retained `sourceId` is immutable provenance, not a live update link. All state writes use the state lock and atomic replacement. A short-lived `removal.json` journal recovers interrupted source/installation metadata transactions before the next writer or plugin startup; interrupted cache cleanup may leave unused files.

### Source trust

**Skills can contain scripts; adding a source means you trust it.** Nothing is executed during installation. Review the displayed source, skill list and licence before installing.

- A source you explicitly add in Sources (marketplace, git, URL, local path or archive) displays **“Trusted — you added this source”** in the theme's success colour. This is source provenance, not a per-skill rating or a claim that code is sandboxed.
- A marketplace's generated entries were not individually added by you. They display their actual source URL/path and **“Not added by you — from marketplace X”** in the theme's warning colour, even when they share the marketplace's host. Adding a marketplace does not silently mark every referenced repository trusted. An entry displays trusted if its exact source identity (type, location, subpath and any pins) is also present as an explicitly added source.
- Removing the explicitly added source removes that trust/provenance record; removing a marketplace also removes its generated source entries, with an explicit choice to remove or abandon their installed skills. Disabling only stops registration; it does not remove source trust. There is no separate trust switch, allowlist or per-skill permission feature.

Skillz state is user-scoped at `$XDG_DATA_HOME/opencode-skillz` (default `~/.local/share/opencode-skillz`); configure the plugin globally to make it available in every project.

### When sessions see changes

Install, update, enable, disable and remove refresh every active location using the same skillz data directory **on the connected server**. Existing sessions see the change on their **next model step**; you do not need to create a new session. A request already in flight is not rewritten.

OpenCode 2.0.24 preserves the initial system instructions and announces later changes in a `<system-reminder>` instead. **“New skills are available in addition to those previously listed” means the current session has received the new skill**, not that it is limited to new sessions. Changed descriptions replace the advertised list; disable/remove announce unavailable IDs. Earlier instructions and already-loaded skill bodies remain conversation history, not a live registry view.

Skills without a description, with `autoinvoke: false`, or denied by the agent's skill permissions are not advertised. Installing a skill does not force the model to invoke it. Separate standalone servers do not receive each other's registry changes; reload/restart the other server's plugin, or use the same shared server.

### Try the local LiteLLM marketplace

With your Skills Gateway running:

```sh
curl --fail http://localhost:4000/claude-code/marketplace.json
opencode --standalone /path/to/your/project
```

1. Run `/skillz`, press **Ctrl+A**, choose **Marketplace**.
2. Enter `http://localhost:4000/claude-code/marketplace.json`.
3. Leave the optional auth env-var name **blank**; this catalog is public.
4. Sources refresh automatically. Browse Discover, search an entry, and press Enter to inspect its actual skills before deciding whether to install.

A public catalog does not imply public entry repositories. Entries using private git remotes still need your normal git credentials. The catalog is not bundled and its contents may change.

### Optional HTTP authentication

The add-source dialog accepts only an **environment-variable name**, never a secret value. Choose Bearer auth, a custom header, or a query-parameter name. Only the reference and transport names are stored. Set the variable securely in the **server's environment before starting OpenCode**; with a managed background service, changing only the client's environment will not change the server's environment. Git sources use existing git credentials instead.

## Security model

- Source trust is your decision, not a sandbox or security audit. Review the preview/source/licence before installing. Skillz never runs downloaded scripts, hooks, package managers or git smudge/process filters. Existing git credentials/SSH are trusted local configuration; authentication is non-interactive.
- Archive traversal, symlinks, hardlinks and special entries are rejected. Existing extraction/index destination symlinks are rejected even if they point inside the destination. Discovery rejects supporting-file or explicit `SKILL.md` symlinks escaping the source. Linked local sources and skillz's private state directory must remain under your control; this is not protection against another process with your UID racing filesystem changes.
- Defaults: **32 MiB/download**, **128 MiB extracted payload**, **10,000 archive entries/index files**, **5 redirects**; indexes also have depth/aggregate-size limits. Tar decompression includes a bounded metadata/header allowance. These core-library limits are not plugin options. Unknown components are reported, never executed.
- Initial HTTP URLs are supported for local gateways (and are not transport-secure); **every redirect must use HTTPS**, including loopback redirects. Index requests/redirects stay same-origin. HTTP auth is never sent to another origin; query credentials are stripped before redirects. No credential values belong in source URLs/config. Env references only; known auth values are redacted from persisted errors and echoed HTTP/archive bodies containing them are rejected before caching.
- Archive SHA-256 and full git SHA pins are verified and mismatch/unavailable commits fail closed. Ref pins suppress automatic movement; they are not immutable cryptographic pins. Use a full SHA/SHA-256 for reproducibility.
- Downloaded bytes, supporting files and per-skill licences are preserved; executable permission bits are retained, archive privilege bits are not. Frontmatter is stripped only from the OpenCode registration body, not the cached `SKILL.md`.
- The pinned OpenCode SDK still has transitive **moderate** npm advisories. Local high/critical Zod/Seroval findings were remediated with a scoped Zod override and compatible Solid update; upgrading the SDK is a separate compatibility decision. Do not treat this implementation as a dependency-audit certification.

### Troubleshooting

- **An existing session reports an old skill list:** send another turn and look for the skill-list update reminder, rather than only the original system prompt. Confirm that `/skillz` and that session use the same server and data directory. A TUI is a separate client process, but its RPC calls go to its connected server. Check description, autoinvoke and skill permissions too. New sessions are not normally required; a model claiming a skill is missing is not proof of what the server sent.
- **No automatic update:** ensure OpenCode is running and `automaticUpdates` is true; inspect pin fields and Errors. The persisted next-run time survives location setup/restarts. Installed → Check updates works immediately in either mode. A source containing a newly colliding ID is skipped in full.
- **Lock timeout/stuck cycle:** inspect Errors and whether the recorded owner process is still alive. Do not remove `.lock` or edit state while a server is using it. Dead state-lock owners are reclaimed after five minutes by default; dead scheduler claims are reclaimed on the next tick. A live owner is never evicted just because a download is slow.
- **HTTP redirect/auth error:** redirects to HTTP are deliberately rejected. Use a final URL or fix the gateway to redirect to HTTPS. For indexes, use the same origin. Set the referenced variable in the server environment, not in the dialog or a URL.
- **Update fails:** the old remote cache and installed pointer remain active; inspect Errors and retry manually. A failed runtime reload also restores the previous registration snapshot. Local files are not versioned by skillz.
- **Another standalone server still shows old skills:** in-process locations synchronize on mutation; separately running servers currently need a plugin reload/restart to refresh their registration snapshot after another server writes shared state. The file lock prevents duplicate scheduler work, not cross-process registry broadcasts.

## Isolated manual trial

This gives OpenCode and skillz disposable state and does not change your normal config. Exit OpenCode before removing the demo directory. An isolated HOME may not have your normal SSH configuration for private git sources.

```sh
cd /path/to/opencode-plugin-skillz
npm ci && npm run build
mkdir -p /tmp/opencode
demo=$(mktemp -d /tmp/opencode/skillz-demo.XXXXXX)
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

```sh
npm run typecheck
npm test
npm run build
# Optional real-terminal integration smoke (requires tmux and OpenCode 2.0.24):
OPENCODE_TUI_SMOKE=1 npm test -- test/tui-runtime.test.ts
# Optional existing-session refresh smoke (local mock provider; no LLM account):
OPENCODE_SESSION_SMOKE=1 npm test -- test/session-runtime.test.ts
# Optional live catalog + scheduler check/update (requires access to its git entry):
SKILLZ_LIVE_MARKETPLACE=1 npm test -- test/live-scheduler.test.ts
```

Pure view-model tests cover tab navigation, filtering, metadata/trust formatting, cache freshness, update badges and overrides. Controller tests exercise the typed RPC adapter, slow background refreshes, deduplication, closed-dialog results and safe confirmations; renderer tests verify in-place updates, theme tokens, read-only details, No/Cancel default focus, cancellation, filtering and footer actions without loading native bindings in Node. Safe-removal tests cover exact origins, shared caches, local/symlink boundaries, rollback, recovery, scheduler races and re-adoption. The opt-in smoke starts a private OpenCode instance with isolated HOME/XDG directories and a dedicated tmux server, invokes `/skillz` from home, installs a colliding local skill only after explicit approval, verifies Installed renders while a real HTTP check is deliberately held pending, observes badges after releasing it, updates, disables/enables, checks removal default Cancel/Escape, keeps skills as abandoned, re-adds to re-adopt, then explicitly removes source and skills and clears Errors. It never uses an LLM or the user's skillz state. It writes plain-text and ANSI-colour captures to `/tmp/opencode/skillz-install{,.ansi}.txt` and `/tmp/opencode/skillz-installed{,.ansi}.txt`, then deletes its isolated runtime state.

The session-refresh smoke loads the plugin from isolated **global** config, opens a real session, installs through `/skillz` in a separate TUI process attached to that session, and inspects actual outgoing model requests at a local mock provider. It verifies next-step addition, description update, disable/enable and removal in that same session, including mutations from another active location. It uses no real provider credentials and cleans up its own server, terminal and HOME/XDG state.

Scheduler/adversarial tests cover singleton claims, manual mode, pins, collision skips, mid-update failures and registration rollback; zip-slip, tar links/decompression bombs, index traversal/symlinks, HTTPS/origin/redirect limits, sha verification, git filter suppression, unchanged licences/modes and sentinel-token scans of persisted files. The live smoke fetches the public localhost LiteLLM catalog and a real git entry in disposable HOME/XDG state. It forces only its disposable installed-version marker stale to deterministically exercise startup check → automatic update without modifying upstream or the user's state.
