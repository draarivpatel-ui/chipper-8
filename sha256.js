/*
 * Chipper-8: pure JavaScript SHA-256 (FIPS 180-4).
 *
 * Zero dependencies. Works in the browser (exposes window.Chipper8.sha256)
 * and in Node.js (module.exports) so the same code is unit tested with
 * `node --test`.
 *
 * Input: a string (UTF-8 encoded), Uint8Array, or a plain byte array.
 * Output: lowercase 64-character hexadecimal digest.
 *
 * Honesty note: SHA-256 is an unkeyed hash. A digest proves a file was not
 * edited after export; it is not a signature and proves nothing about who
 * produced it.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.Chipper8 = root.Chipper8 || {};
    root.Chipper8.sha256 = api;
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Round constants: first 32 bits of the fractional parts of the cube
  // roots of the first 64 primes (FIPS 180-4 section 4.2.2).
  var K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
    0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
    0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
    0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
    0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
    0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];

  var H0 = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ];

  function utf8Bytes(text) {
    if (typeof TextEncoder === 'function') {
      return new TextEncoder().encode(text);
    }
    var out = [];
    for (var i = 0; i < text.length; i++) {
      var code = text.charCodeAt(i);
      if (code < 0x80) {
        out.push(code);
      } else if (code < 0x800) {
        out.push(0xC0 | (code >> 6), 0x80 | (code & 0x3F));
      } else if (code >= 0xD800 && code <= 0xDBFF && i + 1 < text.length) {
        var next = text.charCodeAt(i + 1);
        if (next >= 0xDC00 && next <= 0xDFFF) {
          var cp = 0x10000 + ((code - 0xD800) << 10) + (next - 0xDC00);
          i++;
          out.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3F),
            0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F));
        } else {
          out.push(0xE0 | (code >> 12), 0x80 | ((code >> 6) & 0x3F), 0x80 | (code & 0x3F));
        }
      } else {
        out.push(0xE0 | (code >> 12), 0x80 | ((code >> 6) & 0x3F), 0x80 | (code & 0x3F));
      }
    }
    return out;
  }

  function toBytes(input) {
    if (typeof input === 'string') { return utf8Bytes(input); }
    if (!input || typeof input.length !== 'number' || !Number.isSafeInteger(input.length) || input.length < 0) {
      throw new TypeError('SHA-256 input must be a string or a byte array.');
    }
    var out = new Uint8Array(input.length);
    for (var i = 0; i < input.length; i++) {
      var value = input[i];
      if (!Number.isInteger(value) || value < 0 || value > 255) {
        throw new TypeError('SHA-256 byte input must contain only integers from 0 to 255.');
      }
      out[i] = value;
    }
    return out;
  }

  function rotr(x, n) { return ((x >>> n) | (x << (32 - n))) | 0; }

  // One-shot FIPS 180-4 SHA-256 over the padded message.
  function sha256Bytes(input) {
    var bytes = toBytes(input);
    var length = bytes.length;
    var bitLenHi = Math.floor(length / 0x20000000);
    var bitLenLo = (length * 8) >>> 0;
    var padded = new Uint8Array(((length + 9 + 63) >> 6) << 6);
    padded.set(bytes);
    padded[length] = 0x80;
    var dv = new DataView(padded.buffer);
    dv.setUint32(padded.length - 8, bitLenHi);
    dv.setUint32(padded.length - 4, bitLenLo);

    var h = H0.slice();
    var w = new Int32Array(64);
    for (var block = 0; block < padded.length; block += 64) {
      for (var t = 0; t < 16; t++) { w[t] = dv.getInt32(block + t * 4); }
      for (t = 16; t < 64; t++) {
        var s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
        var s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
        w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
      }
      var a = h[0], b = h[1], c = h[2], d = h[3],
          e = h[4], f = h[5], g = h[6], hh = h[7];
      for (t = 0; t < 64; t++) {
        var S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        var ch = (e & f) ^ (~e & g);
        var temp1 = (hh + S1 + ch + K[t] + w[t]) | 0;
        var S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        var maj = (a & b) ^ (a & c) ^ (b & c);
        var temp2 = (S0 + maj) | 0;
        hh = g; g = f; f = e; e = (d + temp1) | 0;
        d = c; c = b; b = a; a = (temp1 + temp2) | 0;
      }
      h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0;
      h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
      h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0;
      h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
    }

    var out = '';
    for (var i = 0; i < 8; i++) {
      out += ('0000000' + (h[i] >>> 0).toString(16)).slice(-8);
    }
    return out;
  }

  return sha256Bytes;
}));
