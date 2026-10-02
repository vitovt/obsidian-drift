# End-to-end testing

## Run against a disposable vault and profile

The WebdriverIO configuration uses one worker, a temporary Obsidian profile, and a generated test vault. It does not use the normal personal profile. It removes its own profile/vault afterward. The test harness trusts only the vault it just created and copied the local plugin into.

Install dependencies in this directory with `npm ci`. Then run from `e2e/`:

```sh
# Set the Electron version embedded in your installed Obsidian application.
OBSIDIAN_ELECTRON_VERSION=43.3.0 npm run wdio

# Linux without a desktop display:
OBSIDIAN_ELECTRON_VERSION=43.3.0 xvfb-run -a npm run wdio \
  -- --spec ./test/specs/lifecycle-inbox.e2e.ts \
  --spec ./test/specs/replacement-restart.e2e.ts
```

`OBSIDIAN_BINARY` overrides the application path. Defaults are `/opt/Obsidian/obsidian` on Linux and `/Applications/Obsidian.app/Contents/MacOS/Obsidian` on macOS. The default Electron version is the original test environment's 37.10.2; override it for other app versions so ChromeDriver matches. Newer test dependencies may recommend Node 22 even though the recorded run used Node 20.

The pretest step rebuilds the plugin. The harness copies `main.js`, `manifest.json`, and `styles.css`, refreshes plugin manifests, enables Drift, waits for checkpoint initialization, and handles the delayed vault trust dialog. Do not assume that dialog is present immediately after opening the vault.

Failed UI tests save `/tmp/drift-e2e-failure.png`. The lifecycle test also captures the review and rename preview in `/tmp` for layout inspection. These are temporary artifacts, not committed assets.

## Distinguish fixture setup from the behavior under test

Use `markAsSelfModify()` before `vault.modify()` only when creating fixture contents that should not themselves be reviewed. Use an unmarked Vault API write when testing plugin/API detection. Use Node filesystem writes and renames when testing external events. Simulate editor typing with a CodeMirror transaction when testing typing and autosaves.

**Review file API operations** is on by default; tests expecting ignored plugin writes must explicitly disable `trackApiChanges`. Ignoring an API write does not implicitly accept an existing external review. **Review newly created files** is off by default; creations still establish baselines and feed rename matching.

Unit tests resolve CodeMirror from the root package to avoid loading conflicting state/history instances after installing the separate end-to-end dependencies.

## Isolate state and wait for observable changes

Use a fresh vault per suite. Wait for `baselineReady`, the expected review count, or specific review content rather than relying solely on fixed delays. Before writing offline changes, disable the plugin and await its `saveQueue`; after re-enabling it, wait for initialization again.

The dedicated lifecycle test covers copying a note without a creation review, later external modification, a draft, external rename confirmation, and undoing the association. The replacement/restart test covers an API write, delete/create replacement, offline changes, persisted drafts, and saving after a fresh comparison. These tests exercise real local filesystem events; they do not emulate Dropbox itself.

## Interact with the visible view

Drift normally opens in a background tab. Focus it before using WebDriver clicks. Scroll controls into view when needed. Use nested selectors for text buttons, for example `$(".diff-rename-modal").$("button=Confirm rename")`.

Close or locate leaves by view type, not the active leaf. Obsidian can preserve deferred leaves after plugin reload: load them before assuming they are live `DiffView` instances. The harness uses **Open diff viewer** and focuses the resulting view after a restart.

Electron may emit warnings about `Browser.getWindowForTarget` or disabled Node inspection fuses. The renderer WebDriver commands used here can still work. Diagnose actual test failures and screenshots rather than treating those warnings alone as plugin failures.
