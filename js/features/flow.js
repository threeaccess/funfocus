"use strict";
/* features/flow.js — owner: flow agent
 * The FLOW module: three felt moments around the timer.
 *   1. Opening ritual   — a ~10s breathing entry before a focus session.
 *   2. Break quests      — own the break (stretch / breathe / eye-rest) and,
 *                          hardest of all, the RETURN back to focus.
 *   3. Audio narrative arc — music that knows the timer (final-sprint swell,
 *                          resolution at completion, ducking during breaks).
 * Only edits this file. All CSS via FF.ui.injectStyle. IIFE, vanilla, no deps.
 */
(function () {
  FF.registerFeature({
    id: "flow",
    init: function (ctx) {
      var on = ctx.on;
      var timer = ctx.timer;
      var store = ctx.store;
      var ui = ctx.ui;
      var audio = ctx.audio;
      var hooks = ctx.hooks;
      var state = ctx.state;

      /* ------------------------------------------------------------------ *
       * Settings (namespaced ff_flow.*)
       * ------------------------------------------------------------------ */
      var settings = {
        enabled: store.load("flow.enabled", true),
        ritual: store.load("flow.ritual", true),
        quests: store.load("flow.quests", true),
        returnReminder: store.load("flow.returnReminder", true),
        audioArc: store.load("flow.audioArc", true),
        volume: clamp01(store.load("flow.volume", 0.6)),
      };
      function persist(key, val) {
        settings[key] = val;
        store.save("flow." + key, val);
      }
      function clamp01(v) {
        v = Number(v);
        if (isNaN(v)) return 0.6;
        return Math.min(1, Math.max(0, v));
      }

      /* ------------------------------------------------------------------ *
       * Styles
       * ------------------------------------------------------------------ */
      ui.injectStyle(css());

      /* ================================================================== *
       * 1. OPENING RITUAL  (FF.hooks.beforeStart)
       * ================================================================== */
      // The ritual returns a promise that ALWAYS resolves: on completion, on a
      // skip gesture, or (belt & suspenders) on a hard timeout guard.
      hooks.beforeStart(function (info) {
        if (!settings.enabled || !settings.ritual) return;
        if (!info || info.mode !== "focus") return;
        try {
          return runRitual();
        } catch (e) {
          return; // never block start
        }
      });

      function runRitual() {
        return new Promise(function (resolve) {
          var done = false;
          var timers = [];
          var overlay = null;
          var guard = null;

          function finish() {
            if (done) return;
            done = true;
            timers.forEach(clearTimeout);
            if (guard) clearTimeout(guard);
            window.removeEventListener("keydown", onKey, true);
            if (overlay) {
              overlay.classList.remove("show");
              // remove listeners on the overlay itself
              overlay.removeEventListener("pointerdown", skip);
              var el = overlay;
              setTimeout(function () {
                if (el && el.parentNode) el.parentNode.removeChild(el);
              }, 420);
              overlay = null;
            }
            resolve();
          }
          function skip() {
            finish();
          }
          function onKey() {
            finish();
          }

          // Hard guard: never let the ritual hold the timer hostage.
          guard = setTimeout(finish, 12000);

          try {
            overlay = document.createElement("div");
            overlay.className = "flow-ritual";
            overlay.setAttribute("role", "dialog");
            overlay.setAttribute("aria-label", "Breathing ritual");
            overlay.innerHTML =
              '<div class="flow-ritual-stage">' +
              '<div class="flow-ring"><span class="flow-cue">Breathe in…</span></div>' +
              '<div class="flow-skip">tap anywhere to skip</div>' +
              "</div>";
            document.body.appendChild(overlay);
            void overlay.offsetWidth;
            overlay.classList.add("show");

            overlay.addEventListener("pointerdown", skip);
            window.addEventListener("keydown", onKey, true);

            var ring = overlay.querySelector(".flow-ring");
            var cue = overlay.querySelector(".flow-cue");

            // Phase schedule (ms cumulative): in 4s, hold 2s, out 4s, begin 1s.
            setPhase(ring, cue, "in", "Breathe in…");
            timers.push(
              setTimeout(function () {
                setPhase(ring, cue, "hold", "Hold…");
              }, 4000)
            );
            timers.push(
              setTimeout(function () {
                setPhase(ring, cue, "out", "Let go…");
              }, 6000)
            );
            timers.push(
              setTimeout(function () {
                setPhase(ring, cue, "begin", "Begin.");
                if (overlay) overlay.classList.add("begin");
              }, 10000)
            );
            // fade out + resolve after the 1s "Begin." beat
            timers.push(setTimeout(finish, 11000));
          } catch (e) {
            finish();
          }
        });
      }

      function setPhase(ring, cue, phase, text) {
        if (!ring) return;
        ring.setAttribute("data-phase", phase);
        if (cue) cue.textContent = text;
      }

      /* ================================================================== *
       * 2. BREAK QUESTS + THE RETURN
       * ================================================================== */
      var questPanel = null; // dismissible glass panel offering quests
      var activeQuest = null; // running overlay controller
      var returnBanner = null; // remove() fn for the return banner
      var overrunTimer = null; // 90s overrun watchdog
      var titlePulse = null; // interval id for document.title pulsing
      var origTitle = null;

      // panel appears when a break countdown starts
      hooks.onBreakStart(function (info) {
        if (!settings.enabled || !settings.quests) return;
        showQuestPanel(info && info.mode);
      });
      // 'timer:start' on break modes is a second, redundant trigger point per
      // spec — coalesce so we never double-render.
      on("timer:start", function (p) {
        if (!settings.enabled) return;
        if (p && (p.mode === "shortBreak" || p.mode === "longBreak")) {
          if (settings.quests && !questPanel && !activeQuest) {
            showQuestPanel(p.mode);
          }
          // returning to a break clears any pending return prompt
          clearReturn();
        }
        if (p && p.mode === "focus") {
          // any focus start dismisses the return prompt + overrun watchdog
          clearReturn();
          teardownBreakUI();
        }
      });

      // leaving break for any mode change: clean up the panel
      on("mode:change", function (p) {
        if (!p) return;
        if (p.mode === "focus") {
          clearReturn();
          teardownBreakUI();
        } else {
          // moved between break modes / reset: drop stale panel + quest
          teardownBreakUI();
        }
      });

      function breakSeconds(mode) {
        var total = 0;
        try {
          total = timer.getTotal();
        } catch (e) {}
        if (!total) {
          // fall back to remaining if total unavailable
          try {
            total = timer.getRemaining();
          } catch (e2) {}
        }
        return total || (mode === "longBreak" ? 900 : 300);
      }

      function showQuestPanel(mode) {
        teardownQuestPanel();
        var secs = breakSeconds(mode);
        var mins = Math.max(1, Math.round(secs / 60));
        questPanel = document.createElement("div");
        questPanel.className = "flow-quests glass-panel";
        questPanel.innerHTML =
          '<div class="flow-quests-head">' +
          '<span class="flow-quests-title">' +
          ui.icon("coffee", 14) +
          " Break · " +
          ui.esc(String(mins)) +
          " min</span>" +
          '<button class="btn icon-btn flow-quests-x" aria-label="Dismiss">' +
          ui.icon("x", 14) +
          "</button>" +
          "</div>" +
          '<div class="flow-quests-sub">Own the break — pick a quest.</div>' +
          '<div class="flow-quests-row">' +
          questBtn("stretch", "wind", "Stretch") +
          questBtn("breathe", "wind", "Breathe") +
          questBtn("eyes", "sun", "Rest eyes") +
          "</div>";
        document.body.appendChild(questPanel);

        questPanel
          .querySelector(".flow-quests-x")
          .addEventListener("click", teardownQuestPanel);
        questPanel
          .querySelectorAll("[data-quest]")
          .forEach(function (b) {
            b.addEventListener("click", function () {
              var q = b.getAttribute("data-quest");
              startQuest(q, secs);
            });
          });

        void questPanel.offsetWidth;
        questPanel.classList.add("show");
      }

      function questBtn(id, iconName, label) {
        return (
          '<button class="btn chip flow-quest-btn" data-quest="' +
          ui.esc(id) +
          '">' +
          ui.icon(iconName, 14) +
          "<span>" +
          ui.esc(label) +
          "</span></button>"
        );
      }

      function teardownQuestPanel() {
        if (!questPanel) return;
        var el = questPanel;
        questPanel = null;
        el.classList.remove("show");
        setTimeout(function () {
          if (el && el.parentNode) el.parentNode.removeChild(el);
        }, 300);
      }

      // ---- quest runner (shared overlay) ------------------------------
      function startQuest(kind, breakSecs) {
        cancelQuest();
        teardownQuestPanel();

        var overlay = document.createElement("div");
        overlay.className = "flow-quest-overlay";
        overlay.innerHTML =
          '<div class="flow-quest-stage">' +
          '<div class="flow-quest-visual"></div>' +
          '<div class="flow-quest-step"></div>' +
          '<div class="flow-quest-count"></div>' +
          '<div class="flow-quest-bar"><i></i></div>' +
          '<button class="btn flow-quest-cancel">End quest</button>' +
          "</div>";
        document.body.appendChild(overlay);
        void overlay.offsetWidth;
        overlay.classList.add("show");

        var stepEl = overlay.querySelector(".flow-quest-step");
        var countEl = overlay.querySelector(".flow-quest-count");
        var barEl = overlay.querySelector(".flow-quest-bar > i");
        var visual = overlay.querySelector(".flow-quest-visual");

        var timers = [];
        var tickIv = null;
        var dimmed = false;
        var ctrl = {
          cancel: function () {
            teardown(false);
          },
        };
        activeQuest = ctrl;

        overlay
          .querySelector(".flow-quest-cancel")
          .addEventListener("click", function () {
            teardown(false);
          });

        function teardown(completed) {
          timers.forEach(clearTimeout);
          if (tickIv) clearInterval(tickIv);
          if (dimmed) document.body.classList.remove("flow-dim-scene");
          if (activeQuest === ctrl) activeQuest = null;
          if (overlay) {
            overlay.classList.remove("show");
            var el = overlay;
            overlay = null;
            setTimeout(function () {
              if (el && el.parentNode) el.parentNode.removeChild(el);
            }, 320);
          }
          if (completed) {
            ui.toast(completeMsg(kind), { duration: 2600 });
            audio.playCue("unlock");
          }
        }

        function runSteps(steps, onDone) {
          var i = 0;
          function next() {
            if (!activeQuest || activeQuest !== ctrl) return;
            if (i >= steps.length) {
              onDone && onDone();
              return;
            }
            var s = steps[i];
            i++;
            stepEl.textContent = s.text;
            if (s.visual) visual.setAttribute("data-v", s.visual);
            var remain = s.secs;
            countEl.textContent = remain + "s";
            var pct = 0;
            var slice = 100 / steps.length;
            barEl.style.width = ((i - 1) * slice).toFixed(1) + "%";
            if (tickIv) clearInterval(tickIv);
            var startedAt = Date.now();
            tickIv = setInterval(function () {
              var elapsed = (Date.now() - startedAt) / 1000;
              remain = Math.max(0, Math.ceil(s.secs - elapsed));
              countEl.textContent = remain + "s";
              pct = Math.min(1, elapsed / s.secs);
              barEl.style.width = (((i - 1) + pct) * slice).toFixed(1) + "%";
              if (elapsed >= s.secs) {
                clearInterval(tickIv);
                tickIv = null;
                next();
              }
            }, 200);
          }
          next();
        }

        if (kind === "stretch") {
          runQuestStretch(breakSecs, runSteps, function () {
            teardown(true);
          });
        } else if (kind === "breathe") {
          runQuestBreathe(breakSecs, overlay, stepEl, countEl, barEl, function () {
            teardown(true);
          }, function (fn, ms) {
            var t = setTimeout(fn, ms);
            timers.push(t);
            return t;
          }, ctrl);
        } else if (kind === "eyes") {
          dimmed = true;
          document.body.classList.add("flow-dim-scene");
          runQuestEyes(breakSecs, runSteps, function () {
            teardown(true);
          });
        } else {
          teardown(false);
        }
      }

      function cancelQuest() {
        if (activeQuest) {
          try {
            activeQuest.cancel();
          } catch (e) {}
          activeQuest = null;
        }
      }

      // (a) STRETCH — guided steps, per-step countdown, sized to break length
      function runQuestStretch(breakSecs, runSteps, onDone) {
        var pool = [
          { text: "Roll your neck slowly — both ways", secs: 20 },
          { text: "Shrug your shoulders up, then release", secs: 15 },
          { text: "Circle your wrists, unclench your hands", secs: 15 },
          { text: "Stand and reach for the sky — tall", secs: 20 },
          { text: "Gentle side bend, left then right", secs: 20 },
          { text: "Twist your spine, easy and slow", secs: 15 },
        ];
        var n = breakSecs <= 240 ? 4 : breakSecs <= 480 ? 5 : 6;
        runSteps(pool.slice(0, n), onDone);
      }

      // (c) EYES — 20-20-20, gaze at the horizon, soft dim
      function runQuestEyes(breakSecs, runSteps, onDone) {
        var steps = [
          { text: "Look up — find the horizon in the scene", secs: 20 },
          { text: "Soften your focus, let the far distance blur", secs: 20 },
          { text: "Blink slowly a few times — unclench your jaw", secs: 20 },
        ];
        // longer breaks get a repeat of the gaze
        if (breakSecs > 480) {
          steps.push({ text: "One more — gaze far, breathe easy", secs: 20 });
        }
        runSteps(steps, onDone);
      }

      // (b) BREATHE — box breathing 4-4-4-4, animated ring synced to phases,
      //     cycles fitted to break duration.
      function runQuestBreathe(breakSecs, overlay, stepEl, countEl, barEl, onDone, addTimer, ctrl) {
        var visual = overlay.querySelector(".flow-quest-visual");
        visual.classList.add("flow-box");
        visual.innerHTML = '<div class="flow-box-ring"></div>';
        var ring = visual.querySelector(".flow-box-ring");

        var phases = [
          { label: "Breathe in", cls: "in", secs: 4 },
          { label: "Hold", cls: "hold-in", secs: 4 },
          { label: "Breathe out", cls: "out", secs: 4 },
          { label: "Hold", cls: "hold-out", secs: 4 },
        ];
        var cycleSecs = 16;
        // fit whole cycles into ~85% of the break, min 2, cap 8
        var cycles = Math.max(2, Math.min(8, Math.floor((breakSecs * 0.85) / cycleSecs)));
        var totalPhases = cycles * phases.length;
        var idx = 0;

        function step() {
          if (!ctrl || activeQuest !== ctrl) return;
          if (idx >= totalPhases) {
            onDone();
            return;
          }
          var p = phases[idx % phases.length];
          var cyc = Math.floor(idx / phases.length) + 1;
          ring.setAttribute("data-phase", p.cls);
          stepEl.textContent = p.label;
          countEl.textContent = "Cycle " + cyc + " / " + cycles;
          barEl.style.width = ((idx / totalPhases) * 100).toFixed(1) + "%";
          // per-phase countdown number overlay
          var remain = p.secs;
          countEl.textContent = p.label + " · " + remain + "s  (cycle " + cyc + "/" + cycles + ")";
          var iv = setInterval(function () {
            remain -= 1;
            if (remain <= 0) {
              clearInterval(iv);
              return;
            }
            countEl.textContent =
              p.label + " · " + remain + "s  (cycle " + cyc + "/" + cycles + ")";
          }, 1000);
          idx++;
          addTimer(function () {
            clearInterval(iv);
            step();
          }, p.secs * 1000);
        }
        step();
      }

      function completeMsg(kind) {
        if (kind === "stretch") return "Nicely stretched. Your body thanks you.";
        if (kind === "breathe") return "Calm and centered. Well done.";
        return "Eyes rested. The scene missed you.";
      }

      // ---- THE RETURN -------------------------------------------------
      on("session:complete", function (p) {
        if (!settings.enabled) return;
        if (!p || (p.mode !== "shortBreak" && p.mode !== "longBreak")) return;
        // break countdown reached 0 — the re-entry moment.
        teardownQuestPanel();
        cancelQuest();
        // restore music level for the coming focus is handled on focus start;
        // here we just call the user gently back.
        try {
          audio.playCue("breakEnd");
        } catch (e) {}
        if (!settings.returnReminder) return;

        ui.toast("Ready? Let's go.", { duration: 3000 });
        showReturnBanner();
        startOverrunWatch();
      });

      function showReturnBanner() {
        clearReturnBanner();
        returnBanner = ui.banner(
          '<span class="flow-return-msg">Break’s done — ready when you are.</span>' +
            ' <button class="btn flow-return-go" id="flow-return-go">Start focus</button>',
          {
            id: "flow-return",
            onClick: function (e) {
              if (e && e.target && e.target.id === "flow-return-go") {
                returnToFocus();
              }
            },
          }
        );
      }

      // Mode-switch for the Return button: core exposes no switchMode() on FF,
      // so we click the existing focus mode tab in the DOM (which core wires to
      // its internal switchMode), then start the timer. Documented as the
      // sanctioned pragmatic fallback in ARCHITECTURE / task.
      function returnToFocus() {
        clearReturn();
        teardownBreakUI();
        try {
          var tab = document.querySelector('[data-mode="focus"]');
          if (tab) tab.click();
        } catch (e) {}
        // start after the mode-switch settles
        setTimeout(function () {
          try {
            timer.start();
          } catch (e) {}
        }, 30);
      }

      function startOverrunWatch() {
        stopOverrunWatch();
        // 90s after break end with no focus started -> one soft nudge.
        overrunTimer = setTimeout(function () {
          overrunTimer = null;
          if (state.mode === "focus" && state.isActive) return;
          try {
            audio.playCue("breakEnd");
          } catch (e) {}
          startTitlePulse();
        }, 90000);
      }
      function stopOverrunWatch() {
        if (overrunTimer) {
          clearTimeout(overrunTimer);
          overrunTimer = null;
        }
      }

      function startTitlePulse() {
        if (titlePulse) return;
        origTitle = document.title;
        var alt = false;
        titlePulse = setInterval(function () {
          alt = !alt;
          document.title = alt ? origTitle + " — time to return 🌸" : origTitle;
        }, 1500);
        // stop pulsing on any user interaction
        window.addEventListener("pointerdown", stopTitlePulse, { once: true });
        window.addEventListener("keydown", stopTitlePulse, { once: true });
      }
      function stopTitlePulse() {
        if (!titlePulse) return;
        clearInterval(titlePulse);
        titlePulse = null;
        if (origTitle != null) document.title = origTitle;
        window.removeEventListener("pointerdown", stopTitlePulse);
        window.removeEventListener("keydown", stopTitlePulse);
      }

      function clearReturnBanner() {
        if (returnBanner) {
          try {
            returnBanner();
          } catch (e) {}
          returnBanner = null;
        }
      }
      function clearReturn() {
        clearReturnBanner();
        stopOverrunWatch();
        stopTitlePulse();
      }
      function teardownBreakUI() {
        teardownQuestPanel();
        cancelQuest();
      }

      /* ================================================================== *
       * 3. AUDIO NARRATIVE ARC
       * ================================================================== */
      var finalStretchFired = false; // once per focus session
      var swellIv = null;
      var glowOn = false;

      on("timer:start", function (p) {
        if (!settings.enabled || !settings.audioArc) return;
        if (!p) return;
        if (p.mode === "focus") {
          finalStretchFired = false;
          stopSwell();
          try {
            audio.setVolume(settings.volume);
            audio.setPlaybackRate(1);
          } catch (e) {}
        } else if (p.mode === "shortBreak" || p.mode === "longBreak") {
          // duck to 40% of base for the break
          try {
            audio.setVolume(settings.volume * 0.4);
          } catch (e) {}
        }
      });

      on("timer:tick", function (p) {
        if (!settings.enabled || !settings.audioArc) return;
        if (!p || p.mode !== "focus") return;
        // final sprint: exactly T-120s, once per session
        if (!finalStretchFired && p.remaining === 120) {
          finalStretchFired = true;
          try {
            audio.playCue("finalStretch");
          } catch (e) {}
          swellVolume();
        }
        // subtle glow on the timer during the last 2 minutes
        if (p.remaining <= 120 && !glowOn) {
          addGlow();
        }
      });

      on("session:complete", function (p) {
        if (!settings.enabled) return;
        if (!p) return;
        if (p.mode === "focus") {
          removeGlow();
          stopSwell();
          if (settings.audioArc) {
            try {
              audio.playCue("complete");
            } catch (e) {}
            // ease volume back to base
            easeVolumeTo(settings.volume, 1500);
          }
        }
      });

      // any move away from focus clears the glow + swell (session ended)
      on("mode:change", function (p) {
        removeGlow();
        stopSwell();
        finalStretchFired = false;
      });
      on("session:abandon", function () {
        removeGlow();
        stopSwell();
      });

      function swellVolume() {
        // gently swell +15% over ~10s, cap 1.0
        stopSwell();
        var base = settings.volume;
        var target = Math.min(1, base * 1.15);
        var start = base;
        var t0 = Date.now();
        var durMs = 10000;
        swellIv = setInterval(function () {
          var k = Math.min(1, (Date.now() - t0) / durMs);
          try {
            audio.setVolume(start + (target - start) * k);
          } catch (e) {}
          if (k >= 1) {
            clearInterval(swellIv);
            swellIv = null;
          }
        }, 250);
      }
      function easeVolumeTo(target, durMs) {
        stopSwell();
        var start;
        try {
          start = audio.getVolume();
        } catch (e) {
          start = target;
        }
        var t0 = Date.now();
        swellIv = setInterval(function () {
          var k = Math.min(1, (Date.now() - t0) / durMs);
          try {
            audio.setVolume(start + (target - start) * k);
          } catch (e) {}
          if (k >= 1) {
            clearInterval(swellIv);
            swellIv = null;
          }
        }, 250);
      }
      function stopSwell() {
        if (swellIv) {
          clearInterval(swellIv);
          swellIv = null;
        }
      }

      function addGlow() {
        var el = document.getElementById("timer-display");
        if (el) {
          el.classList.add("flow-final-glow");
          glowOn = true;
        }
      }
      function removeGlow() {
        var el = document.getElementById("timer-display");
        if (el) el.classList.remove("flow-final-glow");
        glowOn = false;
      }

      /* ================================================================== *
       * DOCK BUTTON + SETTINGS SHEET
       * ================================================================== */
      if (settings.enabled) {
        ui.registerButton({
          id: "flow",
          icon: "coffee",
          title: "Flow",
          onClick: function () {
            ui.openSheet("flow");
          },
          isActive: function () {
            return false;
          },
        });
      }

      ui.registerSheet("flow", {
        render: function () {
          return (
            "<h2 class=\"flow-sheet-title\">" +
            ui.icon("coffee", 18) +
            " Flow</h2>" +
            '<p class="flow-sheet-sub">The moments around the timer — tuned to you.</p>' +
            toggleRow("ritual", "Opening ritual", "A breath before you begin") +
            toggleRow("quests", "Break quests", "Stretch, breathe, rest your eyes") +
            toggleRow("returnReminder", "Return reminder", "A gentle call back after breaks") +
            toggleRow("audioArc", "Audio arc", "Music that follows the timer") +
            '<div class="flow-vol-row">' +
            '<label for="flow-vol">Base volume</label>' +
            '<input type="range" id="flow-vol" min="0" max="100" value="' +
            Math.round(settings.volume * 100) +
            '">' +
            '<span class="flow-vol-val">' +
            Math.round(settings.volume * 100) +
            "</span>" +
            "</div>"
          );
        },
        wire: function (host) {
          host
            .querySelectorAll("[data-flow-toggle]")
            .forEach(function (el) {
              el.addEventListener("change", function () {
                var key = el.getAttribute("data-flow-toggle");
                persist(key, !!el.checked);
              });
            });
          var vol = host.querySelector("#flow-vol");
          var val = host.querySelector(".flow-vol-val");
          if (vol) {
            vol.addEventListener("input", function () {
              var v = clamp01(Number(vol.value) / 100);
              if (val) val.textContent = String(Math.round(v * 100));
              persist("volume", v);
              // live-apply while focusing (respects mute inside core)
              if (settings.audioArc && state.mode === "focus" && state.isActive) {
                try {
                  audio.setVolume(v);
                } catch (e) {}
              }
            });
          }
        },
      });

      function toggleRow(key, label, sub) {
        return (
          '<label class="flow-toggle-row">' +
          '<span class="flow-toggle-text"><b>' +
          ui.esc(label) +
          "</b><small>" +
          ui.esc(sub) +
          "</small></span>" +
          '<input type="checkbox" data-flow-toggle="' +
          ui.esc(key) +
          '" ' +
          (settings[key] ? "checked" : "") +
          "></label>"
        );
      }

      /* ------------------------------------------------------------------ *
       * Styles
       * ------------------------------------------------------------------ */
      function css() {
        return [
          /* ---- opening ritual ---- */
          ".flow-ritual{position:fixed;inset:0;z-index:500;display:flex;",
          "align-items:center;justify-content:center;background:rgba(6,8,16,0.28);",
          "backdrop-filter:blur(2px);-webkit-backdrop-filter:blur(2px);",
          "opacity:0;transition:opacity .6s ease;pointer-events:auto;}",
          ".flow-ritual.show{opacity:1;}",
          ".flow-ritual.begin{opacity:0;transition:opacity 1s ease;}",
          ".flow-ritual-stage{display:flex;flex-direction:column;align-items:center;gap:1.4rem;}",
          ".flow-ring{width:150px;height:150px;border-radius:50%;",
          "display:flex;align-items:center;justify-content:center;text-align:center;",
          "border:2px solid rgba(255,255,255,0.55);",
          "box-shadow:0 0 40px rgba(244,63,94,0.25),inset 0 0 30px rgba(255,255,255,0.12);",
          "transition:transform 4s cubic-bezier(.37,0,.63,1),box-shadow 4s ease;",
          "transform:scale(0.72);}",
          '.flow-ring[data-phase="in"]{transform:scale(1.08);box-shadow:0 0 60px rgba(14,165,233,0.35),inset 0 0 40px rgba(255,255,255,0.18);}',
          '.flow-ring[data-phase="hold"]{transform:scale(1.08);transition:transform 2s ease;}',
          '.flow-ring[data-phase="out"]{transform:scale(0.72);box-shadow:0 0 30px rgba(139,92,246,0.28),inset 0 0 22px rgba(255,255,255,0.1);}',
          '.flow-ring[data-phase="begin"]{transform:scale(0.95);transition:transform 1s ease;}',
          ".flow-cue{font-family:'Outfit',sans-serif;font-size:1.05rem;color:#fff;",
          "letter-spacing:.02em;text-shadow:0 1px 8px rgba(0,0,0,0.5);padding:0 .5rem;}",
          ".flow-skip{font-size:.72rem;color:rgba(255,255,255,0.6);letter-spacing:.04em;}",

          /* ---- quest offer panel ---- */
          ".flow-quests{position:fixed;left:50%;transform:translateX(-50%) translateY(12px);",
          "bottom:calc(1.5rem + 168px);z-index:70;width:min(340px,calc(100vw - 24px));",
          "padding:.7rem .8rem;opacity:0;transition:opacity .3s ease,transform .3s ease;pointer-events:auto;}",
          "@media(max-width:640px){.flow-quests{bottom:calc(env(safe-area-inset-bottom) + 178px);}}",
          ".flow-quests.show{opacity:1;transform:translateX(-50%) translateY(0);}",
          ".flow-quests-head{display:flex;align-items:center;justify-content:space-between;gap:.5rem;}",
          ".flow-quests-title{display:flex;align-items:center;gap:.35rem;font-family:'Outfit',sans-serif;",
          "font-size:.9rem;color:var(--text,#fff);}",
          ".flow-quests-title svg{opacity:.8;}",
          ".flow-quests-x{flex:none;padding:.25rem;}",
          ".flow-quests-sub{font-size:.75rem;color:var(--text-muted,#9aa);margin:.15rem 0 .55rem;}",
          ".flow-quests-row{display:flex;gap:.4rem;}",
          ".flow-quest-btn{flex:1;display:flex;align-items:center;justify-content:center;gap:.3rem;",
          "font-size:.78rem;padding:.5rem .3rem;}",
          ".flow-quest-btn svg{opacity:.85;}",

          /* ---- quest overlay ---- */
          ".flow-quest-overlay{position:fixed;inset:0;z-index:480;display:flex;",
          "align-items:center;justify-content:center;background:rgba(6,8,16,0.4);",
          "backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);",
          "opacity:0;transition:opacity .32s ease;pointer-events:auto;}",
          ".flow-quest-overlay.show{opacity:1;}",
          ".flow-quest-stage{display:flex;flex-direction:column;align-items:center;gap:1rem;",
          "width:min(360px,calc(100vw - 40px));padding:1.4rem;text-align:center;}",
          ".flow-quest-visual{width:120px;height:120px;}",
          ".flow-quest-step{font-family:'Outfit',sans-serif;font-size:1.05rem;color:#fff;",
          "text-shadow:0 1px 8px rgba(0,0,0,0.5);min-height:2.4em;display:flex;align-items:center;}",
          ".flow-quest-count{font-size:.85rem;color:rgba(255,255,255,0.75);}",
          ".flow-quest-bar{width:180px;height:4px;border-radius:3px;background:rgba(255,255,255,0.16);overflow:hidden;}",
          ".flow-quest-bar>i{display:block;height:100%;width:0;background:var(--accent-short,#0ea5e9);",
          "border-radius:3px;transition:width .2s linear;}",
          ".flow-quest-cancel{margin-top:.4rem;font-size:.8rem;padding:.4rem .9rem;opacity:.85;}",

          /* box breathing visual */
          ".flow-box{display:flex;align-items:center;justify-content:center;}",
          ".flow-box-ring{width:96px;height:96px;border-radius:18px;",
          "border:2px solid rgba(255,255,255,0.55);",
          "box-shadow:0 0 30px rgba(14,165,233,0.3);transform:scale(0.7);",
          "transition:transform 4s ease,box-shadow 4s ease;}",
          '.flow-box-ring[data-phase="in"]{transform:scale(1.05);box-shadow:0 0 46px rgba(14,165,233,0.45);}',
          '.flow-box-ring[data-phase="hold-in"]{transform:scale(1.05);transition:transform 4s linear;}',
          '.flow-box-ring[data-phase="out"]{transform:scale(0.7);box-shadow:0 0 22px rgba(139,92,246,0.3);}',
          '.flow-box-ring[data-phase="hold-out"]{transform:scale(0.7);transition:transform 4s linear;}',

          /* dim the UI for eye rest (scene stays visible) */
          ".flow-dim-scene .control-panel,.flow-dim-scene .controls,",
          ".flow-dim-scene .ff-feature-dock{transition:opacity 20s ease;opacity:.25;}",

          /* ---- return banner button ---- */
          ".flow-return-go{margin-left:.4rem;padding:.3rem .7rem;font-size:.8rem;",
          "background:var(--accent-focus,#f43f5e);color:#fff;border:none;}",
          ".flow-return-msg{font-size:.85rem;}",

          /* ---- final-stretch glow on timer ---- */
          ".flow-final-glow{animation:flowGlow 2s ease-in-out infinite;}",
          "@keyframes flowGlow{0%,100%{text-shadow:0 0 6px rgba(244,63,94,0.2);}",
          "50%{text-shadow:0 0 18px rgba(244,63,94,0.55),0 0 32px rgba(244,63,94,0.3);}}",

          /* ---- settings sheet ---- */
          ".flow-sheet-title{display:flex;align-items:center;gap:.5rem;}",
          ".flow-sheet-sub{color:var(--text-muted,#9aa);font-size:.82rem;margin:-.3rem 0 1rem;}",
          ".flow-toggle-row{display:flex;align-items:center;justify-content:space-between;gap:1rem;",
          "padding:.55rem 0;border-bottom:1px solid rgba(255,255,255,0.06);cursor:pointer;}",
          ".flow-toggle-text{display:flex;flex-direction:column;}",
          ".flow-toggle-text small{color:var(--text-muted,#9aa);font-size:.72rem;}",
          '.flow-toggle-row input[type="checkbox"]{width:20px;height:20px;accent-color:var(--accent-short,#0ea5e9);flex:none;}',
          ".flow-vol-row{display:flex;align-items:center;gap:.6rem;padding:.9rem 0 .3rem;}",
          '.flow-vol-row input[type="range"]{flex:1;accent-color:var(--accent-short,#0ea5e9);}',
          ".flow-vol-val{width:2ch;text-align:right;color:var(--text-muted,#9aa);font-size:.8rem;}",

          "@media(prefers-reduced-motion:reduce){.flow-ring,.flow-box-ring{transition:none;}",
          ".flow-final-glow{animation:none;}}",
        ].join("");
      }
    },
  });
})();
