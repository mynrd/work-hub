// The QR encoder is hand-rolled (no npm in this repo), so it gets checked three
// ways: the published level-M capacity table, the structural patterns a scanner
// looks for, and a decoder that reads the symbol back.
//
// The decoder below deliberately does NOT import anything private from qr.mjs.
// It rederives where the function patterns sit from the geometry in ISO/IEC
// 18004, so a placement bug in the encoder shows up as a failed round trip
// rather than being cancelled out by the same bug on both sides.

import test from 'node:test';
import assert from 'node:assert/strict';

import { encodeQr, sizeOf, dataCapacity, byteCapacity, renderQrToTerminal } from '../src/lib/qr.mjs';
import { CODEWORD_VECTORS } from './fixtures/qr-codewords.mjs';

// ── An independent decoder ───────────────────────────────────────────────────

function alignmentCentres(version) {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step = Math.floor((version * 4 + count * 2 + 1) / (count * 2 - 2)) * 2;
  const out = [];
  for (let pos = sizeOf(version) - 7; out.length < count - 1; pos -= step) out.unshift(pos);
  return [6, ...out];
}

/** True where a module belongs to a fixed pattern rather than to the data. */
function isFunctionModule(version, size, r, c) {
  // Finder patterns with their separators: the 9x9 at three corners.
  if (r <= 8 && c <= 8) return true;
  if (r <= 8 && c >= size - 8) return true;
  if (r >= size - 8 && c <= 8) return true;
  // Timing patterns.
  if (r === 6 || c === 6) return true;
  // Version information blocks, versions 7 and up.
  if (version >= 7) {
    if (r < 6 && c >= size - 11 && c < size - 8) return true;
    if (c < 6 && r >= size - 11 && r < size - 8) return true;
  }
  // Alignment patterns.
  const centres = alignmentCentres(version);
  const last = centres.length - 1;
  for (let i = 0; i < centres.length; i++) {
    for (let j = 0; j < centres.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
      if (Math.abs(r - centres[i]) <= 2 && Math.abs(c - centres[j]) <= 2) return true;
    }
  }
  return false;
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(c / 3) + Math.floor(r / 2)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

/** Reads the first copy of the format strip and checks its BCH code. */
function readFormat(modules, size) {
  let bits = 0;
  const take = (i, r, c) => { bits |= modules[r][c] << i; };
  for (let i = 0; i <= 5; i++) take(i, i, 8);
  take(6, 7, 8);
  take(7, 8, 8);
  take(8, 8, 7);
  for (let i = 9; i < 15; i++) take(i, 8, 14 - i);

  const unmasked = bits ^ 0x5412;
  let rem = unmasked;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  // A valid 15 bit BCH(15,5) word divides cleanly by the generator.
  let check = unmasked;
  for (let i = 14; i >= 10; i--) {
    if ((check >>> i) & 1) check ^= 0x537 << (i - 10);
  }
  return { ecBits: (unmasked >>> 13) & 3, mask: (unmasked >>> 10) & 7, valid: check === 0 };
}

const EC_M = {
  1: { ec: 10, g1: 1, g2: 0 }, 2: { ec: 16, g1: 1, g2: 0 }, 3: { ec: 26, g1: 1, g2: 0 },
  4: { ec: 18, g1: 2, g2: 0 }, 5: { ec: 24, g1: 2, g2: 0 }, 6: { ec: 16, g1: 4, g2: 0 },
  7: { ec: 18, g1: 4, g2: 0 }, 8: { ec: 22, g1: 2, g2: 2 }, 9: { ec: 22, g1: 3, g2: 2 },
  10: { ec: 26, g1: 4, g2: 1 },
};

/** Reads a symbol back to the string it carries. Throws if anything is off. */
function decodeQr({ modules, size }) {
  const version = (size - 17) / 4;
  assert.ok(Number.isInteger(version) && version >= 1 && version <= 10, `bad size ${size}`);

  const format = readFormat(modules, size);
  assert.equal(format.valid, true, 'format information failed its BCH check');
  assert.equal(format.ecBits, 0b00, 'format information does not say level M');
  const maskFn = MASKS[format.mask];

  // Walk the zigzag, unmasking as we go.
  const bits = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const col = right - j;
        const upward = ((right + 1) & 2) === 0;
        const row = upward ? size - 1 - vert : vert;
        if (isFunctionModule(version, size, row, col)) continue;
        bits.push(modules[row][col] ^ (maskFn(row, col) ? 1 : 0));
      }
    }
  }

  const stream = [];
  for (let i = 0; i + 7 < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    stream.push(byte);
  }

  // Undo the interleave: take the data half back into its blocks.
  const spec = EC_M[version];
  const blocks = spec.g1 + spec.g2;
  const dataTotal = dataCapacity(version);
  const shortLen = Math.floor(dataTotal / blocks);
  const lengths = Array.from({ length: blocks }, (_, b) => (b < spec.g1 ? shortLen : shortLen + 1));

  const dataBlocks = lengths.map((len) => new Array(len));
  let idx = 0;
  for (let i = 0; i <= shortLen; i++) {
    for (let b = 0; b < blocks; b++) {
      if (i < lengths[b]) dataBlocks[b][i] = stream[idx++];
    }
  }
  const payload = dataBlocks.flat();

  assert.equal(payload[0] >>> 4, 0b0100, 'mode indicator is not byte mode');
  let cursor;
  let length;
  if (version >= 10) {
    length = ((payload[0] & 0x0f) << 12) | (payload[1] << 4) | (payload[2] >>> 4);
    // The 16 bit count leaves the byte stream nibble-aligned from here.
    const nibbles = [];
    for (let i = 2; i < payload.length; i++) { nibbles.push(payload[i] & 0x0f, payload[i + 1] >>> 4); }
    const out = [];
    for (let i = 0; i < length; i++) out.push((nibbles[i * 2] << 4) | nibbles[i * 2 + 1]);
    return Buffer.from(out).toString('utf8');
  }
  length = ((payload[0] & 0x0f) << 4) | (payload[1] >>> 4);
  cursor = 1;
  const out = [];
  for (let i = 0; i < length; i++) {
    out.push(((payload[cursor] & 0x0f) << 4) | (payload[cursor + 1] >>> 4));
    cursor++;
  }
  return Buffer.from(out).toString('utf8');
}

