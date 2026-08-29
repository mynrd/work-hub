// A QR encoder, byte mode, error correction level M, versions 1-10.
//
// This exists because the repo takes no third-party dependency (see the header
// of serve.mjs), and the enrollment secret must never leave the machine - which
// rules out the usual "GET some QR service with the otpauth URI in the query
// string" shortcut. Version 10 at level M holds 213 bytes; an otpauth URI is
// around 130, so the ceiling is not close.
//
// Structure follows ISO/IEC 18004: build the function patterns, lay the data in
// the zigzag, try all eight masks, keep the one with the lowest penalty.

// GF(256), primitive polynomial x^8 + x^4 + x^3 + x^2 + 1 (0x11D)

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

/**
 * The generator polynomial for `degree` error correction codewords: the product
 * of (x - a^i) for i in 0..degree-1.
 *
 * Coefficients are stored highest power first, so poly[0] is always 1. That
 * ordering is the whole trick here: multiplying by x contributes poly[j] to
 * next[j], and scaling by a^i contributes it to next[j + 1]. Swapping those two
 * builds the polynomial backwards, which still produces plausible-looking
 * codewords - and a symbol no scanner will accept.
 */
function rsGenerator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

/** Polynomial division remainder - the EC codewords for one block. */
function rsEncode(data, degree) {
  const gen = rsGenerator(degree);
  const rem = new Uint8Array(degree);
  for (const byte of data) {
    const factor = byte ^ rem[0];
    rem.copyWithin(0, 1);
    rem[degree - 1] = 0;
    for (let i = 0; i < degree; i++) rem[i] ^= gfMul(gen[i + 1], factor);
  }
  return rem;
}

// Block layout, level M, versions 1-10.
//
// `ec` is EC codewords per block; `g1`/`g2` are how many blocks are in the
// short group and the one-codeword-longer group. The data codeword counts are
// not listed here - they are derived from the module count of the matrix, so a
// typo in this table throws rather than producing a silently corrupt symbol.

const EC_M = {
  1: { ec: 10, g1: 1, g2: 0 },
  2: { ec: 16, g1: 1, g2: 0 },
  3: { ec: 26, g1: 1, g2: 0 },
  4: { ec: 18, g1: 2, g2: 0 },
  5: { ec: 24, g1: 2, g2: 0 },
  6: { ec: 16, g1: 4, g2: 0 },
  7: { ec: 18, g1: 4, g2: 0 },
  8: { ec: 22, g1: 2, g2: 2 },
  9: { ec: 22, g1: 3, g2: 2 },
  10: { ec: 26, g1: 4, g2: 1 },
};

const MAX_VERSION = 10;
const EC_FORMAT_BITS = 0b00; // level M

export function sizeOf(version) {
  return version * 4 + 17;
}

/** Alignment pattern centre coordinates, per ISO/IEC 18004 section 6.3.6. */
function alignmentCentres(version) {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step = Math.floor((version * 4 + count * 2 + 1) / (count * 2 - 2)) * 2;
  const out = [];
  for (let pos = sizeOf(version) - 7; out.length < count - 1; pos -= step) out.unshift(pos);
  return [6, ...out];
}

// Function patterns

function newGrid(size) {
  return Array.from({ length: size }, () => new Uint8Array(size));
}

/**
 * Draws every fixed pattern and returns `{ modules, reserved }`. `reserved`
 * marks the modules the data stream must skip and the mask must not flip.
 */
function drawFunctionPatterns(version) {
  const size = sizeOf(version);
  const modules = newGrid(size);
  const reserved = newGrid(size);

  const set = (row, col, dark) => {
    if (row < 0 || col < 0 || row >= size || col >= size) return;
    modules[row][col] = dark ? 1 : 0;
    reserved[row][col] = 1;
  };

  // Timing patterns first; the finders overwrite their ends.
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }

  // Finder pattern plus its white separator: the 9x9 around each centre, where
  // a module is dark unless its Chebyshev distance from the centre is 2 or 4.
  for (const [cr, cc] of [[3, 3], [3, size - 4], [size - 4, 3]]) {
    for (let dr = -4; dr <= 4; dr++) {
      for (let dc = -4; dc <= 4; dc++) {
        const dist = Math.max(Math.abs(dr), Math.abs(dc));
        set(cr + dr, cc + dc, dist !== 2 && dist !== 4);
      }
    }
  }

  // Alignment patterns, skipping the three that would sit on a finder.
  const centres = alignmentCentres(version);
  const last = centres.length - 1;
  for (let i = 0; i < centres.length; i++) {
    for (let j = 0; j < centres.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          set(centres[i] + dr, centres[j] + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
        }
      }
    }
  }

  // Reserve the format information strips. The real bits are written per mask.
  for (let i = 0; i <= 8; i++) {
    reserved[8][i] = 1;
    reserved[i][8] = 1;
  }
  for (let i = 0; i < 8; i++) {
    reserved[8][size - 1 - i] = 1;
    reserved[size - 1 - i][8] = 1;
  }
  set(size - 8, 8, true); // the module that is always dark

  // Version information, versions 7 and up: an 18 bit BCH code in two blocks.
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const bit = ((bits >>> i) & 1) === 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(b, a, bit); // top right
      set(a, b, bit); // bottom left
    }
  }

  return { modules, reserved, size };
}

