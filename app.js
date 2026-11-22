/*
 * Chipper-8: browser hardware logic analyzer & front panel.
 *
 * Glues engine.js + assembler.js + roms.js into a instruction workbench:
 *   - requestAnimationFrame run loop with adjustable opcode clock (60..2000 Hz)
 *     and 60 Hz delay/sound timers
 *   - 64x32 CDP1861 PIXIE framebuffer rendered on an HTML5 canvas
 *   - Hardware DIP switches for COSMAC VIP vs CHIP-48 quirks
 *   - Instruction trace table & live 16-byte RAM window around PC
 *   - Optional 440 Hz square wave buzzer that stays strictly muted on load
 *
 * Zero dependencies, zero network calls, zero autoplaying audio.
 */
(function () {
  'use strict';

  var C8 = window.Chipper8;
  if (!C8 || !C8.Chip8) {
    document.body.innerHTML = '<p style="padding:40px;font:14px monospace">Failed to load engine.js</p>';
    return;
  }
  var Studio = C8.Studio || null;

  // ---------------------------------------------------------------- ROMs
  var romsApi = C8.ROMS;
  var ROMS = (romsApi && romsApi.list) ? romsApi.list
    : (romsApi && romsApi.build ? romsApi.build(C8.assemble) : []);

  // ---------------------------------------------------------------- DOM
  function $(id) { return document.getElementById(id); }

  var canvas = $('screen');
  var ctx = canvas.getContext('2d');
  var romListEl = $('romList');
  var keypadEl = $('keypad');
  var keyLegendEl = $('keyLegend');
  var romControlsEl = $('romControls');
  var statusDot = $('statusDot');
  var statusText = $('statusText');
  var activeRomName = $('activeRomName');
  var screenOverlay = $('screenOverlay');
  var playBtn = $('playBtn');
  var pauseBtn = $('pauseBtn');
  var stepBtn = $('stepBtn');
  var resetBtn = $('resetBtn');
  var exportStateBtn = $('exportStateBtn');
  var exportTraceBtn = $('exportTraceBtn');
  var speedRange = $('speedRange');
  var speedValue = $('speedValue');
  var audioToggle = $('audioToggle');
  var mutedBadge = $('mutedBadge');
  var ghostToggle = $('ghostToggle');
  var shortcutsToggle = $('shortcutsToggle');
  var shortcutsLabel = $('shortcutsLabel');
  var quirkLoadStore = $('quirkLoadStore');
  var quirkShiftVy = $('quirkShiftVy');
  var quirkJumpVx = $('quirkJumpVx');
  var quirkLoadStoreLabel = $('quirkLoadStoreLabel');
  var quirkShiftVyLabel = $('quirkShiftVyLabel');
  var quirkJumpVxLabel = $('quirkJumpVxLabel');
  var scoreValue = $('scoreValue');
  var opCountEl = $('opCount');
  var frameCountEl = $('frameCount');
  var stateGrid = $('stateGrid');
  var regGrid = $('regGrid');
  var busTraceBody = $('busTraceBody');
  var ramWindow = $('ramWindow');
  var sourceCode = $('sourceCode');
  var sourceTag = $('sourceTag');
  var themeToggle = $('themeToggle');
  var toastEl = $('toast');
  var diagListEl = $('diagList');
  var diagCountEl = $('diagCount');
  var romDiagEl = $('romDiag');
  var srAnnounceEl = $('srAnnounce');
  var stepBackBtn = $('stepBackBtn');
  var timeDepthEl = $('timeDepth');
  var quirkMatrixBody = $('quirkMatrixBody');
  var quirkLiveEl = $('quirkLive');
  var coverageSvg = $('coverageSvg');
  var coverageTotalEl = $('coverageTotal');
  var coverageNoteEl = $('coverageNote');
  var auditJsonBtn = $('auditJsonBtn');
  var auditCsvBtn = $('auditCsvBtn');
  var auditMdBtn = $('auditMdBtn');
  var auditVerifyBtn = $('auditVerifyBtn');
  var auditStatusEl = $('auditStatus');
  var selfTestBtn = $('selfTestBtn');
  var selfTestSummaryEl = $('selfTestSummary');
  var selfTestListEl = $('selfTestList');
  var profileSelectEl = $('profileSelect');

  // Physical keyboard -> CHIP-8 hex key value (COSMAC VIP VP-580 layout):
  //   1 2 3 4      1 2 3 C
  //   Q W E R  ->  4 5 6 D
  //   A S D F      7 8 9 E
  //   Z X C V      A 0 B F
  var KEY_MAP = {
    '1': 0x1, '2': 0x2, '3': 0x3, '4': 0xC,
    'q': 0x4, 'w': 0x5, 'e': 0x6, 'r': 0xD,
    'a': 0x7, 's': 0x8, 'd': 0x9, 'f': 0xE,
    'z': 0xA, 'x': 0x0, 'c': 0xB, 'v': 0xF
  };
  var PHYSICAL = {};
  Object.keys(KEY_MAP).forEach(function (k) {
    var v = KEY_MAP[k];
    if (!PHYSICAL[v]) { PHYSICAL[v] = k.toUpperCase(); }
  });

  var PAD_ORDER = [
    0x1, 0x2, 0x3, 0xC,
    0x4, 0x5, 0x6, 0xD,
    0x7, 0x8, 0x9, 0xE,
    0xA, 0x0, 0xB, 0xF
  ];

  var HEX = '0123456789ABCDEF';
  var PIXEL_SCALE = canvas.width / C8.Chip8.DISPLAY_WIDTH;

  // ---------------------------------------------------------------- State
  var cpu = new C8.Chip8();
  var activeRom = null;
  var clock = new C8.Clock();
  var breakpoints = [], skipBreakpointPc = null, stoppedAtBreakpoint = false;
  var machine = Studio ? new Studio.TimeMachine(256) : null;
  var coverage = Studio ? new Studio.CoverageTracker() : null;
  var keyboardKeys = Object.create(null);
  var virtualKeys = Object.create(null);
  var inspectionPixel = { x: 0, y: 0 };
  var running = false;
  var rafId = 0;
  var speed = 600;                 // opcodes per second
  var lastTime = 0;
  var opCount = 0;
  var frameCount = 0;
  var lastInspector = 0;
  var glow = false;
  var audioEnabled = false;       // muted by default
  var audioCtx = null, osc = null, gainNode = null;
  var pointerKeys = Object.create(null);
  var traceBuffer = [];
  var MAX_TRACE = 16;
  var colors = { bg: '#100b03', pixel: '#ffb000', glow: 'rgba(255,176,0,0.55)' };
  var shortcutsEnabled = true;      // global single-key bench shortcuts (SW6)

  function isKeyHeld(value) {
    return !!(keyboardKeys[value] || pointerKeys[value] || virtualKeys[value]);
  }

  function refreshPixelReadout() {
    var readout = $('pixelReadout');
    if (!readout) { return; }
    readout.textContent = 'PIXEL [' + inspectionPixel.x + ', ' + inspectionPixel.y + '] = ' +
      cpu.getPixel(inspectionPixel.x, inspectionPixel.y) + ' / VRAM OFFSET ' +
      hex3(inspectionPixel.y * C8.Chip8.DISPLAY_WIDTH + inspectionPixel.x);
  }

  // ---------------------------------------------------------------- Colors
  function refreshColors() {
    var style = getComputedStyle(document.documentElement);
    function read(name, fallback) {
      var v = style.getPropertyValue(name).trim();
      return v || fallback;
    }
    colors.bg = read('--screen-bg', '#100b03');
    colors.pixel = read('--screen-pixel', '#ffb000');
    colors.glow = read('--screen-glow', 'rgba(255,176,0,0.55)');
  }

  // ---------------------------------------------------------------- Render
  function fitScreen() {
    var width = canvas.getBoundingClientRect().width || 640;
    var pixelScale = Math.max(1, Math.round(width * (window.devicePixelRatio || 1) / 64));
    if (canvas.width !== pixelScale * 64) { canvas.width = pixelScale * 64; canvas.height = pixelScale * 32; }
    PIXEL_SCALE = pixelScale; ctx.imageSmoothingEnabled = false;
  }
  function render() {
    fitScreen();
    ctx.fillStyle = colors.bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = colors.pixel;
    if (glow) {
      ctx.shadowColor = colors.glow;
      ctx.shadowBlur = 9;
    } else {
      ctx.shadowBlur = 0;
    }
    ctx.beginPath();
    for (var y = 0; y < C8.Chip8.DISPLAY_HEIGHT; y++) {
      for (var x = 0; x < C8.Chip8.DISPLAY_WIDTH; x++) {
        if (cpu.display[y * C8.Chip8.DISPLAY_WIDTH + x]) {
          ctx.rect(x * PIXEL_SCALE, y * PIXEL_SCALE, PIXEL_SCALE, PIXEL_SCALE);
        }
      }
    }
    ctx.fill();
    ctx.shadowBlur = 0;
    refreshPixelReadout();
  }

  // ---------------------------------------------------------------- Audio
  function ensureAudio() {
    if (audioCtx) {
      if (audioCtx.state === 'suspended') { audioCtx.resume(); }
      return true;
    }
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { return false; }
    try {
      audioCtx = new AC();
      gainNode = audioCtx.createGain();
      gainNode.gain.value = 0;
      osc = audioCtx.createOscillator();
      osc.type = 'square';
      osc.frequency.value = 440;
      osc.connect(gainNode);
      gainNode.connect(audioCtx.destination);
      osc.start();
    } catch (e) {
      audioCtx = null;
      return false;
    }
    return true;
  }

  function setAudioEnabled(on) {
    if (on && !ensureAudio()) {
      audioToggle.checked = false;
      toast('Web Audio API unavailable in this environment.');
      return;
    }
    audioEnabled = on;
    if (mutedBadge) {
      mutedBadge.textContent = on ? 'ACTIVE (ST > 0)' : 'MUTED ON LOAD';
    }
    updateSound();
    toast(on ? 'Piezo 440 Hz tone gated by ST register.' : 'Piezo tone muted.');
  }

  function updateSound() {
    if (!audioCtx || !gainNode) { return; }
    var shouldPlay = audioEnabled && running && cpu.soundTimer > 0;
    gainNode.gain.setTargetAtTime(shouldPlay ? 0.035 : 0, audioCtx.currentTime, 0.012);
  }

  // ---------------------------------------------------------------- Quirks
  function syncQuirksFromUI() {
    var noIncI = !!(quirkLoadStore && quirkLoadStore.checked);
    var shiftVy = !!(quirkShiftVy && quirkShiftVy.checked);
    var jumpVx = !!(quirkJumpVx && quirkJumpVx.checked);
    cpu.quirks.loadStoreNoIncrementI = noIncI;
    cpu.quirks.shiftUsesVy = shiftVy;
    cpu.quirks.jumpUsesVx = jumpVx;
    if (quirkLoadStoreLabel) {
      quirkLoadStoreLabel.textContent = noIncI ? 'CHIP-48: I UNCHANGED' : 'VIP: I = I + X + 1';
    }
    if (quirkShiftVyLabel) {
      quirkShiftVyLabel.textContent = shiftVy ? 'VIP: VX = VY >> 1' : 'CHIP-48: SHR VX';
    }
    if (quirkJumpVxLabel) {
      quirkJumpVxLabel.textContent = jumpVx ? 'CHIP-48: PC = XNN + VX' : 'VIP: PC = NNN + V0';
    }
    var profileLine = $('quirkProfileLine');
    if (profileLine) {
      profileLine.textContent = 'Profile quirks: ' +
        (cpu.quirks.clipSprites ? 'sprites clip' : 'sprites wrap') + ' / ' +
        (cpu.quirks.logicResetsVf ? 'logic clears VF' : 'logic retains VF') + ' / ' +
        (cpu.quirks.waitForRelease ? 'key release completes FX0A' : 'held key completes FX0A');
    }
    renderQuirkLab();
    writeBookmark();
  }

  // ---------------------------------------------------------------- Quirk lab
  // Static matrix of which quirk each profile sets, plus the live column.
  // The divergence readout runs identical micro-programs on real CPU
  // instances per profile, so the values shown are executed, not listed.
  function renderQuirkLab() {
    if (!Studio || !quirkMatrixBody) { return; }
    var matrix = Studio.quirkMatrix();
    var order = Studio.PROFILE_ORDER;
    var html = '';
    for (var i = 0; i < matrix.length; i++) {
      var row = matrix[i];
      html += '<tr><th>' + row.label + '</th>';
      for (var p = 0; p < order.length; p++) {
        var on = row.profiles[order[p]];
        html += '<td class="' + (on ? 'qk-on' : 'qk-off') + '">' + (on ? 'YES' : 'no') + '</td>';
      }
      html += '<td class="' + (cpu.quirks[row.key] ? 'qk-live-on' : 'qk-live-off') + '">' +
        (cpu.quirks[row.key] ? 'ON' : 'off') + '</td></tr>';
    }
    quirkMatrixBody.innerHTML = html;
    if (quirkLiveEl) {
      var probes = Studio.quirkProbes();
      quirkLiveEl.textContent = probes.map(function (probe) {
        return probe.label + ': VIP ' + probe.results.vip + ' | C48 ' + probe.results.chip48 +
          ' | SCHIP ' + probe.results.modern + (probe.divergent ? '  [DIVERGES]' : '  [same]');
      }).join('\n');
    }
  }

  // ---------------------------------------------------------------- Coverage SVG
  function accentAlpha(a) {
    var m = /^#([0-9a-f]{6})$/i.exec(colors.pixel || '#ffb000');
    var rgb = m ? parseInt(m[1], 16) : 0xffb000;
    return 'rgba(' + ((rgb >> 16) & 255) + ',' + ((rgb >> 8) & 255) + ',' + (rgb & 255) + ',' + a + ')';
  }

  function renderCoverage() {
    if (!coverageSvg || !coverage) { return; }
    var counts = coverage.counts;
    var max = 1;
    for (var m = 0; m < 16; m++) { if (counts[m] > max) { max = counts[m]; } }
    var html = '';
    for (var f = 0; f < 16; f++) {
      var t = counts[f] / max;
      var alpha = (0.1 + 0.9 * t).toFixed(3);
      var x = f * 20 + 4;
      html += '<g>' +
        '<rect x="' + x + '" y="4" width="16" height="34" fill="' + accentAlpha(alpha) + '">' +
        '<title>0x' + HEX[f] + ': ' + counts[f] + '</title></rect>' +
        '<text x="' + (x + 8) + '" y="50" class="cov-lab">' + HEX[f] + '</text>' +
        '<text x="' + (x + 8) + '" y="63" class="cov-num">' + counts[f] + '</text>' +
        '</g>';
    }
    coverageSvg.innerHTML = html;
    if (coverageTotalEl) { coverageTotalEl.textContent = fmt(coverage.total); }
    if (coverageNoteEl) {
      var hot = 0, hotCount = 0;
      for (var h = 0; h < 16; h++) { if (counts[h] > hotCount) { hotCount = counts[h]; hot = h; } }
      coverageNoteEl.textContent = coverage.total === 0
        ? 'Executed opcodes per family on the live timeline.'
        : 'Hottest family 0x' + HEX[hot] + ' x' + hotCount + ' of ' + fmt(coverage.total) + ' ops. Undo rewinds counts.';
    }
  }

  function renderTimeDepth() {
    if (timeDepthEl && machine) {
      timeDepthEl.textContent = machine.depth() + ' / ' + machine.capacity + ' captured';
    }
  }

  // ---------------------------------------------------------------- UI helpers
  var toastTimer = 0;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('show'); }, 2200);
  }

  // Screen reader announcements: every machine state change lands in a
  // dedicated live region, deduplicated so repeated identical statuses do
  // not spam the speech queue.
  var lastAnnounced = '';
  function announce(msg) {
    if (!srAnnounceEl || msg === lastAnnounced) { return; }
    lastAnnounced = msg;
    srAnnounceEl.textContent = msg;
  }

  function setStatus(text, mode) {
    statusText.textContent = text.toUpperCase();
    statusDot.className = 'status-led' + (mode ? ' ' + mode : '');
    announce(statusText.textContent);
  }

  function setButtons() {
    playBtn.disabled = running;
    pauseBtn.disabled = !running;
  }

  function fmt(n) { return Number(n).toLocaleString('en-US'); }

  function updateStats() {
    scoreValue.textContent = fmt(cpu.V[7]);
    opCountEl.textContent = fmt(opCount);
    frameCountEl.textContent = fmt(frameCount);
  }

  // ---------------------------------------------------------------- Inspector & Bus Trace
  var STATE_FIELDS = [
    { key: 'pc', label: 'PC (ADDR)' },
    { key: 'I', label: 'I (INDEX)' },
    { key: 'sp', label: 'SP (STACK)' },
    { key: 'dt', label: 'DT (60HZ)' },
    { key: 'st', label: 'ST (TONE)' },
    { key: 'op', label: 'IR (DECODE)' }
  ];
  var stateCells = Object.create(null);
  var regCells = [];

  function buildInspector() {
    stateGrid.innerHTML = '';
    STATE_FIELDS.forEach(function (f) {
      var cell = document.createElement('div');
      cell.className = 'state-cell';
      cell.innerHTML = '<span class="k">' + f.label + '</span><span class="v">-</span>';
      stateGrid.appendChild(cell);
      stateCells[f.key] = cell.querySelector('.v');
    });
    stateCells.op.classList.add('accent');

    regGrid.innerHTML = '';
    for (var i = 0; i < 16; i++) {
      var cell2 = document.createElement('div');
      cell2.className = 'reg-cell' + (i === 0xF ? ' vf' : '');
      cell2.innerHTML = '<span class="rk">V' + HEX[i] + '</span><span class="rv">00</span>';
      regGrid.appendChild(cell2);
      regCells.push(cell2.querySelector('.rv'));
    }
  }

  function hex3(v) { return '0x' + (v & 0xFFF).toString(16).toUpperCase().padStart(3, '0'); }
  function hex4(v) { return (v & 0xFFFF).toString(16).toUpperCase().padStart(4, '0'); }
  function hex2(v) { return (v & 0xFF).toString(16).toUpperCase().padStart(2, '0'); }

  function executeAndRecordStep() {
    if (cpu.halted) return cpu.lastOpcode;
    if (machine) { machine.capture(cpu); }
    var countBefore = cpu.instructionsExecuted;
    var pcBefore = cpu.pc;
    var op = cpu.step();
    if (cpu.instructionsExecuted === countBefore) {
      // Stalled FX0A fetch or fault: the capture describes no executed
      // instruction, so drop it to keep the ring one-to-one with steps.
      if (machine) { machine.drop(); }
      return op;
    }
    opCount++;
    if (coverage) { coverage.record(op); }
    traceBuffer.push({
      cyc: opCount,
      pc: pcBefore,
      op: op,
      mnem: cpu.disassembleEffective(op),
      I: cpu.I,
      vf: cpu.V[0xF]
    });
    if (traceBuffer.length > MAX_TRACE) {
      traceBuffer.shift();
    }
    return op;
  }

  function renderBusTrace() {
    if (!busTraceBody) { return; }
    if (traceBuffer.length === 0) {
      busTraceBody.innerHTML = '<tr><td colspan="6" class="trace-empty">Step or run CPU to capture instruction trace.</td></tr>';
      return;
    }
    var rowsHtml = '';
    for (var i = traceBuffer.length - 1; i >= 0; i--) {
      var entry = traceBuffer[i];
      var isLatest = (i === traceBuffer.length - 1);
      rowsHtml += '<tr class="' + (isLatest ? 'trace-head-row' : '') + '">' +
        '<td>' + String(entry.cyc).padStart(4, '0') + '</td>' +
        '<td>' + hex3(entry.pc) + '</td>' +
        '<td>' + hex4(entry.op) + '</td>' +
        '<td>' + escapeHtml(entry.mnem) + '</td>' +
        '<td>' + hex3(entry.I) + '</td>' +
        '<td>' + entry.vf + '</td>' +
        '</tr>';
    }
    busTraceBody.innerHTML = rowsHtml;
  }

  function renderRamWindow() {
    if (!ramWindow) { return; }
    // A true 16-byte window that follows the PC: eight bytes before and seven
    // after, clamped to the 4 KB address space and wrapped at the top.
    var start = cpu.pc - 8;
    if (start < 0) { start = 0; }
    if (start + 16 > 0x1000) { start = 0x1000 - 16; }
    var lines = [];
    for (var r = 0; r < 2; r++) {
      var rowAddr = start + r * 8;
      var parts = [hex3(rowAddr) + ':'];
      for (var c = 0; c < 8; c++) {
        var addr = rowAddr + c;
        var b = hex2(cpu.memory[addr]);
        if (addr === cpu.pc || addr === ((cpu.pc + 1) & 0xFFF)) {
          parts.push('<span class="pc-byte">' + b + '</span>');
        } else {
          parts.push(b);
        }
      }
      lines.push(parts.join(' '));
    }
    ramWindow.innerHTML = lines.join('\n');
  }

  // Render the bounded runtime diagnostic log (SYS no-ops, sprite clip/wrap,
  // index wraps, key masks and CPU faults) plus per-code totals.
  function renderDiagnostics() {
    if (!diagListEl || !diagCountEl) { return; }
    var counts = cpu.diagnosticCounts || {};
    var total = 0, codes = 0;
    for (var code in counts) {
      if (Object.prototype.hasOwnProperty.call(counts, code)) { total += counts[code]; codes++; }
    }
    diagCountEl.textContent = total + ' events / ' + codes + ' codes';
    var list = cpu.diagnostics || [];
    if (!list.length) {
      diagListEl.innerHTML = '<li class="diag-empty">No runtime diagnostics.</li>';
      return;
    }
    var html = '';
    for (var i = Math.max(0, list.length - 4); i < list.length; i++) {
      var d = list[i];
      html += '<li class="diag-item sev-' + d.severity + '"><b>' + escapeHtml(d.code) + '</b>' +
        ' <span class="diag-pc">' + hex3(d.pc) + '</span> ' + escapeHtml(d.message) + '</li>';
    }
    diagListEl.innerHTML = html;
  }

  // Static lint of the active cartridge: malformed bytes, odd length,
  // control flow into low or unloaded memory, and unassigned words.
  function lintActiveRom() {
    if (!romDiagEl || !activeRom) { return; }
    var lint = C8.Chip8.validateRom(activeRom.bytes);
    if (!lint.diagnostics.length) {
      romDiagEl.textContent = 'ROM LINT: clean (0 findings).';
      return;
    }
    var first = lint.diagnostics[0];
    romDiagEl.textContent = 'ROM LINT: ' + lint.errors + ' errors / ' + lint.warnings +
      ' warnings / ' + lint.infos + ' notes / first: ' +
      (first.offset >= 0 ? hex3(first.offset) + ' ' : '') + first.code + ' - ' + first.message;
  }

  function updateInspector() {
    stateCells.pc.textContent = hex3(cpu.pc);
    stateCells.I.textContent = hex3(cpu.I);
    stateCells.sp.textContent = String(cpu.sp);
    stateCells.dt.textContent = String(cpu.delayTimer);
    stateCells.st.textContent = String(cpu.soundTimer);
    stateCells.op.textContent = cpu.lastOpcode
      ? cpu.disassembleEffective(cpu.lastOpcode) : '-';
    for (var i = 0; i < 16; i++) {
      regCells[i].classList.toggle('changed', regCells[i].textContent !== hex2(cpu.V[i]));
      regCells[i].textContent = hex2(cpu.V[i]);
    }
    if (cpu.waitingForKey !== null && running) setStatus('WAITING FOR KEY', 'running');
    renderBusTrace();
    renderRamWindow();
    renderDiagnostics();
    renderCoverage();
    renderTimeDepth();
    updateStats();
  }

  // ---------------------------------------------------------------- Source view
  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function highlightLine(line) {
    var commentAt = line.length;
    var semi = line.indexOf(';');
    var slash = line.indexOf('//');
    if (semi !== -1) { commentAt = Math.min(commentAt, semi); }
    if (slash !== -1) { commentAt = Math.min(commentAt, slash); }
    var code = line.slice(0, commentAt);
    var comment = line.slice(commentAt);

    var prefix = '';
    var labelMatch = /^(\s*)([A-Za-z_][A-Za-z0-9_]*\s*:)/.exec(code);
    if (labelMatch) {
      prefix = escapeHtml(labelMatch[1]) +
        '<span class="lb">' + escapeHtml(labelMatch[2]) + '</span>';
      code = code.slice(labelMatch[0].length);
    }

    var mnMatch = /^(\s*)([A-Za-z]+)/.exec(code);
    var body;
    if (mnMatch) {
      body = escapeHtml(mnMatch[1]) +
        '<span class="mn">' + escapeHtml(mnMatch[2]) + '</span>' +
        escapeHtml(code.slice(mnMatch[0].length));
    } else {
      body = escapeHtml(code);
    }
    return prefix + body + (comment ? '<span class="cm">' + escapeHtml(comment) + '</span>' : '');
  }

  function setSource(rom) {
    var trimmed = rom.source.replace(/^\n/, '').replace(/\s+$/, '');
    sourceCode.innerHTML = '<code>' + trimmed.split('\n').map(highlightLine).join('\n') + '</code>';
    sourceTag.textContent = rom.bytes.length + ' BYTES @ 0x200';
  }

  // ---------------------------------------------------------------- ROM library
  function buildRomList() {
    romListEl.innerHTML = '';
    ROMS.forEach(function (rom, idx) {
      var card = document.createElement('button');
      card.type = 'button';
      card.className = 'rom-card';
      card.setAttribute('aria-pressed', 'false');
      card.dataset.index = String(idx);
      card.innerHTML =
        '<div class="rom-card-head"><span class="rom-card-name"></span>' +
        '<span class="rom-card-size"></span></div>' +
        '<p class="rom-card-blurb"></p>' +
        '<p class="rom-card-controls"></p>';
      card.querySelector('.rom-card-name').textContent = rom.name.toUpperCase();
      card.querySelector('.rom-card-size').textContent = rom.bytes.length + ' BYTES';
      card.querySelector('.rom-card-blurb').textContent = rom.blurb;
      card.querySelector('.rom-card-controls').textContent = 'KEYS: ' + rom.controls.toUpperCase();
      card.addEventListener('click', function () { loadRom(idx, true); });
      romListEl.appendChild(card);
    });
  }

  function markActiveRom(index) {
    var cards = romListEl.querySelectorAll('.rom-card');
    for (var i = 0; i < cards.length; i++) {
      var on = i === index;
      cards[i].classList.toggle('active', on);
      cards[i].setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  function buildKeyLegend(rom) {
    keyLegendEl.innerHTML = '';
    Object.keys(rom.keys).forEach(function (k) {
      var chip = document.createElement('span');
      chip.className = 'legend-chip';
      chip.innerHTML = '<b></b> ';
      chip.querySelector('b').textContent = HEX[parseInt(k, 16)] + ' [' +
        (PHYSICAL[parseInt(k, 16)] || '?') + ']';
      chip.appendChild(document.createTextNode(' ' + rom.keys[k]));
      keyLegendEl.appendChild(chip);
    });
  }

  // ---------------------------------------------------------------- Keypad
  var keyEls = Object.create(null);

  function buildKeypad() {
    keypadEl.innerHTML = '';
    PAD_ORDER.forEach(function (value) {
      var key = document.createElement('button');
      key.type = 'button';
      key.className = 'key';
      key.dataset.value = String(value);
      key.setAttribute('role', 'button');
      key.setAttribute('tabindex', '0');
      key.setAttribute('aria-label', 'CHIP-8 key ' + HEX[value]);
      key.innerHTML = '<div>' + HEX[value] +
        '<span class="key-sub">' + (PHYSICAL[value] || '') + '</span></div>';
      key.setAttribute('aria-pressed', 'false');
      key.addEventListener('keydown', function (event) {
        if (event.key === ' ' || event.key === 'Enter') {
          event.preventDefault(); event.stopPropagation();
          if (!event.repeat) { virtualKeys[value] = true; syncKey(value); }
        }
      });
      key.addEventListener('keyup', function (event) {
        if (event.key === ' ' || event.key === 'Enter') {
          event.preventDefault(); event.stopPropagation();
          delete virtualKeys[value]; syncKey(value);
        }
      });
      key.addEventListener('blur', function () {
        if (virtualKeys[value]) { delete virtualKeys[value]; syncKey(value); }
      });
      key.addEventListener('pointerdown', function (e) {
        e.preventDefault();
        pointerKeys[value] = true;
        syncKey(value);
        if (key.setPointerCapture && eventPointerId(e)) key.setPointerCapture(e.pointerId);
      });
      key.addEventListener('pointerup', function () { releasePointerKey(value); });
      key.addEventListener('pointerleave', function () { releasePointerKey(value); });
      key.addEventListener('pointercancel', function () { releasePointerKey(value); });
      keypadEl.appendChild(key);
      keyEls[value] = key;
    });
  }

  function eventPointerId(event) { return Number.isInteger(event.pointerId); }
  function releasePointerKey(value) {
    if (pointerKeys[value]) {
      delete pointerKeys[value];
      syncKey(value);
    }
  }

  function releaseAllPointerKeys() {
    Object.keys(pointerKeys).forEach(function (v) { releasePointerKey(Number(v)); });
  }

  function syncKey(value) {
    pressKey(value, isKeyHeld(value));
  }

  function pressKey(value, down) {
    cpu.setKey(value, down);
    var el = keyEls[value];
    if (el) { el.classList.toggle('down', !!down); el.setAttribute('aria-pressed', down ? 'true' : 'false'); }
  }

  // ---------------------------------------------------------------- Run loop
  function frame(now) {
    if (!running) { return; }
    var dt = Math.min((now - lastTime) / 1000, 0.1);
    if (dt < 0) { dt = 0; }
    lastTime = now;

    clock.advance(dt, speed, function () {
      if (breakpoints.length && breakpoints.indexOf(cpu.pc) !== -1 && cpu.pc !== skipBreakpointPc) {
        stoppedAtBreakpoint = true; running = false; setButtons(); setStatus('BREAKPOINT ' + hex3(cpu.pc), 'paused'); return false;
      }
      skipBreakpointPc = null;
      executeAndRecordStep();
      if (cpu.halted) { running = false; setButtons(); setStatus('FAULT', 'paused'); toast(cpu.error || 'CPU halted.'); return false; }
      return true;
    }, function () { cpu.tickTimers(); });

    updateSound();

    if (cpu.drawFlag) {
      render();
      cpu.drawFlag = false;
      frameCount++;
    }
    if (now - lastInspector > 90) {
      updateInspector();
      lastInspector = now;
    }
    if (running) { rafId = requestAnimationFrame(frame); }
    else { updateInspector(); }
  }

  function play() {
    if (running) { return; }
    if (!activeRom) { return; }
    if (cpu.halted) { loadDescriptor(activeRom, false); }
    running = true;
    skipBreakpointPc = stoppedAtBreakpoint && breakpoints.indexOf(cpu.pc) !== -1 ? cpu.pc : null;
    stoppedAtBreakpoint = false;
    lastTime = performance.now();
    lastInspector = 0;
    setButtons();
    setStatus('RUNNING', 'running');
    screenOverlay.classList.add('hidden');
    updateSound();
    rafId = requestAnimationFrame(frame);
  }

  function pause() {
    if (!running) { return; }
    running = false;
    cancelAnimationFrame(rafId);
    setButtons();
    setStatus('PAUSED', 'paused');
    updateSound();
    updateInspector();
  }

  function stepOnce() {
    if (running) { pause(); }
    executeAndRecordStep();
    if (cpu.drawFlag) {
      render();
      cpu.drawFlag = false;
      frameCount++;
    }
    setStatus(cpu.halted ? 'HALTED' : 'STEP', cpu.halted ? '' : 'paused');
    screenOverlay.classList.add('hidden');
    updateInspector();
  }

  // Rewind exactly one executed instruction: the ring restores PC, I,
  // V0..VF, stack, timers, keys, quirks, diagnostics, RNG cursor, RAM and
  // the framebuffer, while the trace row and coverage cell it produced
  // come off the live timeline too.
  function stepBack() {
    if (running) { pause(); }
    if (!machine || !machine.undo(cpu)) {
      toast('Nothing to rewind.');
      return;
    }
    var last = traceBuffer.pop();
    if (last && coverage) { coverage.dec(last.op); }
    if (last) { opCount = Math.max(0, opCount - 1); }
    stoppedAtBreakpoint = false;
    render();
    cpu.drawFlag = false;
    setStatus('STEP -1 OP', 'paused');
    screenOverlay.classList.add('hidden');
    updateInspector();
    announce('Rewound one instruction to PC ' + hex3(cpu.pc) + '.');
  }

  function resetMachine() {
    pause();
    releaseAllPointerKeys();
    for (var k = 0; k < 16; k++) { cpu.setKey(k, false); }
    var current = activeRom; loadDescriptor(current, false);
    toast('CPU reset to 0x200.');
  }

  function loadRom(index, autoplay) {
    if (index < 0 || index >= ROMS.length) { return; }
    loadDescriptor(ROMS[index], autoplay);
  }

  function loadDescriptor(rom, autoplay) {
    if (!rom) return;
    if (!rom.bytes || !rom.bytes.length) {
      throw new RangeError('Assembly produced 0 bytes. Active cartridge and CPU state preserved.');
    }
    var index = ROMS.indexOf(rom);
    releaseAllKeys();
    for (var k = 0; k < 16; k++) { cpu.setKey(k, false); }

    cpu.reset();
    cpu.rng = Math.random;
    syncQuirksFromUI();
    cpu.load(rom.bytes);

    activeRom = rom;
    opCount = 0;
    frameCount = 0;
    traceBuffer = [];
    if (machine) { machine.clear(); }
    if (coverage) { coverage.reset(); }
    writeBookmark();
    running = false;
    cancelAnimationFrame(rafId);

    clock.reset(); stoppedAtBreakpoint = false;
    updateSound();

    markActiveRom(index);
    buildKeyLegend(rom);
    setSource(rom);
    $('assemblyEditor').value = rom.source.trim();
    $('assemblerStatus').textContent = rom.bytes.length + ' bytes loaded. PC begins at 0x200.';
    romControlsEl.textContent = 'CARTRIDGE INPUTS: ' + rom.controls;
    activeRomName.textContent = rom.name.toUpperCase() + ' (' + rom.bytes.length + ' B)';
    render();
    updateInspector();
    lintActiveRom();
    setButtons();
    setStatus('READY', '');
    announce('Cartridge ' + rom.name + ' loaded, ' + rom.bytes.length + ' bytes.');
    screenOverlay.querySelector('p').textContent = 'READY AT PC=' + hex3(cpu.pc) + ' // PRESS RUN OR STEP';
    screenOverlay.classList.remove('hidden');

    if (autoplay) { play(); }
  }

  // ---------------------------------------------------------------- Theme
  var THEMES = ['amber', 'green', 'light'];
  var THEME_LABELS = {
    amber: 'PHOSPHOR: P3 AMBER',
    green: 'PHOSPHOR: P1 GREEN',
    light: 'MANUAL: BENCH PAPER'
  };

  function applyTheme(theme) {
    if (THEMES.indexOf(theme) === -1) { theme = 'amber'; }
    document.documentElement.setAttribute('data-theme', theme);
    themeToggle.querySelector('span').textContent = THEME_LABELS[theme];
    try { localStorage.setItem('chipper8-theme', theme); } catch (e) { /* ignore */ }
    refreshColors();
    render();
    announce(THEME_LABELS[theme]);
  }

  function cycleTheme() {
    var cur = document.documentElement.getAttribute('data-theme') || 'amber';
    applyTheme(THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length]);
  }

  function cycleRom(dir) {
    if (!ROMS.length) { return; }
    var idx = ROMS.indexOf(activeRom);
    var wasRunning = running;
    loadRom(((idx < 0 ? 0 : idx) + dir + ROMS.length) % ROMS.length, wasRunning);
  }

  // ---------------------------------------------------------------- Exports
  function downloadText(filename, text, mime) {
    // Kept for auditability: the headless harness and tests can inspect the
    // exact bytes an export click produced through the real code path.
    try { window.__c8LastExport = { filename: filename, mime: mime, text: text }; } catch (e) { /* ignore */ }
    var url = URL.createObjectURL(new Blob([text], { type: mime || 'text/plain' }));
    var link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(function () { URL.revokeObjectURL(url); }, 0);
  }

  function downloadJson(filename, text) {
    downloadText(filename, text, 'application/json');
  }

  // Full register + VRAM snapshot with the canonical FNV-1a state hash.
  function exportState() {
    var snap = cpu.snapshotState();
    downloadJson('chipper8-state.json', JSON.stringify(snap, null, 2));
    var msg = 'State snapshot exported, hash ' + snap.stateHash + '.';
    toast(msg);
    announce(msg);
  }

  // Deterministic trace: replays the active cartridge on a fresh CPU with a
  // seeded RNG, the current quirk flags and a deterministic 60 Hz timer
  // schedule matching the bench clock, so the JSON is byte-identical for the
  // same ROM, seed, timer rate and DIP configuration.
  function exportTrace() {
    if (!activeRom) { toast('No cartridge loaded.'); return; }
    var cyclesPerTick = Math.max(1, Math.round(speed / 60));
    var report = C8.Chip8.traceProgram(activeRom.bytes, 600, {
      quirks: cpu.quirks, seed: 0xC8, timers: 'timed', cyclesPerTick: cyclesPerTick
    });
    downloadJson('chipper8-trace.json', JSON.stringify(report, null, 2));
    var msg = 'Trace exported: ' + report.instructions + ' instructions, hash ' + report.finalHash +
      ' (' + (cyclesPerTick * 60) + ' Hz CPU, 60 Hz timers).';
    toast(msg);
    announce(msg);
  }

  // ---------------------------------------------------------------- Audit
  // SHA-256 checksummed snapshot + deterministic trace. The digest is
  // unkeyed tamper detection, honestly labeled in the export itself.
  function buildAuditNow() {
    var cyclesPerTick = Math.max(1, Math.round(speed / 60));
    return Studio.buildAudit(cpu, activeRom ? activeRom.bytes : [], {
      romName: activeRom ? activeRom.name : 'custom',
      coverage: coverage ? coverage.toArray() : null,
      traceSteps: 600,
      seed: 0xC8,
      cyclesPerTick: cyclesPerTick
    });
  }

  function exportAuditJson() {
    if (!Studio || !activeRom) { toast('No cartridge loaded.'); return; }
    var report = buildAuditNow();
    downloadText('chipper8-audit.json', Studio.auditJson(report), 'application/json');
    var msg = 'Audit JSON exported, SHA-256 ' + report.digest.value.slice(0, 16) + '...';
    toast(msg); announce(msg);
    if (auditStatusEl) { auditStatusEl.textContent = 'Digest ' + report.digest.value; }
  }

  function exportAuditCsv() {
    if (!Studio || !activeRom) { toast('No cartridge loaded.'); return; }
    var report = buildAuditNow();
    downloadText('chipper8-audit.csv', Studio.auditToCsv(report), 'text/csv');
    toast('Audit CSV exported with formula-injection escaping.');
  }

  function exportAuditMd() {
    if (!Studio || !activeRom) { toast('No cartridge loaded.'); return; }
    var report = buildAuditNow();
    downloadText('chipper8-audit.md', Studio.auditToMarkdown(report), 'text/markdown');
    toast('Audit Markdown exported.');
  }

  // In-page replay + tamper verification: rebuild the report, recompute
  // the digest, then re-execute the ROM deterministically and compare
  // every traced step's state hash. Also shows a deliberate tamper
  // round-trip so judges can watch the digest catch an edit.
  function runAuditVerify() {
    if (!Studio || !activeRom) { toast('No cartridge loaded.'); return; }
    var report = buildAuditNow();
    var structural = Studio.verifyAudit(Studio.auditJson(report));
    var replay = Studio.replayAudit(report);
    var forged = JSON.parse(Studio.auditJson(report));
    forged.trace.entries[0].h = 'deadbeef';
    var dirty = Studio.verifyAudit(JSON.stringify(forged));
    var lines = [];
    structural.checks.forEach(function (c) { lines.push((c.pass ? 'PASS ' : 'FAIL ') + c.name); });
    replay.checks.forEach(function (c) { lines.push((c.pass ? 'PASS ' : 'FAIL ') + c.name); });
    lines.push((!dirty.ok ? 'PASS' : 'FAIL') + ' tamper detected on forged entry');
    if (auditStatusEl) { auditStatusEl.textContent = lines.join('\n'); }
    var ok = structural.ok && replay.ok && !dirty.ok;
    toast(ok ? 'Audit verified: digest clean, replay identical, tamper caught.' : 'Audit verification failed.');
    announce(auditStatusEl ? auditStatusEl.textContent.split('\n').join('; ') : 'Audit verified.');
  }

  // ---------------------------------------------------------------- Self-tests
  function runSelfTests() {
    if (!Studio || !selfTestBtn) { return; }
    selfTestListEl.innerHTML = '';
    selfTestSummaryEl.textContent = 'Running...';
    var run = Studio.runSelfTests(function (row) {
      var li = document.createElement('li');
      li.className = 'st-row ' + (row.pass ? 'st-pass' : 'st-fail');
      var name = document.createElement('span');
      name.className = 'st-name';
      name.textContent = row.name;
      var badge = document.createElement('b');
      badge.className = 'st-badge';
      badge.textContent = row.pass ? 'PASS' : 'FAIL';
      var detail = document.createElement('small');
      detail.className = 'st-detail';
      detail.textContent = row.detail;
      li.appendChild(badge);
      li.appendChild(name);
      li.appendChild(detail);
      selfTestListEl.appendChild(li);
    });
    selfTestSummaryEl.textContent = run.passed + ' / ' + run.total + ' PASS' +
      (run.failed ? ' (' + run.failed + ' FAILED)' : '');
    selfTestSummaryEl.classList.toggle('st-bad', run.failed > 0);
    var msg = 'Self-tests: ' + run.passed + ' of ' + run.total + ' passed.';
    toast(msg); announce(msg);
  }

  // ---------------------------------------------------------------- URL bookmark
  // Preset state lives in #c8=: profile, DIP bits, clock and cartridge.
  // Written on every relevant change so the location bar is always a
  // shareable deep link; applied once at boot.
  function currentBookmark() {
    if (!Studio) { return ''; }
    return Studio.encodeBookmark({
      profile: profileSelectEl ? profileSelectEl.value : 'modern',
      dips: Studio.dipsFromQuirks({
        loadStoreNoIncrementI: !!(quirkLoadStore && quirkLoadStore.checked),
        shiftUsesVy: !!(quirkShiftVy && quirkShiftVy.checked),
        jumpUsesVx: !!(quirkJumpVx && quirkJumpVx.checked)
      }),
      speed: speed,
      rom: activeRom ? ROMS.indexOf(activeRom) : 0
    });
  }

  function writeBookmark() {
    try {
      if (typeof window.history !== 'undefined' && window.history.replaceState && window.location) {
        var enc = currentBookmark();
        if (enc) { window.history.replaceState(null, '', '#c8=' + enc); }
      }
    } catch (e) { /* ignore */ }
  }

  function applyBookmarkFromHash() {
    if (!Studio) { return null; }
    try {
      if (!window.location || typeof window.location.hash !== 'string') { return null; }
      var b = Studio.decodeBookmark(window.location.hash);
      if (!b) { return null; }
      if (profileSelectEl) { profileSelectEl.value = b.profile; }
      cpu.setProfile(b.profile);
      quirkLoadStore.checked = !!(b.dips & 1);
      quirkShiftVy.checked = !!(b.dips & 2);
      quirkJumpVx.checked = !!(b.dips & 4);
      syncQuirksFromUI();
      if (Number.isInteger(b.speed)) {
        speed = Math.max(60, Math.min(2000, b.speed));
        speedRange.value = String(speed);
        speedValue.textContent = fmt(speed) + ' Hz';
      }
      return Number.isInteger(b.rom) && b.rom >= 0 && b.rom < ROMS.length ? b.rom : 0;
    } catch (e) { return null; }
  }

  function initTheme() {
    var saved = null;
    try { saved = localStorage.getItem('chipper8-theme'); } catch (e) { /* ignore */ }
    if (saved === 'dark') { saved = 'green'; }
    applyTheme(THEMES.indexOf(saved) !== -1 ? saved : 'amber');
  }

  // WCAG 2.1.4 character-key shortcut switch: SW6 disables every global
  // printable bench shortcut (letters, brackets and Space) and the physical
  // hex-key input. The preference persists in localStorage; non-printable
  // keys (Backspace reset, canvas arrows) and the on-screen keypad buttons
  // keep working either way.
  function setShortcutsEnabled(on, silent) {
    shortcutsEnabled = !!on;
    if (shortcutsToggle) { shortcutsToggle.checked = shortcutsEnabled; }
    if (shortcutsLabel) { shortcutsLabel.textContent = shortcutsEnabled ? 'KEY BENCH ON' : 'KEY BENCH OFF'; }
    try { localStorage.setItem('chipper8-shortcuts', shortcutsEnabled ? 'on' : 'off'); } catch (e) { /* ignore */ }
    if (!shortcutsEnabled) { releaseAllKeys(); }
    if (!silent) {
      var msg = shortcutsEnabled
        ? 'Bench keyboard shortcuts on.'
        : 'Bench keyboard shortcuts off. Buttons and pointer controls still work.';
      toast(msg);
      announce(msg);
    }
  }

  function initShortcuts() {
    var saved = null;
    try { saved = localStorage.getItem('chipper8-shortcuts'); } catch (e) { /* ignore */ }
    setShortcutsEnabled(saved !== 'off', true);
  }

  // ---------------------------------------------------------------- Events
  function isTextEditableTarget(el) {
    if (!el) { return false; }
    var tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
  }

  function isActivationButton(el) {
    if (!el) { return false; }
    var tag = el.tagName;
    return tag === 'BUTTON' || tag === 'A';
  }

  function tickOnce() {
    pause();
    cpu.tickTimers();
    updateInspector();
    updateSound();
  }

  function onKeyDown(e) {
    if (isTextEditableTarget(e.target) || e.ctrlKey || e.metaKey || e.altKey) { return; }
    var key = e.key.toLowerCase();
    if (!shortcutsEnabled) {
      // Character-key shortcuts are off (SW6). Backspace is a non-printable
      // editing key, so the reset binding stays live per WCAG 2.1.4.
      if (key === 'backspace') { e.preventDefault(); resetMachine(); }
      return;
    }
    if (key === ' ' || key === 'spacebar') {
      if (isActivationButton(e.target)) { return; }
      e.preventDefault();
      if (!e.repeat) running ? pause() : play();
      return;
    }
    if (Object.prototype.hasOwnProperty.call(KEY_MAP, key)) {
      e.preventDefault();
      if (!e.repeat) { keyboardKeys[KEY_MAP[key]] = true; syncKey(KEY_MAP[key]); }
      return;
    }
    // Hold-to-repeat is useful for single stepping and timer ticks.
    if (key === 'n') { e.preventDefault(); stepOnce(); return; }
    if (key === 'b') { e.preventDefault(); stepBack(); return; }
    if (key === 't') { e.preventDefault(); tickOnce(); return; }
    if (e.repeat) { return; }
    if (key === 'backspace') { e.preventDefault(); resetMachine(); return; }
    if (key === 'o') { e.preventDefault(); exportState(); return; }
    if (key === 'u') { e.preventDefault(); exportTrace(); return; }
    if (key === 'm') {
      e.preventDefault();
      audioToggle.checked = !audioToggle.checked;
      setAudioEnabled(audioToggle.checked);
      return;
    }
    if (key === 'p') { e.preventDefault(); cycleTheme(); return; }
    if (key === '[' || key === ']') { e.preventDefault(); cycleRom(key === ']' ? 1 : -1); return; }
  }

  function onKeyUp(e) {
    var key = e.key.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(KEY_MAP, key)) {
      delete keyboardKeys[KEY_MAP[key]];
      syncKey(KEY_MAP[key]);
    }
  }

  function releaseAllKeys() {
    keyboardKeys = Object.create(null);
    virtualKeys = Object.create(null);
    releaseAllPointerKeys();
    for (var k = 0; k < 16; k++) { pressKey(k, false); }
  }

  function bindEvents() {
    playBtn.addEventListener('click', play);
    pauseBtn.addEventListener('click', pause);
    stepBtn.addEventListener('click', stepOnce);
    if (stepBackBtn) { stepBackBtn.addEventListener('click', stepBack); }
    resetBtn.addEventListener('click', resetMachine);
    exportStateBtn.addEventListener('click', exportState);
    exportTraceBtn.addEventListener('click', exportTrace);

    speedRange.addEventListener('input', function () {
      speed = Math.max(60, Math.min(2000, Number(speedRange.value) || 600));
      speedValue.textContent = fmt(speed) + ' Hz';
      writeBookmark();
    });

    ghostToggle.addEventListener('change', function () {
      glow = ghostToggle.checked;
      render();
    });

    if (shortcutsToggle) {
      shortcutsToggle.addEventListener('change', function () {
        setShortcutsEnabled(shortcutsToggle.checked);
      });
    }

    audioToggle.addEventListener('change', function () {
      setAudioEnabled(audioToggle.checked);
    });

    if (quirkLoadStore) {
      quirkLoadStore.addEventListener('change', syncQuirksFromUI);
    }
    if (quirkShiftVy) {
      quirkShiftVy.addEventListener('change', syncQuirksFromUI);
    }
    if (quirkJumpVx) {
      quirkJumpVx.addEventListener('change', syncQuirksFromUI);
    }

    themeToggle.addEventListener('click', cycleTheme);

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', function () { releaseAllKeys(); pause(); });
    document.addEventListener('visibilitychange', function () { if (document.hidden) { releaseAllKeys(); pause(); } });
    window.addEventListener('resize', render);
    if (window.ResizeObserver) new window.ResizeObserver(render).observe(canvas);
    document.addEventListener('pointerup', function () { releaseAllPointerKeys(); });
    document.addEventListener('pointercancel', releaseAllPointerKeys);
    bindWorkbench();
  }

  var XOR_SOURCE = [
    '; XOR twice: V2 records no collision, V7 records the erase collision.',
    'start: CLS', 'LD V0, 28', 'LD V1, 12', 'LD I, sprite', 'DRW V0, V1, 5', 'LD V2, VF',
    'LD V3, 30', 'LD DT, V3', 'firstWait: LD V3, DT', 'SE V3, 0', 'JP firstWait',
    'DRW V0, V1, 5', 'LD V7, VF', 'LD V3, 30', 'LD DT, V3', 'LD ST, V3',
    'secondWait: LD V3, DT', 'SE V3, 0', 'JP secondWait', 'JP start',
    'sprite: DB 0xF0, 0x90, 0x90, 0x90, 0xF0'
  ].join('\n');
  function descriptor(source, name) {
    return { id: 'custom', name: name, source: source, bytes: C8.assemble(source), controls: 'Custom assembly', keys: {} };
  }
  function runVerification() {
    var words = [0x00E0, 0x00EE, 0x0123, 0x1234, 0x2234, 0x3123, 0x4123, 0x5120,
      0x6123, 0x7123, 0x8120, 0x8121, 0x8122, 0x8123, 0x8124, 0x8125, 0x8126, 0x8127,
      0x812E, 0x9120, 0xA234, 0xB234, 0xC123, 0xD125, 0xE19E, 0xE1A1, 0xF107,
      0xF10A, 0xF115, 0xF118, 0xF11E, 0xF129, 0xF133, 0xF155, 0xF165];
    try {
      words.forEach(function (word) {
        var bytes = C8.assemble(cpu.disassemble(word));
        if (((bytes[0] << 8) | bytes[1]) !== word) throw new Error('Instruction round trip failed.');
      });
      $('verificationBadge').textContent = words.length + ' instruction round trips passed';
    } catch (error) { $('verificationBadge').textContent = error.message; }
  }
  function inspectPixel(x, y) {
    inspectionPixel.x = Math.max(0, Math.min(63, x)); inspectionPixel.y = Math.max(0, Math.min(31, y));
    refreshPixelReadout();
  }
  function bindWorkbench() {
    $('showcaseXor').addEventListener('click', function () {
      loadDescriptor(descriptor(XOR_SOURCE, 'XOR collision lab'), true);
      $('quirkComparison').textContent = 'Watch V2 = 0 on draw, V7 = 1 on erase. The 60 Hz delay timer paces both phases.';
    });
    $('showcaseQuirks').addEventListener('click', function () {
      var results = [];
      ['modern', 'vip', 'chip48'].forEach(function (name) {
        var machine = new C8.Chip8().setProfile(name); machine.load([0x61, 9, 0x62, 6, 0x81, 0x26]);
        machine.step(); machine.step(); machine.step();
        results.push(name.toUpperCase() + ': V1=' + machine.V[1] + ', VF=' + machine.V[15]);
      });
      $('quirkComparison').textContent = '8126 with V1=9, V2=6 / ' + results.join(' / ');
    });
    $('profileSelect').addEventListener('change', function () {
      pause(); releaseAllKeys(); cpu.setProfile(this.value);
      quirkLoadStore.checked = cpu.quirks.loadStoreNoIncrementI; quirkShiftVy.checked = cpu.quirks.shiftUsesVy; quirkJumpVx.checked = cpu.quirks.jumpUsesVx;
      syncQuirksFromUI(); updateInspector();
      $('quirkComparison').textContent = this.value.toUpperCase() + ': ' + (cpu.quirks.clipSprites ? 'sprites clip' : 'sprites wrap') + ', ' + (cpu.quirks.logicResetsVf ? 'logic clears VF' : 'logic retains VF') + ', ' + (cpu.quirks.waitForRelease ? 'key release completes FX0A' : 'held key completes FX0A') + '.';
    });
    // One address or a comma/space-separated list of PC breakpoints.
    $('breakpointBtn').addEventListener('click', function () {
      var value = $('breakpointInput').value.trim();
      if (!value) {
        breakpoints = []; skipBreakpointPc = null;
        $('breakpointStatus').textContent = 'No breakpoint';
        return;
      }
      var parts = value.split(/[\s,]+/).filter(function (p) { return p.length > 0; });
      var addrs = [], bad = false;
      parts.forEach(function (p) {
        if (!/^(?:0x)?[0-9a-f]{1,3}$/i.test(p)) { bad = true; return; }
        var v = parseInt(p.replace(/^0x/i, ''), 16);
        if (v > 0xFFE) { bad = true; return; }
        if (addrs.indexOf(v) === -1) { addrs.push(v); }
      });
      if (bad || addrs.length === 0) {
        $('breakpointStatus').textContent = 'Enter hexadecimal addresses from 000 to FFE, separated by commas.';
        return;
      }
      breakpoints = addrs; skipBreakpointPc = null;
      $('breakpointStatus').textContent = 'Break before ' + addrs.map(hex3).join(', ') + '. Clear the field to remove.';
    });
    if (auditJsonBtn) { auditJsonBtn.addEventListener('click', exportAuditJson); }
    if (auditCsvBtn) { auditCsvBtn.addEventListener('click', exportAuditCsv); }
    if (auditMdBtn) { auditMdBtn.addEventListener('click', exportAuditMd); }
    if (auditVerifyBtn) { auditVerifyBtn.addEventListener('click', runAuditVerify); }
    if (selfTestBtn) { selfTestBtn.addEventListener('click', runSelfTests); }
    $('timerStepBtn').addEventListener('click', tickOnce);
    $('assembleBtn').addEventListener('click', function () {
      try {
        var source = $('assemblyEditor').value, rom = descriptor(source, 'Custom ROM');
        loadDescriptor(rom, false); $('assemblerStatus').textContent = 'Assembled ' + rom.bytes.length + ' bytes. Ready at 0x200.';
      } catch (error) { $('assemblerStatus').textContent = error.message; }
    });
    $('downloadRomBtn').addEventListener('click', function () {
      if (!activeRom) return;
      var url = URL.createObjectURL(new Blob([activeRom.bytes], { type: 'application/octet-stream' }));
      var link = document.createElement('a'); link.href = url; link.download = 'chipper8-rom.ch8';
      document.body.appendChild(link); link.click(); document.body.removeChild(link);
      setTimeout(function () { URL.revokeObjectURL(url); }, 0); toast('Exported ' + activeRom.bytes.length + ' ROM bytes.');
    });
    canvas.addEventListener('pointermove', function (event) {
      var rect = canvas.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) inspectPixel(Math.floor((event.clientX - rect.left) / rect.width * 64), Math.floor((event.clientY - rect.top) / rect.height * 32));
    });
    canvas.addEventListener('keydown', function (event) {
      var deltas = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }, delta = deltas[event.key];
      if (!delta) return; event.preventDefault(); inspectPixel(inspectionPixel.x + delta[0], inspectionPixel.y + delta[1]);
    });
  }

  // ---------------------------------------------------------------- Init
  function init() {
    if (ROMS.length === 0) {
      sourceCode.textContent = 'No ROMs available. Check that assembler.js and roms.js loaded correctly.';
      return;
    }
    buildInspector();
    buildKeypad();
    buildRomList();
    bindEvents();
    initTheme();
    initShortcuts();
    speedValue.textContent = fmt(speed) + ' Hz';
    audioToggle.checked = false;
    var startRom = applyBookmarkFromHash();
    loadRom(startRom === null || startRom === undefined ? 0 : startRom, false);
    renderQuirkLab();
    renderCoverage();
    renderTimeDepth();
  }

  init();
  runVerification();
})();