/** Every codeword laid into the symbol, data then error correction. */
function readCodewords({ modules, size }) {
  const version = (size - 17) / 4;
  const maskFn = MASKS[readFormat(modules, size).mask];
  const bits = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const col = right - j;
        const upward = ((right + 1) & 2) === 0;
        const row = upward ? size - 1 - vert : vert;
        if (isFunctionModule(version, size, row, col)) continue;
        bits.push(modules[row][col] ^ (maskFn(row, col) ? 1 : 0));
      }
    }
  }
  const out = [];
  for (let i = 0; i + 7 < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    out.push(byte);
  }
  return out;
}

// ── Against an outside implementation ────────────────────────────────────────
//
// The round trip below proves this encoder is self-consistent, which is not the
// same as correct: it reads the data codewords and ignores the error correction
// ones entirely, so a broken Reed-Solomon passes it. That is exactly what
// happened - the generator polynomial was built with its coefficients reversed,
// every symbol carried valid data behind garbage EC bytes, the round trip was
// green, and no phone would scan any of it. These vectors come from outside.

test('the codewords match an independent encoder, error correction included', () => {
  for (const vector of CODEWORD_VECTORS) {
    const text = vector.text ?? vector.repeat[0].repeat(vector.repeat[1]);
    const symbol = encodeQr(text);
    assert.equal(symbol.version, vector.version, `version for ${text.slice(0, 20)}`);

    const expected = vector.codewords;
    const actual = readCodewords(symbol).slice(0, expected.length / 2)
      .map((b) => b.toString(16).padStart(2, '0')).join('');

    if (actual !== expected) {
      const at = [...expected].findIndex((ch, i) => ch !== actual[i]);
      const dataBytes = dataCapacity(vector.version);
      const where = at / 2 < dataBytes ? 'data codewords' : 'error correction codewords';
      assert.fail(`version ${vector.version}: first difference in the ${where}, at byte ${Math.floor(at / 2)}`);
    }
  }
});

// ── Capacities ───────────────────────────────────────────────────────────────

test('data codeword counts match the published level M table', () => {
  // ISO/IEC 18004 table 9, level M, versions 1-10.
  const expected = [16, 28, 44, 64, 86, 108, 124, 154, 182, 216];
  for (let v = 1; v <= 10; v++) assert.equal(dataCapacity(v), expected[v - 1], `version ${v}`);
});

test('the smallest version that fits is the one chosen', () => {
  assert.equal(encodeQr('x'.repeat(byteCapacity(1))).version, 1);
  assert.equal(encodeQr('x'.repeat(byteCapacity(1) + 1)).version, 2);
  assert.equal(encodeQr('x'.repeat(byteCapacity(6))).version, 6);
  assert.equal(encodeQr('x'.repeat(byteCapacity(6) + 1)).version, 7);
});

test('a payload past version 10 is refused with the limit named', () => {
  assert.throws(() => encodeQr('x'.repeat(byteCapacity(10) + 1)), /version 10 symbol \(max 213\)/);
});

// ── Structure ────────────────────────────────────────────────────────────────

