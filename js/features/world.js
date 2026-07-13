"use strict";
/* features/world.js — owner: world agent
 * fireflies co-presence (simulated), village co-op quest (simulated),
 * boss battles, daily montage.
 *
 * Social features are SIMULATED client-side behind the `Presence` interface
 * (getFocusingNow / getWeeklyCommunityMinutes) so a real backend can be swapped
 * in later. Counts are seeded from a deterministic PRNG (date+hour) so they stay
 * stable across re-renders, and shaped by time of day with slow drift.
 *
 * Store keys (all ff_-prefixed via FF.store):
 *   world.enabled       — master flag (default true)
 *   world.fireflies     — fireflies toggle (default true)
 *   world.coop          — { weekKey, contribMin, milestones:[...], lanternWeek }
 *   world.boss          — { name, active } | null   (armed boss, survives reload)
 *   world.trophies      — [{ name, date, durationMin }]
 *
 * Events consumed: timer:start, timer:pause, session:complete,
 *   session:finalized, session:abandon, mode:change, scene:change, app:ready.
 * Events emitted: world:bossStart {name}, world:bossEnd {name?, victory}.
 *
 * setRotationFilter ownership: owned ONLY between world:bossStart and
 * world:bossEnd; always cleared to null on bossEnd (last-set-wins, shared).
 */