/** How many codewords fit in a version, counted off the actual free modules. */
function totalCodewords(version) {
  const { reserved, size } = drawFunctionPatterns(version);
  let free = 0;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (!reserved[r][c]) free++;
  return Math.floor(free / 8);
}

/** Data codewords available to the payload, after the EC codewords are taken. */
export function dataCapacity(version) {
  const spec = EC_M[version];
  const blocks = spec.g1 + spec.g2;
  return totalCodewords(version) - spec.ec * blocks;
}

/** Longest byte payload a version holds, allowing for the mode and count header. */
export function byteCapacity(version) {
  const headerBits = 4 + (version >= 10 ? 16 : 8);
  return Math.floor((dataCapacity(version) * 8 - headerBits) / 8);
}

// Bit stream

function buildCodewords(bytes, version) {
  const capacity = dataCapacity(version);
  const bits = [];
  const push = (value, count) => {
    for (let i = count - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };

  push(0b0100, 4); // byte mode
  push(bytes.length, version >= 10 ? 16 : 8);
  for (const byte of bytes) push(byte, 8);

  const limit = capacity * 8;
  push(0, Math.min(4, limit - bits.length)); // terminator, truncated if it does not fit
  while (bits.length % 8 !== 0) bits.push(0);

  const out = new Uint8Array(capacity);
  for (let i = 0; i < bits.length; i++) out[i >>> 3] |= bits[i] << (7 - (i & 7));
  // Pad bytes alternate 11101100 / 00010001, per section 7.4.10.
  for (let i = bits.length / 8, alt = 0; i < capacity; i++, alt ^= 1) out[i] = alt ? 0x11 : 0xec;
  return out;
}

/** Splits into blocks, appends EC, and interleaves both halves. */
function interleave(codewords, version) {
  const spec = EC_M[version];
  const blocks = spec.g1 + spec.g2;
  const shortLen = Math.floor(codewords.length / blocks);
  if (spec.g1 * shortLen + spec.g2 * (shortLen + 1) !== codewords.length) {
    throw new Error(`Block table for version ${version} does not divide ${codewords.length} data codewords.`);
  }

  const dataBlocks = [];
  const ecBlocks = [];
  let offset = 0;
  for (let b = 0; b < blocks; b++) {
    const len = b < spec.g1 ? shortLen : shortLen + 1;
    const block = codewords.subarray(offset, offset + len);
    offset += len;
    dataBlocks.push(block);
    ecBlocks.push(rsEncode(block, spec.ec));
  }

  const out = [];
  for (let i = 0; i <= shortLen; i++) for (const b of dataBlocks) if (i < b.length) out.push(b[i]);
  for (let i = 0; i < spec.ec; i++) for (const b of ecBlocks) out.push(b[i]);
  return Uint8Array.from(out);
}

// Placement, masking, scoring

function placeCodewords(modules, reserved, size, data) {
  let bit = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // column 6 is the vertical timing pattern
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const col = right - j;
        const upward = ((right + 1) & 2) === 0;
        const row = upward ? size - 1 - vert : vert;
        if (reserved[row][col] || bit >= data.length * 8) continue;
        modules[row][col] = (data[bit >>> 3] >>> (7 - (bit & 7))) & 1;
        bit++;
      }
    }
  }
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

function applyMask(modules, reserved, size, mask) {
  const fn = MASKS[mask];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!reserved[r][c] && fn(r, c)) modules[r][c] ^= 1;
    }
  }
}

