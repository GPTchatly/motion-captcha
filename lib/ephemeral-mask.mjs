export const EPHEMERAL_MASK_WIDTH = 70;
export const EPHEMERAL_MASK_HEIGHT = 84;
export const MASK_ENCODING_ALPHA4 = 'alpha4-base64-v1';

const MAX_AUGMENTATION_ATTEMPTS = 8;
const MIN_INK_COVERAGE = 0.035;
const MAX_INK_COVERAGE = 0.58;

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function createFastRandom(seed) {
  let state = seed >>> 0 || 0x9e3779b9;

  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function randomBetween(random, minimum, maximum) {
  return minimum + (maximum - minimum) * random();
}

function decodeAlpha(encodedAlpha, width, height) {
  if (typeof encodedAlpha !== 'string' || encodedAlpha.length === 0) {
    throw new TypeError('A source mask must contain Base64 alpha data.');
  }

  const decoded = Buffer.from(encodedAlpha, 'base64');

  if (decoded.length !== width * height) {
    throw new RangeError('A source mask does not match the configured dimensions.');
  }

  return decoded;
}

function sampleAlpha(alpha, width, height, x, y) {
  if (x < 0 || y < 0 || x > width - 1 || y > height - 1) {
    return 0;
  }

  const left = Math.floor(x);
  const top = Math.floor(y);
  const right = Math.min(width - 1, left + 1);
  const bottom = Math.min(height - 1, top + 1);
  const horizontal = x - left;
  const vertical = y - top;
  const topValue = alpha[top * width + left] * (1 - horizontal) + alpha[top * width + right] * horizontal;
  const bottomValue =
    alpha[bottom * width + left] * (1 - horizontal) + alpha[bottom * width + right] * horizontal;

  return topValue * (1 - vertical) + bottomValue * vertical;
}

function sampleWithStrokeVariation(alpha, width, height, x, y, strokeVariation) {
  const center = sampleAlpha(alpha, width, height, x, y);

  if (strokeVariation === 0) {
    return center;
  }

  const samples = [
    center,
    sampleAlpha(alpha, width, height, x - 0.85, y),
    sampleAlpha(alpha, width, height, x + 0.85, y),
    sampleAlpha(alpha, width, height, x, y - 0.85),
    sampleAlpha(alpha, width, height, x, y + 0.85)
  ];

  return strokeVariation > 0 ? Math.max(...samples) : Math.min(...samples);
}

function createAugmentedAlpha(sourceAlpha, sourceWidth, sourceHeight, seed) {
  const random = createFastRandom(seed);
  const angle = randomBetween(random, -0.18, 0.18);
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const scaleX = randomBetween(random, 0.84, 0.98);
  const scaleY = randomBetween(random, 0.84, 0.98);
  const shear = randomBetween(random, -0.1, 0.1);
  const translateX = randomBetween(random, -0.045, 0.045);
  const translateY = randomBetween(random, -0.045, 0.045);
  const waveX = randomBetween(random, 0.008, 0.035);
  const waveY = randomBetween(random, 0.008, 0.03);
  const frequencyX = randomBetween(random, 1.1, 2.8);
  const frequencyY = randomBetween(random, 1.1, 2.8);
  const phaseX = randomBetween(random, 0, Math.PI * 2);
  const phaseY = randomBetween(random, 0, Math.PI * 2);
  const strokeVariation = random() < 0.4 ? -1 : random() < 0.72 ? 0 : 1;
  const output = Buffer.alloc(EPHEMERAL_MASK_WIDTH * EPHEMERAL_MASK_HEIGHT);

  for (let y = 0; y < EPHEMERAL_MASK_HEIGHT; y += 1) {
    for (let x = 0; x < EPHEMERAL_MASK_WIDTH; x += 1) {
      const normalizedX = ((x + 0.5) / EPHEMERAL_MASK_WIDTH) * 2 - 1;
      const normalizedY = ((y + 0.5) / EPHEMERAL_MASK_HEIGHT) * 2 - 1;
      const displacedX =
        normalizedX +
        Math.sin(normalizedY * Math.PI * frequencyX + phaseX) * waveX -
        translateX;
      const displacedY =
        normalizedY +
        Math.sin(normalizedX * Math.PI * frequencyY + phaseY) * waveY -
        translateY;
      const unshearedX = displacedX - shear * displacedY;
      const rotatedX = cosine * unshearedX + sine * displacedY;
      const rotatedY = -sine * unshearedX + cosine * displacedY;
      const sourceX = ((rotatedX / scaleX + 1) / 2) * (sourceWidth - 1);
      const sourceY = ((rotatedY / scaleY + 1) / 2) * (sourceHeight - 1);
      const sampled = sampleWithStrokeVariation(
        sourceAlpha,
        sourceWidth,
        sourceHeight,
        sourceX,
        sourceY,
        strokeVariation
      );
      const alphaNoise = sampled > 6 && sampled < 249 ? randomBetween(random, -11, 11) : 0;
      output[y * EPHEMERAL_MASK_WIDTH + x] = Math.round(clamp(sampled + alphaNoise, 0, 255));
    }
  }

  return output;
}

function hasValidInkCoverage(alpha) {
  let inkPixels = 0;

  for (const value of alpha) {
    if (value >= 64) {
      inkPixels += 1;
    }
  }

  const coverage = inkPixels / alpha.length;
  return coverage >= MIN_INK_COVERAGE && coverage <= MAX_INK_COVERAGE;
}

export function packAlpha4(alpha) {
  if (!(alpha instanceof Uint8Array) && !Buffer.isBuffer(alpha)) {
    throw new TypeError('Alpha data must be a byte array.');
  }

  const packed = Buffer.alloc(Math.ceil(alpha.length / 2));

  for (let index = 0; index < alpha.length; index += 2) {
    const high = Math.round(alpha[index] / 17) & 0x0f;
    const low = index + 1 < alpha.length ? Math.round(alpha[index + 1] / 17) & 0x0f : 0;
    packed[index / 2] = (high << 4) | low;
  }

  return packed.toString('base64');
}

export function createEphemeralMask({ variants, sourceWidth, sourceHeight, randomIntFn, usedMasks }) {
  if (!Array.isArray(variants) || variants.length === 0) {
    throw new TypeError('At least one source glyph variant is required.');
  }

  if (!Number.isInteger(sourceWidth) || !Number.isInteger(sourceHeight) || sourceWidth < 1 || sourceHeight < 1) {
    throw new RangeError('Source mask dimensions must be positive integers.');
  }

  if (typeof randomIntFn !== 'function') {
    throw new TypeError('A cryptographic integer generator is required.');
  }

  const fingerprints = usedMasks instanceof Set ? usedMasks : new Set();

  for (let attempt = 0; attempt < MAX_AUGMENTATION_ATTEMPTS; attempt += 1) {
    const source = variants[randomIntFn(variants.length)];
    const sourceAlpha = decodeAlpha(source, sourceWidth, sourceHeight);
    const seed = randomIntFn(0x7fffffff);
    const augmentedAlpha = createAugmentedAlpha(sourceAlpha, sourceWidth, sourceHeight, seed);

    if (!hasValidInkCoverage(augmentedAlpha)) {
      continue;
    }

    const packedAlpha = packAlpha4(augmentedAlpha);

    if (fingerprints.has(packedAlpha)) {
      continue;
    }

    fingerprints.add(packedAlpha);
    return {
      alpha: packedAlpha,
      encoding: MASK_ENCODING_ALPHA4,
      width: EPHEMERAL_MASK_WIDTH,
      height: EPHEMERAL_MASK_HEIGHT
    };
  }

  throw new Error('Unable to create a valid one-time glyph mask.');
}
