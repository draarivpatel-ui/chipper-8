/*
 * Chipper-8: tiny CHIP-8 assembler.
 *
 * The four built-in ROMs are written as readable assembly and compiled into
 * byte arrays in the browser at load time. Nothing is fetched from the
 * network, so the whole emulator works completely offline.
 *
 * Exposes:
 *   - Node: require('./assembler.js').assemble(source, origin)
 *   - Browser: window.Chipper8.assemble(source, origin)
 *
 * assemble() returns a Uint8Array of program bytes (to be loaded at 0x200).
 * Labels are resolved to absolute addresses (origin + byte offset).
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.Chipper8 = root.Chipper8 || {};
    root.Chipper8.assemble = api.assemble;
    root.Chipper8.AssemblerError = api.AssemblerError;
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function AssemblerError(message) {
    this.name = 'AssemblerError';
    this.message = message;
    this.stack = (new Error(message)).stack;
  }
  AssemblerError.prototype = Object.create(Error.prototype);
  AssemblerError.prototype.constructor = AssemblerError;

  function isReg(t) { return /^V[0-9A-Fa-f]$/.test(t); }
  function reg(t) { return parseInt(t.charAt(1), 16); }

  function parseNum(token, labels) {
    var t = String(token).trim();
    if (/^0x[0-9A-Fa-f]+$/.test(t)) { return parseInt(t.slice(2), 16); }
    if (/^\$[0-9A-Fa-f]+$/.test(t)) { return parseInt(t.slice(1), 16); }
    if (/^[0-9]+$/.test(t)) { return parseInt(t, 10); }
    if (Object.prototype.hasOwnProperty.call(labels, t)) { return labels[t]; }
    throw new AssemblerError('Unknown value or label: ' + token);
  }

  // Split a source line into label definitions and an optional statement.
  function parseLine(raw) {
    var line = raw;
    var c = line.indexOf(';');
    if (c !== -1) { line = line.slice(0, c); }
    var sl = line.indexOf('//');
    if (sl !== -1) { line = line.slice(0, sl); }
    line = line.trim();
    if (line === '') { return { labels: [], stmt: null }; }

    var labels = [];
    var m;
    while ((m = /^([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(line)) !== null) {
      labels.push(m[1]);
      line = line.slice(m[0].length).trim();
    }
    if (line === '') { return { labels: labels, stmt: null }; }

    var space = line.search(/\s/);
    var mn, rest;
    if (space === -1) {
      mn = line.toUpperCase();
      rest = '';
    } else {
      mn = line.slice(0, space).toUpperCase();
      rest = line.slice(space + 1).trim();
    }
    var ops = rest === '' ? [] : rest.split(',').map(function (o) { return o.trim(); });
    return { labels: labels, stmt: { mn: mn, ops: ops } };
  }

  function sizeOf(stmt) {
    if (stmt.mn === 'DB') { return stmt.ops.length; }
    if (stmt.mn === 'DW') { return stmt.ops.length * 2; }
    return 2;
  }

  function encode(stmt, labels, out) {
    var ops = stmt.ops;
    var o0 = ops[0], o1 = ops[1], o2 = ops[2];
    var x, y, kk, nnn, n;

    function word(v) {
      out.push((v >> 8) & 0xFF, v & 0xFF);
    }
    function byte(v) { out.push(v & 0xFF); }

    switch (stmt.mn) {
      case 'DB':
        for (var d = 0; d < ops.length; d++) { byte(parseNum(ops[d], labels)); }
        return;
      case 'DW':
        for (var w = 0; w < ops.length; w++) { word(parseNum(ops[w], labels)); }
        return;
      case 'CLS': word(0x00E0); return;
      case 'RET': word(0x00EE); return;
      case 'SYS': word(0x0000 | (parseNum(o0, labels) & 0x0FFF)); return;
      case 'JP': word(0x1000 | (parseNum(o0, labels) & 0x0FFF)); return;
      case 'CALL': word(0x2000 | (parseNum(o0, labels) & 0x0FFF)); return;
      case 'JPV0': word(0xB000 | (parseNum(o0, labels) & 0x0FFF)); return;

      case 'SE':
        x = reg(o0);
        if (isReg(o1)) { word(0x5000 | (x << 8) | (reg(o1) << 4)); }
        else { word(0x3000 | (x << 8) | (parseNum(o1, labels) & 0xFF)); }
        return;
      case 'SNE':
        x = reg(o0);
        if (isReg(o1)) { word(0x9000 | (x << 8) | (reg(o1) << 4)); }
        else { word(0x4000 | (x << 8) | (parseNum(o1, labels) & 0xFF)); }
        return;

      case 'LD':
        if (o0 === 'I') { word(0xA000 | (parseNum(o1, labels) & 0x0FFF)); return; }
        if (o0 === 'DT') { word(0xF015 | (reg(o1) << 8)); return; }
        if (o0 === 'ST') { word(0xF018 | (reg(o1) << 8)); return; }
        if (o0 === 'F') { word(0xF029 | (reg(o1) << 8)); return; }
        if (o0 === 'B') { word(0xF033 | (reg(o1) << 8)); return; }
        if (o0 === '[I]') { word(0xF055 | (reg(o1) << 8)); return; }
        if (!isReg(o0)) { throw new AssemblerError('Bad LD destination: ' + o0); }
        x = reg(o0);
        if (o1 === 'DT') { word(0xF007 | (x << 8)); return; }
        if (o1 === 'K') { word(0xF00A | (x << 8)); return; }
        if (o1 === '[I]') { word(0xF065 | (x << 8)); return; }
        if (isReg(o1)) { word(0x8000 | (x << 8) | (reg(o1) << 4)); return; }
        word(0x6000 | (x << 8) | (parseNum(o1, labels) & 0xFF));
        return;

      case 'ADD':
        if (o0 === 'I') { word(0xF01E | (reg(o1) << 8)); return; }
        if (!isReg(o0)) { throw new AssemblerError('Bad ADD destination: ' + o0); }
        x = reg(o0);
        if (isReg(o1)) { word(0x8004 | (x << 8) | (reg(o1) << 4)); return; }
        word(0x7000 | (x << 8) | (parseNum(o1, labels) & 0xFF));
        return;

      case 'OR': word(0x8001 | (reg(o0) << 8) | (reg(o1) << 4)); return;
      case 'AND': word(0x8002 | (reg(o0) << 8) | (reg(o1) << 4)); return;
      case 'XOR': word(0x8003 | (reg(o0) << 8) | (reg(o1) << 4)); return;
      case 'SUB': word(0x8005 | (reg(o0) << 8) | (reg(o1) << 4)); return;
      case 'SUBN': word(0x8007 | (reg(o0) << 8) | (reg(o1) << 4)); return;
      case 'SHR': word(0x8006 | (reg(o0) << 8)); return;
      case 'SHL': word(0x800E | (reg(o0) << 8)); return;

      case 'RND': word(0xC000 | (reg(o0) << 8) | (parseNum(o1, labels) & 0xFF)); return;
      case 'DRW':
        x = reg(o0); y = reg(o1); n = parseNum(o2, labels) & 0xF;
        word(0xD000 | (x << 8) | (y << 4) | n);
        return;
      case 'SKP': word(0xE09E | (reg(o0) << 8)); return;
      case 'SKNP': word(0xE0A1 | (reg(o0) << 8)); return;

      default:
        throw new AssemblerError('Unknown mnemonic: ' + stmt.mn);
    }
  }

  function assemble(source, origin) {
    var base = (origin === undefined) ? 0x200 : origin;
    var lines = String(source).split(/\r?\n/);
    var parsed = lines.map(parseLine);

    // Pass 1: compute absolute addresses for every label.
    var labels = Object.create(null);
    var addr = 0;
    for (var i = 0; i < parsed.length; i++) {
      for (var l = 0; l < parsed[i].labels.length; l++) {
        var name = parsed[i].labels[l];
        if (Object.prototype.hasOwnProperty.call(labels, name)) {
          throw new AssemblerError('Duplicate label: ' + name);
        }
        labels[name] = base + addr;
      }
      if (parsed[i].stmt) { addr += sizeOf(parsed[i].stmt); }
    }

    // Pass 2: emit bytes.
    var out = [];
    for (var j = 0; j < parsed.length; j++) {
      if (parsed[j].stmt) { encode(parsed[j].stmt, labels, out); }
    }
    if (out.length > 0x1000 - base) {
      throw new AssemblerError('Program too large: ' + out.length + ' bytes');
    }
    return new Uint8Array(out);
  }

  return { assemble: assemble, AssemblerError: AssemblerError, parseLine: parseLine };
}));
