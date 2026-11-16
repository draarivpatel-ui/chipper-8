/* A deterministic host clock. CPU instructions and 60 Hz timer edges are
 * interleaved in timestamp order, independently of display refresh rate. */
(function (root, factory) {
  var Clock = factory();
  if (typeof module === 'object' && module.exports) module.exports = Clock;
  else { root.Chipper8 = root.Chipper8 || {}; root.Chipper8.Clock = Clock; }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  function Clock() { this.reset(); }
  Clock.prototype.reset = function () { this.cyclePhase = 0; this.timerPhase = 0; };
  Clock.prototype.advance = function (seconds, hz, execute, tick) {
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 1) throw new RangeError('Clock elapsed time must be 0 to 1 second.');
    if (!Number.isFinite(hz) || hz < 1 || hz > 10000) throw new RangeError('Clock rate must be 1 to 10000 Hz.');
    var remaining = seconds, instructions = 0, ticks = 0, edges = 0;
    while (remaining > 1e-12) {
      if (++edges > 20000) throw new RangeError('Clock event budget exhausted.');
      var duration = Math.min(remaining, (1 - this.cyclePhase) / hz, (1 - this.timerPhase) / 60);
      this.cyclePhase += duration * hz; this.timerPhase += duration * 60; remaining -= duration;
      if (this.timerPhase >= 1 - 1e-9) { this.timerPhase = Math.max(0, this.timerPhase - 1); tick(); ticks++; }
      if (this.cyclePhase >= 1 - 1e-9) {
        this.cyclePhase = Math.max(0, this.cyclePhase - 1); instructions++;
        if (execute() === false) break;
      }
    }
    return { instructions: instructions, ticks: ticks };
  };
  return Clock;
});
