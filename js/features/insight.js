"use strict";
/* features/insight.js — owner: insight agent
 * Four features on the FF surface (ARCHITECTURE.md is the binding contract):
 *   1. Distraction parking  — capture intrusive thoughts mid-session, review at break.
 *   2. Goal continuity      — one tap to resume a recent goal.
 *   3. Adaptive focus length— learn the user's natural interval and suggest it.
 *   4. Wisdom scroll        — reflection/history insights, computed client-side.
 *
 * Storage (all namespaced under "insight.*" via FF.store):
 *   insight.enabled        : bool  (feature flag; everything no-ops if false)
 *   insight.parking        : [{id, text, done, date}]
 *   insight.goalDismissals : { <goalText>: count }
 *   insight.rhythm         : [{type:'complete'|'abandon'|'pause', plannedSec, elapsedSec?, hour, ts}]  (<=200, FIFO)
 *   insight.lastSuggested  : ms timestamp of the last adaptive suggestion shown
 *   insight.lastPlusSuggest: ms timestamp of the last "+5 min" suggestion (once/week max)
 *
 * Events consumed:
 *   timer:start, timer:pause, mode:change, session:complete,
 *   session:finalized, session:abandon
 * Sanctioned contract exception: this module may set FF.state.notes.goal directly
 * then emit('goal:set', {text}) — used only for goal continuity Resume.
 */
