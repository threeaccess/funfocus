"use strict";
/* features/ambient.js — owner: ambient agent
 * 1. Picture-in-Picture living timer (Document PiP + video PiP fallback)
 * 2. Time & weather scene sync (open-meteo, geolocation, CSS overlays)
 * 3. Calendar-aware sessions ("42 min until <label> — fit a 35-min focus?")
 *
 * Contract notes / choices made:
 *  - setRotationFilter is last-set-wins and SHARED (boss battles override it).
 *    We re-apply our time/weather filter on 'session:finalized' and
 *    'mode:change', but SUSPEND while a boss session is active. world.js may
 *    emit 'world:bossStart' / 'world:bossEnd'; we listen defensively (guarded)
 *    and never fight the boss filter while suspended.
 *  - FF.timer.startCustom(min) both ARMS and STARTS the session (verified in
 *    core.js: it switches to focus mode and returns start()). So the calendar
 *    "Start" action calls startCustom(fitMinutes) ONLY — no extra start().
 *  - All network (fetch) and geolocation failures degrade silently, no toast.
 *  - Everything no-ops when ambient.enabled === false; all intervals are
 *    cleaned up on disable / PiP close.
 */
(function () {
  FF.registerFeature({
    id: "ambient",
    init: init,
  });

  /* ============================================================
   * module-level context + persisted state
   * ========================================================== */
  var FFref = null; // FF context (from init)
  var enabled = true;

  // persisted store shape (namespaced under "ambient.*")
  var st = {
    timeSync: true, // default ON
    weatherSync: false, // default OFF (opt-in)
    geo: null, // {lat, lon}
    commitment: null, // {time:"HH:MM", label:"", dateSet:"YYYY-MM-DD"}
  };

  // runtime (not persisted)
  var bossActive = false;
  var lastFilterKey = null; // remember which bucket we applied
  var weatherState = { code: null, kind: "clear" }; // kind: clear|rain|snow

  // timers/handles
  var timeSyncTimer = null;
  var weatherTimer = null;
  var calendarTimer = null;

  // PiP handles
  var pip = { open: false, mode: null /* "doc"|"video" */ };
  var pipDoc = { win: null, canvas: null, ctx: null, raf: null };
  var pipVid = {
    canvas: null,
    ctx: null,
    video: null,
    stream: null,
    interval: null,
    onLeave: null,
  };

  // banner de-dup
  var lastBannerFit = null; // last fitMinutes we showed a banner for
  var overrunToastKey = null;

  /* ============================================================
   * init
   * ========================================================== */
  function init(ctx) {
    FFref = ctx;
    try {
      loadState();
    } catch (e) {}

    // read enabled flag (default true), no-op cleanly if disabled
    enabled = FFref.store.load("ambient.enabled", true) !== false;
    if (!enabled) return;

    injectStyles();

    // ---- dock buttons (max 2) ----
    try {
      FFref.ui.registerButton({
        id: "ambient-pip",
        icon: "pip",
        title: "Floating timer",
        onClick: togglePip,
        isActive: function () {
          return pip.open;
        },
      });
      FFref.ui.registerButton({
        id: "ambient-sheet",
        icon: "map",
        title: "Ambient",
        onClick: function () {
          FFref.ui.openSheet("ambient");
        },
        isActive: function () {
          return false;
        },
      });
    } catch (e) {}

    // ---- shared settings/commitment sheet ----
    try {
      FFref.ui.registerSheet("ambient", {
        render: renderSheet,
        wire: wireSheet,
      });
    } catch (e) {}

    // ---- boss suspend/resume guards (world.js may or may not emit) ----
    try {
      FFref.on("world:bossStart", function () {
        bossActive = true;
      });
      FFref.on("world:bossEnd", function () {
        bossActive = false;
        applyTimeFilter(true);
      });
    } catch (e) {}

    // ---- time sync: first paint + reapply hooks ----
    try {
      FFref.on("session:finalized", function () {
        applyTimeFilter(false);
        onCalendarTick();
      });
      FFref.on("mode:change", function () {
        applyTimeFilter(false);
      });
    } catch (e) {}

    // ---- normal-session overrun heads-up ----
    try {
      FFref.on("timer:start", function (p) {
        if (p && p.mode === "focus") checkOverrun();
      });
    } catch (e) {}

    // First-load scene bias (before other features would show overlays).
    // Only setScene if no story unlock overlay is showing — at init nothing
    // has painted overlays yet, so this is the safe first-paint window.
    if (st.timeSync) {
      try {
        firstPaintScene();
      } catch (e) {}
    }

    // Start the recurring time-sync loop (every 15 min).
    startTimeSync();

    // Weather (opt-in).
    if (st.weatherSync) startWeather();

    // Calendar loop.
    startCalendar();
  }

  /* ============================================================
   * persistence
   * ========================================================== */
  function loadState() {
    var s = FFref.store.load("ambient.state", null);
    if (s && typeof s === "object") {
      if (typeof s.timeSync === "boolean") st.timeSync = s.timeSync;
      if (typeof s.weatherSync === "boolean") st.weatherSync = s.weatherSync;
      if (s.geo && typeof s.geo.lat === "number") st.geo = s.geo;
      if (s.commitment && typeof s.commitment === "object")
        st.commitment = s.commitment;
    }
    // Expire a stale commitment left from a previous day.
    if (st.commitment && st.commitment.dateSet !== todayStr()) {
      st.commitment = null;
    }
  }
  function saveState() {
    try {
      FFref.store.save("ambient.state", {
        timeSync: st.timeSync,
        weatherSync: st.weatherSync,
        geo: st.geo,
        commitment: st.commitment,
      });
    } catch (e) {}
  }

  /* ============================================================
   * FEATURE 2 — TIME & WEATHER SCENE SYNC
   * ========================================================== */

  // Bucket the local hour into a scene filter + human label.
  function timeBucket() {
    var h = new Date().getHours();
    if (h >= 20 || h < 6) {
      return { key: "night", tags: ["night", "moon"], label: "Evening — moonlit scenes" };
    }
    if (h >= 17) {
      // sunset (fallback include day so pool is never empty)
      return { key: "sunset", tags: ["sunset", "day"], label: "Golden hour — sunset scenes" };
    }
    return { key: "day", tags: ["day", "blossom", "study"], label: "Daytime — bright scenes" };
  }

  // Build a rotation filter fn combining time-bucket + weather preference.
  function buildFilterTags() {
    var b = timeBucket();
    var tags = b.tags.slice();
    // Weather overrides toward calm/night/moon (rain) or snow/moon (snow).
    if (st.weatherSync) {
      if (weatherState.kind === "rain") {
        tags = ["calm", "night", "moon"];
      } else if (weatherState.kind === "snow") {
        tags = ["snow", "moon"];
      }
    }
    return { key: b.key + ":" + weatherState.kind, tags: tags };
  }

  function tagMatcher(tags) {
    return function (m) {
      if (!m || !m.tags) return false;
      for (var i = 0; i < tags.length; i++) {
        if (m.tags.indexOf(tags[i]) !== -1) return true;
      }
      return false;
    };
  }

  // Apply (or re-apply) the rotation filter. `force` bypasses same-key skip.
  function applyTimeFilter(force) {
    if (!enabled || !st.timeSync) return;
    if (bossActive) return; // never fight the boss filter
    var built = buildFilterTags();
    if (!force && built.key === lastFilterKey) return;
    lastFilterKey = built.key;
    try {
      FFref.media.setRotationFilter(tagMatcher(built.tags));
    } catch (e) {}
  }

  // On first load, immediately move the scene to a matching one.
  function firstPaintScene() {
    var built = buildFilterTags();
    lastFilterKey = built.key;
    try {
      FFref.media.setRotationFilter(tagMatcher(built.tags));
    } catch (e) {}
    try {
      var src = FFref.media.pick(tagMatcher(built.tags));
      if (src) FFref.media.setScene(src);
    } catch (e) {}
  }

  function startTimeSync() {
    stopTimeSync();
    if (!st.timeSync) return;
    applyTimeFilter(true);
    // every 15 minutes
    timeSyncTimer = setInterval(function () {
      applyTimeFilter(false);
    }, 15 * 60 * 1000);
  }
  function stopTimeSync() {
    if (timeSyncTimer) {
      clearInterval(timeSyncTimer);
      timeSyncTimer = null;
    }
  }

  // ---- weather ----
  function startWeather() {
    stopWeather();
    if (!st.weatherSync) return;
    ensureGeoThenFetch();
    // refresh hourly
    weatherTimer = setInterval(function () {
      if (st.geo) fetchWeather();
      else ensureGeoThenFetch();
    }, 60 * 60 * 1000);
  }
  function stopWeather() {
    if (weatherTimer) {
      clearInterval(weatherTimer);
      weatherTimer = null;
    }
  }

  function ensureGeoThenFetch() {
    if (st.geo) {
      fetchWeather();
      return;
    }
    if (
      typeof navigator === "undefined" ||
      !navigator.geolocation ||
      typeof navigator.geolocation.getCurrentPosition !== "function"
    ) {
      return; // silent — no geo available
    }
    try {
      navigator.geolocation.getCurrentPosition(
        function (pos) {
          try {
            st.geo = {
              lat: +pos.coords.latitude.toFixed(3),
              lon: +pos.coords.longitude.toFixed(3),
            };
            saveState();
            fetchWeather();
            refreshSheetStatus();
          } catch (e) {}
        },
        function () {
          /* denied / error — silent */
        },
        { maximumAge: 60 * 60 * 1000, timeout: 8000, enableHighAccuracy: false }
      );
    } catch (e) {
      /* silent */
    }
  }

  function fetchWeather() {
    if (!st.geo || typeof fetch !== "function") return;
    var url =
      "https://api.open-meteo.com/v1/forecast?latitude=" +
      encodeURIComponent(st.geo.lat) +
      "&longitude=" +
      encodeURIComponent(st.geo.lon) +
      "&current=weather_code";
    var p;
    try {
      p = fetch(url);
    } catch (e) {
      return; // silent
    }
    if (!p || typeof p.then !== "function") return;
    p.then(function (r) {
      if (!r || !r.ok) throw new Error("bad response");
      return r.json();
    })
      .then(function (data) {
        var code =
          data && data.current && typeof data.current.weather_code === "number"
            ? data.current.weather_code
            : null;
        if (code == null) return;
        weatherState.code = code;
        weatherState.kind = codeToKind(code);
        applyWeatherVisuals();
        applyTimeFilter(true); // re-bias pool toward the weather
        refreshSheetStatus();
      })
      .catch(function () {
        /* network / parse failure — fail silently, no toast */
      });
  }

  function codeToKind(c) {
    if (
      (c >= 51 && c <= 67) ||
      (c >= 80 && c <= 82) ||
      (c >= 95 && c <= 99)
    )
      return "rain";
    if ((c >= 71 && c <= 77) || c === 85 || c === 86) return "snow";
    return "clear";
  }

  // ---- CSS weather overlays (subtle, pointer-events:none) ----
  var weatherOverlay = null;
  function applyWeatherVisuals() {
    removeWeatherOverlay();
    if (!st.weatherSync) return;
    if (weatherState.kind === "rain") buildWeatherOverlay("rain", 28);
    else if (weatherState.kind === "snow") buildWeatherOverlay("snow", 26);
  }
  function buildWeatherOverlay(kind, count) {
    var host = document.createElement("div");
    host.className = "amb-weather amb-weather-" + kind;
    host.setAttribute("aria-hidden", "true");
    var n = Math.min(30, count);
    var frag = document.createDocumentFragment();
    for (var i = 0; i < n; i++) {
      var d = document.createElement("div");
      d.className = kind === "rain" ? "amb-rain-drop" : "amb-snow-flake";
      var left = Math.random() * 100;
      var delay = (Math.random() * (kind === "rain" ? 1.2 : 6)).toFixed(2);
      var dur =
        kind === "rain"
          ? (0.6 + Math.random() * 0.6).toFixed(2)
          : (5 + Math.random() * 6).toFixed(2);
      d.style.left = left + "%";
      d.style.animationDelay = delay + "s";
      d.style.animationDuration = dur + "s";
      if (kind === "snow") {
        var sz = (2 + Math.random() * 3).toFixed(1);
        d.style.width = sz + "px";
        d.style.height = sz + "px";
        d.style.setProperty("--amb-drift", (Math.random() * 40 - 20) + "px");
      }
      frag.appendChild(d);
    }
    host.appendChild(frag);
    document.body.appendChild(host);
    weatherOverlay = host;
  }
  function removeWeatherOverlay() {
    if (weatherOverlay && weatherOverlay.parentNode) {
      weatherOverlay.parentNode.removeChild(weatherOverlay);
    }
    weatherOverlay = null;
  }

  // Human status line for the sheet.
  function statusLine() {
    var parts = [];
    if (st.timeSync) parts.push(timeBucket().label);
    if (st.weatherSync) {
      if (weatherState.kind === "rain")
        parts.push("Raining where you are — the scene listens");
      else if (weatherState.kind === "snow")
        parts.push("Snow outside — the world turns to frost");
      else if (weatherState.code != null)
        parts.push("Clear skies where you are");
      else if (!st.geo)
        parts.push("Waiting for your location…");
    }
    if (!parts.length) return "Ambient sync is off.";
    return parts.join(" · ");
  }

  /* ============================================================
   * FEATURE 3 — CALENDAR-AWARE SESSIONS
   * ========================================================== */
  function startCalendar() {
    stopCalendar();
    onCalendarTick();
    calendarTimer = setInterval(onCalendarTick, 60 * 1000);
  }
  function stopCalendar() {
    if (calendarTimer) {
      clearInterval(calendarTimer);
      calendarTimer = null;
    }
  }

  // minutes from now until the commitment today; null if none/past.
  function gapMinutes() {
    if (!st.commitment || !st.commitment.time) return null;
    if (st.commitment.dateSet !== todayStr()) {
      st.commitment = null;
      saveState();
      return null;
    }
    var parts = String(st.commitment.time).split(":");
    if (parts.length !== 2) return null;
    var hh = parseInt(parts[0], 10);
    var mm = parseInt(parts[1], 10);
    if (isNaN(hh) || isNaN(mm)) return null;
    var now = new Date();
    var target = new Date();
    target.setHours(hh, mm, 0, 0);
    var diffMs = target.getTime() - now.getTime();
    return diffMs / 60000;
  }

  // fit = clamp(gap - break(~gap/6) - 3 buffer, 10, 90)
  function fitMinutes(gap) {
    var brk = Math.round(gap / 6);
    var raw = Math.floor(gap - brk - 3);
    return Math.max(10, Math.min(90, raw));
  }

  function onCalendarTick() {
    if (!enabled) return;
    var gap = gapMinutes();
    if (gap == null) {
      dismissFitBanner();
      return;
    }
    // Commitment time has passed → clear (same-day value).
    if (gap <= 0) {
      st.commitment = null;
      saveState();
      dismissFitBanner();
      return;
    }
    // Don't suggest during an active session.
    if (FFref.state && FFref.state.isActive) {
      return;
    }
    // Need >=10 min of usable time after the 3-min buffer.
    if (gap - 3 < 10) {
      dismissFitBanner();
      return;
    }
    var fit = fitMinutes(gap);
    // Re-show only when the fit changes materially (>=5 min) or after a reset.
    if (
      lastBannerFit != null &&
      Math.abs(fit - lastBannerFit) < 5 &&
      document.querySelector('[data-banner-id="ambient-fit"]')
    ) {
      return;
    }
    showFitBanner(gap, fit);
  }

  var fitBannerRemove = null;
  function showFitBanner(gap, fit) {
    dismissFitBanner();
    lastBannerFit = fit;
    var label = st.commitment && st.commitment.label ? st.commitment.label : "your commitment";
    var mins = Math.round(gap);
    var html =
      '<span>' +
      FFref.ui.esc(String(mins)) +
      " min until " +
      FFref.ui.esc(label) +
      " — fit a " +
      FFref.ui.esc(String(fit)) +
      '-min focus? <button class="btn amb-fit-start" style="margin-left:.4rem;padding:.25rem .6rem;background:var(--accent-focus);border-color:transparent;border-radius:10px;font-size:.8rem;">Start</button></span>';
    try {
      fitBannerRemove = FFref.ui.banner(html, {
        id: "ambient-fit",
        onClick: function (e) {
          if (e && e.target && e.target.classList.contains("amb-fit-start")) {
            startFit(fit);
          }
        },
      });
    } catch (e) {}
  }
  function dismissFitBanner() {
    if (fitBannerRemove) {
      try {
        fitBannerRemove();
      } catch (e) {}
      fitBannerRemove = null;
    }
    lastBannerFit = null;
  }
  function startFit(fit) {
    dismissFitBanner();
    try {
      // startCustom both arms the focus duration AND starts the session.
      FFref.timer.startCustom(fit);
    } catch (e) {}
  }

  // Heads-up if a NORMAL focus session would overrun the commitment.
  function checkOverrun() {
    if (!enabled || !st.commitment) return;
    var gap = gapMinutes();
    if (gap == null || gap <= 0) return;
    var remainSec = 0;
    try {
      remainSec = FFref.timer.getRemaining();
    } catch (e) {
      return;
    }
    var sessionEndMin = remainSec / 60; // minutes from now until session ends
    // overrun if session end is beyond (commitment - 2 min)
    if (sessionEndMin > gap - 2) {
      var label =
        st.commitment && st.commitment.label ? st.commitment.label : "your commitment";
      var key = st.commitment.time + "|" + Math.round(remainSec / 60);
      if (overrunToastKey === key) return; // avoid duplicate spam
      overrunToastKey = key;
      try {
        FFref.ui.toast("Heads up — this runs past " + label + ".");
      } catch (e) {}
    }
  }

  /* ============================================================
   * SETTINGS / COMMITMENT SHEET (shared)
   * ========================================================== */
  function renderSheet() {
    var c = st.commitment || {};
    var timeVal = c.time && c.dateSet === todayStr() ? FFref.ui.esc(c.time) : "";
    var labelVal = c.label ? FFref.ui.esc(c.label) : "";
    var clearRow = timeVal
      ? '<button class="btn amb-clear" id="amb-clear" style="margin-top:.5rem;font-size:.82rem;padding:.4rem .7rem;">Clear commitment</button>'
      : "";

    return (
      '<button class="btn sheet-close" id="sheet-close">' +
      FFref.ui.icon("x", 18) +
      "</button>" +
      "<h2>" +
      FFref.ui.icon("map", 18) +
      " Ambient</h2>" +
      // ---- commitment ----
      '<div class="amb-section">' +
      '<div class="amb-label">Next commitment today at…</div>' +
      '<div class="row amb-row">' +
      '<input type="time" id="amb-time" value="' +
      timeVal +
      '" style="flex:none;width:8.5rem;" />' +
      '<input type="text" id="amb-cmt-label" placeholder="Label (optional)" value="' +
      labelVal +
      '" maxlength="60" style="flex:1;" />' +
      "</div>" +
      '<div class="row" style="margin-top:.5rem;gap:.5rem;">' +
      '<button class="btn" id="amb-save" style="background:var(--accent-focus);border-color:transparent;padding:.5rem .9rem;">Set</button>' +
      clearRow +
      "</div>" +
      "</div>" +
      // ---- toggles ----
      '<div class="amb-section">' +
      toggleRow("amb-timesync", "Match scene to time of day", st.timeSync) +
      toggleRow("amb-weather", "Match scene to local weather", st.weatherSync) +
      '<div class="amb-status" id="amb-status">' +
      FFref.ui.esc(statusLine()) +
      "</div>" +
      "</div>"
    );
  }

  function toggleRow(id, label, on) {
    return (
      '<label class="amb-toggle" for="' +
      id +
      '">' +
      "<span>" +
      FFref.ui.esc(label) +
      "</span>" +
      '<input type="checkbox" id="' +
      id +
      '" ' +
      (on ? "checked" : "") +
      ' role="switch" />' +
      '<span class="amb-switch" aria-hidden="true"></span>' +
      "</label>"
    );
  }

  function wireSheet(hostEl) {
    if (!hostEl) return;
    var q = function (s) {
      return hostEl.querySelector(s);
    };

    var saveBtn = q("#amb-save");
    if (saveBtn) {
      saveBtn.onclick = function () {
        var timeEl = q("#amb-time");
        var labelEl = q("#amb-cmt-label");
        var t = timeEl && timeEl.value ? String(timeEl.value) : "";
        if (!t) {
          st.commitment = null;
        } else {
          st.commitment = {
            time: t,
            label: labelEl ? String(labelEl.value || "").slice(0, 60) : "",
            dateSet: todayStr(),
          };
        }
        overrunToastKey = null;
        saveState();
        onCalendarTick();
        // refresh the sheet if still open
        try {
          FFref.ui.openSheet("ambient");
        } catch (e) {}
      };
    }

    var clearBtn = q("#amb-clear");
    if (clearBtn) {
      clearBtn.onclick = function () {
        st.commitment = null;
        overrunToastKey = null;
        saveState();
        dismissFitBanner();
        try {
          FFref.ui.openSheet("ambient");
        } catch (e) {}
      };
    }

    var tsEl = q("#amb-timesync");
    if (tsEl) {
      tsEl.onchange = function () {
        st.timeSync = !!tsEl.checked;
        saveState();
        if (st.timeSync) {
          startTimeSync();
          firstPaintScene();
        } else {
          stopTimeSync();
          try {
            // release our claim on rotation so others aren't stuck with it
            FFref.media.setRotationFilter(null);
          } catch (e) {}
          lastFilterKey = null;
        }
        refreshSheetStatus();
      };
    }

    var wEl = q("#amb-weather");
    if (wEl) {
      wEl.onchange = function () {
        st.weatherSync = !!wEl.checked;
        saveState();
        if (st.weatherSync) {
          startWeather();
        } else {
          stopWeather();
          removeWeatherOverlay();
          weatherState = { code: null, kind: "clear" };
          applyTimeFilter(true);
        }
        refreshSheetStatus();
      };
    }
  }

  function refreshSheetStatus() {
    var el = document.getElementById("amb-status");
    if (el) el.textContent = statusLine();
  }

  /* ============================================================
   * FEATURE 1 — PICTURE-IN-PICTURE LIVING TIMER
   * ========================================================== */
  function togglePip() {
    if (pip.open) {
      closePip();
      return;
    }
    if (
      typeof window !== "undefined" &&
      window.documentPictureInPicture &&
      typeof window.documentPictureInPicture.requestWindow === "function"
    ) {
      openDocPip();
    } else if (supportsVideoPip()) {
      openVideoPip();
    } else {
      try {
        FFref.ui.toast("Floating timer isn't supported in this browser.");
      } catch (e) {}
    }
  }

  function supportsVideoPip() {
    try {
      var v = document.createElement("video");
      return (
        typeof v.requestPictureInPicture === "function" &&
        document.pictureInPictureEnabled !== false
      );
    } catch (e) {
      return false;
    }
  }

  // Shared painter: draws one frame onto a 2d context of given W x H.
  function paintFrame(g, W, H) {
    if (!g) return;
    try {
      g.clearRect(0, 0, W, H);
      // 1) scene background
      var accent = modeAccent();
      var el = null;
      try {
        el = FFref.media.getElement();
      } catch (e) {}
      var drewScene = false;
      if (
        el &&
        el.tagName === "VIDEO" &&
        el.readyState >= 2 &&
        el.videoWidth > 0
      ) {
        try {
          coverDraw(g, el, el.videoWidth, el.videoHeight, W, H);
          drewScene = true;
        } catch (e) {}
      }
      if (!drewScene) {
        // image-div fallback → gradient using the mode accent
        var grad = g.createLinearGradient(0, 0, W, H);
        grad.addColorStop(0, accent);
        grad.addColorStop(1, "#0f172a");
        g.fillStyle = grad;
        g.fillRect(0, 0, W, H);
      }
      // 2) dark gradient overlay at the bottom for legibility
      var og = g.createLinearGradient(0, H * 0.45, 0, H);
      og.addColorStop(0, "rgba(15,23,42,0)");
      og.addColorStop(1, "rgba(15,23,42,0.85)");
      g.fillStyle = og;
      g.fillRect(0, 0, W, H);

      // 3) big timer text (bold, tabular-ish)
      var remain = 0;
      try {
        remain = FFref.timer.getRemaining();
      } catch (e) {}
      var timeStr = fmtClock(remain);
      g.textAlign = "center";
      g.textBaseline = "alphabetic";
      g.fillStyle = "#f8fafc";
      var big = Math.round(H * 0.34);
      g.font =
        "700 " +
        big +
        'px "Outfit", "Inter", system-ui, -apple-system, sans-serif';
      g.shadowColor = "rgba(0,0,0,0.55)";
      g.shadowBlur = Math.round(H * 0.05);
      g.fillText(timeStr, W / 2, H * 0.72);
      g.shadowBlur = 0;

      // 4) small mode label + goal (escaped by nature of canvas text)
      var mode = "";
      try {
        mode = modeLabel(FFref.state.mode);
      } catch (e) {}
      var goal = "";
      try {
        goal = (FFref.state.notes && FFref.state.notes.goal) || "";
      } catch (e) {}
      var sub = mode;
      if (goal) sub += "  ·  " + goal;
      sub = truncate(sub, 46);
      g.font =
        "500 " +
        Math.round(H * 0.075) +
        'px "Inter", system-ui, -apple-system, sans-serif';
      g.fillStyle = accent;
      g.fillText(truncate(mode, 20), W / 2, H * 0.86);
      if (goal) {
        g.fillStyle = "rgba(226,232,240,0.85)";
        g.font =
          "400 " +
          Math.round(H * 0.06) +
          'px "Inter", system-ui, -apple-system, sans-serif';
        g.fillText(truncate(goal, 42), W / 2, H * 0.95);
      }
    } catch (e) {
      /* painting must never throw */
    }
  }

  function coverDraw(g, img, iw, ih, W, H) {
    var scale = Math.max(W / iw, H / ih);
    var dw = iw * scale;
    var dh = ih * scale;
    var dx = (W - dw) / 2;
    var dy = (H - dh) / 2;
    g.drawImage(img, dx, dy, dw, dh);
  }

  // ---- Document PiP (Chrome) ----
  function openDocPip() {
    var W = 360;
    var H = 220;
    window.documentPictureInPicture
      .requestWindow({ width: W, height: H })
      .then(function (win) {
        pipDoc.win = win;
        pip.open = true;
        pip.mode = "doc";
        // minimal inline styles copied into the PiP document
        try {
          var style = win.document.createElement("style");
          style.textContent =
            "html,body{margin:0;padding:0;background:#0f172a;overflow:hidden;}" +
            "canvas{display:block;width:100%;height:100vh;}";
          win.document.head.appendChild(style);
        } catch (e) {}
        var canvas = win.document.createElement("canvas");
        // internal resolution (crisp on hi-dpi)
        canvas.width = W * 2;
        canvas.height = H * 2;
        win.document.body.appendChild(canvas);
        pipDoc.canvas = canvas;
        pipDoc.ctx = canvas.getContext("2d");

        var CW = canvas.width;
        var CH = canvas.height;
        var last = 0;
        var loop = function (ts) {
          if (!pip.open || pip.mode !== "doc") return;
          // ~8fps
          if (!last || ts - last >= 120) {
            last = ts;
            paintFrame(pipDoc.ctx, CW, CH);
          }
          pipDoc.raf = win.requestAnimationFrame
            ? win.requestAnimationFrame(loop)
            : requestAnimationFrame(loop);
        };
        pipDoc.raf = win.requestAnimationFrame
          ? win.requestAnimationFrame(loop)
          : requestAnimationFrame(loop);

        win.addEventListener("pagehide", cleanupDocPip);
        win.addEventListener("unload", cleanupDocPip);
        refreshDock();
      })
      .catch(function () {
        // user cancelled or failed → fall back to video PiP if possible
        if (supportsVideoPip()) openVideoPip();
        else {
          try {
            FFref.ui.toast("Floating timer isn't supported in this browser.");
          } catch (e) {}
        }
      });
  }

  function cleanupDocPip() {
    if (pipDoc.raf) {
      try {
        (pipDoc.win && pipDoc.win.cancelAnimationFrame
          ? pipDoc.win.cancelAnimationFrame
          : cancelAnimationFrame)(pipDoc.raf);
      } catch (e) {}
      pipDoc.raf = null;
    }
    if (pipDoc.win) {
      try {
        pipDoc.win.close();
      } catch (e) {}
    }
    pipDoc.win = null;
    pipDoc.canvas = null;
    pipDoc.ctx = null;
    if (pip.mode === "doc") {
      pip.open = false;
      pip.mode = null;
    }
    refreshDock();
  }

  // ---- Video PiP fallback (Safari/Firefox) ----
  function openVideoPip() {
    var W = 480;
    var H = 270;
    var canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    pipVid.canvas = canvas;
    pipVid.ctx = canvas.getContext("2d");

    // paint one frame BEFORE captureStream so the video has content
    paintFrame(pipVid.ctx, W, H);

    var stream;
    try {
      stream = canvas.captureStream(8);
    } catch (e) {
      try {
        FFref.ui.toast("Floating timer isn't supported in this browser.");
      } catch (e2) {}
      cleanupVideoPip();
      return;
    }
    pipVid.stream = stream;

    var video = document.createElement("video");
    video.muted = true;
    video.setAttribute("muted", "");
    video.playsInline = true;
    video.setAttribute("playsinline", "");
    video.style.position = "fixed";
    video.style.left = "-9999px";
    video.style.width = "1px";
    video.style.height = "1px";
    video.srcObject = stream;
    document.body.appendChild(video);
    pipVid.video = video;

    // painter interval (~8fps) — only runs while PiP active
    pipVid.interval = setInterval(function () {
      if (!pip.open) return;
      paintFrame(pipVid.ctx, W, H);
    }, 125);

    var onLeave = function () {
      cleanupVideoPip();
    };
    pipVid.onLeave = onLeave;
    video.addEventListener("leavepictureinpicture", onLeave);

    var pr = video.play();
    var afterPlay = function () {
      // guard: video must be ready before requesting PiP
      var request = function () {
        try {
          var rp = video.requestPictureInPicture();
          if (rp && rp.then) {
            rp.then(function () {
              pip.open = true;
              pip.mode = "video";
              refreshDock();
            }).catch(function () {
              cleanupVideoPip();
              try {
                FFref.ui.toast("Floating timer isn't supported in this browser.");
              } catch (e) {}
            });
          } else {
            pip.open = true;
            pip.mode = "video";
            refreshDock();
          }
        } catch (e) {
          cleanupVideoPip();
        }
      };
      if (video.readyState >= 2) request();
      else {
        var once = function () {
          video.removeEventListener("loadeddata", once);
          request();
        };
        video.addEventListener("loadeddata", once);
        // safety: also try shortly after in case loadeddata never fires
        setTimeout(function () {
          if (!pip.open && pipVid.video === video) request();
        }, 400);
      }
    };
    if (pr && pr.then) pr.then(afterPlay).catch(afterPlay);
    else afterPlay();
  }

  function cleanupVideoPip() {
    if (pipVid.interval) {
      clearInterval(pipVid.interval);
      pipVid.interval = null;
    }
    var v = pipVid.video;
    if (v) {
      try {
        if (pipVid.onLeave)
          v.removeEventListener("leavepictureinpicture", pipVid.onLeave);
      } catch (e) {}
      try {
        if (
          document.pictureInPictureElement === v &&
          typeof document.exitPictureInPicture === "function"
        ) {
          var ep = document.exitPictureInPicture();
          if (ep && ep.catch) ep.catch(function () {});
        }
      } catch (e) {}
      try {
        v.pause();
      } catch (e) {}
      try {
        v.srcObject = null;
      } catch (e) {}
      if (v.parentNode) v.parentNode.removeChild(v);
    }
    if (pipVid.stream) {
      try {
        pipVid.stream.getTracks().forEach(function (t) {
          try {
            t.stop();
          } catch (e) {}
        });
      } catch (e) {}
    }
    pipVid.video = null;
    pipVid.stream = null;
    pipVid.canvas = null;
    pipVid.ctx = null;
    pipVid.onLeave = null;
    if (pip.mode === "video") {
      pip.open = false;
      pip.mode = null;
    }
    refreshDock();
  }

  function closePip() {
    if (pip.mode === "doc") cleanupDocPip();
    else if (pip.mode === "video") cleanupVideoPip();
    else {
      pip.open = false;
      pip.mode = null;
    }
  }

  // Nudge the dock so the button's active state re-renders.
  function refreshDock() {
    try {
      FFref.ui.registerButton({
        id: "ambient-pip",
        icon: "pip",
        title: "Floating timer",
        onClick: togglePip,
        isActive: function () {
          return pip.open;
        },
      });
    } catch (e) {}
  }

  /* ============================================================
   * helpers
   * ========================================================== */
  function todayStr() {
    var d = new Date();
    var m = d.getMonth() + 1;
    var day = d.getDate();
    return (
      d.getFullYear() +
      "-" +
      (m < 10 ? "0" + m : m) +
      "-" +
      (day < 10 ? "0" + day : day)
    );
  }
  function fmtClock(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    var m = Math.floor(sec / 60);
    var s = sec % 60;
    return (m < 10 ? "0" + m : m) + ":" + (s < 10 ? "0" + s : s);
  }
  function modeLabel(mode) {
    if (mode === "focus") return "Focus";
    if (mode === "shortBreak") return "Short break";
    if (mode === "longBreak") return "Long break";
    return "Focus";
  }
  function modeAccent() {
    var mode = "focus";
    try {
      mode = FFref.state.mode;
    } catch (e) {}
    if (mode === "shortBreak") return "#0ea5e9";
    if (mode === "longBreak") return "#8b5cf6";
    return "#f43f5e";
  }
  function truncate(str, n) {
    str = String(str == null ? "" : str);
    if (str.length <= n) return str;
    return str.slice(0, Math.max(0, n - 1)) + "…";
  }

  /* ============================================================
   * styles
   * ========================================================== */
  function injectStyles() {
    try {
      FFref.ui.injectStyle(
        /* weather overlays — subtle, never obstruct, pointer-events:none */
        ".amb-weather{position:fixed;inset:0;pointer-events:none;z-index:40;overflow:hidden;}" +
          ".amb-rain-drop{position:absolute;top:-12%;width:1px;height:44px;" +
          "background:linear-gradient(to bottom,rgba(186,230,253,0),rgba(186,230,253,0.35));" +
          "animation-name:amb-rain;animation-timing-function:linear;animation-iteration-count:infinite;}" +
          "@keyframes amb-rain{0%{transform:translateY(-20vh);}100%{transform:translateY(120vh);}}" +
          ".amb-snow-flake{position:absolute;top:-4%;border-radius:50%;background:rgba(255,255,255,0.55);" +
          "--amb-drift:0px;animation-name:amb-snow;animation-timing-function:linear;animation-iteration-count:infinite;}" +
          "@keyframes amb-snow{0%{transform:translate(0,-10vh);opacity:0;}10%{opacity:.7;}" +
          "100%{transform:translate(var(--amb-drift),110vh);opacity:.7;}}" +
          "@media(prefers-reduced-motion:reduce){.amb-rain-drop,.amb-snow-flake{animation:none;opacity:0;}}" +
          /* sheet bits */
          ".amb-section{margin-bottom:1rem;}" +
          ".amb-section:last-child{margin-bottom:0;}" +
          ".amb-label{font-size:.82rem;color:var(--text-muted);margin-bottom:.4rem;}" +
          ".amb-row{gap:.5rem;flex-wrap:wrap;}" +
          ".amb-status{margin-top:.6rem;font-size:.78rem;color:var(--text-muted);line-height:1.4;}" +
          ".amb-toggle{display:flex;align-items:center;justify-content:space-between;gap:.6rem;" +
          "padding:.55rem 0;font-size:.9rem;cursor:pointer;}" +
          ".amb-toggle input{position:absolute;opacity:0;width:0;height:0;pointer-events:none;}" +
          ".amb-toggle .amb-switch{position:relative;flex:none;width:38px;height:22px;border-radius:22px;" +
          "background:rgba(148,163,184,0.35);transition:background .2s ease;}" +
          ".amb-toggle .amb-switch::after{content:'';position:absolute;top:2px;left:2px;width:18px;height:18px;" +
          "border-radius:50%;background:#f8fafc;transition:transform .2s ease;}" +
          ".amb-toggle input:checked ~ .amb-switch{background:var(--accent-focus);}" +
          ".amb-toggle input:checked ~ .amb-switch::after{transform:translateX(16px);}" +
          ".amb-toggle input:focus-visible ~ .amb-switch{outline:2px solid var(--accent-short);outline-offset:2px;}"
      );
    } catch (e) {}
  }
})();
