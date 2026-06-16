/* Klonkt — Lenis smooth wheel scroll init (desktop only) */
(function () {
  if (typeof Lenis === "undefined") return;
  // Skip op touch/mobile — native momentum is beter dan JS lib
  var isMobile = window.matchMedia("(pointer: coarse)").matches || window.innerWidth < 1024;
  if (isMobile) return;
  var lenis = new Lenis({
    duration: 1.0,
    easing: function (t) { return Math.min(1, 1.001 - Math.pow(2, -10 * t)); },
    smoothWheel: true,
    wheelMultiplier: 1.0,
    touchMultiplier: 2.0,
  });
  function raf(time) { lenis.raf(time); requestAnimationFrame(raf); }
  requestAnimationFrame(raf);
  window.lenis = lenis;
})();
