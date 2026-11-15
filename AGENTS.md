# zh-t2s — Agent Guide

## What this is

A single-file Tampermonkey userscript (`zh-t2s.user.js`) that converts between Traditional and Simplified Chinese on web pages using [opencc-js](https://github.com/nk2028/opencc-js).

## Key facts

- **Single source file**: `zh-t2s.user.js` (IIFE pattern). No build system, no `package.json`, no bundler.
- **Lightweight CI**: `.github/workflows/ci.yml` runs syntax checks, `.github/scripts/check-userscript.cjs` for metadata/release-version consistency and rollback prevention, and Node built-in regression tests in `.github/scripts/*.test.cjs`, using Node.js 24 with no project dependencies. Tests load the real userscript in a VM with simulated DOM/GM/timer boundaries and an identity OpenCC substitute. No browser tests or linter exist; manually verify behavior on a Chinese-language site. Do not add further infrastructure unless asked.
- **Only dependency**: `opencc-js@1.4.2` loaded via `@require` from jsDelivr CDN. If CDN is unreachable, conversion is disabled but the script still registers menus and float button.
- **Version**: tracked in `@version` (userscript header) and `CHANGELOG.md`. A commit to `main` is effectively a release because Greasy Fork auto-pulls from `main`.
- **No `node_modules` or lockfile** — everything is runtime-only from CDN.

## How to work with it

- Edit `zh-t2s.user.js` directly; no build step. Save → install/reinstall in Tampermonkey → test.
- **Separate development and release commits**: commit feature/fix code and related usage documentation independently of release metadata. Add change notes under `CHANGELOG.md`'s `Unreleased` section during development; do not bump the published version in feature/fix commits.
- **Release commit**: use a separate `chore(release): <version>` commit to update `@version`, move `Unreleased` notes into a matching dated release entry in `CHANGELOG.md`, and update the README version badge together. Keep feature code out of this release commit. Pick the level with the table below, not by feel.
- **Benchmark**: `bench/benchmark.html` is a synthetic page (params `?blocks=&per=&shadow=&attrs=&ignore=&long=&lang=`) that reports node counts, first-write delay, total conversion time and long tasks. Serve it over HTTP (`python -m http.server`) — the userscript does not match `file://`. Disable the script and reload to get the page-only baseline.
- Maintain the metadata block (`// ==UserScript==`) carefully — Tampermonkey parses it.
  - Current grants: `GM_registerMenuCommand`, `GM_unregisterMenuCommand`, `GM_setValue`, `GM_getValue`.
  - `@noframes` prevents injection into iframes (ad/tracking iframe protection). Remove to re-enable iframe conversion.
  - `@run-at document-idle`, `@match *://*/*`, `@require` for opencc-js CDN.

### Version policy (SemVer applied to a userscript)

The script has no programmatic API, so "public API" means three things: **user-visible behaviour, persisted data, userscript metadata**. Judge the bump against those.

| Level | Bump when |
| --- | --- |
| **MAJOR** | Existing users must act, or cannot upgrade smoothly: GM storage keys or shape change incompatibly (dictionary JSON, settings-backup schema, site preferences), metadata narrows (`@grant`, `@match`, `@run-at`, `@noframes`), a menu or panel entry is removed/renamed, the off state stops restoring the original text, a newer userscript manager becomes required. |
| **MINOR** | Backwards-compatible new capability: wider conversion coverage (shadow DOM, new attributes or element types), a new setting or panel tool, a new persisted field, a reversible default change. |
| **PATCH** | Bug fix, performance work, internal refactor, docs or CI. |

Rules:

- A release that mixes categories takes the highest one.
- "Previously unconverted text now converts" is MINOR even though users experience it as a bug fix, and it belongs under `### 新增` so the change is visible in the release notes.
- `CHANGELOG.md` section meanings are fixed: `新增` user-visible capability, `优化` performance or experience, `维护` CI and dependencies, `修复` incorrect behaviour. Never file CI or tooling work under `新增`.

## Architecture notes

- **Single IIFE, no modules**: sections are numbered (1. converter, 2. config/state/shortcuts/whitelist, 3. WeakMap state, 4. queue, 5. idle scheduling, 6. observer, 7. applyState/restore, 8. menu/keys/float-button/reset, 9. bootstrap). Read top-to-bottom.
- **GM_ menu is intentionally thin** — only 4 items: direction toggle ×2, reset, float button hide/show. Whitelist operations, traditional style, dictionary access, and stats live in the **flat in-page float panel**.
- **Styling**: colours live in `THEME` (light/dark) and reach CSS as `--zh-*` custom properties via `themeVariables()`. Three style contexts share the same names: the injected panel stylesheet (`.zh-t2s-floatpanel{${tokens}}`), and the two shadow roots of the dialogs (`:host{${tokens}}`). Dark mode only re-declares the variables inside `@media (prefers-color-scheme: dark)` — never per-rule overrides. `dialogChrome()` reads the same palette for the `<dialog>` element, which sits outside the shadow tree.
- **Float button**: a draggable FAB (`zh-t2s-floatbtn`) in the bottom-right corner by default; its badge is a status dot (green = active, translucent white = off). Click opens a flat panel that keeps only the frequent entries: site preference, pause, traditional style, global default, dictionary, a collapsible shortcut section (one summary row by default), and a "更多工具" row that opens the low-frequency tools (ignore regions, site dictionary, selection tool, site manager, backup, hide, reset) in a secondary `openMoreTools()` dialog. The dictionary opens in a separate modal with draft editing, JSON import/export, and live preview. Position persisted via `GM_setValue('zh-t2s-floatpos')`.
- **State**: `'t2s' | 's2t' | 'off'`, persisted via `GM_setValue('zh-t2s-enabled')`. Last direction before off is stored in `zh-t2s-lastdir` so re-enable reuses it.
- **effectiveState()**: combines `isWhitelisted`, `hasOpenCC`, and raw `state` to show real per-page status in captions.
- **DOM flow**: initial scan via `enqueueDocument()` — `enqueueViewportHint()` first queues the subtrees around the viewport centre (only when `scrollY > 0`), then `enqueueSubtree(document.documentElement)` runs one TreeWalker for text nodes (O(1) parent-node-name skip via `SKIP_TAGS` Set) and shadow hosts, plus native `querySelectorAll` for attribute-bearing elements. `queue` is a `Set`, so insertion order decides which content converts first. Conversion batched via `requestIdleCallback` with `CHUNK_SIZE=300`. Observer handles dynamic content with self-write pre-check at the callback level (WeakMap `textState`/`attrState`).
- **Dictionary**: `zh-t2s-dictionary` stores `{ t2s: [[source, target]], s2t: [[source, target]] }`. `applyDictionary` matches original text with longest-match priority and converts unmatched segments. `buildDictionaryTries` is pure and reused by preview; install compiled state only after storage succeeds. Matching stays within each text node or attribute.
- **Shadow DOM**: TreeWalker, querySelectorAll and MutationObserver all stop at shadow boundaries, so every open `shadowRoot` found during a scan is treated as an independent root: recursed into by `enqueueSubtree`, observed by a shared `shadowObserver`, and recorded in `shadowRoots` so `restoreAll` covers it. `releaseShadowRoots()` runs when conversion turns off (direction/dictionary changes keep the roots: they are reused by `reconvertAll`). Closed roots and roots created by a later `attachShadow()` on an already-connected element are not picked up until the next full scan (click rescan or settings change).
- **Direction/style/dictionary change**: `applyState` does not restore-then-rescan; it switches the converter and calls `reconvertAll`, which walks document + registered shadow roots and rewrites each recorded node straight from `textOriginal`/`attrOriginal` in one DOM write (`rewriteTextNode`/`rewriteAttributes`). Nodes the page changed since our write drop their record and are handled by the follow-up scan; nodes now inside an ignored region are restored instead. `observer.observe` is re-issued (idempotent) so changed ignore rules take effect.
- **Loop guard**: MutationObserver callback checks `textState`/`attrState` before enqueuing — if the DOM value matches our last written value, skip. Prevents convert→observe→convert loops without queuing.
- **Conversion boundaries**: `INPUT` and `TEXTAREA` content and attributes are skipped; other eligible elements use `CONVERTIBLE_ATTRS`.
- **Silent elements**: one ancestor walk in `shouldSkipElement` (`SKIP_TAGS` set, `.ignore-opencc`, site ignore rules) that hops from a shadow root to its host via `ancestorOf`, so ignored regions cover shadow content too. `inActiveEditable` uses native `Element.isContentEditable` and the active element of `node.getRootNode()`.
- **Cross-tab sync**: `BroadcastChannel('zh-t2s')` broadcasts state and traditional style changes to same-origin tabs. Dictionary changes use GM storage: read on becoming visible or opening the editor, and check for conflicts before saving. `@noframes` prevents iframe injection.
- **Shortcuts**: default F8 (t2s), F9 (s2t), stored as `{ key, ctrl, alt, shift, meta }` under `zh-t2s-shortcut-t2s` / `zh-t2s-shortcut-s2t`. The panel records new combos: `beginShortcutCapture` switches the keydown handler into capture mode, `applyShortcut` saves and rejects duplicates plus keys that would steal typing (`isUsableShortcut`: F1–F12 may stand alone, everything else needs Ctrl/Alt/Cmd, and Shift alone does not count), and closing the panel clears the capture. Changes broadcast `zh-t2s-shortcuts` to same-origin tabs and are re-read on visibility change. Suppressed when input/textarea/contenteditable is focused or a dialog is open.

## Pitfalls to avoid

- `GM_registerMenuCommand` accessKey parameter only accepts single characters — never pass multi-char strings ('c1', 's2', 'cw').
- `window.top` in TM sandbox may not throw for cross-origin iframes. Do NOT rely solely on `window.top !== window.self`. Use `@noframes` as primary defense + try/catch JS fallback.
- The float button's click handler must use `!floatBtn.contains(e.target)` (not `e.target !== floatBtn`) for outside-click detection, because the badge/label children would otherwise cause a double-toggle.
- Menu refresh is throttled at 1s via `lastMenuRefresh` to avoid rapid unregister/register during dynamic content storms.
