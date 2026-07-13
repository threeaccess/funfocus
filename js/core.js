"use strict";
/* =====================================================================
 * FunFocus core.js — timer engine, state, persistence, scenes, audio,
 * UI framework, and the window.FF API (binding contract: ARCHITECTURE.md).
 *
 * Implementation notes (choices made where ARCHITECTURE.md was ambiguous;
 * feature agents should read these):
 *  - "Existing icon set" == the original ICON_PATHS from index.html
 *    (chevron-left/right, volume-2/x, sliders, pause, play, rotate-ccw,
 *    file-text, calendar, x, plus, minus, flag). New contract icons are
 *    added on top as clean lucide-style paths.
 *  - FF.store.load/save use the ff_ prefix and JSON. Legacy profile/history
 *    keys (anime_pomodoro_profiles / anime_pomodoro_history) are UNPREFIXED
 *    and kept exactly as before for backward compat.
 *  - Feature dock: a horizontally scrollable icon strip inside the control
 *    panel, rendered directly below the header row. Hidden (display:none)
 *    when no feature buttons are registered. The primary 4 header icons are
 *    unchanged.
 *  - registerSheet: feature sheets are routed through the SAME openSheet/
 *    closeSheet machinery as the 4 core sheets. A feature sheet render()
 *    returns an HTML string for the inner .sheet content; core wraps it in
 *    .sheet-wrap/.sheet and calls wire(hostEl) where hostEl is the .sheet.
 *    Core injects a close button automatically only if the feature markup
 *    does not include #sheet-close (features may provide their own).
 *  - session:complete fires the instant the countdown hits 0 (for focus,
 *    BEFORE the reflection sheet). session:finalized fires after the focus
 *    session is written to history (reflection saved or skipped).
 *  - session:abandon fires on reset/mode-switch while a focus session was
 *    running with >60s elapsed.
 *  - addSessionExtras merges fields into a pending-extras object that is
 *    spread into the session record at finalize time.
 *  - startCustom(focusMinutes): overrides focus duration for exactly the
 *    next focus session; reverts to the profile value when that session
 *    ends (complete / reset / mode change away from focus).
 *  - beforeStart hooks run sequentially on Start press before countdown;
 *    each wrapped in try/catch so a rejection never blocks start. A single
 *    click or keypress skips the remaining chain (skippable requirement).
 *  - Audio cues: 4 short WebAudio-synthesized cues, gain <= 0.15, AudioCtx
 *    lazily created on first user gesture.
 * ===================================================================== */

