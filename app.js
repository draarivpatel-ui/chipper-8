/*
 * Chipper-8: browser hardware logic analyzer & front panel.
 *
 * Glues engine.js + assembler.js + roms.js into a cycle-accurate workbench:
 *   - requestAnimationFrame run loop with adjustable opcode clock (60..2000 Hz)
 *     and 60 Hz delay/sound timers
 *   - 64x32 CDP1861 PIXIE framebuffer rendered on an HTML5 canvas
 *   - Hardware DIP switches for COSMAC VIP vs CHIP-48 / SUPER-CHIP quirks
 *   - Cycle-accurate bus trace table & live 16-byte RAM window around PC
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
  var speedRange = $('speedRange');
  var speedValue = $('speedValue');
  var audioToggle = $('audioToggle');
  var mutedBadge = $('mutedBadge');
  var ghostToggle = $('ghostToggle');
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
  var PIXEL_SCALE = canvas.width / C8.Chip8.DISPLAY_WIDTH; // 10

  // ---------------------------------------------------------------- State
  var cpu = new C8.Chip8();
  var activeRom = null;
  var running = false;
  var rafId = 0;
  var speed = 600;                 // opcodes per second
  var cycleAcc = 0;
  var timerAcc = 0;
  var lastTime = 0;
  var opCount = 0;
  var frameCount = 0;
  var lastInspector = 0;
  var glow = false;
  var audioEnabled = false;       // muted by default
  var audioCtx = null, osc = null, gainNode = null;
  var pointerKeys = Object.create(null);
  var traceBuffer = [];
  var MAX_TRACE = 7;
  var colors = { bg: '#100b03', pixel: '#ffb000', glow: 'rgba(255,176,0,0.55)' };

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
  function render() {
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
    cpu.quirks = {
      loadStoreNoIncrementI: noIncI,
      shiftUsesVy: shiftVy,
      jumpUsesVx: jumpVx
    };
    if (quirkLoadStoreLabel) {
      quirkLoadStoreLabel.textContent = noIncI ? 'CHIP-48: I UNCHANGED' : 'VIP: I = I + X + 1';
    }
    if (quirkShiftVyLabel) {
      quirkShiftVyLabel.textContent = shiftVy ? 'VIP: VX = VY >> 1' : 'CHIP-48: SHR VX';
    }
    if (quirkJumpVxLabel) {
      quirkJumpVxLabel.textContent = jumpVx ? 'CHIP-48: PC = XNN + VX' : 'VIP: PC = NNN + V0';
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

  function setStatus(text, mode) {
    statusText.textContent = text.toUpperCase();
    statusDot.className = 'status-led' + (mode ? ' ' + mode : '');
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
    var pcBefore = cpu.pc;
    var op = cpu.step();
    opCount++;
    traceBuffer.push({
      cyc: opCount,
      pc: pcBefore,
      op: op,
      mnem: cpu.disassemble(op),
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
      busTraceBody.innerHTML = '<tr><td colspan="6" class="trace-empty">Step or run CPU to capture bus trace.</td></tr>';
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
    var base = cpu.pc & 0xFF0;
    if (base > 0xFF0) { base = 0xFF0; }
    var lines = [];
    for (var r = 0; r < 2; r++) {
      var rowAddr = base + r * 8;
      var parts = [hex3(rowAddr) + ':'];
      for (var c = 0; c < 8; c++) {
        var addr = (rowAddr + c) & 0xFFF;
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

  function updateInspector() {
    stateCells.pc.textContent = hex3(cpu.pc);
    stateCells.I.textContent = hex3(cpu.I);
    stateCells.sp.textContent = String(cpu.sp);
    stateCells.dt.textContent = String(cpu.delayTimer);
    stateCells.st.textContent = String(cpu.soundTimer);
    stateCells.op.textContent = cpu.lastOpcode
      ? cpu.disassemble(cpu.lastOpcode) : '-';
    for (var i = 0; i < 16; i++) {
      regCells[i].textContent = hex2(cpu.V[i]);
    }
    renderBusTrace();
    renderRamWindow();
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
      card.setAttribute('role', 'option');
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
      cards[i].setAttribute('aria-selected', on ? 'true' : 'false');
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
      var key = document.createElement('div');
      key.className = 'key';
      key.dataset.value = String(value);
      key.setAttribute('role', 'button');
      key.setAttribute('tabindex', '-1');
      key.setAttribute('aria-label', 'CHIP-8 key ' + HEX[value]);
      key.innerHTML = '<div>' + HEX[value] +
        '<span class="key-sub">' + (PHYSICAL[value] || '') + '</span></div>';
      key.addEventListener('pointerdown', function (e) {
        e.preventDefault();
        pressKey(value, true);
        pointerKeys[value] = true;
      });
      key.addEventListener('pointerup', function () { releasePointerKey(value); });
      key.addEventListener('pointerleave', function () { releasePointerKey(value); });
      key.addEventListener('pointercancel', function () { releasePointerKey(value); });
      keypadEl.appendChild(key);
      keyEls[value] = key;
    });
  }

  function releasePointerKey(value) {
    if (pointerKeys[value]) {
      delete pointerKeys[value];
      pressKey(value, false);
    }
  }

  function releaseAllPointerKeys() {
    Object.keys(pointerKeys).forEach(function (v) { releasePointerKey(Number(v)); });
  }

  function pressKey(value, down) {
    cpu.setKey(value, down);
    var el = keyEls[value];
    if (el) { el.classList.toggle('down', !!down); }
  }

  // ---------------------------------------------------------------- Run loop
  function frame(now) {
    if (!running) { return; }
    var dt = Math.min((now - lastTime) / 1000, 0.1);
    if (dt < 0) { dt = 0; }
    lastTime = now;

    cycleAcc += dt * speed;
    timerAcc += dt * 60;

    var steps = Math.min(Math.floor(cycleAcc), 4000);
    cycleAcc -= steps;
    for (var i = 0; i < steps; i++) {
      executeAndRecordStep();
      if (cpu.halted) {
        running = false;
        setButtons();
        setStatus('HALTED', '');
        updateSound();
        toast('CPU halted on unknown opcode. Reset to 0x200 to continue.');
        break;
      }
    }

    var ticks = Math.min(Math.floor(timerAcc), 30);
    timerAcc -= ticks;
    for (var t = 0; t < ticks; t++) { cpu.tickTimers(); }

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
    if (cpu.halted) { loadRom(ROMS.indexOf(activeRom), false); }
    running = true;
    cycleAcc = 0;
    timerAcc = 0;
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
    setStatus('HALTED', 'paused');
    updateSound();
    updateInspector();
  }

  function stepOnce() {
    if (running) { pause(); }
    executeAndRecordStep();
    cpu.tickTimers();
    if (cpu.drawFlag) {
      render();
      cpu.drawFlag = false;
      frameCount++;
    }
    setStatus(cpu.halted ? 'HALTED' : 'STEP', cpu.halted ? '' : 'paused');
    screenOverlay.classList.add('hidden');
    updateInspector();
  }

  function resetMachine() {
    pause();
    releaseAllPointerKeys();
    for (var k = 0; k < 16; k++) { cpu.setKey(k, false); }
    loadRom(ROMS.indexOf(activeRom), false);
    toast('CPU reset to 0x200.');
  }

  function stepInitialFrame() {
    // Advance through initial register setup and first sprite DRW ops so the
    // 64x32 display shows the live game layout immediately on cartridge load.
    var draws = 0;
    for (var s = 0; s < 24 && !cpu.halted; s++) {
      var op = executeAndRecordStep();
      if ((op & 0xF000) === 0xD000) { draws++; }
      if (draws >= 2) { break; }
    }
    if (cpu.drawFlag) {
      render();
      cpu.drawFlag = false;
      frameCount = 1;
    }
  }

  function loadRom(index, autoplay) {
    if (index < 0 || index >= ROMS.length) { return; }
    var rom = ROMS[index];
    releaseAllPointerKeys();
    for (var k = 0; k < 16; k++) { cpu.setKey(k, false); }

    cpu.reset();
    cpu.rng = Math.random;
    syncQuirksFromUI();
    cpu.load(rom.bytes);

    activeRom = rom;
    opCount = 0;
    frameCount = 0;
    cycleAcc = 0;
    timerAcc = 0;
    traceBuffer = [];
    running = false;
    cancelAnimationFrame(rafId);

    stepInitialFrame();

    markActiveRom(index);
    buildKeyLegend(rom);
    setSource(rom);
    romControlsEl.textContent = 'CARTRIDGE INPUTS: ' + rom.controls;
    activeRomName.textContent = rom.name.toUpperCase() + ' (' + rom.bytes.length + ' B)';
    render();
    updateInspector();
    setButtons();
    setStatus('READY', '');
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
  }

  function initTheme() {
    var saved = null;
    try { saved = localStorage.getItem('chipper8-theme'); } catch (e) { /* ignore */ }
    if (saved === 'dark') { saved = 'green'; }
    applyTheme(THEMES.indexOf(saved) !== -1 ? saved : 'amber');
  }

  // ---------------------------------------------------------------- Events
  function isTypingTarget(el) {
    if (!el) { return false; }
    var tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
  }

  function onKeyDown(e) {
    if (isTypingTarget(e.target)) { return; }
    var key = e.key.toLowerCase();
    if (key === ' ' || key === 'spacebar') {
      e.preventDefault();
      running ? pause() : play();
      return;
    }
    if (Object.prototype.hasOwnProperty.call(KEY_MAP, key)) {
      e.preventDefault();
      if (!e.repeat) { pressKey(KEY_MAP[key], true); }
    }
  }

  function onKeyUp(e) {
    var key = e.key.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(KEY_MAP, key)) {
      if (!pointerKeys[KEY_MAP[key]]) { pressKey(KEY_MAP[key], false); }
    }
  }

  function releaseAllKeys() {
    releaseAllPointerKeys();
    for (var k = 0; k < 16; k++) { pressKey(k, false); }
  }

  function bindEvents() {
    playBtn.addEventListener('click', play);
    pauseBtn.addEventListener('click', pause);
    stepBtn.addEventListener('click', stepOnce);
    resetBtn.addEventListener('click', resetMachine);

    speedRange.addEventListener('input', function () {
      speed = Number(speedRange.value);
      speedValue.textContent = fmt(speed) + ' Hz';
    });

    ghostToggle.addEventListener('change', function () {
      glow = ghostToggle.checked;
      render();
    });

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

    themeToggle.addEventListener('click', function () {
      var cur = document.documentElement.getAttribute('data-theme') || 'amber';
      var nextIdx = (THEMES.indexOf(cur) + 1) % THEMES.length;
      applyTheme(THEMES[nextIdx]);
    });

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', releaseAllKeys);
    document.addEventListener('pointerup', function () { releaseAllPointerKeys(); });
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
    speedValue.textContent = fmt(speed) + ' Hz';
    audioToggle.checked = false;
    loadRom(0, false);
  }

  init();
})();
