# Orca Discord Presence

> Fork of [LuticaCANARD/orca-discord-presence](https://github.com/LuticaCANARD/orca-discord-presence) (MIT).

Publishes what your [Orca](https://github.com/stablyai/orca) agent fleet is doing to your Discord status, next to the Orca logo.

```text
Playing Orca ADE
┌──────┐  Claude codes the best                          ← tagline, rotates every 45s
│ logo │  2 agents working · 1 blocked for 4m   (3 of 5)  ← live fleet…
└────🟡┘  00:14 elapsed
          [ Get Orca ]

┌──────┐  Agents assembled
│ logo │  Today: 14 tasks done · 3h 40m agent time       ← …or today's stats
└────🟢┘  00:14 elapsed
          [ Get Orca ]
```

**Everything is set from a settings page:** run **Discord Presence: Open Settings** in Orca, or visit **http://orcadcrpc.localhost:47317** while Orca is running. Every field has a switch, and a live preview shows the card as Discord will.

- **Top line:** one of 50 built-in taglines ("Claude codes the best", "Codex is cooking", …) or your own list, in a shuffled order that only repeats once all have been shown. Turn taglines off and the line shows your **header** instead, which can name the workspace and branch at `full` privacy. While taglines rotate, the header moves to the logo's hover text.
- **Bottom line:** the live fleet, including how long an agent has been waiting on you, alternating with **today's stats** (tasks finished, agent time) and **all-time stats**. The party gauge counts busy agents out of the agents Orca has announced.
- **Timer:** the current stretch of work, from the moment the agent itself started, as stamped by Orca.
- **Badge:** in the logo's corner, following the fleet: 🟢 working, 🟡 an agent is waiting on you, ⚪ idle. Waiting outranks working.
- **Member list:** your name carries the fleet line ("2 agents working") instead of the application name.
- **Idle:** after 15 quiet minutes the status clears. It comes back the moment an agent gets busy, and an idle card notes an interrupted last run.

An agent counts as busy while it is `working`, `blocked`, or `waiting` — Orca renders the last two identically, as "agent needs user attention", so a fleet sitting on permission prompts keeps the timer running instead of reading as idle.

TypeScript, no runtime dependencies — the Discord Rich Presence IPC protocol is spoken directly over `node:net`.

## Requirements

- Orca `>= 1.4.0` with the plugin system enabled (Settings → Plugins) — last verified against Orca `1.4.221`, see [Compatibility](#compatibility)
- The Discord **desktop** app running on the same machine (the web client exposes no local IPC socket)

Nothing else. The plugin ships with a Discord application id and starts publishing as soon as an agent does something.

## Install

Settings → Plugins → *Add marketplace*, paste the URL, and accept the consent dialog:

```text
https://github.com/rftglyv/orca-discord-presence.git#v0.4.0
```

The `#v0.4.0` matters: without it Orca reads the index off `main`, which moves. The dialog lists the [capabilities](#capabilities-requested) below. To hack on the plugin instead, see [Development](#development).

## Privacy

**The default is `minimal`, and that is deliberate.** Branch names routinely carry ticket ids and client names, and a status that published them the moment you enabled the plugin would be a bad default.

| Level | Published |
| --- | --- |
| `full` | Header, focused workspace, branch, agent counts, and the workspaces agents are working in |
| `minimal` *(default)* | Header and agent counts. Busy worktrees are counted, never named; `{workspace}` and `{branch}` in the header blank out |
| `off` | Nothing; the status is cleared |

Cycle levels with the **Cycle Privacy Level** command. The `minimal` masking is not a convention — tests assert that no project, branch, or workspace name reaches the payload at that level.

Workspace names come from the worktree's directory name, falling back to its branch. Only worktrees Orca announced while the plugin was running can be named, so a `full` status degrades to `across 2 worktrees` rather than going blank, and long lists collapse to `in api, cli, docs +2`.

## Commands

| Command | Effect |
| --- | --- |
| `Discord Presence: Open Settings` | Opens the settings page in your browser — see [The settings page](#the-settings-page) |
| `Discord Presence: Toggle` | Enable/disable publishing |
| `Discord Presence: Cycle Privacy Level` | Sets the level from the command's argument, or cycles `full` → `minimal` → `off` → … without one |
| `Discord Presence: Set Header` | Sets line one from the command's argument, or cycles the presets without one |
| `Discord Presence: Reconnect` | Drops the Discord connection and publishes again immediately |
| `Discord Presence: Show Connection Status` | What is being published, the logo key, connection state, socket path, and the last error |

All of them persist. **Show Connection Status** is the first thing to reach for when something looks wrong — it reports why the last publish failed.

**Reconnect** is for the case the backoff cannot cover: Discord started after Orca, or restarted while the fleet was quiet. The plugin retries on its own, but only while its worker is alive, and Orca reaps an idle worker after five minutes (see [Known limitations](#known-limitations)). Running the command re-forks the worker *and* makes that fork connect straight away.

### Shortcuts

Every command shows up under **Settings → Shortcuts → Plugins**, where you can record a chord for the ones you reach for — `Toggle` and `Cycle Privacy Level` being the likely two.

**The plugin ships no default chords, deliberately.** A manifest keybinding is *instructional content* to Orca: declaring one binds your consent to the plugin's file tree, so every release would arrive as *Needs review* in Settings → Plugins, and a chord that collided with another plugin's would disable **both** plugins' commands. A shortcut you record yourself is an override — it survives updates and costs neither.

## Configuration

### The settings page

**Discord Presence: Open Settings** starts a small web server inside the plugin and opens `http://orcadcrpc.localhost:47317` in your browser. Bookmark it: it works whenever Orca is running and the plugin has started. (If port 47317 is taken, the command opens whichever port it got instead.)

Every `*.localhost` name points at your own machine without any DNS or hosts-file change, which is how the friendly name works. A bare word like `orcadcrpc` with no `.localhost` would not: browsers treat it as a search, and claiming a name like that needs admin rights to edit `/etc/hosts`.

The server only answers on your machine (`127.0.0.1` and `::1`), and only to requests that name it as `localhost`, `orcadcrpc.localhost` or the loopback address, so a website using DNS tricks cannot reach it. Saving needs a token that only the page itself can read, and requests from other sites are refused. Settings saved here go through the same validation as the settings file below.

### Taglines and stats

The 50 built-in taglines live in `src/lib/taglines.mts`. To use your own, paste them into **My taglines** on the settings page (one per line, 2–128 characters) or set `customTaglines` in the settings file.

Stats count a **task** as one agent going busy and coming back to `done`; a detour through a permission prompt does not count twice. **Agent time** adds up those stretches, using Orca's own start time when it has one. "Today" resets at local midnight. Stats are kept in plugin storage, so they survive Orca restarts.

Every setting has a working default; this section is for changing them.

### The header

The **Set Header** command is the way in that does not involve a text editor:

- **With an argument** — the argument becomes the header, so a keybinding or automation can set it outright: `"My Fleet"`, or `{ "header": "My Fleet" }`. An empty string hides the header.
- **With no argument** — it cycles the presets, which is all the command palette can drive on its own:

  `Orca` → `{workspace}` → `{workspace} · {branch}` → *hidden* → `Orca` → …

`{workspace}` and `{branch}` are resolved at publish time, not frozen into the setting, and that distinction is the whole point. A header of `checkout-service` keeps publishing that name after a drop to `minimal`; `{workspace}` blanks out and falls back to `Orca`. A token that resolves to nothing takes its separator with it, so the line never trails a stray middle dot.

### The logo and the badge

`largeImage` is an **art asset key**, not a file path — Discord renders artwork uploaded to the application the presence is published through. The shipped application hosts the Orca logo under the key `orca`, which is why the logo needs no configuration.

Point `clientId` at your own application and that stops being true: the key `orca` means nothing there until you upload artwork under that name. Upload a logo as `orca`, or set `largeImage` to whichever key you used.

`smallImage` is the badge in the logo's corner. **Unset, it follows the fleet** and publishes one of the keys `working`, `waiting`, or `idle`, which the shipped application hosts (the artwork lives in `assets/discord/`). Set it to a key of your own to pin that artwork, or to `""` to turn the badge off. A badge with no logo to sit on is dropped rather than published alone.

### The button and the member list

`buttons` defaults to one **Get Orca** button linking to onorca.dev. Discord shows buttons to everyone viewing your profile *except you*, so do not expect to see it on your own card. Up to two buttons are published; one with a label over 32 characters or a non-`http(s)` URL is dropped rather than sent, since Discord would reject the whole update over it.

`statusLine` picks which line Discord shows next to your name in member and DM lists: `"state"` (default — the fleet line), `"details"` (the header line), or `"name"` (the application name).

### The party gauge

Discord renders `(3 of 5)` beside the status line: busy agents out of the panes Orca has reported a status for. It needs no configuration and carries no names, so it publishes at `full` and `minimal` alike, and disappears when nothing is busy — `(0 of 5)` reads as a broken party rather than as an idle fleet. The party id that accompanies it is random per worker and joinless: Rich Presence needs a join secret to put a **Join** button on your profile, which this plugin never sends.

### Publishing under your own Discord application

The line *above* the header reads *"Playing \<application name\>"*, and that name belongs to the Discord application, not to this plugin — Rich Presence IPC has no field for it. That is what `header` exists for: it is the topmost line a plugin can control. To change the *"Playing …"* line itself, publish through an application of your own:

1. [Discord Developer Portal](https://discord.com/developers/applications) → **New Application**
2. Name it whatever the status should read as
3. Copy the **Application ID** from *General Information* into `clientId`
4. Upload artwork under *Rich Presence → Art Assets* — the four PNGs in `assets/discord/` keep their file names as keys, which is what the defaults expect (`scripts/generate-discord-art.py` regenerates them from Orca's icon)

A Rich Presence application id is a public identifier — it travels in every client's IPC traffic and grants nothing on its own. The sensitive half is the OAuth client secret, which Rich Presence never needs and this plugin never asks for. That is why an id ships in the source.

### The settings file

Orca has no UI for per-plugin settings yet, so anything the commands do not cover is written by hand:

| Platform | Path |
| --- | --- |
| Linux | `~/.config/Orca/plugins-data/rftglyv.discord-presence/settings.json` |
| macOS | `~/Library/Application Support/orca/plugins-data/rftglyv.discord-presence/settings.json` |
| Windows | `%APPDATA%\Orca\plugins-data\rftglyv.discord-presence\settings.json` |

```json
{
  "enabled": true,
  "privacy": "minimal",
  "clientId": "1234567890123456789",
  "header": "Orca",
  "largeImage": "orca",
  "largeText": "Orca",
  "smallText": "",
  "buttons": [{ "label": "Get Orca", "url": "https://onorca.dev" }],
  "statusLine": "state",
  "idleClearMinutes": 15
}
```

| Key | Default | Effect |
| --- | --- | --- |
| `enabled` | `true` | Publish at all |
| `privacy` | `"minimal"` | See [Privacy](#privacy) |
| `clientId` | shipped id | The Discord application to publish through |
| `header` | `"Orca"` | Line one; takes `{workspace}` and `{branch}`; `""` hides it |
| `largeImage` | `"orca"` | Art asset key for the logo; `""` publishes no image |
| `largeText` | `"Orca"` | Tooltip when hovering the logo |
| `smallImage` | *(follows the fleet)* | Art asset key for the badge; `""` turns it off |
| `smallText` | *(follows the fleet)* | Tooltip when hovering the badge |
| `buttons` | Get Orca | Up to two `{ "label", "url" }` link buttons; `[]` or `false` publishes none |
| `statusLine` | `"state"` | Member-list line: `"state"`, `"details"`, or `"name"` |
| `idleClearMinutes` | `15` | Minutes an idle card stays up before the status clears; `0` keeps it |
| `taglines` | `true` | Rotate taglines through the top line; `false` shows the header |
| `customTaglines` | *(built-in 50)* | Your own list of taglines |
| `showStats` | `true` | Rotate today's and all-time stats through the bottom line |
| `rotateSeconds` | `45` | Seconds between rotations; never faster than 20 |

Every key is optional, and `""` means *off* rather than *default*. Restart Orca, or disable and re-enable the plugin, to pick the file up.

## Capabilities requested

| Capability | Why |
| --- | --- |
| `workspace:read` | Focused workspace name and branch, for `full` privacy |
| `events:subscribe` | Worktree lifecycle and agent status changes — the data being published |
| `storage` | Fleet state, stats, and the settings-page token survive restarts |
| `settings:own` | The plugin's own `enabled` / `privacy` / `clientId` / `header` / artwork keys |
| `notifications:show` | Command feedback |

`secrets` and `terminal:send` are deliberately **not** requested.

Beyond these, the plugin opens two local connections that Orca has no permission setting for yet: the Discord IPC socket, and the settings-page server on `127.0.0.1` / `::1` (only after you run **Open Settings**).

## Compatibility

Reviewed on 2026-10-07 against Orca [`v1.4.221`](https://github.com/stablyai/orca/releases/tag/v1.4.221), the latest stable release, and `main` at `2137295bb692f5e559daecee9e7bfb04472e5707`. (The upstream plugin last reviewed `v1.4.192`.)

Two tracked contracts moved since then, both compatibly:

- **`plugin-events.ts`** — `agent.status.changed` gained an optional `mainAgent: { state, outcome?, stateStartedAt }`. The plugin now uses `stateStartedAt` for the elapsed timer and falls back to its own clock on hosts that omit it.
- **`plugin-manifest.ts`** — tab-key helpers moved to `plugin-tab-key.ts` and are re-exported; the manifest schema itself is unchanged.

The engine floor stays `>=1.4.0`: every field used beyond the original contract is optional.

Re-read upstream — these are the contracts `src/lib/orca-api.mts` transcribes:

| Upstream contract | State |
| --- | --- |
| Host API v0 method table (`plugin-host-api.ts`) | 13 methods, all still `experimental`; `workspace.readContext` still returns `{ branch, displayName, terminals }` |
| Event set (`plugin-events.ts`) | Still the three worktree/agent events — no focus-change event; `agent.status.changed` now carries optional `mainAgent` |
| Capability kinds (`plugin-capabilities.ts`) | Still seven unscoped kinds; still no `net:*` |
| Agent states (`agent-status-types.ts`) | Still `working` / `blocked` / `waiting` / `done`; the internal `monitoring` working mode still does not reach the plugin event payload |
| Worker environment (`plugin-worker-env.ts`) | Still an allowlist without `XDG_RUNTIME_DIR` |
| Idle reap (`plugin-host-protocol.ts`) | Still 5 minutes; worker→host calls count as activity (`plugin-host-process.ts`) |
| Settings and storage location | Still `<userData>/plugins-data/<publisher>.<id>/` |
| Manifest and marketplace schemas | Unchanged; `commands[].context` is declared here |

`orca-compatibility.json` records the reviewed Git blob ids. The read-only **Orca compatibility** workflow checks the latest stable release and `main` every Monday; it fails on any new stable version—even if the files are unchanged—or on contract drift in either ref, forcing this section and the handwritten API types to be reviewed. Run the same check locally with `npm run check:orca-compatibility` (network access to the public GitHub API is required).

Contribution kinds the manifest could carry and deliberately does not:

- **`keybindings`** — see [Shortcuts](#shortcuts).
- **`panels`** — a sandboxed panel may call only `workspace.readContext`, `terminal.sendText`, and `notifications.show`. Plugin storage and settings are worker-only, so a presence panel could not read what the plugin is publishing; there is nothing to render yet.
- **`languagePacks`, `vmRecipes`, `agents`** — content packs for other kinds of plugin.
- **`icon`** — the host validates it, but nothing surfaces it in the plugin list yet.

## Known limitations

**The status appears on the first event.** Orca forks a plugin worker lazily, so after Orca starts the card shows up with the first agent status change, not at launch. Once running, the worker's own 30-second workspace poll counts as activity, so Orca's 5-minute idle reap (`PLUGIN_WORKER_IDLE_REAP_MS`) does not take it down while Orca is open — which is why the plugin clears an idle card itself after `idleClearMinutes`. Fleet state is persisted to plugin storage across a restart, and statuses older than six hours are dropped rather than rehydrated as if still live.

**The focused workspace is polled, not pushed.** Orca emits no focus-change event, so `full` privacy refreshes and republishes the workspace and branch every 30 seconds. **Show Connection Status** and **Reconnect** refresh it immediately.

**Command arguments depend on the host.** **Set Header** accepts a string or `{ header }`, and **Cycle Privacy Level** a level or `{ privacy }`, when Orca passes an argument through. As of `1.4.221` no host path does: the palette and recorded shortcuts both invoke commands with no argument, even though the IPC carries one. Until that changes the cycles are the whole interface, and free-form headers go in the settings file.

**Linux socket discovery is heuristic.** Orca's worker environment is an allowlist that omits `XDG_RUNTIME_DIR`, so `/run/user/<uid>` is reconstructed from `process.getuid()`. Flatpak and Snap layouts are probed too.

**The plugin API is EXPERIMENTAL upstream.** Orca's own docs promise no compatibility until `pluginApi` v1 freezes. Opening a local socket is possible today only because the capability model has no `net:*` kind yet — the source notes scoped kinds are planned. A future Orca may gate this, and the plugin would need a declared capability to keep working.

**Discord throttles rapid reconnects.** A client that connects many times in a few minutes sees handshakes slow down or time out; in normal use the plugin connects once and stays connected, but space out manual testing.

**Discord rate limits `SET_ACTIVITY`.** Updates are debounced (1.5s) with a 4s floor between publishes, and identical payloads are skipped entirely.

**The worker's own log is in Settings.** When **Show Connection Status** is not enough, Settings → Plugins → *View logs* shows what the worker logged — failed connects, capability denials, and rejected events all land there.

## Development

```bash
git clone https://github.com/rftglyv/orca-discord-presence.git
cd orca-discord-presence
npm install
npm run build      # tsc → dist/
npm test           # build + node --test
npm run typecheck  # no emit
npm run preview -- waiting 60   # show a sample card (working | waiting | idle | stats) for 60s
npm run dev:host -- 10          # run the plugin outside Orca for 10 min, with fake agents and the settings page
```

Settings → Plugins → *Add development plugin* and pick the checkout directory to load it into Orca.

```text
orca-plugin.json            manifest (validated against the host schema by a test)
orca-marketplace.json       marketplace index — lets this repo be its own source
orca-compatibility.json     reviewed Orca release and plugin-contract object ids
scripts/check-orca-compatibility.mjs
                            latest-release and main contract drift check
src/main.mts                worker entry: activate/deactivate, commands, events
src/lib/orca-api.mts        hand-maintained types for Orca's plugin worker API
src/lib/presence-model.mts  pure state model — events in, activity payload out
src/lib/discord-ipc.mts     Rich Presence IPC client over node:net
src/lib/socket-path.mts     socket discovery across platforms and sandboxes
```

`dist/` **is committed on purpose.** Orca installs a plugin directory as-is with no build step on the host side, so the compiled entry has to be in the repository. CI fails the build when `dist/` and `src/` disagree.

Orca ships no types package for plugin authors, so `src/lib/orca-api.mts` transcribes the host's contracts (`plugin-host-api.ts`, `plugin-events.ts`, `plugin-capabilities.ts`). A type error there after an Orca upgrade is a real signal — read it before casting it away.

### Cutting a release

Four places carry the version, and a test fails if they disagree:

1. `package.json` → `version`
2. `orca-plugin.json` → `version`
3. `orca-marketplace.json` → `plugins[].source.ref` (as `v<version>`)
4. `README.md` → the install URL's `#v<version>` fragment

Then `npm run build`, commit, and push a matching tag:

```bash
git tag v0.1.0 && git push origin v0.1.0
```

The release workflow re-runs typecheck, build, the stale-`dist/` check and the tests, verifies the tag matches the manifest, and publishes a GitHub release.

The marketplace listing pins a **release tag**, not `main` — a branch ref would re-resolve to whatever HEAD happens to be on the next marketplace refresh, quietly moving users onto unreleased commits. A test enforces that the ref is a tag and that it matches the manifest version.

## License

MIT
