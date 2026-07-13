"use strict";
/* boot.js — must load last. Calls FF.init() once the DOM is ready. */
(function () {
  function boot() {
    if (window.FF && typeof window.FF.init === "function") {
      window.FF.init();
    } else {
      console.error("FF core not loaded — cannot boot.");
    }
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
