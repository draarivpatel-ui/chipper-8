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
    root.Chipper8.assembleDetailed = api.assembleDetailed;
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

  function isReg(t) { return /^V[0-9A-Fa-f]$/i.test(t); }
  function reg(t) {
    if (!isReg(t)) throw new AssemblerError('Expected a register V0 through VF, received ' + String(t));
    return parseInt(String(t).charAt(1), 16);
  }

  function parseNum(token, labels) {
    var t = String(token).trim();
    if (/^0x[0-9A-Fa-f]+$/i.test(t)) { return parseInt(t.slice(2), 16); }
    if (/^\$[0-9A-Fa-f]+$/.test(t)) { return parseInt(t.slice(1), 16); }
    if (/^[0-9]+$/.test(t)) { return parseInt(t, 10); }
    var key = t.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(labels, key)) { return labels[key]; }
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
    var u0 = o0 !== undefined ? o0.toUpperCase() : '';
    var u1 = o1 !== undefined ? o1.toUpperCase() : '';
    var x, y, kk, nnn, n;
    var counts = { CLS: [0], RET: [0], SYS: [1], JP: [1, 2], CALL: [1], JPV0: [1],
      SE: [2], SNE: [2], LD: [2], ADD: [2], OR: [2], AND: [2], XOR: [2], SUB: [2], SUBN: [2],
      SHR: [1, 2], SHL: [1, 2], RND: [2], DRW: [3], SKP: [1], SKNP: [1] };
    if (stmt.mn === 'DB' || stmt.mn === 'DW') {
      if (!ops.length) throw new AssemblerError(stmt.mn + ' needs at least one value.');
    } else if (counts[stmt.mn] && counts[stmt.mn].indexOf(ops.length) === -1) {
      throw new AssemblerError('Wrong operand count for ' + stmt.mn + '.');
    }
    if (ops.some(function (v) { return v === ''; })) throw new AssemblerError('Empty operand.');
    function bounded(token, limit) {
      var value = parseNum(token, labels);
      if (!Number.isSafeInteger(value) || value < 0 || value > limit) throw new AssemblerError('Value ' + token + ' must be between 0 and ' + limit + '.');
      return value;
    }

    function word(v) {
      out.push((v >> 8) & 0xFF, v & 0xFF);
    }
    function byte(v) { out.push(v & 0xFF); }

    switch (stmt.mn) {
      case 'DB':
        for (var d = 0; d < ops.length; d++) { byte(bounded(ops[d], 255)); }
        return;
      case 'DW':
        for (var w = 0; w < ops.length; w++) { word(bounded(ops[w], 65535)); }
        return;
      case 'CLS': word(0x00E0); return;
      case 'RET': word(0x00EE); return;
      case 'SYS': word(0x0000 | bounded(o0, 4095)); return;
      case 'JP':
        if (ops.length === 2) {
          if (u0 !== 'V0') throw new AssemblerError('Offset jump syntax is JP V0, address.');
          word(0xB000 | bounded(o1, 4095));
        } else word(0x1000 | bounded(o0, 4095));
        return;
      case 'CALL': word(0x2000 | bounded(o0, 4095)); return;
      case 'JPV0': word(0xB000 | bounded(o0, 4095)); return;

      case 'SE':
        x = reg(o0);
        if (isReg(o1)) { word(0x5000 | (x << 8) | (reg(o1) << 4)); }
        else { word(0x3000 | (x << 8) | bounded(o1, 255)); }
        return;
      case 'SNE':
        x = reg(o0);
        if (isReg(o1)) { word(0x9000 | (x << 8) | (reg(o1) << 4)); }
        else { word(0x4000 | (x << 8) | bounded(o1, 255)); }
        return;

      case 'LD':
        if (u0 === 'I') { word(0xA000 | bounded(o1, 4095)); return; }
        if (u0 === 'DT') { word(0xF015 | (reg(o1) << 8)); return; }
        if (u0 === 'ST') { word(0xF018 | (reg(o1) << 8)); return; }
        if (u0 === 'F') { word(0xF029 | (reg(o1) << 8)); return; }
        if (u0 === 'B') { word(0xF033 | (reg(o1) << 8)); return; }
        if (u0 === '[I]') { word(0xF055 | (reg(o1) << 8)); return; }
        if (!isReg(o0)) { throw new AssemblerError('Bad LD destination: ' + o0); }
        x = reg(o0);
        if (u1 === 'DT') { word(0xF007 | (x << 8)); return; }
        if (u1 === 'K') { word(0xF00A | (x << 8)); return; }
        if (u1 === '[I]') { word(0xF065 | (x << 8)); return; }
        if (isReg(o1)) { word(0x8000 | (x << 8) | (reg(o1) << 4)); return; }
        word(0x6000 | (x << 8) | bounded(o1, 255));
        return;

      case 'ADD':
        if (u0 === 'I') { word(0xF01E | (reg(o1) << 8)); return; }
        if (!isReg(o0)) { throw new AssemblerError('Bad ADD destination: ' + o0); }
        x = reg(o0);
        if (isReg(o1)) { word(0x8004 | (x << 8) | (reg(o1) << 4)); return; }
        word(0x7000 | (x << 8) | bounded(o1, 255));
        return;

      case 'OR': word(0x8001 | (reg(o0) << 8) | (reg(o1) << 4)); return;
      case 'AND': word(0x8002 | (reg(o0) << 8) | (reg(o1) << 4)); return;
      case 'XOR': word(0x8003 | (reg(o0) << 8) | (reg(o1) << 4)); return;
      case 'SUB': word(0x8005 | (reg(o0) << 8) | (reg(o1) << 4)); return;
      case 'SUBN': word(0x8007 | (reg(o0) << 8) | (reg(o1) << 4)); return;
      case 'SHR': word(0x8006 | (reg(o0) << 8) | ((o1 === undefined ? 0 : reg(o1)) << 4)); return;
      case 'SHL': word(0x800E | (reg(o0) << 8) | ((o1 === undefined ? 0 : reg(o1)) << 4)); return;

      case 'RND': word(0xC000 | (reg(o0) << 8) | bounded(o1, 255)); return;
      case 'DRW':
        x = reg(o0); y = reg(o1); n = bounded(o2, 15);
        word(0xD000 | (x << 8) | (y << 4) | n);
        return;
      case 'SKP': word(0xE09E | (reg(o0) << 8)); return;
      case 'SKNP': word(0xE0A1 | (reg(o0) << 8)); return;

      default:
        throw new AssemblerError('Unknown mnemonic: ' + stmt.mn);
    }
  }

  function assemble(source, origin, detailed) {
    var base = (origin === undefined) ? 0x200 : origin;
    if (!Number.isInteger(base) || base < 0 || base > 4095) throw new AssemblerError('Origin must be an address from 0 to 4095.');
    var lines = String(source).split(/\r?\n/);
    var parsed = lines.map(parseLine);

    // Pass 1: compute absolute addresses for every label.
    var labels = Object.create(null);
    var addr = 0;
    for (var i = 0; i < parsed.length; i++) {
      for (var l = 0; l < parsed[i].labels.length; l++) {
        // Labels are case-insensitive, matching the register/keyword convention.
        // Keep the source spelling for detailed listings, plus a lowercase key
        // so references in any case resolve to the same address.
        var original = parsed[i].labels[l];
        var name = original.toLowerCase();
        if (Object.prototype.hasOwnProperty.call(labels, name)) {
          throw new AssemblerError('Line ' + (i + 1) + ': duplicate label ' + original);
        }
        labels[name] = base + addr;
        if (original !== name) { labels[original] = base + addr; }
      }
      if (parsed[i].stmt) { addr += sizeOf(parsed[i].stmt); }
    }

    // Pass 2: emit bytes.
    var out = [], listing = [];
    for (var j = 0; j < parsed.length; j++) {
      if (parsed[j].stmt) {
        var start = out.length;
        try { encode(parsed[j].stmt, labels, out); }
        catch (error) {
          if (!(error instanceof AssemblerError)) throw error;
          throw new AssemblerError('Line ' + (j + 1) + ': ' + error.message);
        }
        listing.push({ line: j + 1, address: base + start, bytes: out.slice(start) });
      }
    }
    if (out.length > 0x1000 - base) {
      throw new AssemblerError('Program too large: ' + out.length + ' bytes');
    }
    var bytes = new Uint8Array(out);
    return detailed ? { bytes: bytes, labels: labels, listing: listing } : bytes;
  }

  return { assemble: assemble, assembleDetailed: function (source, origin) { return assemble(source, origin, true); }, AssemblerError: AssemblerError, parseLine: parseLine };
}));
