"use strict";
/* features/story.js — owner: story agent
 * Three features, all self-contained here:
 *   1. STORY PROGRESSION — serialized micro-fiction gated behind focus sessions.
 *   2. POSTCARDS — every focus session mints a collectible card.
 *   3. STREAK WEATHER — the world reflects consistency, never punishes.
 *
 * Only edits this file. All CSS via FF.ui.injectStyle. All user text via FF.ui.esc.
 * No-ops cleanly when the `story.enabled` flag (default true) is false.
 * Works at 360px wide, matches the dark-glass aesthetic. */
(function () {
  if (typeof window === "undefined" || !window.FF) return;

  /* =================================================================
   * SEASON 1 — "The Lantern Keeper"
   * A student in a blossom village discovers her town's guardian legend,
   * and finds the legend was waiting for her. Each episode is pinned to a
   * real scene from FF.media.list. 12 episodes, then a Season 2 stub.
   * Every episode ends in a gentle cliffhanger hook.
   * ================================================================= */
  var EPISODES = [
    {
      title: "The Desk by the Window",
      scene: "images/girl_studying_compressed.mp4",
      text:
        "Aoi studied late, the way she always did, her lamp the last light on her street. Between one page and the next, she felt someone watching — not unkindly, only patiently. When she looked up, the window held nothing but her own reflection, and behind it, the faint outline of a lantern she had never lit.",
    },
    {
      title: "What the Margins Said",
      scene: "images/girl_writing_3.mp4",
      text:
        "In the old notebook her grandmother left, Aoi found handwriting curling into the margins — a list of names, and beside each, a single word: kept. She wrote her own name at the bottom without meaning to. The ink, still wet, spelled something she hadn't written.",
    },
    {
      title: "Through the Glasses, Clearly",
      scene: "images/nice_glasses_1_compressed.mp4",
      text:
        "She cleaned her glasses and the world sharpened — and for half a breath, the town outside looked older, roofed in a different century, lit by lanterns that floated without strings. Then it was only her quiet neighborhood again. But one lantern, far down the hill, stayed lit.",
    },
    {
      title: "Downhill, at First Light",
      scene: "images/bike_ride_village_compressed.mp4",
      text:
        "Aoi followed the lit lantern on her bike, coasting past shuttered shops and sleeping gardens. The village she had crossed a thousand times unspooled like a map she'd never truly read. At the last turn, the road split — one way home, one way toward the blossoms she'd been told never to enter after dark.",
    },
    {
      title: "The Street That Blooms at Night",
      scene: "images/blossom_street_1_compressed.mp4",
      text:
        "The forbidden street was drowning in petals, though it was long past their season. They fell upward as much as down, and where they touched the ground they left faint prints — the shape of feet, walking a slow patrol. Someone had guarded this place for a very long time. Someone was still guarding it.",
    },
    {
      title: "At the Temple Gate",
      scene: "images/cherry_blossoms_temple_1.mp4",
      text:
        "At the end of the blossoms stood a temple, its bell rope frayed and its steps swept clean by no living hand. A voice like wind through paper asked her name. When Aoi gave it, the gate remembered — 'kept,' it whispered, the way her grandmother's notebook had. It had been expecting her for years.",
    },
    {
      title: "The House on the Hill",
      scene: "images/house_on_A_hill_compressed.mp4",
      text:
        "The temple keeper led her to a house above the valley, gold with sunset, where the village's story was written on the walls in fading paint. Here, she learned, every generation the town chose a keeper of its lantern — and every keeper had first been protected by two who never aged. Below, on the far ridge, two silhouettes turned to face the hill.",
    },
    {
      title: "The Two Who Wait",
      scene: "images/ronin_combined.mp4",
      text:
        "They were ronin — masterless, ageless, bound to the village by a promise older than its name. For centuries they had turned back what came for the lantern in the dark. Tonight their blades were half-drawn, their eyes on the treeline. 'It's early this year,' the elder said. 'And she is not ready.'",
    },
    {
      title: "Words on the Cliff",
      scene: "images/two_ronins_talking_on_a_cliff_compressed.mp4",
      text:
        "On the cliff's edge the two ronin argued in low voices while the valley darkened beneath them. One wished to send Aoi home and hold the line alone, as always. The other pressed a wrapped bundle into her hands. 'The lantern chooses,' he said. 'It chose you. Open it only when the light goes out.'",
    },
    {
      title: "The Blade in the Cloth",
      scene: "images/purple_sword_girl_compressed.mp4",
      text:
        "The bundle held a sword, slim and violet-dark, lighter than any blade should be. When Aoi's fingers closed on the hilt it warmed like a held hand, and she understood — the keeper did not carry the lantern. The keeper became it. Down in the trees, the first light of the village went out.",
    },
    {
      title: "The Leap",
      scene: "images/warrior_girl_leaping_compressed.mp4",
      text:
        "She did not decide to run; her body simply went, over the temple wall and into the dark between the houses, the sword drawing a bright line behind her. The ronin's shouts fell away. For the first time in her careful, quiet life, Aoi was exactly where she needed to be — and not nearly fast enough.",
    },
    {
      title: "Under the Great Moon",
      scene: "images/girl_warrior_big_moon_compressed.mp4",
      text:
        "In the clearing beneath a moon far too large, the thing that came for the village finally showed itself, and Aoi raised the lantern-blade against it. The light held. The village behind her stayed dark and safe and sleeping. She planted her feet, and the long night of the keeper began.",
    },
  ];

  var SEASON2_STUB = {
    title: "Season 2 arrives soon",
    text: "The lantern is lit and the keeper stands her watch. New episodes will unlock as the story grows.",
  };

  // Interlude scenes used to warm up the unlock overlay before the reveal.
  var MILESTONES = { 3: true, 7: true, 11: true }; // 0-based → episodes 4, 8, 12

  /* =================================================================
   * Store keys (all namespaced under "story.")
   *   story.enabled   — boolean, default true
   *   story.progress  — { unlocked: <count of unlocked episodes> }
   *   story.postcards — [ {id,date,sceneSrc,goal,durationMin,episodeIdx,thumb} ]
   *   story.streak    — { count, lastDay, lapseHandled }
   * ================================================================= */
  var K_ENABLED = "story.enabled";
  var K_PROGRESS = "story.progress";
  var K_POSTCARDS = "story.postcards";
  var K_STREAK = "story.streak";

  var POSTCARD_CAP = 200;
  var THUMB_W = 320;

  FF.registerFeature({
    id: "story",
    init: init,
  });

  function init(ctx) {
    var FF = window.FF;
    var enabled = FF.store.load(K_ENABLED, true);
    if (enabled === false) return; // clean no-op when disabled

    injectStyles();

    var progress = normalizeProgress(FF.store.load(K_PROGRESS, null));
    var postcards = normalizePostcards(FF.store.load(K_POSTCARDS, null));

    // ---- streak weather: compute on load ----
    var streak = computeStreak();
    FF.store.save(K_STREAK, streak);

    // ---- register the two dock buttons ----
    FF.ui.registerButton({
      id: "story-book",
      icon: "book-open",
      title: "Story",
      onClick: function () {
        FF.ui.openSheet("story");
      },
      isActive: function () {
        return FF.state.openSheet === "story";
      },
    });
    FF.ui.registerButton({
      id: "story-postcards",
      icon: "camera",
      title: "Postcards",
      onClick: function () {
        FF.ui.openSheet("postcards");
      },
      isActive: function () {
        return FF.state.openSheet === "postcards";
      },
    });

    // ---- register the two sheets ----
    FF.ui.registerSheet("story", {
      render: renderStorySheet,
      wire: wireStorySheet,
    });
    FF.ui.registerSheet("postcards", {
      render: renderPostcardsSheet,
      wire: wirePostcardsSheet,
    });

    // ---- streak ambient overlay (blossom petals on blossom/day scenes) ----
    ensureAmbient();
    applyAmbientForScene();
    FF.on("scene:change", function () {
      applyAmbientForScene();
    });

    // ---- lapse handling: bias one scene toward snow/moon + gentle toast ----
    handleLapseOnOpen();

    // ---- main progression + postcard mint on focus finalize ----
    FF.on("session:finalized", function (payload) {
      try {
        onSessionFinalized(payload);
      } catch (e) {
        console.error("story: session:finalized handler error", e);
      }
    });

    // ---- abandon: quiet toast + 5-minute rescue banner ----
    FF.on("session:abandon", function (payload) {
      try {
        onSessionAbandon(payload);
      } catch (e) {
        console.error("story: session:abandon handler error", e);
      }
    });

    // -----------------------------------------------------------------
    // state accessors kept in closure so sheet render fns see fresh data
    // -----------------------------------------------------------------
    function currentProgress() {
      return progress;
    }
    function currentPostcards() {
      return postcards;
    }
    function currentStreak() {
      return streak;
    }

    // expose to the render/wire helpers via module-scoped refs
    _get.progress = currentProgress;
    _get.postcards = currentPostcards;
    _get.streak = currentStreak;

    // =================================================================
    // SESSION FINALIZED — unlock next episode + mint postcard
    // =================================================================
    function onSessionFinalized(payload) {
      var session = (payload && payload.session) || {};

      // ---------- 1. mint a postcard for this session ----------
      var media = FF.media.current();
      var sceneSrc = (media && media.src) || "";
      var durationMin = Math.max(
        1,
        Math.round((Number(session.duration) || 0) / 60)
      );
      var thumb = captureThumb(); // may be null → placeholder later
      var card = {
        id: session.id || Date.now(),
        date: session.date || new Date().toISOString(),
        sceneSrc: sceneSrc,
        goal: session.goal || "",
        durationMin: durationMin,
        episodeIdx: Math.min(progress.unlocked, EPISODES.length - 1),
        thumb: thumb || null,
      };
      postcards.push(card);
      if (postcards.length > POSTCARD_CAP) {
        postcards = postcards.slice(postcards.length - POSTCARD_CAP);
      }
      FF.store.save(K_POSTCARDS, postcards);

      // ---------- 2. recompute streak (today now has a session) ----------
      streak = computeStreak();
      FF.store.save(K_STREAK, streak);
      applyAmbientForScene();

      // ---------- 3. advance the story ----------
      if (progress.unlocked < EPISODES.length) {
        var idx = progress.unlocked; // the episode we are unlocking now
        progress.unlocked = idx + 1;
        FF.store.save(K_PROGRESS, progress);
        FF.emit("story:unlock", { index: idx, title: EPISODES[idx].title });
        // If this session was a boss duel, another feature (world) will show a
        // victory banner on the same finalize. Let that land first, then reveal
        // the story unlock ~3s later so the two overlays don't fight.
        if (session && session.boss) {
          setTimeout(function () { playUnlock(idx); }, 3000);
        } else {
          playUnlock(idx);
        }
      }
      // If everything is already unlocked we simply mint the postcard and
      // let the streak update — no overlay, no error.
    }

    // =================================================================
    // SESSION ABANDON — dusk toast + rescue banner
    // =================================================================
    function onSessionAbandon() {
      FF.ui.toast("The story pauses at dusk.", { duration: 3000 });
      var remove = FF.ui.banner(
        '<span class="ff-story-rescue-txt">Save the session — 5 focused minutes?</span>' +
          '<button class="btn ff-story-rescue-btn">Rescue</button>',
        {
          id: "story-rescue",
          timeout: 30000,
        }
      );
      // wire the rescue button (banner body onClick would fire for any tap;
      // we specifically target the button element).
      requestAnimationFrame(function () {
        var host = document.querySelector('[data-banner-id="story-rescue"]');
        if (!host) return;
        var btn = host.querySelector(".ff-story-rescue-btn");
        if (btn) {
          btn.onclick = function (e) {
            e.stopPropagation();
            if (typeof remove === "function") remove();
            try {
              FF.timer.startCustom(5);
            } catch (err) {
              console.error("story: rescue startCustom failed", err);
            }
          };
        }
      });
    }
  }

  // module-scoped accessor bag populated in init() so the (module-level)
  // sheet render/wire functions can read live state.
  var _get = { progress: null, postcards: null, streak: null };

  /* =================================================================
   * PROGRESS / POSTCARD / STREAK NORMALIZERS
   * ================================================================= */
  function normalizeProgress(p) {
    if (!p || typeof p !== "object") return { unlocked: 0 };
    var n = Number(p.unlocked);
    if (!isFinite(n) || n < 0) n = 0;
    if (n > EPISODES.length) n = EPISODES.length;
    return { unlocked: Math.floor(n) };
  }
  function normalizePostcards(list) {
    if (!Array.isArray(list)) return [];
    return list.filter(function (c) {
      return c && typeof c === "object";
    });
  }

  // consecutive calendar days with >=1 focus session, today included if present.
  function computeStreak() {
    var history = [];
    try {
      history = FF.store.getHistory() || [];
    } catch (e) {
      history = [];
    }
    // collect the set of local day-keys that have a session.
    var days = Object.create(null);
    var lastTs = 0;
    for (var i = 0; i < history.length; i++) {
      var rec = history[i];
      if (!rec || !rec.date) continue;
      var d = new Date(rec.date);
      if (isNaN(d.getTime())) continue;
      days[dayKey(d)] = true;
      var t = d.getTime();
      if (t > lastTs) lastTs = t;
    }
    // walk backward from today counting consecutive days.
    var count = 0;
    var cursor = new Date();
    // today only counts if a session exists today; otherwise start from
    // yesterday so an as-yet-empty today doesn't break an existing streak.
    if (!days[dayKey(cursor)]) {
      cursor.setDate(cursor.getDate() - 1);
    }
    while (days[dayKey(cursor)]) {
      count++;
      cursor.setDate(cursor.getDate() - 1);
    }
    var lastDay = lastTs ? dayKey(new Date(lastTs)) : null;
    // days since last session (for lapse bias)
    var lapseDays = 0;
    if (lastTs) {
      var today0 = startOfDay(new Date());
      var last0 = startOfDay(new Date(lastTs));
      lapseDays = Math.round((today0 - last0) / 86400000);
    } else {
      lapseDays = 999;
    }
    return { count: count, lastDay: lastDay, lapseDays: lapseDays };
  }
  function dayKey(d) {
    return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate();
  }
  function startOfDay(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  }

  /* =================================================================
   * THUMB CAPTURE — draw the live bg element into a small JPEG dataURL.
   * Wrapped in try/catch; returns null on any failure (→ placeholder).
   * ================================================================= */
  function captureThumb() {
    try {
      var el = FF.media.getElement();
      if (!el) return null;
      var sw, sh;
      var isVideo = el.tagName === "VIDEO";
      if (isVideo) {
        sw = el.videoWidth;
        sh = el.videoHeight;
        if (!sw || !sh) return null; // not enough frame data yet
      } else {
        // image background rendered as a div with background-image — we can't
        // reliably rasterize it cross-origin, so fall back to placeholder.
        var r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
        sw = (r && r.width) || 0;
        sh = (r && r.height) || 0;
        if (!sw || !sh) return null;
        return null; // div bg → use tag gradient placeholder
      }
      var w = THUMB_W;
      var h = Math.round((w * sh) / sw) || Math.round(w * 1.25);
      var canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      var g = canvas.getContext("2d");
      if (!g) return null;
      g.drawImage(el, 0, 0, w, h);
      return canvas.toDataURL("image/jpeg", 0.6);
    } catch (e) {
      return null; // tainted canvas / anything else → placeholder
    }
  }

  // deterministic-ish gradient placeholder derived from a scene src's tags.
  function gradientForScene(sceneSrc) {
    var item = null;
    var list = (FF.media && FF.media.list) || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].src === sceneSrc) {
        item = list[i];
        break;
      }
    }
    var tags = (item && item.tags) || [];
    if (tags.indexOf("snow") >= 0)
      return "linear-gradient(160deg,#334155,#0f172a)";
    if (tags.indexOf("night") >= 0 || tags.indexOf("moon") >= 0)
      return "linear-gradient(160deg,#3b2f63,#0f172a)";
    if (tags.indexOf("sunset") >= 0)
      return "linear-gradient(160deg,#7c2d3a,#3b2f63)";
    if (tags.indexOf("action") >= 0 || tags.indexOf("epic") >= 0)
      return "linear-gradient(160deg,#5b1f2e,#1e1b2e)";
    if (tags.indexOf("blossom") >= 0)
      return "linear-gradient(160deg,#7a3b5a,#3b2f63)";
    if (tags.indexOf("village") >= 0)
      return "linear-gradient(160deg,#3a5a4a,#1e293b)";
    if (tags.indexOf("study") >= 0)
      return "linear-gradient(160deg,#334155,#1e1b2e)";
    return "linear-gradient(160deg,#334155,#0f172a)";
  }

  /* =================================================================
   * UNLOCK OVERLAY — cinematic reveal after finalize.
   * Crossfade to episode scene, title+text fade in over scene bottom,
   * dismiss on tap or after ~10s. Confetti on milestones.
   * ================================================================= */
  var _unlockActive = false;
  function playUnlock(idx) {
    var ep = EPISODES[idx];
    if (!ep) return;
    // crossfade the actual background to the episode's scene
    try {
      FF.media.setScene(ep.scene);
    } catch (e) {}
    try {
      FF.audio.playCue("unlock");
    } catch (e) {}
    if (MILESTONES[idx]) {
      try {
        FF.ui.confetti();
      } catch (e) {}
    }

    if (_unlockActive) return; // don't stack overlays
    _unlockActive = true;

    var host = document.createElement("div");
    host.className = "ff-story-unlock";
    host.innerHTML =
      '<div class="ff-story-unlock-inner glass-panel">' +
      '<div class="ff-story-unlock-kicker">Episode ' +
      (idx + 1) +
      " unlocked</div>" +
      '<div class="ff-story-unlock-title">' +
      FF.ui.esc(ep.title) +
      "</div>" +
      '<div class="ff-story-unlock-text">' +
      FF.ui.esc(ep.text) +
      "</div>" +
      '<div class="ff-story-unlock-hint">tap to continue</div>' +
      "</div>";
    document.body.appendChild(host);
    // fade in
    void host.offsetWidth;
    host.classList.add("show");

    var closed = false;
    var timer = null;
    function close() {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      host.classList.remove("show");
      setTimeout(function () {
        if (host.parentNode) host.parentNode.removeChild(host);
        _unlockActive = false;
      }, 400);
    }
    host.addEventListener("click", close);
    timer = setTimeout(close, 10000);
  }

  /* =================================================================
   * STREAK AMBIENT — drifting blossom petals on blossom/day scenes.
   * <=24 petals, pointer-events:none, very low opacity. CSS-animated.
   * ================================================================= */
  var _ambientHost = null;
  function ensureAmbient() {
    if (_ambientHost && document.body.contains(_ambientHost)) return;
    _ambientHost = document.createElement("div");
    _ambientHost.className = "ff-story-ambient";
    _ambientHost.setAttribute("aria-hidden", "true");
    // Insert as first child of #root so it sits above bg but below controls.
    var root = document.getElementById("root");
    (root || document.body).appendChild(_ambientHost);
  }
  function buildPetals() {
    if (!_ambientHost) return;
    if (_ambientHost.childNodes.length) return; // build once
    var n = 20; // <= 24
    var html = "";
    for (var i = 0; i < n; i++) {
      var left = Math.round(Math.random() * 100);
      var dur = (9 + Math.random() * 9).toFixed(2);
      var delay = (Math.random() * 12).toFixed(2);
      var size = (5 + Math.random() * 6).toFixed(1);
      var drift = Math.round((Math.random() * 2 - 1) * 60);
      html +=
        '<span class="ff-story-petal" style="left:' +
        left +
        "%;width:" +
        size +
        "px;height:" +
        (size * 0.72).toFixed(1) +
        "px;animation-duration:" +
        dur +
        "s;animation-delay:-" +
        delay +
        "s;--ff-pdrift:" +
        drift +
        'px;"></span>';
    }
    _ambientHost.innerHTML = html;
  }
  function applyAmbientForScene() {
    if (!_ambientHost) return;
    var streak = FF.store.load(K_STREAK, { count: 0 });
    var on = false;
    if (streak && streak.count >= 3) {
      var cur = FF.media.current();
      var item = findMedia(cur && cur.src);
      var tags = (item && item.tags) || [];
      if (tags.indexOf("blossom") >= 0 || tags.indexOf("day") >= 0) on = true;
    }
    if (on) {
      buildPetals();
      _ambientHost.classList.add("on");
    } else {
      _ambientHost.classList.remove("on");
    }
  }
  function findMedia(src) {
    if (!src) return null;
    var list = (FF.media && FF.media.list) || [];
    for (var i = 0; i < list.length; i++) if (list[i].src === src) return list[i];
    return null;
  }

  /* =================================================================
   * LAPSE — on first app open after >=2 quiet days, bias one scene pick
   * toward snow/moon and show one gentle (never guilt) toast.
   * ================================================================= */
  function handleLapseOnOpen() {
    var streak = FF.store.load(K_STREAK, null) || computeStreak();
    if (!streak || typeof streak.lapseDays !== "number") return;
    if (streak.lapseDays < 2 || streak.lapseDays > 900) return; // 999 = never focused; skip
    // bias exactly one scene pick toward a quiet snow/moon scene.
    try {
      var quiet = FF.media.pick(function (m) {
        var t = m.tags || [];
        return t.indexOf("snow") >= 0 || t.indexOf("moon") >= 0;
      });
      if (quiet) FF.media.setScene(quiet);
    } catch (e) {}
    FF.ui.toast("The village kept a lantern lit for you.", { duration: 3600 });
  }

  /* =================================================================
   * STORY SHEET — season progress bar + episode list.
   * ================================================================= */
  function renderStorySheet() {
    var progress = _get.progress ? _get.progress() : { unlocked: 0 };
    var streak = _get.streak ? _get.streak() : { count: 0 };
    var unlocked = progress.unlocked;
    var total = EPISODES.length;
    var pct = Math.round((Math.min(unlocked, total) / total) * 100);

    var streakChip = "";
    if (streak && streak.count >= 3) {
      streakChip =
        '<span class="ff-story-streak-chip">' +
        FF.ui.icon("sparkles", 13) +
        " " +
        streak.count +
        "-day streak</span>";
    }

    var rows = "";
    for (var i = 0; i < total; i++) {
      var ep = EPISODES[i];
      var isUnlocked = i < unlocked;
      var isCurrent = i === unlocked - 1; // most-recently unlocked
      if (isUnlocked) {
        rows +=
          '<button class="ff-ep ff-ep-unlocked' +
          (isCurrent ? " ff-ep-current" : "") +
          '" data-ep="' +
          i +
          '">' +
          '<div class="ff-ep-num">' +
          (i + 1) +
          "</div>" +
          '<div class="ff-ep-body">' +
          '<div class="ff-ep-title">' +
          FF.ui.esc(ep.title) +
          (isCurrent
            ? '<span class="ff-ep-badge">now</span>'
            : "") +
          "</div>" +
          '<div class="ff-ep-text">' +
          FF.ui.esc(ep.text) +
          "</div>" +
          "</div>" +
          "</button>";
      } else {
        rows +=
          '<div class="ff-ep ff-ep-locked">' +
          '<div class="ff-ep-num">' +
          FF.ui.icon("book-open", 13) +
          "</div>" +
          '<div class="ff-ep-body">' +
          '<div class="ff-ep-title ff-ep-locked-title">Episode ' +
          (i + 1) +
          " — locked</div>" +
          '<div class="ff-ep-text ff-ep-locked-text">Complete a focus session to unlock.</div>' +
          "</div>" +
          '<div class="ff-ep-lock">' +
          lockGlyph() +
          "</div>" +
          "</div>";
      }
    }

    // Season 2 stub row (shown once all 12 unlocked, or always dimmed at end)
    var s2 =
      '<div class="ff-ep ff-ep-locked ff-ep-s2">' +
      '<div class="ff-ep-num">' +
      FF.ui.icon("sparkles", 13) +
      "</div>" +
      '<div class="ff-ep-body">' +
      '<div class="ff-ep-title ff-ep-locked-title">' +
      FF.ui.esc(SEASON2_STUB.title) +
      "</div>" +
      '<div class="ff-ep-text ff-ep-locked-text">' +
      FF.ui.esc(SEASON2_STUB.text) +
      "</div>" +
      "</div>" +
      "</div>";

    return (
      closeBtn() +
      '<h2>' +
      FF.ui.icon("book-open", 18) +
      ' <span class="ff-story-h2">Season 1 — The Lantern Keeper</span>' +
      streakChip +
      "</h2>" +
      '<div class="ff-story-progress">' +
      '<div class="ff-story-progress-bar"><div class="ff-story-progress-fill" style="width:' +
      pct +
      '%"></div></div>' +
      '<div class="ff-story-progress-label">' +
      Math.min(unlocked, total) +
      " / " +
      total +
      " episodes</div>" +
      "</div>" +
      '<div class="sheet-scroll ff-ep-list">' +
      rows +
      s2 +
      "</div>"
    );
  }

  function wireStorySheet(hostEl) {
    if (!hostEl) return;
    var btns = hostEl.querySelectorAll("[data-ep]");
    btns.forEach(function (b) {
      b.onclick = function () {
        var idx = Number(b.getAttribute("data-ep"));
        var ep = EPISODES[idx];
        if (!ep) return;
        try {
          FF.media.setScene(ep.scene);
        } catch (e) {}
        // re-read modal
        openEpisodeReader(idx);
      };
    });
  }

  // A calm reader overlay for re-reading an unlocked episode.
  function openEpisodeReader(idx) {
    var ep = EPISODES[idx];
    if (!ep) return;
    FF.ui.closeSheet();
    var host = document.createElement("div");
    host.className = "ff-story-unlock show ff-story-reader";
    host.innerHTML =
      '<div class="ff-story-unlock-inner glass-panel">' +
      '<div class="ff-story-unlock-kicker">Episode ' +
      (idx + 1) +
      "</div>" +
      '<div class="ff-story-unlock-title">' +
      FF.ui.esc(ep.title) +
      "</div>" +
      '<div class="ff-story-unlock-text">' +
      FF.ui.esc(ep.text) +
      "</div>" +
      '<div class="ff-story-unlock-hint">tap to close</div>' +
      "</div>";
    document.body.appendChild(host);
    host.addEventListener("click", function () {
      host.classList.remove("show");
      setTimeout(function () {
        if (host.parentNode) host.parentNode.removeChild(host);
      }, 400);
    });
  }

  /* =================================================================
   * POSTCARDS SHEET — 2-col grid of minted cards.
   * ================================================================= */
  function renderPostcardsSheet() {
    var postcards = _get.postcards ? _get.postcards() : [];
    var cards = postcards.slice().reverse(); // newest first

    if (!cards.length) {
      return (
        closeBtn() +
        "<h2>" +
        FF.ui.icon("camera", 18) +
        " Postcards</h2>" +
        '<div class="ff-pc-empty muted">Complete a focus session to mint your first postcard — a keepsake of the scene, your goal, and the time you gave it.</div>'
      );
    }

    var grid = "";
    for (var i = 0; i < cards.length; i++) {
      var c = cards[i];
      var visual = c.thumb
        ? 'background-image:url(' + c.thumb + ");background-size:cover;background-position:center;"
        : "background:" + gradientForScene(c.sceneSrc) + ";";
      grid +=
        '<button class="ff-pc-card" data-card="' +
        FF.ui.esc(String(c.id)) +
        '">' +
        '<div class="ff-pc-visual" style="' +
        visual +
        '"><span class="ff-pc-dur">' +
        c.durationMin +
        'm</span></div>' +
        '<div class="ff-pc-meta">' +
        '<div class="ff-pc-date">' +
        FF.ui.esc(shortDate(c.date)) +
        "</div>" +
        (c.goal
          ? '<div class="ff-pc-goal">' + FF.ui.esc(truncate(c.goal, 42)) + "</div>"
          : '<div class="ff-pc-goal ff-pc-nogoal">Focus session</div>') +
        "</div>" +
        "</button>";
    }

    return (
      closeBtn() +
      "<h2>" +
      FF.ui.icon("camera", 18) +
      " Postcards <span class=\"ff-pc-count\">" +
      postcards.length +
      "</span></h2>" +
      '<div class="sheet-scroll"><div class="ff-pc-grid">' +
      grid +
      "</div></div>"
    );
  }

  function wirePostcardsSheet(hostEl) {
    if (!hostEl) return;
    var postcards = _get.postcards ? _get.postcards() : [];
    var byId = Object.create(null);
    postcards.forEach(function (c) {
      byId[String(c.id)] = c;
    });
    hostEl.querySelectorAll("[data-card]").forEach(function (b) {
      b.onclick = function () {
        var c = byId[b.getAttribute("data-card")];
        if (c) openPostcardDetail(c);
      };
    });
  }

  // Detail overlay for a single card with a "Save image" button.
  function openPostcardDetail(card) {
    var host = document.createElement("div");
    host.className = "ff-story-unlock show ff-pc-detail";
    var visual = card.thumb
      ? 'background-image:url(' + card.thumb + ");background-size:cover;background-position:center;"
      : "background:" + gradientForScene(card.sceneSrc) + ";";
    host.innerHTML =
      '<div class="ff-pc-detail-card glass-panel">' +
      '<div class="ff-pc-detail-visual" style="' +
      visual +
      '"><span class="ff-pc-detail-wordmark">FunFocus</span></div>' +
      '<div class="ff-pc-detail-body">' +
      '<div class="ff-pc-detail-goal">' +
      FF.ui.esc(card.goal || "Focus session") +
      "</div>" +
      '<div class="ff-pc-detail-sub muted">' +
      FF.ui.esc(longDate(card.date)) +
      " · " +
      card.durationMin +
      " min</div>" +
      '<div class="ff-pc-detail-actions">' +
      '<button class="btn ff-pc-save">' +
      FF.ui.icon("camera", 15) +
      " Save image</button>" +
      '<button class="btn ff-pc-close-btn">Close</button>' +
      "</div>" +
      "</div>" +
      "</div>";
    document.body.appendChild(host);

    function close() {
      host.classList.remove("show");
      setTimeout(function () {
        if (host.parentNode) host.parentNode.removeChild(host);
      }, 400);
    }
    host.addEventListener("click", function (e) {
      if (e.target === host) close();
    });
    var closeBtnEl = host.querySelector(".ff-pc-close-btn");
    if (closeBtnEl) closeBtnEl.onclick = close;
    var saveBtn = host.querySelector(".ff-pc-save");
    if (saveBtn)
      saveBtn.onclick = function (e) {
        e.stopPropagation();
        savePostcardImage(card);
      };
  }

  // Render a polished 1080x1350 postcard and trigger a PNG download.
  function savePostcardImage(card) {
    try {
      var W = 1080,
        H = 1350;
      var canvas = document.createElement("canvas");
      canvas.width = W;
      canvas.height = H;
      var g = canvas.getContext("2d");
      if (!g) return;

      function paintChrome() {
        // vignette
        var vg = g.createRadialGradient(
          W / 2,
          H / 2,
          H * 0.25,
          W / 2,
          H / 2,
          H * 0.72
        );
        vg.addColorStop(0, "rgba(0,0,0,0)");
        vg.addColorStop(1, "rgba(0,0,0,0.55)");
        g.fillStyle = vg;
        g.fillRect(0, 0, W, H);

        // bottom scrim for text legibility
        var sc = g.createLinearGradient(0, H * 0.55, 0, H);
        sc.addColorStop(0, "rgba(15,23,42,0)");
        sc.addColorStop(1, "rgba(15,23,42,0.9)");
        g.fillStyle = sc;
        g.fillRect(0, H * 0.55, W, H * 0.45);

        // goal text
        var goal = card.goal || "A focus session";
        g.fillStyle = "#f8fafc";
        g.font = "800 68px 'Outfit', system-ui, sans-serif";
        g.textBaseline = "alphabetic";
        wrapText(g, goal, 72, H - 250, W - 144, 78, 3);

        // meta line
        g.fillStyle = "#cbd5e1";
        g.font = "500 40px 'Inter', system-ui, sans-serif";
        g.fillText(
          longDate(card.date) + "  ·  " + card.durationMin + " min",
          72,
          H - 120
        );

        // accent rule
        g.fillStyle = "#f43f5e";
        g.fillRect(72, H - 96, 96, 6);

        // wordmark
        g.fillStyle = "#f8fafc";
        g.font = "800 34px 'Outfit', system-ui, sans-serif";
        g.textAlign = "right";
        g.fillText("FunFocus", W - 72, H - 84);
        g.textAlign = "left";

        triggerDownload(canvas, card);
      }

      if (card.thumb) {
        var img = new Image();
        img.onload = function () {
          // cover-fit the thumb across the canvas
          var ir = img.width / img.height;
          var cr = W / H;
          var dw, dh, dx, dy;
          if (ir > cr) {
            dh = H;
            dw = H * ir;
            dx = (W - dw) / 2;
            dy = 0;
          } else {
            dw = W;
            dh = W / ir;
            dx = 0;
            dy = (H - dh) / 2;
          }
          g.drawImage(img, dx, dy, dw, dh);
          paintChrome();
        };
        img.onerror = function () {
          paintGradientBg(g, W, H, card);
          paintChrome();
        };
        img.src = card.thumb;
      } else {
        paintGradientBg(g, W, H, card);
        paintChrome();
      }
    } catch (e) {
      console.error("story: savePostcardImage failed", e);
      FF.ui.toast("Couldn't render the postcard.");
    }
  }

  function paintGradientBg(g, W, H, card) {
    // approximate the CSS gradient with a canvas linear gradient
    var lg = g.createLinearGradient(0, 0, W, H);
    var pair = gradientStops(card.sceneSrc);
    lg.addColorStop(0, pair[0]);
    lg.addColorStop(1, pair[1]);
    g.fillStyle = lg;
    g.fillRect(0, 0, W, H);
  }
  function gradientStops(sceneSrc) {
    var item = findMedia(sceneSrc);
    var tags = (item && item.tags) || [];
    if (tags.indexOf("snow") >= 0) return ["#334155", "#0f172a"];
    if (tags.indexOf("night") >= 0 || tags.indexOf("moon") >= 0)
      return ["#3b2f63", "#0f172a"];
    if (tags.indexOf("sunset") >= 0) return ["#7c2d3a", "#3b2f63"];
    if (tags.indexOf("action") >= 0 || tags.indexOf("epic") >= 0)
      return ["#5b1f2e", "#1e1b2e"];
    if (tags.indexOf("blossom") >= 0) return ["#7a3b5a", "#3b2f63"];
    if (tags.indexOf("village") >= 0) return ["#3a5a4a", "#1e293b"];
    if (tags.indexOf("study") >= 0) return ["#334155", "#1e1b2e"];
    return ["#334155", "#0f172a"];
  }

  function wrapText(g, text, x, y, maxWidth, lineHeight, maxLines) {
    var words = String(text).split(/\s+/);
    var lines = [];
    var line = "";
    for (var i = 0; i < words.length; i++) {
      var test = line ? line + " " + words[i] : words[i];
      if (g.measureText(test).width > maxWidth && line) {
        lines.push(line);
        line = words[i];
        if (lines.length === maxLines - 1) break;
      } else {
        line = test;
      }
    }
    if (line && lines.length < maxLines) lines.push(line);
    if (lines.length === maxLines) {
      // ellipsize last line if there was more text
      var last = lines[maxLines - 1];
      while (g.measureText(last + "…").width > maxWidth && last.length > 1) {
        last = last.slice(0, -1);
      }
      // only add ellipsis if we truncated words
      lines[maxLines - 1] = last;
    }
    // draw bottom-up from y so it grows upward from the anchor
    var startY = y - (lines.length - 1) * lineHeight;
    for (var j = 0; j < lines.length; j++) {
      g.fillText(lines[j], x, startY + j * lineHeight);
    }
  }

  function triggerDownload(canvas, card) {
    try {
      var url = canvas.toDataURL("image/png");
      var a = document.createElement("a");
      a.href = url;
      a.download = "funfocus-postcard-" + (card.id || Date.now()) + ".png";
      document.body.appendChild(a);
      a.click();
      setTimeout(function () {
        if (a.parentNode) a.parentNode.removeChild(a);
      }, 100);
      FF.ui.toast("Postcard saved.");
    } catch (e) {
      console.error("story: triggerDownload failed", e);
      FF.ui.toast("Couldn't save the postcard.");
    }
  }

  /* =================================================================
   * small helpers
   * ================================================================= */
  function closeBtn() {
    return (
      '<button class="btn sheet-close" id="sheet-close">' +
      FF.ui.icon("x", 18) +
      "</button>"
    );
  }
  function lockGlyph() {
    // small lock SVG (not in core icon set) — inline, aria-hidden.
    return (
      '<svg class="lucide" width="13" height="13" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
      '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/>' +
      '<path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>'
    );
  }
  function truncate(s, n) {
    s = String(s || "");
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  }
  function shortDate(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  function longDate(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }

  /* =================================================================
   * STYLES
   * ================================================================= */
  function injectStyles() {
    FF.ui.injectStyle(
      /* ---- unlock / reader / detail overlay ---- */
      ".ff-story-unlock{position:fixed;inset:0;z-index:450;display:flex;align-items:flex-end;" +
        "justify-content:center;background:rgba(0,0,0,0);opacity:0;transition:opacity .5s ease;" +
        "pointer-events:none;padding:0 12px max(20px,env(safe-area-inset-bottom));}" +
        ".ff-story-unlock.show{opacity:1;background:rgba(0,0,0,0.28);pointer-events:auto;cursor:pointer;}" +
        ".ff-story-unlock-inner{width:100%;max-width:440px;padding:1rem 1.15rem 1.15rem;border-radius:22px;" +
        "transform:translateY(18px);transition:transform .5s cubic-bezier(.2,.9,.3,1);}" +
        ".ff-story-unlock.show .ff-story-unlock-inner{transform:translateY(0);}" +
        ".ff-story-unlock-kicker{font-size:.72rem;letter-spacing:.08em;text-transform:uppercase;" +
        "color:var(--accent-focus);font-weight:600;margin-bottom:.3rem;}" +
        ".ff-story-unlock-title{font-family:var(--font-timer);font-weight:800;font-size:1.35rem;" +
        "line-height:1.15;margin-bottom:.5rem;}" +
        ".ff-story-unlock-text{font-size:.92rem;line-height:1.5;color:#e2e8f0;}" +
        ".ff-story-unlock-hint{margin-top:.8rem;font-size:.72rem;color:var(--text-muted);text-align:center;}" +
        /* ---- story sheet ---- */
        ".ff-story-h2{font-size:.95rem;font-weight:600;}" +
        ".ff-story-streak-chip{margin-left:auto;display:inline-flex;align-items:center;gap:.25rem;" +
        "font-size:.72rem;padding:.2rem .5rem;border-radius:999px;background:#f43f5e22;color:#fda4af;" +
        "white-space:nowrap;}" +
        ".ff-story-streak-chip .lucide{width:13px;height:13px;}" +
        ".ff-story-progress{margin-bottom:.8rem;}" +
        ".ff-story-progress-bar{height:7px;border-radius:999px;background:rgba(255,255,255,.1);overflow:hidden;}" +
        ".ff-story-progress-fill{height:100%;border-radius:999px;background:linear-gradient(90deg,#f43f5e,#fb7185);" +
        "transition:width .4s ease;}" +
        ".ff-story-progress-label{margin-top:.35rem;font-size:.75rem;color:var(--text-muted);}" +
        ".ff-ep-list{display:flex;flex-direction:column;gap:.5rem;}" +
        ".ff-ep{display:flex;gap:.6rem;text-align:left;width:100%;padding:.65rem .7rem;border-radius:14px;" +
        "background:rgba(255,255,255,.05);border:1px solid transparent;color:inherit;font-family:inherit;}" +
        "button.ff-ep{cursor:pointer;transition:background .15s ease,border-color .15s ease;}" +
        "button.ff-ep-unlocked:hover{background:rgba(255,255,255,.09);}" +
        ".ff-ep-current{border-color:rgba(244,63,94,.5);background:#f43f5e14;}" +
        ".ff-ep-locked{opacity:.5;}" +
        ".ff-ep-num{flex:none;width:24px;height:24px;border-radius:8px;display:flex;align-items:center;" +
        "justify-content:center;font-size:.78rem;font-weight:700;background:rgba(255,255,255,.1);" +
        "font-family:var(--font-timer);}" +
        ".ff-ep-body{flex:1;min-width:0;}" +
        ".ff-ep-title{font-size:.9rem;font-weight:600;margin-bottom:.15rem;display:flex;align-items:center;gap:.4rem;}" +
        ".ff-ep-badge{font-size:.6rem;letter-spacing:.06em;text-transform:uppercase;color:#fda4af;" +
        "background:#f43f5e22;padding:.05rem .35rem;border-radius:999px;font-weight:700;}" +
        ".ff-ep-text{font-size:.8rem;line-height:1.45;color:#cbd5e1;}" +
        ".ff-ep-locked-title{color:var(--text-muted);font-weight:600;}" +
        ".ff-ep-locked-text{color:var(--text-muted);}" +
        ".ff-ep-lock{flex:none;align-self:center;color:var(--text-muted);}" +
        ".ff-ep-s2{opacity:.6;margin-top:.2rem;}" +
        /* ---- postcards ---- */
        ".ff-pc-count,.ff-pc-detail .ff-pc-count{margin-left:auto;font-size:.72rem;color:var(--text-muted);" +
        "font-weight:500;}" +
        ".ff-pc-empty{margin-top:1.2rem;line-height:1.5;text-align:center;}" +
        ".ff-pc-grid{display:grid;grid-template-columns:1fr 1fr;gap:.6rem;}" +
        ".ff-pc-card{padding:0;border:none;background:rgba(255,255,255,.05);border-radius:14px;overflow:hidden;" +
        "cursor:pointer;color:inherit;font-family:inherit;text-align:left;transition:transform .15s ease;}" +
        ".ff-pc-card:active{transform:scale(.98);}" +
        ".ff-pc-visual{position:relative;width:100%;aspect-ratio:4/5;background:#1e293b;}" +
        ".ff-pc-dur{position:absolute;bottom:6px;right:6px;font-size:.68rem;font-weight:600;padding:.1rem .4rem;" +
        "border-radius:999px;background:rgba(0,0,0,.5);color:#fff;backdrop-filter:blur(4px);}" +
        ".ff-pc-meta{padding:.45rem .5rem .55rem;}" +
        ".ff-pc-date{font-size:.68rem;color:var(--text-muted);margin-bottom:.1rem;}" +
        ".ff-pc-goal{font-size:.78rem;line-height:1.3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}" +
        ".ff-pc-nogoal{color:var(--text-muted);font-style:italic;}" +
        /* ---- postcard detail ---- */
        ".ff-pc-detail-card{width:100%;max-width:440px;border-radius:22px;overflow:hidden;" +
        "transform:translateY(18px);transition:transform .5s cubic-bezier(.2,.9,.3,1);}" +
        ".ff-story-unlock.show .ff-pc-detail-card{transform:translateY(0);}" +
        ".ff-pc-detail-visual{position:relative;width:100%;aspect-ratio:4/5;background:#1e293b;}" +
        ".ff-pc-detail-wordmark{position:absolute;bottom:10px;right:12px;font-family:var(--font-timer);" +
        "font-weight:800;font-size:.9rem;color:#fff;text-shadow:0 1px 8px rgba(0,0,0,.6);}" +
        ".ff-pc-detail-body{padding:.9rem 1rem 1.05rem;}" +
        ".ff-pc-detail-goal{font-family:var(--font-timer);font-weight:800;font-size:1.15rem;line-height:1.2;" +
        "margin-bottom:.3rem;}" +
        ".ff-pc-detail-sub{margin-bottom:.8rem;}" +
        ".ff-pc-detail-actions{display:flex;gap:.5rem;}" +
        ".ff-pc-save{flex:1;background:var(--accent-focus);border-color:transparent;padding:.6rem;}" +
        ".ff-pc-close-btn{flex:none;padding:.6rem 1rem;}" +
        /* ---- rescue banner button ---- */
        ".ff-story-rescue-txt{flex:1;}" +
        ".ff-story-rescue-btn{padding:.35rem .7rem;font-size:.78rem;background:var(--accent-focus);" +
        "border-color:transparent;flex:none;}" +
        /* ---- streak ambient petals ---- */
        ".ff-story-ambient{position:absolute;inset:0;z-index:5;pointer-events:none;overflow:hidden;" +
        "opacity:0;transition:opacity 1.2s ease;}" +
        ".ff-story-ambient.on{opacity:1;}" +
        ".ff-story-petal{position:absolute;top:-20px;border-radius:60% 60% 62% 38% / 62% 62% 40% 40%;" +
        "background:radial-gradient(circle at 30% 30%,#fbcfe8,#f9a8d4);opacity:.14;" +
        "animation-name:ff-story-drift;animation-timing-function:linear;animation-iteration-count:infinite;" +
        "will-change:transform;}" +
        "@keyframes ff-story-drift{0%{transform:translate3d(0,0,0) rotate(0);opacity:0;}" +
        "8%{opacity:.16;}92%{opacity:.16;}" +
        "100%{transform:translate3d(var(--ff-pdrift),102vh,0) rotate(320deg);opacity:0;}}" +
        "@media(prefers-reduced-motion:reduce){.ff-story-petal{animation:none;display:none;}}"
    );
  }
})();