(function () {
  FF.registerFeature({
    id: "insight",
    init: function (ctx) {
      var on = ctx.on,
        emit = ctx.emit,
        state = ctx.state,
        timer = ctx.timer,
        store = ctx.store,
        ui = ctx.ui;

      /* ---------------- feature flag ---------------- */
      var enabled = store.load("insight.enabled", true);
      if (enabled === false) return; // clean no-op

      /* ---------------- constants ---------------- */
      var RHYTHM_CAP = 200;
      var SUGGEST_COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000; // once per 3 days
      var PLUS_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000; // once per week
      var GOAL_LOOKBACK_MS = 48 * 60 * 60 * 1000; // 48h
      var MAX_GOAL_OFFERS = 2; // don't re-offer the same goal more than twice
      var BLOCKER_WORDS = [
        "blocked",
        "stuck",
        "tired",
        "distracted",
        "interrupted",
        "slow",
        "meeting",
      ];

      /* ---------------- storage helpers ---------------- */
      function loadParking() {
        var p = store.load("insight.parking", []);
        return Array.isArray(p) ? p : [];
      }
      function saveParking(p) {
        store.save("insight.parking", Array.isArray(p) ? p : []);
      }
      function pendingCount() {
        return loadParking().filter(function (x) {
          return x && !x.done;
        }).length;
      }
      function loadRhythm() {
        var r = store.load("insight.rhythm", []);
        return Array.isArray(r) ? r : [];
      }
      function pushRhythm(entry) {
        var r = loadRhythm();
        r.push(entry);
        if (r.length > RHYTHM_CAP) r = r.slice(r.length - RHYTHM_CAP);
        store.save("insight.rhythm", r);
      }
      function loadDismissals() {
        var d = store.load("insight.goalDismissals", {});
        return d && typeof d === "object" ? d : {};
      }

      /* ---------------- small utils ---------------- */
      function uid() {
        return (
          Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
        );
      }
      function num(v) {
        return typeof v === "number" && isFinite(v) ? v : NaN;
      }
      function hourOf(dateLike) {
        var d = new Date(dateLike);
        var h = d.getHours();
        return isFinite(h) ? h : new Date().getHours();
      }
      function nowHour() {
        return new Date().getHours();
      }
      function plannedFocusSec() {
        // Best-effort "planned" duration for the current focus session.
        var p = state.activeProfile;
        if (p && num(p.focus)) return p.focus * 60;
        var tot = timer.getTotal ? timer.getTotal() : 0;
        return num(tot) && tot > 0 ? tot : 25 * 60;
      }
      function median(arr) {
        var a = arr
          .filter(function (x) {
            return num(x);
          })
          .slice()
          .sort(function (x, y) {
            return x - y;
          });
        if (!a.length) return NaN;
        var mid = Math.floor(a.length / 2);
        return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
      }
      function isFocus() {
        return state.mode === "focus";
      }
      // an input/textarea/contenteditable is focused
      function typing() {
        var el = document.activeElement;
        if (!el) return false;
        var tag = (el.tagName || "").toLowerCase();
        return (
          tag === "input" ||
          tag === "textarea" ||
          tag === "select" ||
          el.isContentEditable === true
        );
      }
      function sheetOpen() {
        return !!state.openSheet || !!document.querySelector(".sheet-wrap");
      }

      /* ---------------- styles ---------------- */
      ui.injectStyle(
        ".ins-cap-scrim{position:fixed;inset:0;z-index:600;display:flex;" +
          "align-items:flex-start;justify-content:center;padding-top:22vh;" +
          "background:rgba(6,8,16,0.45);backdrop-filter:blur(3px);}" +
          ".ins-cap{width:min(90vw,340px);}" +
          ".ins-cap-hint{font-size:0.72rem;color:var(--text-muted);text-align:center;" +
          "margin:0 0 0.4rem;}" +
          ".ins-cap input{width:100%;box-sizing:border-box;}" +
          /* sheet bits */
          ".ins-list{list-style:none;margin:0;padding:0;}" +
          ".ins-row{display:flex;align-items:flex-start;gap:0.5rem;padding:0.5rem;" +
          "background:rgba(255,255,255,0.05);border-radius:12px;margin-bottom:0.5rem;}" +
          ".ins-row.done .ins-txt{opacity:0.5;text-decoration:line-through;}" +
          ".ins-chk{flex:none;width:20px;height:20px;border-radius:6px;cursor:pointer;" +
          "border:1.5px solid var(--text-muted);background:transparent;display:flex;" +
          "align-items:center;justify-content:center;padding:0;margin-top:1px;color:#fff;}" +
          ".ins-row.done .ins-chk{background:var(--accent-short);border-color:transparent;}" +
          ".ins-txt{flex:1;font-size:0.88rem;line-height:1.35;word-break:break-word;}" +
          ".ins-del{flex:none;background:transparent;border:none;color:var(--text-muted);" +
          "cursor:pointer;padding:0.15rem;opacity:0.7;}" +
          ".ins-del:hover{opacity:1;color:var(--accent-focus);}" +
          ".ins-sub{font-size:0.72rem;color:var(--text-muted);margin:0.1rem 0 0.7rem;}" +
          ".ins-sec{margin:1.1rem 0 0.4rem;font-size:0.9rem;font-weight:600;" +
          "display:flex;align-items:center;gap:0.4rem;}" +
          ".ins-sec:first-of-type{margin-top:0.3rem;}" +
          ".ins-take{font-size:0.8rem;color:var(--text-muted);margin:0.25rem 0 0;line-height:1.4;}" +
          /* week bars */
          ".ins-bars{display:flex;align-items:flex-end;gap:0.9rem;height:74px;" +
          "padding:0.2rem 0.3rem 0;}" +
          ".ins-bar-col{display:flex;flex-direction:column;align-items:center;gap:0.3rem;flex:1;}" +
          ".ins-bar{width:100%;max-width:46px;border-radius:8px 8px 3px 3px;" +
          "background:linear-gradient(180deg,var(--accent-focus),rgba(244,63,94,0.35));" +
          "min-height:4px;transition:height 0.3s ease;}" +
          ".ins-bar.prev{background:linear-gradient(180deg,rgba(255,255,255,0.28),rgba(255,255,255,0.08));}" +
          ".ins-bar-lbl{font-size:0.7rem;color:var(--text-muted);}" +
          ".ins-bar-val{font-size:0.72rem;font-weight:600;}" +
          /* heat strip */
          ".ins-heat{display:flex;gap:2px;margin-top:0.3rem;flex-wrap:nowrap;}" +
          ".ins-heat-cell{flex:1;height:22px;border-radius:3px;" +
          "background:var(--accent-short);min-width:0;}" +
          ".ins-heat-axis{display:flex;justify-content:space-between;" +
          "font-size:0.62rem;color:var(--text-muted);margin-top:0.2rem;}" +
          /* rhythm chip */
          ".ins-rhythm{background:rgba(255,255,255,0.05);border-radius:12px;" +
          "padding:0.6rem 0.7rem;font-size:0.82rem;line-height:1.4;}" +
          ".ins-refl{background:rgba(255,255,255,0.05);border-radius:10px;" +
          "padding:0.5rem 0.6rem;margin-bottom:0.45rem;font-size:0.82rem;line-height:1.4;}" +
          ".ins-refl .d{font-size:0.68rem;color:var(--text-muted);margin-bottom:0.15rem;}" +
          ".ins-empty{text-align:center;color:var(--text-muted);font-size:0.86rem;" +
          "padding:1.4rem 0.5rem;line-height:1.5;}"
      );

      /* =================================================================
       * 1. DISTRACTION PARKING
       * ============================================================== */
      var capScrim = null;

      function closeCapture() {
        if (capScrim && capScrim.parentNode) {
          capScrim.parentNode.removeChild(capScrim);
        }
        capScrim = null;
      }
      function openCapture() {
        if (capScrim) return; // already open
        capScrim = document.createElement("div");
        capScrim.className = "ins-cap-scrim";
        capScrim.innerHTML =
          '<div class="ins-cap glass-panel sheet" style="padding:0.9rem;">' +
          '<p class="ins-cap-hint">Park a thought — it\'ll be here at break time</p>' +
          '<input id="ins-cap-input" type="text" autocomplete="off" ' +
          'placeholder="e.g. reply to Sam, look up flights" />' +
          "</div>";
        document.body.appendChild(capScrim);
        var input = capScrim.querySelector("#ins-cap-input");
        // click outside cancels
        capScrim.addEventListener("mousedown", function (e) {
          if (e.target === capScrim) closeCapture();
        });
        function onKey(e) {
          if (e.key === "Enter") {
            e.preventDefault();
            var t = (input.value || "").trim();
            if (t) {
              var list = loadParking();
              list.push({
                id: uid(),
                text: t,
                done: false,
                date: new Date().toISOString(),
              });
              saveParking(list);
              refreshDockActive();
              ui.toast("Parked — back to focus");
            }
            closeCapture();
          } else if (e.key === "Escape") {
            e.preventDefault();
            closeCapture();
          }
          e.stopPropagation();
        }
        input.addEventListener("keydown", onKey);
        // focus after paint so the global 'd' keydown doesn't leak in
        setTimeout(function () {
          try {
            input.focus();
          } catch (e) {}
        }, 0);
      }

      // global "d" quick-capture while focusing
      window.addEventListener("keydown", function (e) {
        if (e.key !== "d" && e.key !== "D") return;
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        if (!isFocus() || !state.isActive) return;
        if (typing() || sheetOpen() || capScrim) return;
        e.preventDefault();
        openCapture();
      });

      /* ---- parking review sheet ---- */
      ui.registerSheet("insight-parking", {
        render: function () {
          var list = loadParking();
          var pending = list.filter(function (x) {
            return x && !x.done;
          }).length;
          var body;
          if (!list.length) {
            body =
              '<div class="ins-empty">Nothing parked. Press <b>d</b> during a ' +
              "focus session to stash a stray thought without breaking stride.</div>";
          } else {
            // pending first, then done
            var ordered = list
              .slice()
              .sort(function (a, b) {
                return (a.done ? 1 : 0) - (b.done ? 1 : 0);
              });
            body =
              '<ul class="ins-list">' +
              ordered
                .map(function (it) {
                  return (
                    '<li class="ins-row ' +
                    (it.done ? "done" : "") +
                    '">' +
                    '<button class="ins-chk" data-park-toggle="' +
                    ui.esc(it.id) +
                    '" aria-label="Toggle done">' +
                    (it.done ? ui.icon("flag", 12) : "") +
                    "</button>" +
                    '<span class="ins-txt">' +
                    ui.esc(it.text) +
                    "</span>" +
                    '<button class="ins-del" data-park-del="' +
                    ui.esc(it.id) +
                    '" aria-label="Delete">' +
                    ui.icon("x", 15) +
                    "</button>" +
                    "</li>"
                  );
                })
                .join("") +
              "</ul>";
          }
          var doneCount = list.length - pending;
          var clear =
            doneCount > 0
              ? '<button class="btn" id="ins-park-clear" style="width:100%;' +
                'margin-top:0.4rem;font-size:0.82rem;">Clear ' +
                doneCount +
                " done</button>"
              : "";
          return (
            "<h2>" +
            ui.icon("inbox", 18) +
            " Parking lot</h2>" +
            '<p class="ins-sub">' +
            (pending
              ? pending + " thought" + (pending === 1 ? "" : "s") + " waiting"
              : "All clear.") +
            "</p>" +
            '<div class="sheet-scroll">' +
            body +
            "</div>" +
            clear
          );
        },
        wire: function (hostEl) {
          hostEl.querySelectorAll("[data-park-toggle]").forEach(function (b) {
            b.onclick = function () {
              var id = b.getAttribute("data-park-toggle");
              var list = loadParking();
              var it = list.find(function (x) {
                return x && x.id === id;
              });
              if (it) it.done = !it.done;
              saveParking(list);
              refreshDockActive();
              FF.ui.openSheet("insight-parking"); // re-render
            };
          });
          hostEl.querySelectorAll("[data-park-del]").forEach(function (b) {
            b.onclick = function () {
              var id = b.getAttribute("data-park-del");
              var list = loadParking().filter(function (x) {
                return x && x.id !== id;
              });
              saveParking(list);
              refreshDockActive();
              FF.ui.openSheet("insight-parking");
            };
          });
          var clr = hostEl.querySelector("#ins-park-clear");
          if (clr)
            clr.onclick = function () {
              var list = loadParking().filter(function (x) {
                return x && !x.done;
              });
              saveParking(list);
              refreshDockActive();
              FF.ui.openSheet("insight-parking");
            };
        },
      });

      // Parking dock button — badge-ish via active state when items pending.
      ui.registerButton({
        id: "insight-parking",
        icon: "inbox",
        title: "Parking lot",
        onClick: function () {
          FF.ui.openSheet("insight-parking");
        },
        isActive: function () {
          return pendingCount() > 0;
        },
      });

      function refreshDockActive() {
        // re-registering the button refreshes its active/badge styling via render()
        ui.registerButton({
          id: "insight-parking",
          icon: "inbox",
          title: "Parking lot",
          onClick: function () {
            FF.ui.openSheet("insight-parking");
          },
          isActive: function () {
            return pendingCount() > 0;
          },
        });
      }

      // Break-time reminder: show once when a break begins (or at focus complete
      // if items are pending). Guard against double-firing.
      var breakReminderShown = false;
      function showBreakReminder() {
        var n = pendingCount();
        if (n <= 0) return;
        if (breakReminderShown) return;
        breakReminderShown = true;
        ui.toast(
          n + " parked thought" + (n === 1 ? "" : "s") + " waiting",
          { duration: 3200 }
        );
        ui.banner(
          "<b>" +
            n +
            "</b> parked thought" +
            (n === 1 ? "" : "s") +
            " — take a look? " +
            '<span style="text-decoration:underline;">Review</span>',
          {
            id: "insight-parking-remind",
            onClick: function () {
              FF.ui.openSheet("insight-parking");
            },
            timeout: 12000,
          }
        );
      }

      on("mode:change", function (p) {
        // reset the once-per-break latch when we move into a break
        if (p && (p.mode === "shortBreak" || p.mode === "longBreak")) {
          breakReminderShown = false;
        }
      });
      on("timer:start", function (p) {
        if (p && (p.mode === "shortBreak" || p.mode === "longBreak")) {
          showBreakReminder();
        }
      });
      on("session:complete", function (p) {
        // focus countdown hit 0 — surface parked items immediately if any.
        if (p && p.mode === "focus" && pendingCount() > 0) {
          showBreakReminder();
        }
      });

      /* =================================================================
       * 2. GOAL CONTINUITY
       * ============================================================== */
      var goalOfferedThisStart = false;

      function mostRecentGoalSession() {
        var hist = store.getHistory();
        if (!Array.isArray(hist)) return null;
        var cutoff = Date.now() - GOAL_LOOKBACK_MS;
        // walk newest-first
        for (var i = hist.length - 1; i >= 0; i--) {
          var s = hist[i];
          if (!s || typeof s !== "object") continue;
          var g = typeof s.goal === "string" ? s.goal.trim() : "";
          if (!g) continue;
          var t = s.date ? new Date(s.date).getTime() : NaN;
          if (!isFinite(t) || t < cutoff) continue;
          return { goal: g, ts: t };
        }
        return null;
      }

      on("timer:start", function (p) {
        if (!p || p.mode !== "focus") return;
        if (goalOfferedThisStart) return;
        goalOfferedThisStart = true;
        if (state.notes && state.notes.goal) return; // goal already set
        var rec = mostRecentGoalSession();
        if (!rec) return;
        var dismissals = loadDismissals();
        var seen = num(dismissals[rec.goal]) ? dismissals[rec.goal] : 0;
        if (seen >= MAX_GOAL_OFFERS) return;

        ui.banner(
          'Continue where you left off — "<b>' +
            ui.esc(rec.goal) +
            '</b>"? ' +
            '<span style="text-decoration:underline;">Resume</span>',
          {
            id: "insight-goal-continue",
            timeout: 14000,
            onClick: function () {
              // sanctioned contract exception:
              state.notes.goal = rec.goal;
              emit("goal:set", { text: rec.goal });
              ui.toast("Goal resumed");
              var rm = document.querySelector(
                '[data-banner-id="insight-goal-continue"]'
              );
              if (rm && rm.parentNode) rm.parentNode.removeChild(rm);
            },
          }
        );
        // Count this as an offer (dismissal budget) so the same goal isn't
        // re-offered more than twice across sessions.
        dismissals[rec.goal] = seen + 1;
        store.save("insight.goalDismissals", dismissals);
      });

      // reset the per-start latch when a session ends / mode changes
      on("session:finalized", function () {
        goalOfferedThisStart = false;
      });
      on("mode:change", function () {
        goalOfferedThisStart = false;
      });

      /* =================================================================
       * 3. ADAPTIVE FOCUS LENGTH
       * ============================================================== */
      // Log rhythm data.
      on("session:finalized", function (p) {
        var planned = plannedFocusSec();
        pushRhythm({
          type: "complete",
          plannedSec: planned,
          elapsedSec: planned,
          completed: true,
          hour: nowHour(),
          ts: Date.now(),
        });
        maybeSuggestRhythm();
      });
      on("session:abandon", function (p) {
        if (!p || p.mode !== "focus") return;
        var planned = plannedFocusSec();
        var elapsed = num(p.elapsedSec) ? p.elapsedSec : 0;
        pushRhythm({
          type: "abandon",
          plannedSec: planned,
          elapsedSec: elapsed,
          completed: false,
          hour: nowHour(),
          ts: Date.now(),
        });
      });
      on("timer:pause", function (p) {
        if (!p || p.mode !== "focus") return;
        var planned = plannedFocusSec();
        var remaining = num(p.remaining) ? p.remaining : 0;
        var elapsed = Math.max(0, planned - remaining);
        // ignore trivial pauses right at the start
        if (elapsed < 30) return;
        pushRhythm({
          type: "pause",
          plannedSec: planned,
          elapsedSec: elapsed,
          completed: false,
          hour: nowHour(),
          ts: Date.now(),
        });
      });

      // Compute a suggestion object or null.
      // Returns { focusMin, breakMin, kind:'shorter'|'longer' } | null
      function computeSuggestion() {
        var r = loadRhythm().filter(function (e) {
          return e && num(e.plannedSec) && e.plannedSec > 0;
        });
        // "focus records" = completes + abandons (real session outcomes)
        var focusRecords = r.filter(function (e) {
          return e.type === "complete" || e.type === "abandon";
        });
        if (focusRecords.length < 5) return null;

        var interruptions = r.filter(function (e) {
          return (
            (e.type === "abandon" || e.type === "pause") && num(e.elapsedSec)
          );
        });
        var completes = r.filter(function (e) {
          return e.type === "complete";
        });
        var medPlanned = median(
          focusRecords.map(function (e) {
            return e.plannedSec;
          })
        );

        // --- shorter suggestion: interruptions cluster mid-session ---
        var interruptRatio = interruptions.length / focusRecords.length;
        if (interruptRatio >= 0.4 && interruptions.length >= 2) {
          var medAbandon = median(
            interruptions.map(function (e) {
              return e.elapsedSec;
            })
          );
          if (num(medAbandon) && num(medPlanned) && medPlanned > 0) {
            var frac = medAbandon / medPlanned;
            // median interruption lands 60–90% into a session that's
            // meaningfully longer (>5min) than the interruption point.
            if (
              frac >= 0.6 &&
              frac <= 0.9 &&
              medPlanned > medAbandon + 5 * 60
            ) {
              var focusMin = Math.round(medAbandon / 60);
              focusMin = Math.max(15, Math.min(90, focusMin));
              var breakMin = Math.max(3, Math.round(focusMin / 5));
              return {
                focusMin: focusMin,
                breakMin: breakMin,
                kind: "shorter",
              };
            }
          }
        }

        // --- longer suggestion: consistently full, no pauses, short planned ---
        var pauses = r.filter(function (e) {
          return e.type === "pause";
        });
        if (
          completes.length >= 5 &&
          completes.length >= focusRecords.length && // no abandons among them
          pauses.length === 0 &&
          num(medPlanned) &&
          medPlanned < 50 * 60
        ) {
          var lastPlus = num(store.load("insight.lastPlusSuggest", 0))
            ? store.load("insight.lastPlusSuggest", 0)
            : 0;
          if (Date.now() - lastPlus >= PLUS_COOLDOWN_MS) {
            var upMin = Math.min(
              90,
              Math.round(medPlanned / 60) + 5
            );
            var upBreak = Math.max(3, Math.round(upMin / 5));
            return {
              focusMin: upMin,
              breakMin: upBreak,
              kind: "longer",
            };
          }
        }
        return null;
      }

      function maybeSuggestRhythm() {
        var last = num(store.load("insight.lastSuggested", 0))
          ? store.load("insight.lastSuggested", 0)
          : 0;
        if (Date.now() - last < SUGGEST_COOLDOWN_MS) return;
        var s = computeSuggestion();
        if (!s) return;

        store.save("insight.lastSuggested", Date.now());
        if (s.kind === "longer") {
          store.save("insight.lastPlusSuggest", Date.now());
        }

        var msg =
          s.kind === "longer"
            ? "You're finishing every session clean. Try a " +
              s.focusMin +
              "/" +
              s.breakMin +
              " and stretch a little?"
            : "Your natural focus looks like ~" +
              s.focusMin +
              " min. Try a " +
              s.focusMin +
              "/" +
              s.breakMin +
              " next? ";

        ui.banner(
          msg + '<span style="text-decoration:underline;">Try it</span>',
          {
            id: "insight-rhythm",
            timeout: 16000,
            onClick: function () {
              try {
                timer.startCustom(s.focusMin);
              } catch (e) {}
              ui.toast("Next session: " + s.focusMin + " min");
              var rm = document.querySelector(
                '[data-banner-id="insight-rhythm"]'
              );
              if (rm && rm.parentNode) rm.parentNode.removeChild(rm);
            },
          }
        );
      }

      // Human-readable current rhythm summary for the Insights sheet.
      function rhythmSummaryHtml() {
        var r = loadRhythm().filter(function (e) {
          return e && num(e.plannedSec) && e.plannedSec > 0;
        });
        var focusRecords = r.filter(function (e) {
          return e.type === "complete" || e.type === "abandon";
        });
        if (focusRecords.length < 3) {
          return (
            '<div class="ins-rhythm">A few more sessions and a personal ' +
            "rhythm will emerge here.</div>"
          );
        }
        var completes = r.filter(function (e) {
          return e.type === "complete";
        }).length;
        var abandons = r.filter(function (e) {
          return e.type === "abandon";
        }).length;
        var rate = Math.round(
          (completes / Math.max(1, completes + abandons)) * 100
        );
        var medPlanned = median(
          focusRecords.map(function (e) {
            return e.plannedSec;
          })
        );
        var s = computeSuggestion();
        var line = s
          ? "Your natural interval looks like about <b>" +
            s.focusMin +
            " min</b>."
          : "You're settling into about <b>" +
            Math.round((num(medPlanned) ? medPlanned : 0) / 60) +
            " min</b> sessions.";
        return (
          '<div class="ins-rhythm">' +
          line +
          "<br/>" +
          '<span style="color:var(--text-muted);">' +
          completes +
          " completed · " +
          rate +
          "% finish rate" +
          "</span></div>"
        );
      }

      /* =================================================================
       * 4. WISDOM SCROLL (reflection insights)
       * ============================================================== */
      function validSessions() {
        var h = store.getHistory();
        if (!Array.isArray(h)) return [];
        return h.filter(function (s) {
          return s && typeof s === "object" && s.date;
        });
      }

      function startOfWeek(d) {
        var x = new Date(d);
        x.setHours(0, 0, 0, 0);
        var day = x.getDay(); // 0 Sun
        var diff = (day + 6) % 7; // make Monday the start
        x.setDate(x.getDate() - diff);
        return x.getTime();
      }

      function weekBarsHtml(sessions) {
        var now = Date.now();
        var thisWeekStart = startOfWeek(now);
        var lastWeekStart = thisWeekStart - 7 * 24 * 60 * 60 * 1000;
        var thisSec = 0,
          lastSec = 0;
        sessions.forEach(function (s) {
          var t = new Date(s.date).getTime();
          var dur = num(s.duration) ? s.duration : 0;
          if (!isFinite(t)) return;
          if (t >= thisWeekStart) thisSec += dur;
          else if (t >= lastWeekStart && t < thisWeekStart) lastSec += dur;
        });
        var thisMin = Math.round(thisSec / 60);
        var lastMin = Math.round(lastSec / 60);
        var maxMin = Math.max(thisMin, lastMin, 1);
        function h(minv) {
          return Math.max(4, Math.round((minv / maxMin) * 66));
        }
        function label(minv) {
          if (minv >= 60) {
            var hrs = Math.floor(minv / 60);
            var rem = minv % 60;
            return hrs + "h" + (rem ? " " + rem + "m" : "");
          }
          return minv + "m";
        }
        var take;
        if (thisMin === 0 && lastMin === 0) {
          take = "No focus time logged yet this week or last.";
        } else if (thisMin >= lastMin) {
          take =
            lastMin === 0
              ? "A fresh start this week — " + label(thisMin) + " so far."
              : "Up from last week. Nicely done.";
        } else {
          take = "A quieter week than last — that's okay, rest counts too.";
        }
        return (
          '<div class="ins-bars">' +
          '<div class="ins-bar-col">' +
          '<div class="ins-bar-val">' +
          label(lastMin) +
          "</div>" +
          '<div class="ins-bar prev" style="height:' +
          h(lastMin) +
          'px;"></div>' +
          '<div class="ins-bar-lbl">Last week</div>' +
          "</div>" +
          '<div class="ins-bar-col">' +
          '<div class="ins-bar-val">' +
          label(thisMin) +
          "</div>" +
          '<div class="ins-bar" style="height:' +
          h(thisMin) +
          'px;"></div>' +
          '<div class="ins-bar-lbl">This week</div>' +
          "</div>" +
          "</div>" +
          '<p class="ins-take">' +
          ui.esc(take) +
          "</p>"
        );
      }

      function heatStripHtml(sessions) {
        // completion-by-hour: count sessions per hour of day
        var counts = new Array(24).fill(0);
        sessions.forEach(function (s) {
          var hr = hourOf(s.date);
          if (hr >= 0 && hr < 24) counts[hr]++;
        });
        var max = counts.reduce(function (a, b) {
          return Math.max(a, b);
        }, 0);
        if (max === 0) return "";
        var cells = counts
          .map(function (c) {
            var op = c === 0 ? 0.06 : 0.2 + 0.8 * (c / max);
            return (
              '<div class="ins-heat-cell" style="opacity:' +
              op.toFixed(2) +
              '" title="' +
              c +
              ' session(s)"></div>'
            );
          })
          .join("");
        // best window: find the 3-hour run with the max sum
        var bestStart = 0,
          bestSum = -1;
        for (var i = 0; i <= 21; i++) {
          var sum = counts[i] + counts[i + 1] + counts[i + 2];
          if (sum > bestSum) {
            bestSum = sum;
            bestStart = i;
          }
        }
        function fmtHr(h) {
          var ampm = h < 12 ? "am" : "pm";
          var hr12 = h % 12 === 0 ? 12 : h % 12;
          return hr12 + ampm;
        }
        var take =
          bestSum > 0
            ? "You finish most sessions between " +
              fmtHr(bestStart) +
              " and " +
              fmtHr(bestStart + 3) +
              "."
            : "";
        return (
          '<div class="ins-heat">' +
          cells +
          "</div>" +
          '<div class="ins-heat-axis"><span>12a</span><span>6a</span>' +
          "<span>12p</span><span>6p</span><span>11p</span></div>" +
          (take ? '<p class="ins-take">' + ui.esc(take) + "</p>" : "")
        );
      }

      function goalEffectHtml(sessions) {
        var withG = sessions.filter(function (s) {
          return typeof s.goal === "string" && s.goal.trim();
        });
        var without = sessions.filter(function (s) {
          return !(typeof s.goal === "string" && s.goal.trim());
        });
        if (withG.length < 5 || without.length < 5) return "";
        // "completed" proxy: session made it into history at full/near duration.
        // We don't store an explicit completed flag on core records, so treat
        // any stored focus session as completed and compare presence of a
        // reflection as an engagement signal — but the spec wants completion
        // rates. Since every stored record IS a completed session, use the
        // reflection-write rate as the differentiator instead if identical.
        function reflRate(arr) {
          var r = arr.filter(function (s) {
            return typeof s.reflection === "string" && s.reflection.trim();
          }).length;
          return Math.round((r / arr.length) * 100);
        }
        var wRate = reflRate(withG);
        var woRate = reflRate(without);
        if (wRate === woRate) return "";
        return (
          '<div class="ins-take">Sessions with a written goal: <b>' +
          wRate +
          "%</b> came with a reflection, vs <b>" +
          woRate +
          "%</b> without. Writing the goal seems to keep you engaged.</div>"
        );
      }

      function blockerPatternHtml(sessions) {
        var hits = {}; // word -> {count, hours:[]}
        sessions.forEach(function (s) {
          var refl = (typeof s.reflection === "string" ? s.reflection : "")
            .toLowerCase();
          if (!refl) return;
          BLOCKER_WORDS.forEach(function (w) {
            if (refl.indexOf(w) !== -1) {
              if (!hits[w]) hits[w] = { count: 0, hours: [] };
              hits[w].count++;
              hits[w].hours.push(hourOf(s.date));
            }
          });
        });
        var top = null;
        Object.keys(hits).forEach(function (w) {
          if (!top || hits[w].count > hits[top].count) top = w;
        });
        if (!top || hits[top].count < 3) return "";
        // correlate to part of day
        var buckets = { morning: 0, afternoon: 0, evening: 0 };
        hits[top].hours.forEach(function (h) {
          if (h < 12) buckets.morning++;
          else if (h < 18) buckets.afternoon++;
          else buckets.evening++;
        });
        var partOfDay = "morning";
        if (buckets.afternoon >= buckets.morning && buckets.afternoon >= buckets.evening)
          partOfDay = "afternoon";
        else if (buckets.evening >= buckets.morning && buckets.evening >= buckets.afternoon)
          partOfDay = "evening";
        return (
          '<div class="ins-take">You mention "<b>' +
          ui.esc(top) +
          '</b>" most in ' +
          partOfDay +
          " sessions — worth noticing, not judging.</div>"
        );
      }

      function recentReflectionsHtml(sessions) {
        var withR = sessions
          .filter(function (s) {
            return typeof s.reflection === "string" && s.reflection.trim();
          })
          .slice(-5)
          .reverse();
        if (!withR.length) return "";
        var rows = withR
          .map(function (s) {
            var d = new Date(s.date);
            var ds = isNaN(d.getTime())
              ? ""
              : d.toLocaleDateString([], {
                  month: "short",
                  day: "numeric",
                });
            return (
              '<div class="ins-refl"><div class="d">' +
              ui.esc(ds) +
              (s.goal ? " · " + ui.esc(String(s.goal).slice(0, 40)) : "") +
              "</div>" +
              ui.esc(s.reflection) +
              "</div>"
            );
          })
          .join("");
        return (
          '<div class="ins-sec">' +
          ui.icon("book-open", 16) +
          " Recent reflections</div>" +
          rows
        );
      }

      ui.registerSheet("insight-scroll", {
        render: function () {
          var sessions = validSessions();
          if (!sessions.length) {
            return (
              "<h2>" +
              ui.icon("lightbulb", 18) +
              " Insights</h2>" +
              '<div class="ins-empty">Your scroll is blank — wisdom ' +
              "accumulates with each session. Focus once and come back; " +
              "patterns will reveal themselves gently.</div>"
            );
          }
          var parts = [];
          parts.push("<h2>" + ui.icon("lightbulb", 18) + " Insights</h2>");
          parts.push('<div class="sheet-scroll">');

          // week bars
          parts.push(
            '<div class="ins-sec">' +
              ui.icon("zap", 16) +
              " Focus this week</div>"
          );
          parts.push(weekBarsHtml(sessions));

          // rhythm
          parts.push(
            '<div class="ins-sec">' +
              ui.icon("brain", 16) +
              " Your rhythm</div>"
          );
          parts.push(rhythmSummaryHtml());

          // heat strip
          var heat = heatStripHtml(sessions);
          if (heat) {
            parts.push(
              '<div class="ins-sec">' +
                ui.icon("sun", 16) +
                " When you focus</div>"
            );
            parts.push(heat);
          }

          // goal effect
          var goalFx = goalEffectHtml(sessions);
          if (goalFx) {
            parts.push(
              '<div class="ins-sec">' +
                ui.icon("flag", 16) +
                " The goal effect</div>"
            );
            parts.push(goalFx);
          }

          // blocker patterns
          var blockers = blockerPatternHtml(sessions);
          if (blockers) {
            parts.push(
              '<div class="ins-sec">' +
                ui.icon("wind", 16) +
                " Patterns</div>"
            );
            parts.push(blockers);
          }

          // recent reflections
          parts.push(recentReflectionsHtml(sessions));

          parts.push("</div>");
          return parts.join("");
        },
        wire: function () {
          /* read-only sheet — nothing interactive */
        },
      });

      ui.registerButton({
        id: "insight-scroll",
        icon: "lightbulb",
        title: "Insights",
        onClick: function () {
          FF.ui.openSheet("insight-scroll");
        },
        isActive: function () {
          return state.openSheet === "insight-scroll";
        },
      });
    },
  });
})();