(function () {
  /* ---------------- tiny event bus ---------------- */
  const listeners = Object.create(null);
  function on(name, cb) {
    (listeners[name] || (listeners[name] = [])).push(cb);
    return () => off(name, cb);
  }
  function off(name, cb) {
    const a = listeners[name];
    if (!a) return;
    const i = a.indexOf(cb);
    if (i >= 0) a.splice(i, 1);
  }
  function emit(name, payload) {
    const a = listeners[name];
    if (!a) return;
    a.slice().forEach((cb) => {
      try {
        cb(payload);
      } catch (e) {
        console.error("FF listener error for '" + name + "':", e);
      }
    });
  }

  /* ---------------- persistence ---------------- */
  const LEGACY_PROFILES = "anime_pomodoro_profiles";
  const LEGACY_HISTORY = "anime_pomodoro_history";

  const store = {
    load(key, fallback) {
      try {
        const raw = localStorage.getItem("ff_" + key);
        return raw == null ? fallback : JSON.parse(raw);
      } catch (e) {
        return fallback;
      }
    },
    save(key, value) {
      try {
        localStorage.setItem("ff_" + key, JSON.stringify(value));
      } catch (e) {
        /* ignore quota / disabled storage */
      }
    },
    getHistory() {
      try {
        const y = localStorage.getItem(LEGACY_HISTORY);
        return y ? JSON.parse(y) : [];
      } catch (e) {
        return [];
      }
    },
    addSessionExtras(obj) {
      if (obj && typeof obj === "object") Object.assign(pendingExtras, obj);
    },
  };

  function getProfiles() {
    const defaults = [
      { id: "1", name: "Coding", focus: 45, shortBreak: 10, longBreak: 20 },
      { id: "2", name: "Studying", focus: 25, shortBreak: 5, longBreak: 15 },
      { id: "3", name: "Reading", focus: 60, shortBreak: 10, longBreak: 15 },
    ];
    try {
      const c = localStorage.getItem(LEGACY_PROFILES);
      return c ? JSON.parse(c) : defaults;
    } catch (e) {
      return defaults;
    }
  }
  function saveProfiles(p) {
    try {
      localStorage.setItem(LEGACY_PROFILES, JSON.stringify(p));
    } catch (e) {}
  }
  function addSessionRecord(s) {
    let c;
    try {
      const y = localStorage.getItem(LEGACY_HISTORY);
      c = y ? JSON.parse(y) : [];
    } catch (e) {
      c = [];
    }
    const rec = { ...s, id: Date.now(), date: new Date().toISOString() };
    c.push(rec);
    try {
      localStorage.setItem(LEGACY_HISTORY, JSON.stringify(c));
    } catch (e) {}
    return rec;
  }

  /* ---------------- media list + scene tags ---------------- */
  // Tags derived from ARCHITECTURE.md "Scene tag assignments".
  const MEDIA = [
    { file: "18b60f11-9c49-4f45-acd2-7b18673e8d76.jpg", tags: ["calm", "day"] },
    { file: "98c93cdc-72e5-4bad-a7ce-ced2d51912be.jpg", tags: ["calm", "day"] },
    { file: "f42aba03-3972-4266-8488-9353ef334cf0.jpg", tags: ["calm", "day"] },
    { file: "girl_studying_2.jpg", tags: ["study", "calm"] },
    { file: "apartment_compressed.mp4", tags: ["day", "study", "calm"] },
    { file: "bike_ride_brooklyn_compressed.mp4", tags: ["day"] },
    { file: "bike_ride_greece_compressed.mp4", tags: ["day"] },
    { file: "bike_ride_village_compressed.mp4", tags: ["day", "village"] },
    { file: "blossom_street_1_compressed.mp4", tags: ["day", "blossom"] },
    { file: "bonsai_moonset_compressed.mp4", tags: ["night", "moon"] },
    { file: "Cherry_blossom_compressed.mp4", tags: ["day", "blossom"] },
    { file: "cherry_blossoms_temple_1.mp4", tags: ["day", "blossom"] },
    { file: "girl_and_sunset_compressed.mp4", tags: ["sunset"] },
    { file: "girl_over_bridge_compressed.mp4", tags: ["sunset"] },
    { file: "girl_studying_compressed.mp4", tags: ["study", "calm"] },
    { file: "girl_sunset_lake_compressed.mp4", tags: ["sunset"] },
    { file: "girl_sunset_pond_compressed.mp4", tags: ["sunset"] },
    { file: "girl_walking_cherry_blossoms_compressed.mp4", tags: ["day", "blossom"] },
    { file: "girl_warrior_big_moon_compressed.mp4", tags: ["night", "action", "epic", "moon", "character"] },
    { file: "girl_writing_3.mp4", tags: ["study", "calm"] },
    { file: "grok-video-382c2362-7e64-48e1-9b8e-450575dd5f41.mp4", tags: ["calm", "day"] },
    { file: "grok-video-e06f26b9-5717-49c0-bff3-bc1a0be4a424.mp4", tags: ["calm", "day"] },
    { file: "hands_in_pockets_girl_compressed.mp4", tags: ["study", "calm", "character"] },
    { file: "house_on_A_hill_compressed.mp4", tags: ["sunset", "village"] },
    { file: "house_on_purple_cliffs.mp4", tags: ["night", "village"] },
    { file: "moon_lit_walk_2_compressed.mp4", tags: ["night", "moon"] },
    { file: "moon_over_purple_clouds_compressed.mp4", tags: ["night", "moon"] },
    { file: "moon_ring_compressed.mp4", tags: ["night", "moon"] },
    { file: "nice_glasses_1_compressed.mp4", tags: ["study", "calm", "character"] },
    { file: "nice_glasses_2_compressed.mp4", tags: ["study", "calm", "character"] },
    { file: "one_friend_compressed.mp4", tags: ["day", "group"] },
    { file: "purple_moon_over_koi_pond_with_gates_compressed.mp4", tags: ["night", "moon"] },
    { file: "purple_sword_girl_compressed.mp4", tags: ["action", "epic", "character"] },
    { file: "ronin_combined.mp4", tags: ["action", "epic"] },
    { file: "snow_sword_compressed.mp4", tags: ["action", "epic", "snow"] },
    { file: "three_friends_compressed.mp4", tags: ["day", "group"] },
    { file: "two_friends_compressed.mp4", tags: ["day", "group"] },
    { file: "two_ronins_compressed.mp4", tags: ["action", "epic", "group"] },
    { file: "two_ronins_talking_on_a_cliff_compressed.mp4", tags: ["action", "epic", "group"] },
    { file: "warrior_girl_leaping_compressed.mp4", tags: ["action", "epic", "character"] },
  ].map((m) => ({
    src: "images/" + m.file,
    type: m.file.endsWith(".mp4") ? "video" : "image",
    tags: m.tags,
  }));

  const isVideo = (s) => s.endsWith(".mp4");
  function randomIndex(cur, len) {
    if (len <= 1) return 0;
    let m;
    do {
      m = Math.floor(Math.random() * len);
    } while (m === cur);
    return m;
  }

  /* ---------------- icons ---------------- */
  const ICON_PATHS = {
    // ----- existing set (unchanged) -----
    "chevron-left": '<path d="m15 18-6-6 6-6"/>',
    "chevron-right": '<path d="m9 18 6-6-6-6"/>',
    "volume-2":
      '<path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z"/><path d="M16 9a5 5 0 0 1 0 6"/><path d="M19.364 18.364a9 9 0 0 0 0-12.728"/>',
    "volume-x":
      '<path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z"/><line x1="22" x2="16" y1="9" y2="15"/><line x1="16" x2="22" y1="9" y2="15"/>',
    sliders:
      '<line x1="21" x2="14" y1="4" y2="4"/><line x1="10" x2="3" y1="4" y2="4"/><line x1="21" x2="12" y1="12" y2="12"/><line x1="8" x2="3" y1="12" y2="12"/><line x1="21" x2="16" y1="20" y2="20"/><line x1="12" x2="3" y1="20" y2="20"/><line x1="14" x2="14" y1="2" y2="6"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="16" x2="16" y1="18" y2="22"/>',
    pause:
      '<rect x="14" y="3" width="5" height="18" rx="1"/><rect x="5" y="3" width="5" height="18" rx="1"/>',
    play:
      '<path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"/>',
    "rotate-ccw":
      '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
    "file-text":
      '<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
    calendar:
      '<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
    minus: '<path d="M5 12h14"/>',
    flag:
      '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" x2="4" y1="22" y2="15"/>',

    // ----- new contract icons (lucide-style) -----
    sparkles:
      '<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/><path d="M4 17v2"/><path d="M5 18H3"/>',
    "book-open":
      '<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>',
    camera:
      '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z"/><circle cx="12" cy="13" r="3"/>',
    film:
      '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M7 3v18"/><path d="M3 7.5h4"/><path d="M3 12h18"/><path d="M3 16.5h4"/><path d="M17 3v18"/><path d="M17 7.5h4"/><path d="M17 16.5h4"/>',
    users:
      '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    swords:
      '<polyline points="14.5 17.5 3 6 3 3 6 3 17.5 14.5"/><line x1="13" x2="19" y1="19" y2="13"/><line x1="16" x2="20" y1="16" y2="20"/><line x1="19" x2="21" y1="21" y2="19"/><polyline points="14.5 6.5 18 3 21 3 21 6 17.5 9.5"/><line x1="5" x2="9" y1="14" y2="18"/><line x1="7" x2="4" y1="17" y2="20"/><line x1="3" x2="5" y1="19" y2="21"/>',
    "cloud-sun":
      '<path d="M12 2v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="M20 12h2"/><path d="m19.07 4.93-1.41 1.41"/><path d="M15.947 12.65a4 4 0 0 0-5.925-4.128"/><path d="M13 22H7a5 5 0 1 1 4.9-6H13a3 3 0 0 1 0 6Z"/>',
    pip:
      '<path d="M2 10h6V4"/><path d="m2 4 6 6"/><path d="M21 10V7a2 2 0 0 0-2-2h-7"/><path d="M3 14v2a2 2 0 0 0 2 2h3"/><rect x="12" y="13" width="10" height="7" rx="1"/>',
    brain:
      '<path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/><path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4"/><path d="M17.599 6.5a3 3 0 0 0 .399-1.375"/><path d="M6.003 5.125A3 3 0 0 0 6.401 6.5"/><path d="M3.477 10.896a4 4 0 0 1 .585-.396"/><path d="M19.938 10.5a4 4 0 0 1 .585.396"/><path d="M6 18a4 4 0 0 1-1.967-.516"/><path d="M19.967 17.484A4 4 0 0 1 18 18"/>',
    coffee:
      '<path d="M10 2v2"/><path d="M14 2v2"/><path d="M16 8a1 1 0 0 1 1 1v8a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1h14a4 4 0 1 1 0 8h-1"/><path d="M6 2v2"/>',
    wind:
      '<path d="M12.8 19.6A2 2 0 1 0 14 16H2"/><path d="M17.5 8a2.5 2.5 0 1 1 2 4H2"/><path d="M9.8 4.4A2 2 0 1 1 11 8H2"/>',
    map:
      '<path d="M14.106 5.553a2 2 0 0 0 1.788 0l3.659-1.83A1 1 0 0 1 21 4.619v12.764a1 1 0 0 1-.553.894l-4.553 2.277a2 2 0 0 1-1.788 0l-4.212-2.106a2 2 0 0 0-1.788 0l-3.659 1.83A1 1 0 0 1 3 19.381V6.618a1 1 0 0 1 .553-.894l4.553-2.277a2 2 0 0 1 1.788 0z"/><path d="M15 5.764v15"/><path d="M9 3.236v15"/>',
    gift:
      '<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13"/><path d="M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7"/><path d="M7.5 8a2.5 2.5 0 0 1 0-5A4.8 8 0 0 1 12 8a4.8 8 0 0 1 4.5-5 2.5 2.5 0 0 1 0 5"/>',
    trophy:
      '<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/>',
    zap:
      '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
    moon:
      '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
    sun:
      '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
    inbox:
      '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
    lightbulb:
      '<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/>',
  };
  function icon(name, size = 24) {
    const p = ICON_PATHS[name] || "";
    return (
      '<svg class="lucide" width="' +
      size +
      '" height="' +
      size +
      '" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
      p +
      "</svg>"
    );
  }

  /* ---------------- html escape ---------------- */
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /* ---------------- application state ---------------- */
  const state = {
    profiles: [],
    activeProfile: null,
    mode: "focus", // focus | shortBreak | longBreak
    timeLeft: 0, // seconds
    isActive: false,
    notes: { goal: "", reflection: "" },
    muted: false,
    bgIndex: Math.floor(Math.random() * MEDIA.length),
    openSheet: null, // null | "time" | "history" | "goal" | "reflection" | <feature kind>
    presetOpen: false,
  };
  let newPresetName = "";

  let tickInterval = null;
  let bgTimeout = null;
  let audioEl = null;
  let lastRenderedBg = -1;

  let customFocusMin = null; // startCustom override for next focus session
  let sessionElapsed = 0; // seconds elapsed in current focus run (for abandon)
  let pendingExtras = {}; // merged into finalized focus session

  let rotationFilter = null; // FF.media.setRotationFilter

  const fmt = (secs) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
  };

  function focusSeconds() {
    if (customFocusMin != null) return customFocusMin * 60;
    return state.activeProfile ? state.activeProfile.focus * 60 : 0;
  }
  function modeSeconds(mode) {
    if (!state.activeProfile) return 0;
    if (mode === "focus") return focusSeconds();
    return state.activeProfile[mode] * 60;
  }

  /* ---------------- timer engine ---------------- */
  function startTick() {
    stopTick();
    tickInterval = setInterval(() => {
      if (state.timeLeft > 0) {
        state.timeLeft -= 1;
        if (state.mode === "focus" && state.isActive) sessionElapsed += 1;
        updateTimerDisplay();
        emit("timer:tick", {
          remaining: state.timeLeft,
          total: modeSeconds(state.mode),
          mode: state.mode,
        });
        // gentle final-stretch cue at 60s remaining while focusing
        if (state.mode === "focus" && state.timeLeft === 60) {
          playCue("finalStretch");
        }
      } else {
        onCountdownComplete();
      }
    }, 1000);
  }
  function stopTick() {
    if (tickInterval) {
      clearInterval(tickInterval);
      tickInterval = null;
    }
  }

  function onCountdownComplete() {
    stopTick();
    const mode = state.mode;
    state.isActive = false;
    syncAudio();
    scheduleBgRotation();

    const durationSec =
      mode === "focus" ? focusSeconds() : modeSeconds(mode);
    emit("session:complete", {
      mode: mode,
      durationSec: durationSec,
      goal: state.notes.goal,
    });

    if (mode === "focus") {
      playCue("complete");
      state.openSheet = "reflection";
    } else {
      playCue("breakEnd");
    }
    render();
  }

  let running = false; // guards concurrent start presses during beforeStart chain

  async function start() {
    if (state.isActive || running) return;
    running = true;
    try {
      await runBeforeStartChain();
    } finally {
      running = false;
    }
    // Fresh focus run resets the elapsed counter.
    if (state.mode === "focus") sessionElapsed = 0;
    state.isActive = true;
    startTick();
    syncAudio();
    scheduleBgRotation();
    emit("timer:start", { mode: state.mode });
    if (state.mode === "shortBreak" || state.mode === "longBreak") {
      emitBreakStart(state.mode);
    }
    render();
  }

  function pause() {
    if (!state.isActive) return;
    state.isActive = false;
    stopTick();
    syncAudio();
    scheduleBgRotation();
    emit("timer:pause", { mode: state.mode, remaining: state.timeLeft });
    render();
  }

  function toggle() {
    if (state.isActive) pause();
    else start();
  }

  function abandonIfNeeded(fromMode) {
    if (fromMode === "focus" && sessionElapsed > 60) {
      emit("session:abandon", {
        mode: "focus",
        elapsedSec: sessionElapsed,
        remaining: state.timeLeft,
      });
    }
  }

  function reset() {
    if (state.isActive || sessionElapsed > 60) abandonIfNeeded(state.mode);
    // A reset clears any startCustom override (session ended).
    customFocusMin = null;
    switchMode(state.mode, { isReset: true });
  }

  function switchMode(mode, opts) {
    opts = opts || {};
    const prev = state.mode;
    // Abandon if leaving a running/elapsed focus session (not a plain reset,
    // which already emitted abandon above).
    if (!opts.isReset && prev === "focus" && mode !== "focus") {
      if (state.isActive || sessionElapsed > 60) abandonIfNeeded(prev);
    }
    // Any move away from focus reverts a startCustom override.
    if (mode !== "focus") customFocusMin = null;

    state.mode = mode;
    state.isActive = false;
    stopTick();
    sessionElapsed = 0;
    if (state.activeProfile) state.timeLeft = modeSeconds(mode);
    syncAudio();
    scheduleBgRotation();
    emit("mode:change", { mode: mode });
    render();
  }

  function setTimeLeft(seconds) {
    if (state.isActive) return; // only while paused/idle
    const s = Math.max(0, Math.floor(seconds));
    state.timeLeft = s;
    updateTimerDisplay();
  }

  function startCustom(focusMinutes) {
    const min = Math.min(180, Math.max(1, Math.floor(focusMinutes || 1)));
    customFocusMin = min;
    if (state.mode !== "focus") {
      switchMode("focus");
    } else {
      state.timeLeft = focusSeconds();
      state.isActive = false;
      stopTick();
      updateTimerDisplay();
      render();
    }
    return start();
  }

  /* ---------------- profiles / presets ---------------- */
  function selectProfile(p) {
    state.activeProfile = p;
    customFocusMin = null;
    if (!state.isActive) state.timeLeft = modeSeconds(state.mode);
  }
  function adjustDuration(field, delta) {
    const p = state.activeProfile;
    if (!p) return;
    p[field] = Math.min(180, Math.max(1, (p[field] || 1) + delta));
    saveProfiles(state.profiles);
    if (field === state.mode && !state.isActive) {
      customFocusMin = field === "focus" ? null : customFocusMin;
      state.timeLeft = modeSeconds(state.mode);
    }
    render();
  }
  function addPreset() {
    const p = state.activeProfile;
    const name = (newPresetName || "").trim() || "Custom";
    const np = {
      id: Date.now().toString(),
      name: name,
      focus: p ? p.focus : 25,
      shortBreak: p ? p.shortBreak : 5,
      longBreak: p ? p.longBreak : 15,
    };
    state.profiles = [...state.profiles, np];
    saveProfiles(state.profiles);
    selectProfile(np);
    newPresetName = "";
    state.presetOpen = false;
    render();
  }

  /* ---------------- finalize focus ---------------- */
  function finalizeFocus(reflection) {
    const prof = state.activeProfile;
    const rec = addSessionRecord({
      profileName: prof ? prof.name : "",
      duration: focusSeconds(),
      goal: state.notes.goal,
      reflection: reflection || "",
      ...pendingExtras,
    });
    pendingExtras = {};
    customFocusMin = null; // custom override consumed
    state.notes = { goal: "", reflection: "" };
    state.openSheet = null;
    emit("session:finalized", { session: rec });
    switchMode("shortBreak");
  }

  /* ---------------- background music ---------------- */
  function syncAudio() {
    if (!audioEl) return;
    const shouldPlay =
      state.isActive &&
      (state.mode === "focus" || state.mode === "shortBreak") &&
      !state.muted;
    if (shouldPlay) {
      const pr = audioEl.play();
      if (pr && pr.catch) pr.catch((e) => console.log("Audio play failed:", e));
    } else {
      audioEl.pause();
    }
  }

  /* ---------------- background rotation ---------------- */
  function rotationPool() {
    if (!rotationFilter) return null;
    const idxs = [];
    for (let i = 0; i < MEDIA.length; i++) {
      try {
        if (rotationFilter(MEDIA[i], i)) idxs.push(i);
      } catch (e) {}
    }
    return idxs.length ? idxs : null;
  }
  function nextRotationIndex(cur) {
    const pool = rotationPool();
    if (pool) {
      if (pool.length === 1) return pool[0];
      let m;
      do {
        m = pool[Math.floor(Math.random() * pool.length)];
      } while (m === cur && pool.length > 1);
      return m;
    }
    return randomIndex(cur, MEDIA.length);
  }
  function scheduleBgRotation() {
    if (bgTimeout) {
      clearTimeout(bgTimeout);
      bgTimeout = null;
    }
    if (!state.isActive) return;
    const delay = (30 + Math.random() * 30) * 1000;
    bgTimeout = setTimeout(() => {
      setScene(nextRotationIndex(state.bgIndex));
      scheduleBgRotation();
    }, delay);
  }
  function changeBackground() {
    setScene(nextRotationIndex(state.bgIndex));
  }

  function setScene(indexOrSrc) {
    let idx = -1;
    if (typeof indexOrSrc === "number") idx = indexOrSrc;
    else idx = MEDIA.findIndex((m) => m.src === indexOrSrc);
    if (idx < 0 || idx >= MEDIA.length) return;
    state.bgIndex = idx;
    renderBackground();
    emit("scene:change", { src: MEDIA[idx].src, index: idx });
  }
  function mediaCurrent() {
    return { src: MEDIA[state.bgIndex].src, index: state.bgIndex };
  }
  function mediaPick(filterFn) {
    const matches = [];
    for (let i = 0; i < MEDIA.length; i++) {
      try {
        if (!filterFn || filterFn(MEDIA[i], i)) matches.push(MEDIA[i].src);
      } catch (e) {}
    }
    if (!matches.length) return null;
    return matches[Math.floor(Math.random() * matches.length)];
  }

  /* ---------------- DOM roots + audio element ---------------- */
  let root, bgHost, uiHost;

  function ensureDom() {
    root = document.getElementById("root");
    bgHost = document.createElement("div");
    uiHost = document.createElement("div");
    root.appendChild(bgHost);
    root.appendChild(uiHost);

    audioEl = document.createElement("audio");
    audioEl.loop = true;
    audioEl.src = "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-17.mp3";
    root.appendChild(audioEl);
  }

  function renderBackground() {
    if (state.bgIndex === lastRenderedBg && bgHost.childNodes.length) return;
    lastRenderedBg = state.bgIndex;
    const item = MEDIA[state.bgIndex];
    const src = item.src;
    bgHost.innerHTML = "";
    if (isVideo(src)) {
      const v = document.createElement("video");
      v.className = "bg-layer";
      v.src = src;
      v.autoplay = true;
      v.loop = true;
      v.muted = true;
      v.playsInline = true;
      v.setAttribute("playsinline", "");
      v.addEventListener("loadedmetadata", () => (v.playbackRate = 0.75));
      v.playbackRate = 0.75;
      bgHost.appendChild(v);
    } else {
      const d = document.createElement("div");
      d.className = "bg-layer";
      d.style.backgroundImage = "url(" + src + ")";
      bgHost.appendChild(d);
    }
    const overlay = document.createElement("div");
    overlay.className = "bg-overlay";
    bgHost.appendChild(overlay);
  }
  function getBgElement() {
    return bgHost ? bgHost.querySelector(".bg-layer") : null;
  }

  function updateTimerDisplay() {
    const el = document.getElementById("timer-display");
    if (el) el.textContent = fmt(state.timeLeft);
  }

  // While a session runs the chrome fades out; a tap on the scene "wakes" it
  // for a few seconds so the user can reach the controls, then it fades again.
  let awakeTimer = null;
  function wakeControls() {
    if (!uiHost || !state.isActive) return;
    uiHost.classList.add("ff-awake");
    clearTimeout(awakeTimer);
    awakeTimer = setTimeout(function () {
      if (uiHost) uiHost.classList.remove("ff-awake");
    }, 3500);
  }

  /* ---------------- feature dock (registerButton) ---------------- */
  const featureButtons = []; // {id, icon, title, onClick, isActive}

  function registerButton(cfg) {
    if (!cfg || !cfg.id) return;
    const existing = featureButtons.findIndex((b) => b.id === cfg.id);
    const entry = {
      id: cfg.id,
      icon: cfg.icon || "sparkles",
      title: cfg.title || cfg.id,
      onClick: typeof cfg.onClick === "function" ? cfg.onClick : function () {},
      isActive: typeof cfg.isActive === "function" ? cfg.isActive : function () { return false; },
    };
    if (existing >= 0) featureButtons[existing] = entry;
    else featureButtons.push(entry);
    if (uiHost) render();
  }

  function featureDockHtml() {
    if (!featureButtons.length) return "";
    const btns = featureButtons
      .map(function (b) {
        let active = false;
        try {
          active = !!b.isActive();
        } catch (e) {}
        return (
          '<button class="btn icon-btn ff-dock-btn ' +
          (active ? "active" : "") +
          '" data-dock-id="' +
          esc(b.id) +
          '" title="' +
          esc(b.title) +
          '">' +
          icon(b.icon, 15) +
          "</button>"
        );
      })
      .join("");
    return (
      '<div class="ff-feature-dock" id="ff-feature-dock">' + btns + "</div>"
    );
  }

  /* ---------------- feature sheets (registerSheet) ---------------- */
  const featureSheets = Object.create(null); // kind -> {render, wire}

  function registerSheet(kind, cfg) {
    if (!kind || !cfg || typeof cfg.render !== "function") return;
    featureSheets[kind] = {
      render: cfg.render,
      wire: typeof cfg.wire === "function" ? cfg.wire : function () {},
    };
  }

  /* ---------------- toast / banner / confetti / injectStyle ---------------- */
  let toastHost = null;
  function ensureToastHost() {
    if (toastHost && document.body.contains(toastHost)) return toastHost;
    toastHost = document.createElement("div");
    toastHost.className = "ff-toast-host";
    document.body.appendChild(toastHost);
    return toastHost;
  }
  function toast(msg, opts) {
    opts = opts || {};
    const host = ensureToastHost();
    const el = document.createElement("div");
    el.className = "ff-toast glass-panel";
    el.textContent = String(msg == null ? "" : msg);
    host.appendChild(el);
    // force reflow then show
    void el.offsetWidth;
    el.classList.add("show");
    const dur = opts.duration || 2600;
    setTimeout(function () {
      el.classList.remove("show");
      setTimeout(function () {
        if (el.parentNode) el.parentNode.removeChild(el);
      }, 250);
    }, dur);
    return el;
  }

  let bannerHost = null;
  function ensureBannerHost() {
    if (bannerHost && document.body.contains(bannerHost)) return bannerHost;
    bannerHost = document.createElement("div");
    bannerHost.className = "ff-banner-host";
    document.body.appendChild(bannerHost);
    return bannerHost;
  }
  function banner(html, opts) {
    opts = opts || {};
    const host = ensureBannerHost();
    if (opts.id) {
      const prev = host.querySelector('[data-banner-id="' + CSS_escapeAttr(opts.id) + '"]');
      if (prev && prev.parentNode) prev.parentNode.removeChild(prev);
    }
    const el = document.createElement("div");
    el.className = "ff-banner glass-panel";
    if (opts.id) el.setAttribute("data-banner-id", opts.id);
    el.innerHTML =
      '<div class="ff-banner-body">' +
      html +
      "</div>" +
      '<button class="btn icon-btn ff-banner-x" aria-label="Dismiss">' +
      icon("x", 14) +
      "</button>";
    host.appendChild(el);
    const remove = function () {
      if (el.parentNode) el.parentNode.removeChild(el);
    };
    el.querySelector(".ff-banner-x").onclick = function (e) {
      e.stopPropagation();
      remove();
    };
    if (typeof opts.onClick === "function") {
      el.querySelector(".ff-banner-body").onclick = function (e) {
        opts.onClick(e);
      };
    }
    if (opts.timeout) setTimeout(remove, opts.timeout);
    void el.offsetWidth;
    el.classList.add("show");
    // Cap visible banners at 2 — drop the oldest so suggestion strips from
    // several features (goal continuity, rhythm, calendar fit) can't stack up
    // and bury the scene. Newest banner stays.
    while (host.children.length > 2) {
      host.removeChild(host.firstChild);
    }
    return remove;
  }
  // minimal attribute-safe escape for querySelector
  function CSS_escapeAttr(s) {
    return String(s).replace(/["\\]/g, "\\$&");
  }

  const injectedStyles = Object.create(null);
  let styleAutoId = 0;
  function injectStyle(css) {
    const key = css; // dedupe by content
    if (injectedStyles[key]) return;
    injectedStyles[key] = true;
    const st = document.createElement("style");
    st.setAttribute("data-ff-style", String(++styleAutoId));
    st.textContent = css;
    document.head.appendChild(st);
  }

  function confetti() {
    const host = document.createElement("div");
    host.className = "ff-confetti-host";
    document.body.appendChild(host);
    const colors = ["#f9a8d4", "#fbcfe8", "#f472b6", "#fda4af", "#fecdd3"];
    const n = 34; // <= ~40 petals
    for (let i = 0; i < n; i++) {
      const petal = document.createElement("div");
      petal.className = "ff-petal";
      const left = Math.random() * 100;
      const size = 8 + Math.random() * 8;
      const dur = 1600 + Math.random() * 1400;
      const delay = Math.random() * 250;
      const drift = (Math.random() * 2 - 1) * 80;
      const rot = (Math.random() * 2 - 1) * 540;
      petal.style.left = left + "%";
      petal.style.width = size + "px";
      petal.style.height = size * 0.72 + "px";
      petal.style.background = colors[i % colors.length];
      petal.style.setProperty("--ff-drift", drift + "px");
      petal.style.setProperty("--ff-rot", rot + "deg");
      petal.style.animationDuration = dur + "ms";
      petal.style.animationDelay = delay + "ms";
      host.appendChild(petal);
    }
    setTimeout(function () {
      if (host.parentNode) host.parentNode.removeChild(host);
    }, 3400);
  }

  function injectCoreStyles() {
    injectStyle(
      /* feature dock */
      ".ff-feature-dock{display:flex;gap:0.3rem;overflow-x:auto;overflow-y:hidden;" +
        "-webkit-overflow-scrolling:touch;scrollbar-width:none;margin:0 0 0.55rem;padding-bottom:2px;}" +
        ".ff-feature-dock::-webkit-scrollbar{display:none;}" +
        ".ff-feature-dock .ff-dock-btn{flex:none;}" +
        /* toast */
        ".ff-toast-host{position:fixed;top:calc(var(--banner-h) + 12px);left:0;right:0;z-index:400;" +
        "display:flex;flex-direction:column;align-items:center;gap:6px;pointer-events:none;}" +
        ".ff-toast{pointer-events:auto;padding:0.55rem 0.9rem;border-radius:14px;font-size:0.85rem;" +
        "max-width:min(90vw,420px);text-align:center;opacity:0;transform:translateY(-8px);" +
        "transition:opacity 0.22s ease,transform 0.22s ease;}" +
        ".ff-toast.show{opacity:1;transform:translateY(0);}" +
        /* banner */
        ".ff-banner-host{position:absolute;left:12px;right:12px;bottom:calc(env(safe-area-inset-bottom) + 108px);z-index:60;" +
        "display:flex;flex-direction:column;gap:6px;align-items:stretch;pointer-events:none;}" +
        ".ff-banner{pointer-events:auto;display:flex;align-items:center;gap:0.5rem;padding:0.55rem 0.7rem;" +
        "border-radius:14px;font-size:0.82rem;opacity:0;transform:translateY(6px);" +
        "transition:opacity 0.22s ease,transform 0.22s ease;}" +
        ".ff-banner.show{opacity:1;transform:translateY(0);}" +
        ".ff-banner .ff-banner-body{flex:1;cursor:default;}" +
        ".ff-banner .ff-banner-x{flex:none;padding:0.3rem;}" +
        /* confetti */
        ".ff-confetti-host{position:fixed;inset:0;pointer-events:none;z-index:500;overflow:hidden;}" +
        ".ff-petal{position:absolute;top:-24px;border-radius:60% 60% 62% 38% / 62% 62% 40% 40%;" +
        "opacity:0.95;will-change:transform,opacity;animation-name:ff-fall;animation-timing-function:ease-in;" +
        "animation-fill-mode:forwards;}" +
        "@keyframes ff-fall{0%{transform:translateY(-24px) translateX(0) rotate(0deg);opacity:0;}" +
        "10%{opacity:1;}100%{transform:translateY(105vh) translateX(var(--ff-drift)) rotate(var(--ff-rot));opacity:0;}}"
    );
  }

  /* ---------------- rendering (control panel + sheets) ---------------- */
  function render() {
    if (!uiHost) return;
    renderBackground();
    const p = state.activeProfile;
    if (!p) {
      uiHost.innerHTML = "";
      return;
    }
    const mode = state.mode;
    const accent =
      mode === "focus"
        ? "var(--accent-focus)"
        : mode === "shortBreak"
        ? "var(--accent-short)"
        : "var(--accent-long)";
    const goalActive = !!state.notes.goal;

    const modeChip = (m, label, ac) =>
      '<button class="btn mode-chip ' +
      (mode === m ? "theme-" + m : "") +
      '" data-mode="' +
      m +
      '" style="background:' +
      (mode === m ? ac : "") +
      ";border-color:" +
      (mode === m ? "transparent" : "") +
      ';">' +
      label +
      "</button>";

    const modeLabel =
      mode === "focus"
        ? "Focus"
        : mode === "shortBreak"
        ? "Short Break"
        : "Long Break";

    // All icons — core options + registered feature buttons — spread across
    // the top of the scene as one row so they read as ambient chrome, not a
    // stacked control block.
    const featIcons = featureButtons
      .map(function (b) {
        let active = false;
        try {
          active = !!b.isActive();
        } catch (e) {}
        return (
          '<button class="btn icon-btn ff-dock-btn ' +
          (active ? "active" : "") +
          '" data-dock-id="' +
          esc(b.id) +
          '" title="' +
          esc(b.title) +
          '">' +
          icon(b.icon, 18) +
          "</button>"
        );
      })
      .join("");

    uiHost.innerHTML =
      '<div class="side-nav left"><button class="btn" id="bg-prev">' +
      icon("chevron-left", 28) +
      "</button></div>" +
      '<div class="side-nav right"><button class="btn" id="bg-next">' +
      icon("chevron-right", 28) +
      "</button></div>" +
      // ---- top bar: options spread across ----
      '<div class="ff-topbar">' +
      '<button class="btn icon-btn ' +
      (goalActive ? "active" : "") +
      '" id="goal-btn" title="Session goal">' +
      icon("flag", 18) +
      "</button>" +
      '<button class="btn icon-btn" id="mute-btn" title="Music">' +
      icon(state.muted ? "volume-x" : "volume-2", 18) +
      "</button>" +
      '<button class="btn icon-btn" id="time-btn" title="Timer settings">' +
      icon("sliders", 18) +
      "</button>" +
      '<button class="btn icon-btn" id="history-btn" title="History">' +
      icon("file-text", 18) +
      "</button>" +
      featIcons +
      "</div>" +
      // ---- lower-left: the timer (the prominent element) ----
      '<div class="ff-timerzone">' +
      '<div class="ff-modelabel">' +
      esc(modeLabel) +
      " · " +
      esc(p.name) +
      "</div>" +
      '<div id="timer-display" class="timer theme-' +
      mode +
      '" title="Tap to adjust">' +
      fmt(state.timeLeft) +
      "</div>" +
      "</div>" +
      // ---- bottom: action selection + start ----
      '<div class="ff-bottombar">' +
      '<div class="ff-modes">' +
      modeChip("focus", "Focus", "var(--accent-focus)") +
      modeChip("shortBreak", "Short", "var(--accent-short)") +
      modeChip("longBreak", "Long", "var(--accent-long)") +
      "</div>" +
      '<div class="ff-actions">' +
      '<button class="btn" id="toggle-btn" style="padding:0.55rem 1.6rem;font-size:0.95rem;background:' +
      accent +
      ';border-color:transparent;">' +
      icon(state.isActive ? "pause" : "play", 18) +
      (state.isActive ? "Pause" : "Start") +
      "</button>" +
      '<button class="btn" id="reset-btn" style="padding:0.55rem;" title="Reset">' +
      icon("rotate-ccw", 18) +
      "</button>" +
      "</div>" +
      "</div>" +
      '<div id="sheet-host"></div>';

    // Reflect running state so chrome can fade to near-invisible during a
    // session, leaving only the (shrunken) countdown prominent.
    uiHost.classList.toggle("ff-running", !!state.isActive);
    if (!state.isActive) uiHost.classList.remove("ff-awake");

    const q = (s) => uiHost.querySelector(s);
    q("#bg-prev").onclick = changeBackground;
    q("#bg-next").onclick = changeBackground;
    q("#goal-btn").onclick = () => openSheet("goal");
    q("#mute-btn").onclick = () => {
      state.muted = !state.muted;
      syncAudio();
      render();
    };
    q("#time-btn").onclick = () => openSheet("time");
    q("#history-btn").onclick = () => openSheet("history");
    q("#timer-display").onclick = () => openSheet("time");
    uiHost
      .querySelectorAll("[data-mode]")
      .forEach((b) => (b.onclick = () => switchMode(b.dataset.mode)));
    q("#toggle-btn").onclick = () => toggle();
    q("#reset-btn").onclick = () => reset();

    // feature dock wiring
    uiHost.querySelectorAll("[data-dock-id]").forEach(function (b) {
      const entry = featureButtons.find((x) => x.id === b.dataset.dockId);
      if (entry)
        b.onclick = function () {
          try {
            entry.onClick();
          } catch (e) {
            console.error("FF dock button error:", e);
          }
        };
    });

    renderSheet();
  }

  function openSheet(kind) {
    state.openSheet = kind;
    render();
    emit("sheet:open", { kind: kind });
  }
  function closeSheet() {
    const kind = state.openSheet;
    if (kind === "reflection") return finalizeFocus("");
    state.openSheet = null;
    state.presetOpen = false;
    render();
    if (kind) emit("sheet:close", { kind: kind });
  }

  /* ---------------- bottom sheets ---------------- */
  function renderSheet() {
    const host = document.getElementById("sheet-host");
    if (!host) return;
    const kind = state.openSheet;
    if (!kind) {
      host.innerHTML = "";
      return;
    }
    let inner = "";
    let isFeature = false;
    if (kind === "time") inner = timeSheet();
    else if (kind === "history") inner = historySheet();
    else if (kind === "goal") inner = goalSheet();
    else if (kind === "reflection") inner = reflectionSheet();
    else if (featureSheets[kind]) {
      isFeature = true;
      try {
        inner = featureSheets[kind].render() || "";
      } catch (e) {
        console.error("FF feature sheet render error (" + kind + "):", e);
        inner = "";
      }
      // auto-inject close button if the feature didn't provide one
      if (inner.indexOf("sheet-close") === -1) inner = closeBtnHtml() + inner;
    } else {
      // unknown kind: nothing to render
      host.innerHTML = "";
      return;
    }

    host.innerHTML =
      '<div class="sheet-wrap" id="sheet-wrap"><div class="sheet glass-panel">' +
      inner +
      "</div></div>";
    wireSheet(host, kind, isFeature);
  }

  function closeBtnHtml() {
    return (
      '<button class="btn sheet-close" id="sheet-close">' + icon("x", 18) + "</button>"
    );
  }

  function timeSheet() {
    const p = state.activeProfile;
    const chips = state.profiles
      .map(
        (o) =>
          '<button class="chip ' +
          (p && p.id === o.id ? "active" : "") +
          '" data-profile-id="' +
          esc(o.id) +
          '">' +
          esc(o.name) +
          "</button>"
      )
      .join("");
    const stepper = (label, field) =>
      '<div class="stepper-row"><span>' +
      label +
      '</span><div class="stepper">' +
      '<button class="step-btn" data-adj="' +
      field +
      '" data-delta="-1">' +
      icon("minus", 16) +
      "</button>" +
      '<span class="step-val">' +
      p[field] +
      "</span>" +
      '<button class="step-btn" data-adj="' +
      field +
      '" data-delta="1">' +
      icon("plus", 16) +
      "</button>" +
      '<span class="muted" style="margin-left:2px;">min</span>' +
      "</div></div>";
    const addRow = state.presetOpen
      ? '<div class="row" style="margin-top:0.6rem;">' +
        '<input id="preset-name" placeholder="Preset name" value="' +
        esc(newPresetName) +
        '" />' +
        '<button class="btn" id="preset-save" style="background:var(--accent-focus);border-color:transparent;padding:0.6rem 0.9rem;">Add</button>' +
        "</div>"
      : '<button class="chip" id="preset-new" style="margin-top:0.6rem;">' +
        icon("plus", 15) +
        "&nbsp;New preset</button>";

    return (
      closeBtnHtml() +
      "<h2>" +
      icon("sliders", 18) +
      " Timer</h2>" +
      '<div style="display:flex;flex-wrap:wrap;gap:0.4rem;margin-bottom:0.9rem;">' +
      chips +
      "</div>" +
      stepper("Focus", "focus") +
      stepper("Short break", "shortBreak") +
      stepper("Long break", "longBreak") +
      addRow
    );
  }

  function historySheet() {
    const sessions = store.getHistory().slice().reverse();
    const fmtDate = (d) => {
      const m = new Date(d);
      return (
        m.toLocaleDateString() +
        " " +
        m.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      );
    };
    const body =
      sessions.length === 0
        ? '<div class="muted" style="text-align:center;margin-top:1.5rem;">No sessions recorded yet!</div>'
        : sessions
            .map(
              (s) =>
                '<div style="background:rgba(255,255,255,0.05);border-radius:12px;padding:0.75rem;margin-bottom:0.6rem;">' +
                '<div style="display:flex;justify-content:space-between;gap:0.5rem;margin-bottom:0.3rem;font-size:0.8rem;" class="muted">' +
                "<span>" +
                esc(fmtDate(s.date)) +
                "</span>" +
                '<span style="color:var(--accent-focus);white-space:nowrap;">' +
                esc(s.profileName) +
                " · " +
                s.duration / 60 +
                "m</span>" +
                "</div>" +
                (s.goal
                  ? '<div style="font-size:0.85rem;margin-bottom:0.15rem;"><strong>Goal:</strong> ' +
                    esc(s.goal) +
                    "</div>"
                  : "") +
                (s.reflection
                  ? '<div style="font-size:0.85rem;"><strong>Notes:</strong> ' +
                    esc(s.reflection) +
                    "</div>"
                  : "") +
                "</div>"
            )
            .join("");
    return (
      closeBtnHtml() +
      "<h2>" +
      icon("calendar", 18) +
      " History</h2>" +
      '<div class="sheet-scroll">' +
      body +
      "</div>"
    );
  }

  function goalSheet() {
    return (
      closeBtnHtml() +
      "<h2>" +
      icon("flag", 18) +
      " Focus goal</h2>" +
      '<p class="muted" style="margin-bottom:0.6rem;">Optional — set what you\'re working on.</p>' +
      '<textarea id="goal-input" rows="2" placeholder="e.g. Finish the report">' +
      esc(state.notes.goal) +
      "</textarea>" +
      '<button class="btn" id="goal-save" style="width:100%;margin-top:0.7rem;background:var(--accent-focus);border-color:transparent;">Save</button>'
    );
  }

  function reflectionSheet() {
    return (
      "<h2>" +
      icon("flag", 18) +
      " Session done</h2>" +
      '<p class="muted" style="margin-bottom:0.6rem;">Add a quick note, or skip.</p>' +
      '<textarea id="reflect-input" rows="2" placeholder="How did it go? (optional)"></textarea>' +
      '<div class="row" style="margin-top:0.7rem;">' +
      '<button class="btn" id="reflect-skip" style="flex:1;">Skip</button>' +
      '<button class="btn" id="reflect-save" style="flex:1;background:var(--accent-focus);border-color:transparent;">Save</button>' +
      "</div>"
    );
  }

  function wireSheet(host, kind, isFeature) {
    const q = (s) => host.querySelector(s);
    const wrap = q("#sheet-wrap");
    if (wrap)
      wrap.addEventListener("mousedown", (e) => {
        if (e.target === wrap) closeSheet();
      });
    const close = q("#sheet-close");
    if (close) close.onclick = closeSheet;

    if (isFeature) {
      const sheetEl = host.querySelector(".sheet");
      try {
        featureSheets[kind].wire(sheetEl);
      } catch (e) {
        console.error("FF feature sheet wire error (" + kind + "):", e);
      }
      return;
    }

    if (kind === "time") {
      host.querySelectorAll("[data-profile-id]").forEach((c) => {
        c.onclick = () => {
          const prof = state.profiles.find((x) => x.id === c.dataset.profileId);
          if (prof) {
            selectProfile(prof);
            render();
          }
        };
      });
      host.querySelectorAll("[data-adj]").forEach((b) => {
        b.onclick = () => adjustDuration(b.dataset.adj, Number(b.dataset.delta));
      });
      const newBtn = q("#preset-new");
      if (newBtn)
        newBtn.onclick = () => {
          state.presetOpen = true;
          render();
        };
      const nameInput = q("#preset-name");
      if (nameInput) {
        nameInput.oninput = () => (newPresetName = nameInput.value);
        nameInput.focus();
      }
      const saveBtn = q("#preset-save");
      if (saveBtn) saveBtn.onclick = addPreset;
    }

    if (kind === "goal") {
      const input = q("#goal-input");
      q("#goal-save").onclick = () => {
        state.notes.goal = input.value.trim();
        state.openSheet = null;
        render();
        emit("goal:set", { text: state.notes.goal });
      };
      if (input) input.focus();
    }

    if (kind === "reflection") {
      const input = q("#reflect-input");
      q("#reflect-skip").onclick = () => finalizeFocus("");
      q("#reflect-save").onclick = () => finalizeFocus(input.value.trim());
      if (input) input.focus();
    }
  }

  /* ---------------- WebAudio cues ---------------- */
  let actx = null;
  function ensureAudioCtx() {
    if (actx) return actx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try {
      actx = new AC();
    } catch (e) {
      actx = null;
    }
    return actx;
  }
  function tone(ctx, freq, startAt, dur, peak, type) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type || "sine";
    osc.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, startAt);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak), startAt + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, startAt + dur);
    osc.connect(g);
    g.connect(ctx.destination);
    osc.start(startAt);
    osc.stop(startAt + dur + 0.02);
  }
  const CUE_GAIN = 0.13; // <= 0.15
  function playCue(name) {
    const ctx = ensureAudioCtx();
    if (!ctx) return;
    if (ctx.state === "suspended" && ctx.resume) {
      try {
        ctx.resume();
      } catch (e) {}
    }
    const t = ctx.currentTime + 0.02;
    if (name === "complete") {
      // resolution chord (major triad, staggered)
      tone(ctx, 523.25, t, 0.9, CUE_GAIN, "sine"); // C5
      tone(ctx, 659.25, t + 0.06, 0.9, CUE_GAIN * 0.85, "sine"); // E5
      tone(ctx, 783.99, t + 0.12, 1.0, CUE_GAIN * 0.8, "sine"); // G5
    } else if (name === "finalStretch") {
      // gentle rising motif
      tone(ctx, 587.33, t, 0.3, CUE_GAIN * 0.8, "sine"); // D5
      tone(ctx, 698.46, t + 0.16, 0.3, CUE_GAIN * 0.8, "sine"); // F5
      tone(ctx, 880.0, t + 0.32, 0.42, CUE_GAIN * 0.8, "sine"); // A5
    } else if (name === "breakEnd") {
      // soft koto pluck call-back (triangle, short decays)
      tone(ctx, 659.25, t, 0.5, CUE_GAIN, "triangle"); // E5
      tone(ctx, 493.88, t + 0.22, 0.6, CUE_GAIN * 0.85, "triangle"); // B4
    } else if (name === "unlock") {
      // chime
      tone(ctx, 784.0, t, 0.5, CUE_GAIN, "sine"); // G5
      tone(ctx, 1046.5, t + 0.1, 0.6, CUE_GAIN * 0.8, "sine"); // C6
    }
  }

  /* ---------------- FF.audio bed controls ---------------- */
  let bedVolume = 1;
  function setVolume(v) {
    bedVolume = Math.min(1, Math.max(0, Number(v)));
    if (audioEl) audioEl.volume = state.muted ? 0 : bedVolume;
  }
  function getVolume() {
    return bedVolume;
  }
  function setPlaybackRate(r) {
    if (audioEl) {
      try {
        audioEl.playbackRate = Math.max(0.25, Math.min(4, Number(r) || 1));
      } catch (e) {}
    }
  }
  function isMuted() {
    return !!state.muted;
  }

  /* ---------------- hooks ---------------- */
  const beforeStartFns = [];
  const onBreakStartFns = [];
  function hookBeforeStart(fn) {
    if (typeof fn === "function") beforeStartFns.push(fn);
  }
  function hookOnBreakStart(fn) {
    if (typeof fn === "function") onBreakStartFns.push(fn);
  }
  function emitBreakStart(mode) {
    onBreakStartFns.forEach(function (fn) {
      try {
        const r = fn({ mode: mode });
        if (r && r.catch) r.catch(function () {});
      } catch (e) {
        console.error("FF onBreakStart error:", e);
      }
    });
  }
  // Run beforeStart chain; each fn wrapped so failure never blocks start.
  // A click / keypress skips the remaining chain.
  function runBeforeStartChain() {
    if (!beforeStartFns.length) return Promise.resolve();
    let skipped = false;
    const skip = function () {
      skipped = true;
    };
    window.addEventListener("keydown", skip, { once: true });
    window.addEventListener("pointerdown", skip, { once: true });
    let chain = Promise.resolve();
    beforeStartFns.forEach(function (fn) {
      chain = chain.then(function () {
        if (skipped) return;
        return Promise.resolve()
          .then(function () {
            return fn({ mode: state.mode });
          })
          .catch(function (e) {
            console.error("FF beforeStart hook error:", e);
          });
      });
    });
    return chain.then(
      function () {
        window.removeEventListener("keydown", skip);
        window.removeEventListener("pointerdown", skip);
      },
      function () {
        window.removeEventListener("keydown", skip);
        window.removeEventListener("pointerdown", skip);
      }
    );
  }

  /* ---------------- gestures + keyboard ---------------- */
  function installGestures() {
    window.addEventListener("keydown", (e) => {
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") changeBackground();
    });
    // Any pointer press reveals the faded controls during a running session.
    root.addEventListener("pointerdown", wakeControls);
    let touchX = null,
      touchY = null;
    root.addEventListener(
      "touchstart",
      (e) => {
        if (
          e.target.closest(
            ".ff-topbar, .ff-timerzone, .ff-bottombar, .controls, .sheet-wrap, .side-nav, .ff-banner"
          )
        ) {
          touchX = null;
          return;
        }
        touchX = e.changedTouches[0].clientX;
        touchY = e.changedTouches[0].clientY;
      },
      { passive: true }
    );
    root.addEventListener(
      "touchend",
      (e) => {
        if (touchX == null) return;
        const dx = e.changedTouches[0].clientX - touchX;
        const dy = e.changedTouches[0].clientY - touchY;
        if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.5)
          changeBackground();
        touchX = null;
      },
      { passive: true }
    );
  }

  /* ---------------- feature registration + init ---------------- */
  const registeredFeatures = [];
  function registerFeature(feat) {
    if (feat && feat.id && typeof feat.init === "function") {
      registeredFeatures.push(feat);
    }
  }

  let initialized = false;
  function init() {
    if (initialized) return;
    initialized = true;

    ensureDom();
    injectCoreStyles();

    state.profiles = getProfiles();
    state.activeProfile = state.profiles[0] || null;
    if (state.activeProfile) state.timeLeft = modeSeconds(state.mode);

    if (audioEl) audioEl.volume = state.muted ? 0 : bedVolume;

    installGestures();
    render();

    const ctx = {
      on: on,
      off: off,
      emit: emit,
      state: state,
      timer: FF.timer,
      store: FF.store,
      media: FF.media,
      ui: FF.ui,
      audio: FF.audio,
      hooks: FF.hooks,
    };
    registeredFeatures.forEach(function (feat) {
      try {
        feat.init(ctx);
      } catch (e) {
        console.error("FF feature init failed (" + feat.id + "):", e);
      }
    });

    emit("app:ready", {});
  }

  /* ---------------- public FF surface ---------------- */
  const FF = {
    version: 2,
    init: init,
    registerFeature: registerFeature,

    on: on,
    off: off,
    emit: emit,

    state: state,

    timer: {
      start: start,
      pause: pause,
      toggle: toggle,
      reset: reset,
      getRemaining: function () {
        return state.timeLeft;
      },
      getTotal: function () {
        return modeSeconds(state.mode);
      },
      setTimeLeft: setTimeLeft,
      startCustom: startCustom,
    },

    store: {
      load: store.load,
      save: store.save,
      getHistory: store.getHistory,
      addSessionExtras: store.addSessionExtras,
    },

    media: {
      list: MEDIA,
      setScene: setScene,
      current: mediaCurrent,
      pick: mediaPick,
      setRotationFilter: function (fn) {
        rotationFilter = typeof fn === "function" ? fn : null;
      },
      getElement: getBgElement,
    },

    ui: {
      registerButton: registerButton,
      registerSheet: registerSheet,
      openSheet: openSheet,
      closeSheet: closeSheet,
      toast: toast,
      banner: banner,
      icon: icon,
      esc: esc,
      injectStyle: injectStyle,
      confetti: confetti,
    },

    audio: {
      setVolume: setVolume,
      getVolume: getVolume,
      setPlaybackRate: setPlaybackRate,
      playCue: playCue,
      isMuted: isMuted,
    },

    hooks: {
      beforeStart: hookBeforeStart,
      onBreakStart: hookOnBreakStart,
    },
  };

  window.FF = FF;
})();