test('the three finder patterns and both timing patterns are where a scanner looks', () => {
  const { modules, size } = encodeQr('https://example.test/some/path');
  for (const [br, bc] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    for (let dr = 0; dr < 7; dr++) {
      for (let dc = 0; dc < 7; dc++) {
        const ring = Math.max(Math.abs(dr - 3), Math.abs(dc - 3));
        assert.equal(modules[br + dr][bc + dc], ring === 2 ? 0 : 1, `finder at ${br},${bc} offset ${dr},${dc}`);
      }
    }
  }
  for (let i = 8; i < size - 8; i++) {
    assert.equal(modules[6][i], i % 2 === 0 ? 1 : 0, `horizontal timing at column ${i}`);
    assert.equal(modules[i][6], i % 2 === 0 ? 1 : 0, `vertical timing at row ${i}`);
  }
  assert.equal(modules[size - 8][8], 1, 'the always-dark module');
});

test('both copies of the format information agree', () => {
  const { modules, size } = encodeQr('format check');
  const first = readFormat(modules, size);
  let second = 0;
  for (let i = 0; i < 8; i++) second |= modules[8][size - 1 - i] << i;
  for (let i = 8; i < 15; i++) second |= modules[size - 15 + i][8] << i;
  const unmasked = second ^ 0x5412;
  assert.equal((unmasked >>> 10) & 7, first.mask);
  assert.equal((unmasked >>> 13) & 3, first.ecBits);
});

// ── Round trip ───────────────────────────────────────────────────────────────

test('every symbol decodes back to what went in', () => {
  const cases = [
    'A',
    'HELLO WORLD',
    'otpauth://totp/Work%20Hub:mynrd@DESKTOP-1?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Work%20Hub&algorithm=SHA1&digits=6&period=30',
    'x'.repeat(byteCapacity(1)),
    'x'.repeat(byteCapacity(4)),
    'y'.repeat(byteCapacity(8)),
    'z'.repeat(byteCapacity(9)),
  ];
  for (const text of cases) {
    const symbol = encodeQr(text);
    assert.equal(decodeQr(symbol), text, `round trip failed at version ${symbol.version}`);
  }
});

test('a version 10 symbol round trips through the 16 bit length field', () => {
  const text = 'q'.repeat(byteCapacity(10));
  const symbol = encodeQr(text);
  assert.equal(symbol.version, 10);
  assert.equal(decodeQr(symbol), text);
});

// ── Terminal rendering ───────────────────────────────────────────────────────

test('the terminal render carries the four module quiet zone on every side', () => {
  const { size } = encodeQr('quiet zone');
  const lines = renderQrToTerminal('quiet zone', { color: false }).split('\n');
  const total = size + 8;
  assert.equal(lines.length, Math.ceil(total / 2));
  // With color off the light modules are drawn, so a full quiet-zone row is all
  // full blocks and nothing else.
  assert.equal(lines[0], '█'.repeat(total));
  assert.equal(lines[1], '█'.repeat(total));
  for (const line of lines) {
    assert.match(line, /^█{4}/, 'left quiet zone');
    assert.match(line, /█{4}$/, 'right quiet zone');
  }
});

// The encoder can be perfect and the printed code still unscannable if the half
// block mapping is inverted or off by a row. This reads the glyphs back.
test('the printed glyphs decode to the same symbol that was encoded', () => {
  const text = 'otpauth://totp/Work%20Hub:me@box?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Work%20Hub';
  const symbol = encodeQr(text);
  const quiet = 4;
  const lines = renderQrToTerminal(text, { color: false, quiet }).split('\n');

  // With color off the glyph paints the light modules, so it inverts on read.
  const TOP = { ' ': 1, '▄': 1, '▀': 0, '█': 0 };
  const BOTTOM = { ' ': 1, '▄': 0, '▀': 1, '█': 0 };

  const painted = [];
  for (const line of lines) {
    const glyphs = Array.from(line);
    painted.push(glyphs.map((g) => TOP[g]), glyphs.map((g) => BOTTOM[g]));
  }

  for (let r = 0; r < symbol.size; r++) {
    for (let c = 0; c < symbol.size; c++) {
      assert.equal(painted[r + quiet][c + quiet], symbol.modules[r][c], `module ${r},${c} printed wrong`);
    }
  }
  assert.equal(decodeQr(symbol), text);
});

test('the coloured render pins both colours on every cell, so a dark theme cannot invert it', () => {
  const line = renderQrToTerminal('theme', { color: true }).split('\n')[0];
  const cells = line.split('▀').length - 1;
  assert.ok(cells > 0);
  // Every cell writes a foreground and a background before its glyph.
  assert.equal(line.split('[97m').length - 1 + (line.split('[30m').length - 1), cells);
  assert.equal(line.split('[107m').length - 1 + (line.split('[40m').length - 1), cells);
  assert.match(line, /\[0m$/);
});
