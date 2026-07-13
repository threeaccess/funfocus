# FunFocus Module Architecture (v2 build)

This document is the binding contract for all agents working on this codebase. Read it fully before writing code. Feature agents may ONLY edit their own assigned file under `js/features/`. Never edit `index.html`, `js/core.js`, `js/boot.js`, or another agent's feature file.

## File layout

```
index.html            — shell: core CSS, DOM roots (#ad-banner, #root), script tags in fixed order
js/core.js            — timer engine, state, persistence, scenes, audio, UI framework, FF API
js/features/story.js  — story progression, postcards, streak weather
js/features/flow.js   — break quests, opening ritual, audio narrative arc
js/features/insight.js— adaptive focus length, reflection insights, goal continuity, distraction parking
js/features/ambient.js— picture-in-picture timer, time/weather scene sync, calendar-aware sessions
js/features/world.js  — fireflies co-presence (simulated), village co-op quest (simulated), boss battles, daily montage
js/boot.js            — calls FF.init() (must load last)
```

Script order in index.html: `core.js`, then all feature files (any order), then `boot.js`. All plain `<script>` tags (no modules, so file:// works too). Everything must run on a static host (Cloudflare Workers assets) with no build step.

## Global API — `window.FF`

Core implements exactly this API. Feature modules consume it and must not reach into core internals or other modules.

### Registration & lifecycle
- `FF.registerFeature({ id, init(ctx) })` — called by each feature file at top level. Core invokes `init` for each feature (registration order) inside `FF.init()` after state/DOM are ready. `ctx` is `{ on, emit, state, timer, store, media, ui, audio, hooks }` (same objects as the `FF.*` namespaces).
- Feature `init` must be exception-safe: core wraps each `init` in try/catch and logs failures without breaking other features.

### Events — `FF.on(name, cb)`, `FF.off(name, cb)`, `FF.emit(name, payload)`
Core emits:
- `app:ready` — after all features initialized
- `timer:start` `{ mode }`
- `timer:pause` `{ mode, remaining }`
- `timer:tick` `{ remaining, total, mode }` — every second while running
- `session:complete` `{ mode, durationSec, goal }` — countdown reached 0 (before reflection sheet for focus)
- `session:finalized` `{ session }` — focus session stored (after reflection save/skip). `session` = `{ profileName, duration, goal, reflection, id, date, ...extras }`
- `session:abandon` `{ mode, elapsedSec, remaining }` — reset or mode-switch while a focus session was running with >60s elapsed
- `mode:change` `{ mode }` — mode is `focus | shortBreak | longBreak`
- `goal:set` `{ text }`
- `scene:change` `{ src, index }`
- `sheet:open` `{ kind }`, `sheet:close` `{ kind }`

Features may emit their own namespaced events (e.g. `story:unlock`) for cross-feature listeners, but must not *depend* on another feature being present.

### State (read-only for features) — `FF.state`
`{ mode, timeLeft, isActive, activeProfile, profiles, notes: {goal, reflection}, muted, openSheet }`

### Timer — `FF.timer`
- `start()`, `pause()`, `toggle()`, `reset()`
- `getRemaining()`, `getTotal()`
- `setTimeLeft(seconds)` — only while paused
- `startCustom(focusMinutes)` — temporarily override focus duration for the next session (used by calendar fit + rescue sessions); reverts to profile after the session ends.

### Persistence — `FF.store`
- `FF.store.load(key, fallback)`, `FF.store.save(key, value)` — JSON, localStorage, keys auto-prefixed `ff_`.
- Legacy keys `anime_pomodoro_profiles` and `anime_pomodoro_history` remain as-is (core keeps using them). Session history read via `FF.store.getHistory()`; core also exposes `FF.store.addSessionExtras(obj)` — merges extra fields (e.g. `{boss:true}`) into the session record currently being finalized.
- Each feature must namespace its keys with its module name, e.g. `story.progress`.

### Scenes — `FF.media`
- `FF.media.list` — `[{ src, type: 'video'|'image', tags: [...] }]`. Tags from: `night, day, sunset, action, calm, character, group, study, village, snow, blossom, moon, epic`.
- `FF.media.setScene(indexOrSrc)` — crossfade to scene
- `FF.media.current()` — `{ src, index }`
- `FF.media.pick(filterFn)` — random scene matching predicate (returns src or null)
- `FF.media.setRotationFilter(fn|null)` — constrain the automatic rotation pool (used by weather/time sync, boss mode). Last-set wins; pass null to clear.
- `FF.media.getElement()` — the current background `<video>`/`<div>` element (for PiP capture).

### UI — `FF.ui`
- `FF.ui.registerButton({ id, icon, title, onClick, isActive() })` — adds an icon button to the feature dock (core renders a horizontally scrollable strip of feature buttons below the header; primary 4 buttons unchanged).
- `FF.ui.registerSheet(kind, { render(): htmlString, wire(hostEl) })` — feature-owned bottom sheets, opened via `FF.ui.openSheet(kind)`. Core routes rendering/wiring/closing.
- `FF.ui.openSheet(kind)`, `FF.ui.closeSheet()`
- `FF.ui.toast(msg, opts={duration})` — small transient glass toast, top-center.
- `FF.ui.banner(html, opts={id, onClick, timeout})` — dismissible suggestion strip above the control panel (used for "continue goal?", "fit a session before your meeting", rescue offers). Returns remove().
- `FF.ui.icon(name, size)` — lucide icon HTML. Core includes the existing icon set plus: `sparkles, book-open, camera, film, users, swords, cloud-sun, pip (picture-in-picture), brain, coffee, wind, map, gift, trophy, zap, moon, sun, inbox, lightbulb`.
- `FF.ui.esc(str)` — HTML escape.
- `FF.ui.injectStyle(cssString)` — appends a `<style>` tag once per feature.
- `FF.ui.confetti()` — tiny built-in petal burst (blossom particles) for celebrations.

### Audio — `FF.audio`
- `FF.audio.setVolume(v)` 0..1 (respects mute), `FF.audio.getVolume()`
- `FF.audio.setPlaybackRate(r)`
- `FF.audio.playCue(name)` — short synthesized WebAudio cues generated in core (no external files): `complete` (resolution chord), `finalStretch` (gentle rising motif), `breakEnd` (soft koto pluck call-back), `unlock` (chime).
- `FF.audio.isMuted()`
- Core keeps the looping bed track; features adjust volume/rate rather than swapping tracks.

### Hooks — `FF.hooks`
- `FF.hooks.beforeStart(asyncFn)` — registered functions run sequentially when the user presses Start, BEFORE the countdown begins (e.g. opening ritual overlay). Each receives `{ mode }` and may return a Promise; timer starts when all resolve. Must always resolve (never block start on error) and must be skippable by a click/keypress.
- `FF.hooks.onBreakStart(fn)`, called when a break countdown starts.

## Design rules

1. **Visual language**: dark glassmorphism, existing CSS vars (`--bg-panel`, `--accent-focus` #f43f5e, `--accent-short` #0ea5e9, `--accent-long` #8b5cf6, `--text-muted`). Reuse `.glass-panel`, `.btn`, `.chip`, `.sheet` classes. Fonts: Inter body, Outfit display. Everything must look native to the existing app — calm, minimal, no clutter.
2. **The scene is sacred**: never permanently obstruct the background. Overlays fade, panels stay compact, ambient elements (fireflies, weather) are subtle and pointer-events:none.
3. **No punishment UX**: lapses = quiet/dusk imagery, never guilt copy.
4. **Mobile-first**: everything works at 360px wide and with touch. Respect `env(safe-area-inset-bottom)`.
5. **Zero build, zero deps**: vanilla JS (ES2020 ok), no imports, no external libraries. External network calls allowed only where specified (open-meteo for weather) and must fail silently into a fallback.
6. **Performance**: no per-frame work while idle; use CSS animations where possible; cap particle counts (~24 fireflies max, ~40 petals).
7. **Escape all user text** with `FF.ui.esc`.
8. **Feature flags**: every feature registers in the Settings sheet via `FF.ui.registerButton` only if enabled; store an `enabled` flag under your namespace defaulting to true, and no-op cleanly when disabled.
9. IIFE-wrap every feature file: `(function(){ "use strict"; ... FF.registerFeature({...}); })();`

## Scene tag assignments (core must use these)

night: bonsai_moonset, moon_lit_walk_2, moon_over_purple_clouds, moon_ring, purple_moon_over_koi_pond_with_gates, house_on_purple_cliffs, girl_warrior_big_moon, moon* images
day: bike_ride_*, blossom_street_1, Cherry_blossom, cherry_blossoms_temple_1, girl_walking_cherry_blossoms, apartment, three_friends, two_friends, one_friend
sunset: girl_and_sunset, girl_sunset_lake, girl_sunset_pond, girl_over_bridge, house_on_A_hill
action/epic: purple_sword_girl, snow_sword, ronin_combined, two_ronins, two_ronins_talking_on_a_cliff, warrior_girl_leaping, girl_warrior_big_moon
study/calm: girl_studying_compressed, girl_studying_2.jpg, girl_writing_3, apartment, nice_glasses_1, nice_glasses_2, hands_in_pockets_girl
group: one_friend, two_friends, three_friends, two_ronins, two_ronins_talking_on_a_cliff
snow: snow_sword | blossom: Cherry_blossom, blossom_street_1, cherry_blossoms_temple_1, girl_walking_cherry_blossoms | village: bike_ride_village, house_on_A_hill, house_on_purple_cliffs | moon: all moon* + bonsai_moonset + girl_warrior_big_moon
(images with uuid filenames: tag `calm day`)

## Testing

`test/smoke.mjs` (jsdom) must keep passing: loads index.html, asserts no exceptions on boot, timer starts/ticks, all registered sheets open/close. Run: `node test/smoke.mjs`.