function drawFormatBits(modules, size, mask) {
  const data = (EC_FORMAT_BITS << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const bit = (i) => (bits >>> i) & 1;

  for (let i = 0; i <= 5; i++) modules[i][8] = bit(i);
  modules[7][8] = bit(6);
  modules[8][8] = bit(7);
  modules[8][7] = bit(8);
  for (let i = 9; i < 15; i++) modules[8][14 - i] = bit(i);

  for (let i = 0; i < 8; i++) modules[8][size - 1 - i] = bit(i);
  for (let i = 8; i < 15; i++) modules[size - 15 + i][8] = bit(i);
  modules[size - 8][8] = 1;
}

/** ISO/IEC 18004 section 7.8.3: the four penalty rules, lowest total wins. */
function penalty(modules, size) {
  let score = 0;

  const scanLine = (get) => {
    let runColor = get(0);
    let runLength = 1;
    const history = [];
    for (let i = 1; i <= size; i++) {
      const value = i < size ? get(i) : -1;
      if (value === runColor) {
        runLength++;
        continue;
      }
      if (runLength >= 5) score += 3 + (runLength - 5); // rule 1
      history.push({ color: runColor, length: runLength });
      runColor = value;
      runLength = 1;
    }
    // Rule 3: the finder-like 1:1:3:1:1 run with four light modules on a side.
    for (let i = 0; i + 4 < history.length; i++) {
      const [a, b, c, d, e] = history.slice(i, i + 5);
      if (a.color !== 1 || b.color !== 0 || c.color !== 1 || d.color !== 0 || e.color !== 1) continue;
      const unit = a.length;
      if (unit === 0 || b.length !== unit || c.length !== unit * 3 || d.length !== unit || e.length !== unit) continue;
      const before = i > 0 ? history[i - 1] : null;
      const after = i + 5 < history.length ? history[i + 5] : null;
      if (i === 0 || (before && before.color === 0 && before.length >= unit * 4)) score += 40;
      else if (i + 5 === history.length || (after && after.color === 0 && after.length >= unit * 4)) score += 40;
    }
  };

  for (let r = 0; r < size; r++) scanLine((c) => modules[r][c]);
  for (let c = 0; c < size; c++) scanLine((r) => modules[r][c]);

  // Rule 2: every 2x2 block of one colour.
  for (let r = 0; r + 1 < size; r++) {
    for (let c = 0; c + 1 < size; c++) {
      const v = modules[r][c];
      if (v === modules[r][c + 1] && v === modules[r + 1][c] && v === modules[r + 1][c + 1]) score += 3;
    }
  }

  // Rule 4: how far the dark share sits from half.
  let dark = 0;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) dark += modules[r][c];
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;

  return score;
}

// Entry point

/**
 * Encodes `text` (UTF-8, byte mode) at error correction level M.
 * Returns `{ version, size, mask, modules }`; `modules[row][col]` is 1 for dark.
 */
export function encodeQr(text) {
  const bytes = Buffer.from(String(text), 'utf8');

  let version = 0;
  for (let v = 1; v <= MAX_VERSION; v++) {
    if (bytes.length <= byteCapacity(v)) { version = v; break; }
  }
  if (!version) {
    throw new Error(`${bytes.length} bytes does not fit in a version ${MAX_VERSION} symbol (max ${byteCapacity(MAX_VERSION)}).`);
  }

  const data = interleave(buildCodewords(bytes, version), version);
  const { reserved, size } = drawFunctionPatterns(version);

  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const { modules } = drawFunctionPatterns(version);
    placeCodewords(modules, reserved, size, data);
    applyMask(modules, reserved, size, mask);
    drawFormatBits(modules, size, mask);
    const score = penalty(modules, size);
    if (!best || score < best.score) best = { score, mask, modules };
  }

  return { version, size, mask: best.mask, modules: best.modules };
}

// Terminal rendering

const CSI = String.fromCharCode(27) + '[';
const WHITE_FG = CSI + '97m';
const WHITE_BG = CSI + '107m';
const BLACK_FG = CSI + '30m';
const BLACK_BG = CSI + '40m';
const RESET = CSI + '0m';

const UPPER_HALF = '▀';
const LOWER_HALF = '▄';
const FULL_BLOCK = '█';

/**
 * Renders a symbol as text for a terminal.
 *
 * Each character cell carries two vertically stacked modules using the upper
 * half block, and the colours are written as explicit ANSI foreground and
 * background rather than left to the terminal theme - a dark themed console
 * would otherwise render an inverted symbol, which no scanner reads. The four
 * module quiet zone is mandatory (section 6.3.8); without it phones fail to
 * lock on.
 *
 * With `color: false` the same symbol is drawn from block characters alone, for
 * a console with no ANSI support. That one only scans on a light background,
 * which is why it is not the default.
 */
export function renderQrToTerminal(text, { quiet = 4, color = true } = {}) {
  const { modules, size } = encodeQr(text);
  const total = size + quiet * 2;
  const at = (r, c) => {
    const rr = r - quiet;
    const cc = c - quiet;
    if (rr < 0 || cc < 0 || rr >= size || cc >= size) return 0;
    return modules[rr][cc];
  };

  const lines = [];
  for (let r = 0; r < total; r += 2) {
    let line = '';
    for (let c = 0; c < total; c++) {
      const top = at(r, c);
      const bottom = r + 1 < total ? at(r + 1, c) : 0;
      if (!color) {
        // No ANSI: the glyphs draw the light modules, so the ink is the paper.
        line += top && bottom ? ' ' : top ? LOWER_HALF : bottom ? UPPER_HALF : FULL_BLOCK;
        continue;
      }
      // The glyph is the upper half block, so its foreground paints the top
      // module and its background paints the bottom one.
      line += (top ? BLACK_FG : WHITE_FG) + (bottom ? BLACK_BG : WHITE_BG) + UPPER_HALF;
    }
    lines.push(color ? line + RESET : line);
  }
  return lines.join('\n');
}