(function () {
  if (!window.FF) return;

  /* ============================================================
   * Small utilities
   * ========================================================== */
  function clamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
  }
  function pad2(n) {
    return String(n).padStart(2, "0");
  }
  // mulberry32 — tiny deterministic PRNG from a 32-bit seed.
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  // Hash a string to a 32-bit int (for seeding).
  function hashStr(s) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  // ISO week key, e.g. "2026-W28". Also returns start(ms) / elapsed helpers.
  function isoWeekInfo(d) {
    d = d ? new Date(d) : new Date();
    // Copy so we don't mutate the argument.
    const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const dayNum = (date.getUTCDay() + 6) % 7; // Mon=0..Sun=6
    date.setUTCDate(date.getUTCDate() - dayNum + 3); // to Thursday
    const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
    const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
    firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
    const week =
      1 + Math.round((date - firstThursday) / (7 * 24 * 3600 * 1000));
    return {
      key: date.getUTCFullYear() + "-W" + pad2(week),
      year: date.getUTCFullYear(),
      week: week,
    };
  }
  // Monday 00:00 local of the current week (ms).
  function weekStartMs(now) {
    now = now ? new Date(now) : new Date();
    const dayNum = (now.getDay() + 6) % 7; // Mon=0
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - dayNum);
    return start.getTime();
  }
  const WEEK_MS = 7 * 24 * 3600 * 1000;

  function isSameDay(iso, ref) {
    const a = new Date(iso);
    const b = ref || new Date();
    return (
      a.getFullYear() === b.getFullYear() &&
      a.getMonth() === b.getMonth() &&
      a.getDate() === b.getDate()
    );
  }
  function fmtHM(mins) {
    mins = Math.max(0, Math.round(mins));
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    if (h && m) return h + "h " + m + "m";
    if (h) return h + "h";
    return m + "m";
  }

  /* ============================================================
   * Presence — the (simulated) co-presence backend interface.
   * Swap this object for a network-backed one later; the rest of
   * the module only calls getFocusingNow() / getWeeklyCommunityMinutes().
   * ========================================================== */
  const Presence = {
    // How many "travelers" are focusing right now. Deterministic within the
    // current hour, shaped by time of day, with a slow within-hour drift.
    getFocusingNow: function (now) {
      now = now || new Date();
      const hour = now.getHours();
      const dayKey =
        now.getFullYear() + "-" + (now.getMonth() + 1) + "-" + now.getDate();
      const rng = mulberry32(hashStr(dayKey + "|h" + hour + "|focus"));
      // Diurnal shape (0..1): quiet pre-dawn, morning bump, evening peak.
      // Peak ~1.0 around 20:00–22:00; trough ~0.12 around 04:00.
      const rad = ((hour - 3) / 24) * Math.PI * 2;
      let shape = 0.5 - 0.42 * Math.cos(rad); // 0.08..0.92 base curve
      // Evening emphasis (18–23) and morning bump (7–10).
      if (hour >= 18 && hour <= 23) shape += 0.18;
      if (hour >= 7 && hour <= 10) shape += 0.08;
      shape = clamp(shape, 0.08, 1.05);
      // Map to a plausible band: ~8 at trough, ~220 at peak.
      const LO = 8,
        HI = 220;
      const base = LO + (HI - LO) * shape;
      const jitter = (rng() - 0.5) * 22; // per-hour jitter
      // Slow within-hour drift so it's alive but never jumps on re-render.
      const frac = (now.getMinutes() * 60 + now.getSeconds()) / 3600;
      const drift = Math.sin((frac + rng()) * Math.PI * 2) * 9;
      return Math.round(clamp(base + jitter + drift, 5, 240));
    },

    // Simulated community minutes accumulated so far THIS ISO week.
    // Deterministic function of elapsed time in the week with a plausible,
    // slightly front/evening-loaded pace. Does NOT include the user.
    getWeeklyCommunityMinutes: function (now) {
      now = now || new Date();
      const wk = isoWeekInfo(now);
      const start = weekStartMs(now);
      const elapsed = clamp(now.getTime() - start, 0, WEEK_MS);
      const frac = elapsed / WEEK_MS; // 0..1 through the week
      const rng = mulberry32(hashStr(wk.key + "|community"));
      // Target pace: aim to land a bit above the weekly goal by week's end so
      // the quest is usually winnable but not trivially so. Per-week variance.
      const WEEKLY_TARGET_MIN = COOP_TARGET_HOURS * 60;
      const finalMultiplier = 0.9 + rng() * 0.5; // 0.9x..1.4x of target
      // Integrate a diurnal-ish pace so progress isn't perfectly linear:
      // sample the elapsed days and accumulate a smooth weighting.
      const days = frac * 7;
      // Smooth cumulative curve: slightly S-shaped, evenings heavier.
      const cume = smoothCumulative(days, rng);
      const mins = Math.round(WEEKLY_TARGET_MIN * finalMultiplier * cume);
      return Math.max(0, mins);
    },
  };

  // Returns 0..1 cumulative fraction of the week's community focus completed
  // by `days` (0..7). Monotonic, gently front/evening-weighted, per-week wobble.
  function smoothCumulative(days, rng) {
    const total = 7;
    const d = clamp(days, 0, total);
    // base linear + a mild sinusoidal daily ripple that nets out over a week
    const wobbleA = 0.06 * (rng() - 0.5);
    let x = d / total;
    // ease so early week is a touch slower, midweek faster
    let eased = x * x * (3 - 2 * x) * 0.55 + x * 0.45; // blend smoothstep+linear
    eased += wobbleA * Math.sin(d * Math.PI); // small ripple, 0 at endpoints
    return clamp(eased, 0, 1);
  }

  /* ============================================================
   * Config
   * ========================================================== */
  const COOP_TARGET_HOURS = 12000; // weekly village goal (hours)
  const MILESTONES = [25, 50, 75, 100];

  /* ============================================================
   * Module state (in-memory mirror of persisted state)
   * ========================================================== */
  let FFctx = null;
  let enabled = true;
  let firefliesEnabled = true;

  let coop = null; // {weekKey, contribMin, milestones:[], lanternWeek}
  let boss = null; // {name, active} | null
  let trophies = []; // [{name, date, durationMin}]

  // runtime
  let firefliesHost = null; // DOM container for firefly/lantern particles
  let firefliesActive = false;
  let legendEl = null;
  let bossBannerTimer = null;
  let bossSessionArmedThisRun = false; // this focus run IS the boss battle
  let montageOverlay = null;
  let montageTimer = null;
  let lanternActive = false;
  let currentSceneVillage = false;

  /* ============================================================
   * Persistence helpers
   * ========================================================== */
  function loadAll() {
    const S = FF.store;
    enabled = S.load("world.enabled", true) !== false;
    firefliesEnabled = S.load("world.fireflies", true) !== false;

    const wk = isoWeekInfo().key;
    let c = S.load("world.coop", null);
    if (!c || c.weekKey !== wk) {
      c = { weekKey: wk, contribMin: 0, milestones: [], lanternWeek: null };
    }
    if (!Array.isArray(c.milestones)) c.milestones = [];
    coop = c;

    boss = S.load("world.boss", null);
    if (boss && (!boss.name || typeof boss.name !== "string")) boss = null;

    trophies = S.load("world.trophies", []);
    if (!Array.isArray(trophies)) trophies = [];
  }
  function saveCoop() {
    FF.store.save("world.coop", coop);
  }
  function saveBoss() {
    FF.store.save("world.boss", boss);
  }
  function saveTrophies() {
    FF.store.save("world.trophies", trophies);
  }

  /* ============================================================
   * History-derived user stats
   * ========================================================== */
  function historySessions() {
    try {
      return FF.store.getHistory() || [];
    } catch (e) {
      return [];
    }
  }
  // User's focus minutes THIS ISO week (from history durations in seconds).
  function userWeekMinutes() {
    const start = weekStartMs();
    let sec = 0;
    historySessions().forEach(function (s) {
      if (!s || !s.date) return;
      const t = new Date(s.date).getTime();
      if (t >= start && t <= start + WEEK_MS) sec += Number(s.duration) || 0;
    });
    return Math.round(sec / 60);
  }
  // Today's finalized focus sessions (chronological).
  function todaySessions() {
    const ref = new Date();
    return historySessions().filter(function (s) {
      return s && s.date && isSameDay(s.date, ref);
    });
  }

  /* ============================================================
   * Co-op quest math
   * ========================================================== */
  function coopSnapshot() {
    // Refresh weekly rollover lazily.
    const wk = isoWeekInfo().key;
    if (coop.weekKey !== wk) {
      coop = { weekKey: wk, contribMin: 0, milestones: [], lanternWeek: null };
      saveCoop();
    }
    const userMin = userWeekMinutes();
    const userDoubled = userMin * 2; // counted DOUBLE
    coop.contribMin = userMin; // store the raw snapshot (single-counted)
    const communityMin = Presence.getWeeklyCommunityMinutes();
    const totalMin = communityMin + userDoubled;
    const targetMin = COOP_TARGET_HOURS * 60;
    const pct = clamp((totalMin / targetMin) * 100, 0, 100);
    // days remaining in the ISO week
    const now = Date.now();
    const end = weekStartMs() + WEEK_MS;
    const daysLeft = Math.max(0, Math.ceil((end - now) / (24 * 3600 * 1000)));
    return {
      userMin: userMin,
      userDoubled: userDoubled,
      communityMin: communityMin,
      totalMin: totalMin,
      targetMin: targetMin,
      pct: pct,
      daysLeft: daysLeft,
    };
  }

  const MILESTONE_COPY = {
    25: "The first lanterns are lit.",
    50: "Half the village glows.",
    75: "The festival square is bright.",
    100: "The lanterns rise — the village celebrates you.",
  };

  function checkCoopMilestones(opts) {
    opts = opts || {};
    const snap = coopSnapshot();
    let crossedTop = false;
    MILESTONES.forEach(function (m) {
      if (snap.pct >= m && coop.milestones.indexOf(m) === -1) {
        coop.milestones.push(m);
        crossedTop = true;
        if (!opts.silent) {
          try {
            FF.audio.playCue("unlock");
          } catch (e) {}
          try {
            FF.ui.confetti();
          } catch (e) {}
          FF.ui.toast(MILESTONE_COPY[m] || "The village grows brighter.", {
            duration: 3200,
          });
        }
      }
    });
    // 100% => remember lantern glow for the rest of this week
    if (snap.pct >= 100 && coop.lanternWeek !== coop.weekKey) {
      coop.lanternWeek = coop.weekKey;
    }
    saveCoop();
    updateLanternAmbient();
    return crossedTop;
  }

  /* ============================================================
   * STYLES
   * ========================================================== */
  function injectStyles() {
    FF.ui.injectStyle(
      /* particle host — above scene (z -1) but well below controls (z 20) */
      ".ff-world-particles{position:absolute;inset:0;z-index:6;pointer-events:none;overflow:hidden;}" +
        ".ff-world-particles.fade-in{animation:ff-world-fadein 3s ease forwards;}" +
        ".ff-world-particles.fade-out{animation:ff-world-fadeout 1.2s ease forwards;}" +
        "@keyframes ff-world-fadein{from{opacity:0;}to{opacity:1;}}" +
        "@keyframes ff-world-fadeout{from{opacity:1;}to{opacity:0;}}" +
        /* a single firefly */
        ".ff-fly{position:absolute;border-radius:50%;background:radial-gradient(circle," +
        "rgba(255,236,170,0.95) 0%,rgba(255,207,92,0.7) 40%,rgba(255,190,60,0) 72%);" +
        "box-shadow:0 0 6px 2px rgba(255,208,110,0.45);will-change:transform,opacity;" +
        "animation-name:ff-fly-wander,ff-fly-glow;animation-timing-function:ease-in-out,ease-in-out;" +
        "animation-iteration-count:infinite,infinite;animation-direction:alternate,alternate;}" +
        "@keyframes ff-fly-wander{0%{transform:translate(0,0);}" +
        "25%{transform:translate(var(--wx1),var(--wy1));}" +
        "50%{transform:translate(var(--wx2),var(--wy2));}" +
        "75%{transform:translate(var(--wx3),var(--wy3));}" +
        "100%{transform:translate(var(--wx4),var(--wy4));}}" +
        "@keyframes ff-fly-glow{0%{opacity:var(--opLo);}100%{opacity:var(--opHi);}}" +
        /* lanterns — larger, amber, rising */
        ".ff-lantern{position:absolute;border-radius:48% 48% 52% 52%;" +
        "background:radial-gradient(circle at 50% 40%,rgba(255,214,140,0.95) 0%," +
        "rgba(255,168,64,0.72) 45%,rgba(255,140,40,0) 78%);" +
        "box-shadow:0 0 14px 5px rgba(255,168,74,0.4);will-change:transform,opacity;" +
        "animation-name:ff-lantern-rise;animation-timing-function:linear;" +
        "animation-iteration-count:infinite;}" +
        "@keyframes ff-lantern-rise{0%{transform:translate(0,10vh) scale(0.9);opacity:0;}" +
        "12%{opacity:0.8;}88%{opacity:0.8;}100%{transform:translate(var(--lx),-14vh) scale(1.05);opacity:0;}}" +
        /* co-presence legend */
        ".ff-world-legend{position:absolute;right:14px;bottom:14px;z-index:8;" +
        "font-size:0.7rem;color:var(--text-muted);pointer-events:none;" +
        "background:rgba(15,23,42,0.35);backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);" +
        "padding:0.28rem 0.55rem;border-radius:999px;border:1px solid rgba(255,255,255,0.08);" +
        "opacity:0;transition:opacity 0.6s ease;max-width:70vw;}" +
        ".ff-world-legend.show{opacity:0.85;}" +
        "@media(max-width:640px){.ff-world-legend{bottom:calc(env(safe-area-inset-bottom) + 210px);}}" +
        /* boss banner / victory overlay */
        ".ff-boss-card{position:fixed;inset:0;z-index:340;display:flex;align-items:center;" +
        "justify-content:center;pointer-events:none;}" +
        ".ff-boss-card .inner{text-align:center;padding:1.1rem 1.6rem;border-radius:18px;" +
        "background:rgba(15,23,42,0.55);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);" +
        "border:1px solid rgba(244,63,94,0.5);box-shadow:0 0 40px rgba(244,63,94,0.35);" +
        "animation:ff-boss-in 0.4s ease,ff-boss-out 0.6s ease 1.9s forwards;max-width:88vw;}" +
        ".ff-boss-card .tag{font-size:0.72rem;letter-spacing:0.22em;color:#fb7185;font-weight:600;}" +
        ".ff-boss-card .name{font-family:var(--font-timer);font-size:1.6rem;font-weight:800;" +
        "margin-top:0.2rem;color:#fff;text-shadow:0 0 22px rgba(244,63,94,0.6);}" +
        ".ff-boss-card .sub{font-size:0.78rem;color:var(--text-muted);margin-top:0.4rem;}" +
        "@keyframes ff-boss-in{from{opacity:0;transform:scale(0.92);}to{opacity:1;transform:scale(1);}}" +
        "@keyframes ff-boss-out{to{opacity:0;transform:scale(1.02);}}" +
        /* victory variant lingers longer & tints gold */
        ".ff-boss-card.victory .inner{border-color:rgba(251,191,36,0.6);" +
        "box-shadow:0 0 46px rgba(251,191,36,0.4);animation:ff-boss-in 0.4s ease,ff-boss-out 0.7s ease 3.1s forwards;}" +
        ".ff-boss-card.victory .tag{color:#fcd34d;}" +
        ".ff-boss-card.victory .name{text-shadow:0 0 22px rgba(251,191,36,0.6);}" +
        /* boss timer glow */
        ".ff-boss-glow #timer-display,#timer-display.ff-boss-glow{text-shadow:0 0 34px rgba(244,63,94,0.75)!important;}" +
        /* world sheet bits */
        ".ff-quest-card{background:rgba(255,255,255,0.05);border-radius:14px;padding:0.85rem;margin-bottom:0.7rem;}" +
        ".ff-quest-flavor{font-size:0.86rem;margin-bottom:0.6rem;}" +
        ".ff-prog{height:10px;border-radius:999px;background:rgba(255,255,255,0.08);overflow:hidden;margin:0.5rem 0 0.35rem;}" +
        ".ff-prog>span{display:block;height:100%;border-radius:999px;" +
        "background:linear-gradient(90deg,#f59e0b,#fbbf24);transition:width 0.6s ease;}" +
        ".ff-quest-meta{display:flex;justify-content:space-between;font-size:0.76rem;color:var(--text-muted);}" +
        ".ff-you{margin-top:0.55rem;font-size:0.82rem;color:#fcd34d;}" +
        ".ff-world-entry{display:flex;align-items:center;gap:0.5rem;width:100%;justify-content:flex-start;" +
        "margin-bottom:0.7rem;background:rgba(255,255,255,0.05);}" +
        ".ff-trophy-row{display:flex;align-items:center;gap:0.5rem;padding:0.5rem 0.2rem;" +
        "border-bottom:1px solid rgba(255,255,255,0.06);font-size:0.85rem;}" +
        ".ff-trophy-row .tdate{margin-left:auto;color:var(--text-muted);font-size:0.75rem;}" +
        ".ff-dock-dot{position:relative;}" +
        ".ff-dock-dot::after{content:'';position:absolute;top:2px;right:2px;width:7px;height:7px;" +
        "border-radius:50%;background:#fbbf24;box-shadow:0 0 6px rgba(251,191,36,0.8);}" +
        /* montage overlay */
        ".ff-montage{position:fixed;inset:0;z-index:360;background:rgba(10,14,26,0.55);" +
        "display:flex;align-items:flex-end;justify-content:center;overflow:hidden;" +
        "animation:ff-world-fadein 0.4s ease;}" +
        ".ff-montage .m-card{position:relative;z-index:2;width:calc(100% - 40px);max-width:440px;" +
        "margin:0 auto max(28px,env(safe-area-inset-bottom));background:rgba(15,23,42,0.62);" +
        "backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border:1px solid rgba(255,255,255,0.12);" +
        "border-radius:20px;padding:1.2rem 1.25rem 1.4rem;text-align:center;}" +
        ".ff-montage .m-title{font-family:var(--font-timer);font-weight:800;font-size:1.25rem;line-height:1.2;}" +
        ".ff-montage .m-sub{color:var(--text-muted);font-size:0.82rem;margin-top:0.3rem;}" +
        ".ff-montage .m-stat{font-family:var(--font-timer);font-size:2.4rem;font-weight:800;margin:0.4rem 0;}" +
        ".ff-montage .m-line{font-size:0.9rem;margin:0.15rem 0;}" +
        ".ff-montage .m-x{position:absolute;top:10px;right:10px;pointer-events:auto;}" +
        ".ff-montage .m-dots{display:flex;gap:5px;justify-content:center;margin-top:0.9rem;}" +
        ".ff-montage .m-dots i{width:6px;height:6px;border-radius:50%;background:rgba(255,255,255,0.25);}" +
        ".ff-montage .m-dots i.on{background:#fbbf24;}" +
        ".ff-montage .m-save{margin-top:0.9rem;background:var(--accent-focus);border-color:transparent;pointer-events:auto;}" +
        ".ff-montage .m-hint{color:var(--text-muted);font-size:0.72rem;margin-top:0.7rem;}"
    );
  }

  /* ============================================================
   * FIREFLIES / LANTERNS ambient
   * ========================================================== */
  function ensureParticleHost() {
    const rootEl = document.getElementById("root");
    if (!rootEl) return null;
    if (firefliesHost && rootEl.contains(firefliesHost)) return firefliesHost;
    firefliesHost = document.createElement("div");
    firefliesHost.className = "ff-world-particles";
    rootEl.appendChild(firefliesHost);
    return firefliesHost;
  }

  function firefliesCount() {
    const now = Presence.getFocusingNow();
    return clamp(Math.round(now / 12), 5, 18);
  }

  function spawnFireflies() {
    if (!enabled || !firefliesEnabled) return;
    const host = ensureParticleHost();
    if (!host) return;
    // Clear any leftover fireflies (keep lanterns if lanternActive).
    clearFireflyNodes();
    firefliesActive = true;
    const n = firefliesCount();
    const rng = mulberry32(hashStr("fireflies|" + Date.now()));
    for (let i = 0; i < n; i++) {
      const f = document.createElement("div");
      f.className = "ff-fly";
      const size = (2 + rng() * 2).toFixed(1); // 2-4px
      const left = (rng() * 100).toFixed(2);
      const top = (10 + rng() * 80).toFixed(2);
      f.style.width = size + "px";
      f.style.height = size + "px";
      f.style.left = left + "%";
      f.style.top = top + "%";
      // organic wander via 4 waypoints (px offsets)
      const amp = 26 + rng() * 40;
      f.style.setProperty("--wx1", ((rng() * 2 - 1) * amp).toFixed(1) + "px");
      f.style.setProperty("--wy1", ((rng() * 2 - 1) * amp).toFixed(1) + "px");
      f.style.setProperty("--wx2", ((rng() * 2 - 1) * amp).toFixed(1) + "px");
      f.style.setProperty("--wy2", ((rng() * 2 - 1) * amp).toFixed(1) + "px");
      f.style.setProperty("--wx3", ((rng() * 2 - 1) * amp).toFixed(1) + "px");
      f.style.setProperty("--wy3", ((rng() * 2 - 1) * amp).toFixed(1) + "px");
      f.style.setProperty("--wx4", ((rng() * 2 - 1) * amp).toFixed(1) + "px");
      f.style.setProperty("--wy4", ((rng() * 2 - 1) * amp).toFixed(1) + "px");
      const opLo = (0.5 + rng() * 0.15).toFixed(2);
      const opHi = (0.65 + rng() * 0.15).toFixed(2); // <=0.8
      f.style.setProperty("--opLo", opLo);
      f.style.setProperty("--opHi", Math.min(0.8, Number(opHi)).toFixed(2));
      const wanderDur = (14 + rng() * 16).toFixed(1) + "s";
      const glowDur = (2.2 + rng() * 2.8).toFixed(1) + "s";
      f.style.animationDuration = wanderDur + "," + glowDur;
      f.style.animationDelay =
        (-rng() * 12).toFixed(1) + "s," + (-rng() * 3).toFixed(1) + "s";
      host.appendChild(f);
    }
    // fade-in over ~3s
    host.classList.remove("fade-out");
    host.classList.add("fade-in");
  }

  function clearFireflyNodes() {
    if (!firefliesHost) return;
    firefliesHost
      .querySelectorAll(".ff-fly")
      .forEach(function (n) {
        n.parentNode && n.parentNode.removeChild(n);
      });
  }

  function fadeOutFireflies() {
    firefliesActive = false;
    if (!firefliesHost) return;
    firefliesHost.classList.remove("fade-in");
    firefliesHost.classList.add("fade-out");
    setTimeout(function () {
      clearFireflyNodes();
      if (firefliesHost) firefliesHost.classList.remove("fade-out");
      // If lanterns still active, keep host & re-show at full opacity.
      if (lanternActive && firefliesHost) firefliesHost.style.opacity = "";
    }, 1300);
  }

  /* --------- lanterns (100% co-op glow on village scenes) --------- */
  function updateLanternAmbient() {
    const wantLantern =
      enabled &&
      coop &&
      coop.lanternWeek === coop.weekKey &&
      currentSceneVillage;
    if (wantLantern && !lanternActive) startLanterns();
    else if (!wantLantern && lanternActive) stopLanterns();
  }
  function startLanterns() {
    const host = ensureParticleHost();
    if (!host) return;
    lanternActive = true;
    // host must be visible even without a focus session
    host.classList.remove("fade-out");
    host.style.opacity = "1";
    spawnLanternNodes();
  }
  function spawnLanternNodes() {
    if (!firefliesHost) return;
    clearLanternNodes();
    const n = 9; // capped, subtle
    const rng = mulberry32(hashStr("lantern|" + coop.weekKey));
    for (let i = 0; i < n; i++) {
      const l = document.createElement("div");
      l.className = "ff-lantern";
      const size = (7 + rng() * 6).toFixed(1);
      l.style.width = size + "px";
      l.style.height = (Number(size) * 1.25).toFixed(1) + "px";
      l.style.left = (rng() * 100).toFixed(2) + "%";
      l.style.bottom = "-6vh";
      l.style.setProperty("--lx", ((rng() * 2 - 1) * 40).toFixed(1) + "px");
      const dur = (16 + rng() * 12).toFixed(1) + "s";
      l.style.animationDuration = dur;
      l.style.animationDelay = (-rng() * 20).toFixed(1) + "s";
      firefliesHost.appendChild(l);
    }
  }
  function clearLanternNodes() {
    if (!firefliesHost) return;
    firefliesHost.querySelectorAll(".ff-lantern").forEach(function (n) {
      n.parentNode && n.parentNode.removeChild(n);
    });
  }
  function stopLanterns() {
    lanternActive = false;
    clearLanternNodes();
    if (firefliesHost && !firefliesActive) firefliesHost.style.opacity = "";
  }

  /* --------- co-presence legend --------- */
  function showLegend() {
    if (!enabled || !firefliesEnabled) return;
    removeLegend();
    const rootEl = document.getElementById("root");
    if (!rootEl) return;
    const n = Presence.getFocusingNow();
    legendEl = document.createElement("div");
    legendEl.className = "ff-world-legend";
    legendEl.textContent = n + " travelers are focusing with you";
    rootEl.appendChild(legendEl);
    void legendEl.offsetWidth;
    legendEl.classList.add("show");
    setTimeout(function () {
      if (legendEl) legendEl.classList.remove("show");
      setTimeout(removeLegend, 700);
    }, 6000);
  }
  function removeLegend() {
    if (legendEl && legendEl.parentNode) legendEl.parentNode.removeChild(legendEl);
    legendEl = null;
  }

  /* ============================================================
   * BOSS BATTLES
   * ========================================================== */
  function isActionScene(m) {
    return m.tags && (m.tags.indexOf("action") !== -1 || m.tags.indexOf("epic") !== -1);
  }
  function applyBossFilter() {
    FF.media.setRotationFilter(isActionScene);
    const src = FF.media.pick(isActionScene);
    if (src) FF.media.setScene(src);
  }
  function challengeBoss(name) {
    name = String(name || "").trim();
    if (!name) return;
    boss = { name: name, active: true };
    saveBoss();
    FF.emit("world:bossStart", { name: name });
    applyBossFilter();
    FF.ui.toast("The duel begins when you do.", { duration: 3000 });
    if (FF.state.openSheet === "world-boss") FF.ui.closeSheet();
  }

  function showBossBanner(name, victory, sub) {
    const el = document.createElement("div");
    el.className = "ff-boss-card" + (victory ? " victory" : "");
    el.innerHTML =
      '<div class="inner">' +
      '<div class="tag">' +
      (victory ? "VICTORY" : "BOSS") +
      "</div>" +
      '<div class="name">' +
      FF.ui.esc(name) +
      "</div>" +
      (sub ? '<div class="sub">' + FF.ui.esc(sub) + "</div>" : "") +
      "</div>";
    document.body.appendChild(el);
    if (bossBannerTimer) clearTimeout(bossBannerTimer);
    const life = victory ? 4200 : 2900;
    bossBannerTimer = setTimeout(function () {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, life);
  }

  function setBossTimerGlow(on) {
    const el = document.getElementById("timer-display");
    if (el) el.classList.toggle("ff-boss-glow", !!on);
  }

  function bossVictory(session) {
    const name =
      (session && session.bossName) || (boss && boss.name) || "the duel";
    const durationMin = Math.round((Number(session && session.duration) || 0) / 60);
    // full celebration
    try {
      FF.ui.confetti();
    } catch (e) {}
    try {
      FF.audio.playCue("complete");
    } catch (e) {}
    setTimeout(function () {
      try {
        FF.audio.playCue("unlock");
      } catch (e) {}
    }, 650);
    showBossBanner(name, true, name + " falls. The path is clear.");
    trophies.push({
      name: name,
      date: new Date().toISOString(),
      durationMin: durationMin,
    });
    saveTrophies();
    // clear boss state & release the shared rotation filter
    boss = null;
    saveBoss();
    bossSessionArmedThisRun = false;
    setBossTimerGlow(false);
    FF.media.setRotationFilter(null);
    FF.emit("world:bossEnd", { name: name, victory: true });
  }

  function bossWithdraw() {
    // gentle — boss stays armed for the next session
    setBossTimerGlow(false);
    bossSessionArmedThisRun = false;
    FF.ui.toast("The ronin withdraws. The duel will wait.", { duration: 3200 });
    // Keep the action-scene filter armed while boss remains; do not clear.
  }

  /* ============================================================
   * DAILY MONTAGE
   * ========================================================== */
  function montageAvailable() {
    return todaySessions().length >= 1;
  }
  function refreshDockBadge() {
    // The dock is re-rendered by core on many actions, which strips our class,
    // so apply on a fresh microtask so it lands AFTER core's render.
    setTimeout(function () {
      const btn = document.querySelector('[data-dock-id="world-sheet"]');
      if (btn) btn.classList.toggle("ff-dock-dot", montageAvailable());
    }, 0);
  }

  function readStreak() {
    // story module MAY write story.streak; read defensively, never depend.
    try {
      const st = FF.store.load("story.streak", null);
      if (st == null) return null;
      if (typeof st === "number") return st;
      if (typeof st === "object" && typeof st.count === "number") return st.count;
    } catch (e) {}
    return null;
  }

  function buildMontageSlides() {
    const sessions = todaySessions();
    const now = new Date();
    const dayName = now.toLocaleDateString(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
    });
    const slides = [];
    // title
    slides.push({ type: "title", day: dayName });
    // one per session (max 6)
    sessions.slice(0, 6).forEach(function (s) {
      slides.push({ type: "session", s: s });
    });
    // closing totals
    let totalSec = 0,
      goalsDone = 0;
    sessions.forEach(function (s) {
      totalSec += Number(s.duration) || 0;
      if (s.goal && String(s.goal).trim()) goalsDone++;
    });
    slides.push({
      type: "closing",
      count: sessions.length,
      totalMin: Math.round(totalSec / 60),
      goalsDone: goalsDone,
      streak: readStreak(),
      day: dayName,
    });
    return slides;
  }

  function playMontage() {
    if (montageOverlay) return;
    const slides = buildMontageSlides();
    if (!slides.length) return;
    let idx = 0;
    const perSlideMs = Math.max(2200, Math.round(18000 / slides.length));

    // gentle music swell (+20%) then restore
    let restoredVol = false;
    const prevVol = FF.audio.getVolume();
    try {
      FF.audio.setVolume(Math.min(1, prevVol * 1.2));
    } catch (e) {}
    function restoreVol() {
      if (restoredVol) return;
      restoredVol = true;
      try {
        FF.audio.setVolume(prevVol);
      } catch (e) {}
    }

    montageOverlay = document.createElement("div");
    montageOverlay.className = "ff-montage";
    document.body.appendChild(montageOverlay);

    function close() {
      if (montageTimer) {
        clearTimeout(montageTimer);
        montageTimer = null;
      }
      restoreVol();
      if (montageOverlay && montageOverlay.parentNode)
        montageOverlay.parentNode.removeChild(montageOverlay);
      montageOverlay = null;
    }

    function fmtTime(iso) {
      try {
        return new Date(iso).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        });
      } catch (e) {
        return "";
      }
    }

    function renderSlide() {
      const sl = slides[idx];
      // set a backdrop scene behind the card
      if (sl.type === "session") {
        // pick a scene: prefer non-boss study/calm for variety
        const src = FF.media.pick(function (m) {
          return true;
        });
        // keep the user's live scene rotation calm — just softly change
        if (src) FF.media.setScene(src);
      }
      const dots =
        '<div class="m-dots">' +
        slides
          .map(function (_, i) {
            return '<i class="' + (i <= idx ? "on" : "") + '"></i>';
          })
          .join("") +
        "</div>";
      let body = "";
      if (sl.type === "title") {
        body =
          '<div class="m-title">Today\'s montage</div>' +
          '<div class="m-sub">' +
          FF.ui.esc(sl.day) +
          " — your day in the village</div>";
      } else if (sl.type === "session") {
        const s = sl.s;
        const dur = Math.round((Number(s.duration) || 0) / 60);
        body =
          '<div class="m-sub">' +
          FF.ui.esc(fmtTime(s.date)) +
          "</div>" +
          '<div class="m-stat">' +
          dur +
          '<span style="font-size:1rem;font-weight:600;"> min</span></div>' +
          (s.goal
            ? '<div class="m-line">' + FF.ui.esc(String(s.goal)) + "</div>"
            : '<div class="m-line muted">A quiet session</div>') +
          (s.boss
            ? '<div class="m-sub" style="color:#fcd34d;">Boss felled: ' +
              FF.ui.esc(s.bossName || "") +
              "</div>"
            : "");
      } else if (sl.type === "closing") {
        const streakLine =
          sl.streak != null
            ? '<div class="m-line">Streak: ' +
              FF.ui.esc(String(sl.streak)) +
              " day" +
              (sl.streak === 1 ? "" : "s") +
              "</div>"
            : "";
        body =
          '<div class="m-sub">' +
          FF.ui.esc(sl.day) +
          "</div>" +
          '<div class="m-stat">' +
          fmtHM(sl.totalMin) +
          "</div>" +
          '<div class="m-line">' +
          sl.count +
          " session" +
          (sl.count === 1 ? "" : "s") +
          " · " +
          sl.goalsDone +
          " goal" +
          (sl.goalsDone === 1 ? "" : "s") +
          " set</div>" +
          streakLine +
          '<button class="btn m-save" id="ff-montage-save">' +
          FF.ui.icon("camera", 16) +
          " Save summary</button>";
        // closing swell + confetti
        try {
          FF.ui.confetti();
        } catch (e) {}
      }
      montageOverlay.innerHTML =
        '<div class="m-card">' +
        '<button class="btn icon-btn m-x" id="ff-montage-x" aria-label="Close">' +
        FF.ui.icon("x", 16) +
        "</button>" +
        body +
        dots +
        '<div class="m-hint">tap to continue</div>' +
        "</div>";
      // wiring
      const xBtn = montageOverlay.querySelector("#ff-montage-x");
      if (xBtn)
        xBtn.onclick = function (e) {
          e.stopPropagation();
          close();
        };
      const saveBtn = montageOverlay.querySelector("#ff-montage-save");
      if (saveBtn)
        saveBtn.onclick = function (e) {
          e.stopPropagation();
          saveMontageSummary(slides);
        };
      // tap anywhere (except buttons) advances
      montageOverlay.onclick = function () {
        advance();
      };
      // auto-advance (closing slide does not auto-close)
      if (montageTimer) clearTimeout(montageTimer);
      if (sl.type !== "closing") {
        montageTimer = setTimeout(advance, perSlideMs);
      } else {
        restoreVol();
      }
    }

    function advance() {
      if (idx >= slides.length - 1) {
        // on closing slide, tapping does nothing further (X / save only)
        return;
      }
      idx++;
      renderSlide();
    }

    renderSlide();
  }

  /* --------- Save summary → 1080x1080 PNG --------- */
  function saveMontageSummary(slides) {
    const closing = slides[slides.length - 1] || {};
    const sessions = todaySessions();
    try {
      const size = 1080;
      const cv = document.createElement("canvas");
      cv.width = size;
      cv.height = size;
      const g = cv.getContext("2d");
      if (!g) return;
      // dark gradient bg
      const grad = g.createLinearGradient(0, 0, size, size);
      grad.addColorStop(0, "#0f172a");
      grad.addColorStop(1, "#1e1b4b");
      g.fillStyle = grad;
      g.fillRect(0, 0, size, size);
      // subtle amber glow top
      const rg = g.createRadialGradient(540, 300, 40, 540, 300, 620);
      rg.addColorStop(0, "rgba(251,191,36,0.16)");
      rg.addColorStop(1, "rgba(251,191,36,0)");
      g.fillStyle = rg;
      g.fillRect(0, 0, size, size);

      g.textAlign = "center";
      g.fillStyle = "#94a3b8";
      g.font = "600 34px Inter, system-ui, sans-serif";
      g.fillText((closing.day || "").toString(), 540, 150);

      // big total number
      g.fillStyle = "#f8fafc";
      g.font = "800 150px Outfit, Inter, sans-serif";
      g.fillText(fmtHM(closing.totalMin || 0), 540, 340);
      g.fillStyle = "#94a3b8";
      g.font = "600 34px Inter, system-ui, sans-serif";
      g.fillText("focused today", 540, 400);

      // session list
      g.textAlign = "left";
      let y = 500;
      const list = sessions.slice(0, 8);
      list.forEach(function (s) {
        const dur = Math.round((Number(s.duration) || 0) / 60);
        let t = "";
        try {
          t = new Date(s.date).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          });
        } catch (e) {}
        g.fillStyle = "#fbbf24";
        g.font = "700 30px Inter, system-ui, sans-serif";
        g.fillText(t + "  ·  " + dur + "m", 150, y);
        const goal = (s.goal ? String(s.goal) : "").slice(0, 42);
        g.fillStyle = "#e2e8f0";
        g.font = "400 30px Inter, system-ui, sans-serif";
        g.fillText(goal, 380, y);
        y += 58;
      });

      // totals line
      g.textAlign = "center";
      g.fillStyle = "#cbd5e1";
      g.font = "600 32px Inter, system-ui, sans-serif";
      g.fillText(
        (closing.count || sessions.length) +
          " sessions   ·   " +
          (closing.goalsDone || 0) +
          " goals" +
          (closing.streak != null ? "   ·   " + closing.streak + " day streak" : ""),
        540,
        Math.max(y + 40, 900)
      );

      // wordmark
      g.fillStyle = "#f43f5e";
      g.font = "800 40px Outfit, Inter, sans-serif";
      g.fillText("FunFocus", 540, 1010);

      cv.toBlob(function (blob) {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "funfocus-" + new Date().toISOString().slice(0, 10) + ".png";
        document.body.appendChild(a);
        a.click();
        setTimeout(function () {
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        }, 100);
      }, "image/png");
    } catch (e) {
      console.error("FF world: montage save failed", e);
    }
  }

  /* ============================================================
   * SHEETS
   * ========================================================== */
  function worldSheetHtml() {
    const snap = coopSnapshot();
    const pct = Math.round(snap.pct);
    const entry = montageAvailable()
      ? '<button class="btn ff-world-entry" id="ff-open-montage">' +
        FF.ui.icon("film", 16) +
        " Today's montage</button>"
      : "";
    const lanternNote =
      coop.lanternWeek === coop.weekKey
        ? '<div class="m-sub" style="color:#fcd34d;margin-top:0.3rem;">The lanterns are lit — they glow over the village until week\'s end.</div>'
        : "";
    return (
      '<button class="btn sheet-close" id="sheet-close">' +
      FF.ui.icon("x", 18) +
      "</button>" +
      "<h2>" +
      FF.ui.icon("users", 18) +
      " World</h2>" +
      entry +
      '<div class="ff-quest-card">' +
      '<div class="ff-quest-flavor">The village is raising the festival lanterns — ' +
      COOP_TARGET_HOURS.toLocaleString() +
      " hours together this week.</div>" +
      '<div class="ff-prog"><span style="width:' +
      pct +
      '%;"></span></div>' +
      '<div class="ff-quest-meta"><span>' +
      pct +
      "% complete</span><span>" +
      snap.daysLeft +
      " day" +
      (snap.daysLeft === 1 ? "" : "s") +
      " left</span></div>" +
      '<div class="ff-you">You\'ve added ' +
      fmtHM(snap.userMin) +
      " — counted twice</div>" +
      lanternNote +
      "</div>" +
      '<div class="muted" style="text-align:center;">' +
      Presence.getFocusingNow() +
      " travelers are focusing right now</div>"
    );
  }

  function bossSheetHtml() {
    const armed = boss && boss.active;
    const trophyRows = trophies.length
      ? trophies
          .slice()
          .reverse()
          .map(function (t) {
            let d = "";
            try {
              d = new Date(t.date).toLocaleDateString();
            } catch (e) {}
            return (
              '<div class="ff-trophy-row">' +
              FF.ui.icon("trophy", 15) +
              "<span>" +
              FF.ui.esc(t.name) +
              "</span>" +
              '<span class="tdate">' +
              FF.ui.esc(d) +
              " · " +
              (Number(t.durationMin) || 0) +
              "m</span></div>"
            );
          })
          .join("")
      : '<div class="muted" style="text-align:center;margin-top:0.4rem;">No duels won yet. Name what you\'ve been avoiding.</div>';

    const challengeBlock = armed
      ? '<div class="ff-quest-card"><div class="ff-quest-flavor">Armed: <strong>' +
        FF.ui.esc(boss.name) +
        "</strong></div>" +
        '<div class="m-sub">The duel begins the moment your next focus session starts.</div>' +
        '<button class="btn" id="ff-boss-standdown" style="width:100%;margin-top:0.6rem;">Stand down</button></div>'
      : '<textarea id="ff-boss-name" rows="2" placeholder="e.g. The tax return"></textarea>' +
        '<button class="btn" id="ff-boss-challenge" style="width:100%;margin-top:0.7rem;background:var(--accent-focus);border-color:transparent;">' +
        FF.ui.icon("swords", 16) +
        " Challenge</button>";

    return (
      '<button class="btn sheet-close" id="sheet-close">' +
      FF.ui.icon("x", 18) +
      "</button>" +
      "<h2>" +
      FF.ui.icon("swords", 18) +
      " Boss battle</h2>" +
      '<p class="muted" style="margin-bottom:0.6rem;">What have you been avoiding?</p>' +
      challengeBlock +
      '<h2 style="margin-top:1rem;">' +
      FF.ui.icon("trophy", 18) +
      " Trophy shelf</h2>" +
      '<div class="sheet-scroll">' +
      trophyRows +
      "</div>"
    );
  }

  function wireWorldSheet(host) {
    const q = function (s) {
      return host.querySelector(s);
    };
    const m = q("#ff-open-montage");
    if (m)
      m.onclick = function () {
        FF.ui.closeSheet();
        setTimeout(playMontage, 60);
      };
  }
  function wireBossSheet(host) {
    const q = function (s) {
      return host.querySelector(s);
    };
    const ch = q("#ff-boss-challenge");
    if (ch)
      ch.onclick = function () {
        const input = q("#ff-boss-name");
        const name = input ? input.value : "";
        if (!name || !name.trim()) {
          if (input) input.focus();
          return;
        }
        challengeBoss(name);
      };
    const input = q("#ff-boss-name");
    if (input) input.focus();
    const stand = q("#ff-boss-standdown");
    if (stand)
      stand.onclick = function () {
        boss = null;
        saveBoss();
        FF.media.setRotationFilter(null);
        FF.emit("world:bossEnd", { victory: false });
        FF.ui.toast("The duel is set aside.", { duration: 2400 });
        // re-render sheet
        FF.ui.openSheet("world-boss");
      };
  }

  /* ============================================================
   * INIT
   * ========================================================== */
  FF.registerFeature({
    id: "world",
    init: function (ctx) {
      FFctx = ctx;
      loadAll();
      if (!enabled) return; // no-op cleanly when disabled

      injectStyles();

      // dock buttons (max 2)
      FF.ui.registerButton({
        id: "world-sheet",
        icon: "users",
        title: "World",
        onClick: function () {
          FF.ui.openSheet("world-sheet");
        },
        isActive: function () {
          return FF.state.openSheet === "world-sheet";
        },
      });
      FF.ui.registerButton({
        id: "world-boss",
        icon: "swords",
        title: "Boss battle",
        onClick: function () {
          FF.ui.openSheet("world-boss");
        },
        isActive: function () {
          return (boss && boss.active) || FF.state.openSheet === "world-boss";
        },
      });

      FF.ui.registerSheet("world-sheet", {
        render: worldSheetHtml,
        wire: wireWorldSheet,
      });
      FF.ui.registerSheet("world-boss", {
        render: bossSheetHtml,
        wire: wireBossSheet,
      });

      // ---- events ----
      ctx.on("timer:start", function (p) {
        if (p && p.mode === "focus") {
          if (firefliesEnabled) {
            spawnFireflies();
            showLegend();
          }
          // boss battle: the NEXT focus session after arming
          if (boss && boss.active) {
            bossSessionArmedThisRun = true;
            // Bake extras into the record NOW — core clears pendingExtras
            // before session:finalized fires, so this must happen at start.
            try {
              FF.store.addSessionExtras({ boss: true, bossName: boss.name });
            } catch (e) {}
            // core calls render() right after emitting timer:start, which
            // rebuilds #timer-display; defer the glow so it survives.
            setTimeout(function () {
              setBossTimerGlow(true);
            }, 0);
            showBossBanner(boss.name, false, "The duel begins.");
          }
        }
      });

      // Keep the boss glow alive across core re-renders (self-healing, cheap).
      ctx.on("timer:tick", function (p) {
        if (bossSessionArmedThisRun && p && p.mode === "focus") {
          const el = document.getElementById("timer-display");
          if (el && !el.classList.contains("ff-boss-glow")) setBossTimerGlow(true);
        }
      });

      ctx.on("timer:pause", function (p) {
        if (p && p.mode === "focus") fadeOutFireflies();
      });

      ctx.on("session:complete", function (p) {
        // countdown hit 0; fireflies fade at end of the focus session
        if (p && p.mode === "focus") fadeOutFireflies();
      });

      ctx.on("session:finalized", function (p) {
        // co-op: user contribution changed
        checkCoopMilestones();
        refreshDockBadge();
        // boss victory when the finalized record carries our boss extras
        const sess = p && p.session;
        if (bossSessionArmedThisRun || (sess && sess.boss)) {
          bossVictory(sess);
        }
      });

      ctx.on("session:abandon", function (p) {
        if (p && p.mode === "focus") {
          fadeOutFireflies();
          if (bossSessionArmedThisRun) bossWithdraw();
        }
      });

      ctx.on("mode:change", function (p) {
        // leaving focus while fireflies up (e.g. switch to break): fade them
        if (p && p.mode !== "focus") fadeOutFireflies();
      });

      ctx.on("scene:change", function (p) {
        const idx = p && typeof p.index === "number" ? p.index : -1;
        const m = idx >= 0 ? FF.media.list[idx] : null;
        currentSceneVillage = !!(m && m.tags && m.tags.indexOf("village") !== -1);
        updateLanternAmbient();
      });

      // At init: detect any already-crossed co-op milestones silently, then
      // surface the current lantern/badge state. Run after app:ready so the
      // dock button is rendered.
      ctx.on("app:ready", function () {
        checkCoopMilestones({ silent: true });
        // seed currentSceneVillage from current scene
        try {
          const cur = FF.media.current();
          const m = cur ? FF.media.list[cur.index] : null;
          currentSceneVillage =
            !!(m && m.tags && m.tags.indexOf("village") !== -1);
        } catch (e) {}
        updateLanternAmbient();
        refreshDockBadge();
        // If a boss was armed before reload, re-apply its action-scene filter.
        if (boss && boss.active) applyBossFilter();
      });
    },
  });
})();
