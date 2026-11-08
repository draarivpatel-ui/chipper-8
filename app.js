/*
 * Chipper-8: browser front end.
 *
 * Glues engine.js + assembler.js + roms.js into a playable emulator:
 *   - a requestAnimationFrame run loop with adjustable opcode rate and 60 Hz timers
 *   - 64x32 framebuffer rendering on a canvas
 *   - keyboard and on screen hex keypad input
 *   - a live CPU / register inspector and ROM source viewer
 *   - optional sound that stays completely muted until the toggle is clicked
 *
 * No dependencies, no network calls, no autoplaying media.
 */
(function () {
  'use strict';

  var C8 = window.Chipper8;
  if (!C8 || !C8.Chip8) {
    document.body.innerHTML = '<p style="padding:40px;font:16px sans-serif">Failed to load engine.js</p>';
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
  var scoreValue = $('scoreValue');
  var opCountEl = $('opCount');
  var frameCountEl = $('frameCount');
  var stateGrid = $('stateGrid');
  var regGrid = $('regGrid');
  var sourceCode = $('sourceCode');
  var sourceTag = $('sourceTag');
  var themeToggle = $('themeToggle');
  var toastEl = $('toast');

  // Physical keyboard -> CHIP-8 hex key value. Mirrors the classic layout:
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
  // Reverse lookup so each on screen key can show its shortcut.
  var PHYSICAL = {};
  Object.keys(KEY_MAP).forEach(function (k) {
    var v = KEY_MAP[k];
    if (!PHYSICAL[v]) { PHYSICAL[v] = k.toUpperCase(); }
  });

  // Display order of the 4x4 hex pad.
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
  var colors = { bg: '#08120e', pixel: '#7bf3b2', glow: 'rgba(123,243,178,0.55)' };

  // ---------------------------------------------------------------- Colors
  function refreshColors() {
    var style = getComputedStyle(document.documentElement);
    function read(name, fallback) {
      var v = style.getPropertyValue(name).trim();
      return v || fallback;
    }
    colors.bg = read('--screen-bg', '#08120e');
    colors.pixel = read('--screen-pixel', '#7bf3b2');
    colors.glow = read('--screen-glow', 'rgba(123,243,178,0.55)');
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
    // One path + one fill keeps the glow effect cheap even with many pixels.
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
  // The AudioContext is created lazily. It cannot exist until the user has
  // explicitly clicked the Sound toggle, which keeps everything silent on load.
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
      toast('This browser does not support Web Audio.');
      return;
    }
    audioEnabled = on;
    mutedBadge.classList.toggle('hidden', on);
    updateSound();
    toast(on ? 'Sound on. The beep follows the CHIP-8 sound timer.' : 'Sound muted.');
  }

  // CHIP-8 convention: a tone plays for as long as ST is greater than zero.
  function updateSound() {
    if (!audioCtx || !gainNode) { return; }
    var shouldPlay = audioEnabled && running && cpu.soundTimer > 0;
    gainNode.gain.setTargetAtTime(shouldPlay ? 0.035 : 0, audioCtx.currentTime, 0.012);
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
    statusText.textContent = text;
    statusDot.className = 'status-dot' + (mode ? ' ' + mode : '');
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

  // ---------------------------------------------------------------- Inspector
  var STATE_FIELDS = [
    { key: 'pc', label: 'PC' },
    { key: 'I', label: 'I reg' },
    { key: 'sp', label: 'SP' },
    { key: 'dt', label: 'Delay' },
    { key: 'st', label: 'Sound' },
    { key: 'op', label: 'Last op' }
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
      cell2.innerHTML = '<div class="rk">V' + HEX[i] + '</div><div class="rv">00</div>';
      regGrid.appendChild(cell2);
      regCells.push(cell2.querySelector('.rv'));
    }
  }

  function hex3(v) { return '0x' + (v & 0xFFF).toString(16).toUpperCase().padStart(3, '0'); }
  function hex2(v) { return '0x' + (v & 0xFF).toString(16).toUpperCase().padStart(2, '0'); }

  function updateInspector() {
    stateCells.pc.textContent = hex3(cpu.pc);
    stateCells.I.textContent = hex3(cpu.I);
    stateCells.sp.textContent = String(cpu.sp);
    stateCells.dt.textContent = String(cpu.delayTimer);
    stateCells.st.textContent = String(cpu.soundTimer);
    stateCells.op.textContent = cpu.lastOpcode
      ? cpu.disassemble(cpu.lastOpcode) : '-';
    for (var i = 0; i < 16; i++) {
      regCells[i].textContent = (cpu.V[i] & 0xFF).toString(16).toUpperCase().padStart(2, '0');
    }
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
    sourceTag.textContent = rom.bytes.length + ' bytes';
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
      card.querySelector('.rom-card-name').textContent = rom.name;
      card.querySelector('.rom-card-size').textContent = rom.bytes.length + ' B';
      card.querySelector('.rom-card-blurb').textContent = rom.blurb;
      card.querySelector('.rom-card-controls').textContent = rom.controls;
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
      chip.querySelector('b').textContent = HEX[parseInt(k, 16)] + ' / ' +
        (PHYSICAL[parseInt(k, 16)] || '?');
      chip.appendChild(document.createTextNode(rom.keys[k]));
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
      cpu.step();
      opCount++;
      if (cpu.halted) {
        running = false;
        setButtons();
        setStatus('Halted', '');
        updateSound();
        toast('CPU halted on an unknown opcode. Reset to continue.');
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
    setStatus('Running', 'running');
    screenOverlay.classList.add('hidden');
    updateSound();
    rafId = requestAnimationFrame(frame);
  }

  function pause() {
    if (!running) { return; }
    running = false;
    cancelAnimationFrame(rafId);
    setButtons();
    setStatus('Paused', 'paused');
    updateSound();
    updateInspector();
  }

  function stepOnce() {
    if (running) { pause(); }
    cpu.step();
    opCount++;
    cpu.tickTimers();
    if (cpu.drawFlag) {
      render();
      cpu.drawFlag = false;
      frameCount++;
    }
    setStatus(cpu.halted ? 'Halted' : 'Stepping', cpu.halted ? '' : 'paused');
    screenOverlay.classList.add('hidden');
    updateInspector();
  }

  function resetMachine() {
    pause();
    releaseAllPointerKeys();
    for (var k = 0; k < 16; k++) { cpu.setKey(k, false); }
    loadRom(ROMS.indexOf(activeRom), false);
    screenOverlay.classList.remove('hidden');
    setStatus('Ready', '');
    toast('Machine reset.');
  }

  function loadRom(index, autoplay) {
    if (index < 0 || index >= ROMS.length) { return; }
    var rom = ROMS[index];
    releaseAllPointerKeys();
    for (var k = 0; k < 16; k++) { cpu.setKey(k, false); }

    cpu.reset();
    cpu.rng = Math.random;
    cpu.quirks = { loadStoreNoIncrementI: false, shiftUsesVy: false, jumpUsesVx: false };
    cpu.load(rom.bytes);

    activeRom = rom;
    opCount = 0;
    frameCount = 0;
    cycleAcc = 0;
    timerAcc = 0;
    running = false;
    cancelAnimationFrame(rafId);

    markActiveRom(index);
    buildKeyLegend(rom);
    setSource(rom);
    romControlsEl.textContent = rom.controls;
    activeRomName.textContent = rom.name;
    render();
    updateInspector();
    setButtons();
    setStatus('Ready', '');
    screenOverlay.classList.remove('hidden');

    if (autoplay) { play(); }
  }

  // ---------------------------------------------------------------- Theme
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    themeToggle.querySelector('span').textContent = theme === 'light' ? '☀' : '☽';
    try { localStorage.setItem('chipper8-theme', theme); } catch (e) { /* ignore */ }
    refreshColors();
    render();
  }

  function initTheme() {
    var saved = null;
    try { saved = localStorage.getItem('chipper8-theme'); } catch (e) { /* ignore */ }
    applyTheme(saved === 'light' ? 'light' : 'dark');
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
      // Do not release a key that the on screen keypad is still holding.
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

    themeToggle.addEventListener('click', function () {
      var next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
      applyTheme(next);
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
    audioToggle.checked = false;   // sound muted by default
    mutedBadge.classList.remove('hidden');
    loadRom(0, false);
  }

  init();
})();
