/*
 * Chipper-8: built-in ROM library.
 *
 * Four small, original games are written here as readable CHIP-8 assembly,
 * then compiled into byte arrays with assembler.js. Nothing is fetched from
 * the network, so the emulator is fully offline and self contained.
 *
 * Browser: window.Chipper8.ROMS  (load assembler.js before this file)
 * Node:    require('./roms.js')
 *
 * Each ROM descriptor:
 *   { id, name, blurb, keys, source, origin, bytes }
 *   - keys maps a hex keypad value (as a string) to a human label.
 *   - source is the assembly text; bytes is the compiled Uint8Array.
 */
(function (root, factory) {
  'use strict';
  var isNode = typeof module === 'object' && module.exports;
  var assemble = isNode
    ? require('./assembler.js').assemble
    : (root.Chipper8 && root.Chipper8.assemble) || null;
  var api = factory(assemble);
  if (isNode) {
    module.exports = api;
  } else {
    root.Chipper8 = root.Chipper8 || {};
    root.Chipper8.ROMS = api;
  }
}(typeof self !== 'undefined' ? self : this, function (assemble) {
  'use strict';

  var ORIGIN = 0x200;

  // Human readable keypad labels, shared with the on screen reference.
  var KEY_LABELS = {
    '0': '0', '1': '1', '2': 'Up / 2', '3': '3',
    '4': 'Left / 4', '5': 'Fire / 5', '6': 'Right / 6', '7': '7',
    '8': 'Down / 8', '9': '9', 'A': 'A', 'B': 'B',
    'C': 'C', 'D': 'D', 'E': 'E', 'F': 'F'
  };

  var definitions = [

    {
      id: 'pong',
      name: 'Pong',
      blurb: 'Classic solo pong. Keep the ball in play with the left paddle. ' +
             'The ball speeds nothing up, but every successful return adds to ' +
             'your score in V7. Missing the ball simply serves a new one.',
      controls: '2 = paddle up, 8 = paddle down',
      keys: { '2': 'Paddle up', '8': 'Paddle down' },
      source: `
; Pong - keep the ball in play with the left paddle.
; Keys: 2 = paddle up, 8 = paddle down.
init:
    LD V6, 1
    LD V9, 1        ; paddle X (fixed)
    LD V0, 30       ; ball X
    LD V1, 16       ; ball Y
    LD V2, 1        ; ball X direction (1 = right, 0 = left)
    LD V3, 1        ; ball Y direction (1 = down, 0 = up)
    LD V4, 12       ; paddle Y (top)
    LD V7, 0        ; score
loop:
    CLS
    LD I, ball
    DRW V0, V1, 1
    LD I, paddle
    DRW V9, V4, 5
    ; ---- input ----
    LD V5, 2
    SKP V5
    JP noUp
    SE V4, 0
    JP decPaddleY
    JP noUp
decPaddleY:
    SUB V4, V6
noUp:
    LD V5, 8
    SKP V5
    JP noDown
    LD V5, 26
    SE V4, V5
    JP incPaddleY
    JP noDown
incPaddleY:
    ADD V4, 1
noDown:
    ; ---- X movement ----
    LD V5, 1
    SE V2, V5
    JP xLeft
    JP xRight
xRight:
    LD V5, 62
    SE V0, V5
    JP rInc
    JP flipLeft
rInc:
    ADD V0, 1
    JP xDone
flipLeft:
    LD V2, 0
    SUB V0, V6
    JP xDone
xLeft:
    LD V5, 2
    SE V0, V5
    JP lDec
    JP checkPaddle
lDec:
    SUB V0, V6
    JP xDone
checkPaddle:
    LD V5, V4
    ADD V5, 4
    LD V8, V1
    SUB V8, V4
    SE VF, 0
    JP checkLow
    JP miss
checkLow:
    LD V8, V5
    SUB V8, V1
    SE VF, 0
    JP catch
    JP miss
catch:
    LD V2, 1
    ADD V7, 1
    ADD V0, 1
    JP xDone
miss:
    LD V0, 30
    LD V1, 16
    LD V2, 1
    JP xDone
xDone:
    ; ---- Y movement ----
    LD V5, 1
    SE V3, V5
    JP yUp
    JP yDown
yDown:
    LD V5, 31
    SE V1, V5
    JP dInc
    JP flipUp
dInc:
    ADD V1, 1
    JP yDone
flipUp:
    LD V3, 0
    SUB V1, V6
    JP yDone
yUp:
    SE V1, 0
    JP uDec
    JP flipDown
uDec:
    SUB V1, V6
    JP yDone
flipDown:
    LD V3, 1
    ADD V1, 1
yDone:
    JP loop

ball:
    DB 0x80
paddle:
    DB 0x80, 0x80, 0x80, 0x80, 0x80
`
    },

    {
      id: 'catch',
      name: 'Catch',
      blurb: 'A dot falls from the top of the screen. Slide the eight pixel ' +
             'paddle left and right to catch it. Each catch raises the score ' +
             'in V7 and drops a new dot from a random column.',
      controls: '4 = move left, 6 = move right',
      keys: { '4': 'Move left', '6': 'Move right' },
      source: `
; Catch - move the paddle to catch the falling dot.
; Keys: 4 = left, 6 = right.
init:
    LD V6, 1
    LD V3, 28       ; paddle Y (fixed)
    LD V2, 28       ; paddle X
    LD V0, 32       ; dot X
    LD V1, 0        ; dot Y
    LD V7, 0        ; score
loop:
    CLS
    LD I, dot
    DRW V0, V1, 1
    LD I, paddle
    DRW V2, V3, 1
    ; ---- input ----
    LD V5, 4
    SKP V5
    JP noLeft
    SE V2, 0
    JP decX
    JP noLeft
decX:
    SUB V2, V6
noLeft:
    LD V5, 6
    SKP V5
    JP noRight
    LD V5, 56
    SE V2, V5
    JP incX
    JP noRight
incX:
    ADD V2, 1
noRight:
    ; ---- fall ----
    LD V5, 28
    SE V1, V5
    JP falling
    JP checkCatch
falling:
    ADD V1, 1
    JP drawDone
checkCatch:
    LD V8, V0
    SUB V8, V2
    SE VF, 0
    JP checkRight
    JP respawn
checkRight:
    LD V5, V2
    ADD V5, 8
    LD V8, V5
    SUB V8, V0
    SE VF, 0
    JP caught
    JP respawn
caught:
    ADD V7, 1
respawn:
    LD V1, 0
    RND V0, 63
drawDone:
    JP loop

dot:
    DB 0x80
paddle:
    DB 0xFF
`
    },

    {
      id: 'navigator',
      name: 'Navigator',
      blurb: 'Steer the four by four cursor across the screen and overlap ' +
             'the wandering goal. Sprite collision (XOR) registers a hit, ' +
             'adds to the score in V7, and teleports the goal somewhere new.',
      controls: '2 = up, 4 = left, 6 = right, 8 = down',
      keys: { '2': 'Move up', '4': 'Move left', '6': 'Move right', '8': 'Move down' },
      source: `
; Navigator - steer the cursor onto the wandering goal.
; Keys: 2 = up, 4 = left, 6 = right, 8 = down.
init:
    LD V6, 1
    LD V0, 4        ; player X
    LD V1, 4        ; player Y
    LD V2, 40       ; goal X
    LD V3, 20       ; goal Y
    LD V7, 0        ; score
loop:
    ; ---- input ----
    LD V5, 2
    SKP V5
    JP noUp
    SE V1, 0
    JP decY
    JP noUp
decY:
    SUB V1, V6
noUp:
    LD V5, 8
    SKP V5
    JP noDown
    LD V5, 28
    SE V1, V5
    JP incY
    JP noDown
incY:
    ADD V1, 1
noDown:
    LD V5, 4
    SKP V5
    JP noLeft
    SE V0, 0
    JP decX
    JP noLeft
decX:
    SUB V0, V6
noLeft:
    LD V5, 6
    SKP V5
    JP noRight
    LD V5, 60
    SE V0, V5
    JP incX
    JP noRight
incX:
    ADD V0, 1
noRight:
    ; ---- draw + XOR collision ----
    CLS
    LD I, goal
    DRW V2, V3, 4
    LD I, player
    DRW V0, V1, 4
    SNE VF, 0
    JP loop
    ADD V7, 1
    RND V2, 55
    RND V3, 27
    JP loop

goal:
    DB 0xF0, 0x90, 0x90, 0xF0
player:
    DB 0x90, 0xF0, 0xF0, 0x90
`
    },

    {
      id: 'blaster',
      name: 'Blaster',
      blurb: 'A target drifts down the screen. Line up the ship, fire a shot ' +
             'with the middle key, and hit the target to score in V7. The ' +
             'target then respawns in a fresh random column.',
      controls: '4 = move left, 6 = move right, 5 = fire',
      keys: { '4': 'Move left', '6': 'Move right', '5': 'Fire' },
      source: `
; Blaster - move, fire, and shoot the falling target.
; Keys: 4 = left, 6 = right, 5 = fire.
init:
    LD V6, 1
    LD V1, 28       ; player Y (fixed)
    LD V0, 30       ; player X
    LD V2, 20       ; target X
    LD V3, 2        ; target Y
    LD V5, 255      ; bullet Y sentinel (255 = inactive)
    LD V4, 0        ; bullet X
    LD V7, 0        ; score
loop:
    ; ---- input ----
    LD V8, 4
    SKP V8
    JP noLeft
    SE V0, 0
    JP decPX
    JP noLeft
decPX:
    SUB V0, V6
noLeft:
    LD V8, 6
    SKP V8
    JP noRight
    LD V8, 56
    SE V0, V8
    JP incPX
    JP noRight
incPX:
    ADD V0, 1
noRight:
    LD V8, 5
    SKP V8
    JP noFire
    LD V8, 255
    SE V5, V8
    JP noFire
    LD V4, V0
    LD V5, 27
noFire:
    ; ---- bullet ----
    LD V8, 255
    SE V5, V8
    JP bulletActive
    JP targetMove
bulletActive:
    LD V8, V4
    SUB V8, V2
    SE VF, 0
    JP bxHigh
    JP bulletMove
bxHigh:
    LD V8, V2
    ADD V8, 8
    LD V9, V8
    SUB V9, V4
    SE VF, 0
    JP byLow
    JP bulletMove
byLow:
    LD V8, V5
    SUB V8, V3
    SE VF, 0
    JP byHigh
    JP bulletMove
byHigh:
    LD V8, V3
    ADD V8, 4
    LD V9, V8
    SUB V9, V5
    SE VF, 0
    JP hit
    JP bulletMove
hit:
    ADD V7, 1
    LD V5, 255
    RND V2, 55
    LD V3, 2
    JP targetMove
bulletMove:
    SE V5, 0
    JP bDec
    JP bOff
bDec:
    SUB V5, V6
    JP targetMove
bOff:
    LD V5, 255
    JP targetMove
targetMove:
    LD V8, 28
    SE V3, V8
    JP tInc
    JP respawn
tInc:
    ADD V3, 1
    JP draw
respawn:
    RND V2, 55
    LD V3, 2
draw:
    CLS
    LD I, target
    DRW V2, V3, 4
    LD I, ship
    DRW V0, V1, 1
    LD V8, 255
    SE V5, V8
    JP noBulletDraw
    LD I, bullet
    DRW V4, V5, 1
noBulletDraw:
    JP loop

target:
    DB 0xFF, 0x81, 0x81, 0xFF
ship:
    DB 0xFF
bullet:
    DB 0x80
`
    }

  ];

  // Compile every source into a ready to load ROM descriptor.
  // Pass an assemble function explicitly, or rely on the one captured at load.
  function build(assembleFn) {
    var fn = assembleFn || assemble;
    if (typeof fn !== 'function') {
      throw new Error('roms.js: assembler.js must be loaded before building ROMs');
    }
    return definitions.map(function (def) {
      var bytes = fn(def.source, ORIGIN);
      return {
        id: def.id,
        name: def.name,
        blurb: def.blurb,
        controls: def.controls,
        keys: def.keys,
        source: def.source,
        origin: ORIGIN,
        bytes: bytes
      };
    });
  }

  var api = {
    ORIGIN: ORIGIN,
    KEY_LABELS: KEY_LABELS,
    definitions: definitions,
    build: build
  };

  // When the assembler was available at load time, expose a compiled list too.
  if (assemble) { api.list = build(assemble); }

  return api;
}));
