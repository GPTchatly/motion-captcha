export const MASK_ENCODING_ALPHA4 = 'alpha4-base64-v1';
export const PROTOCOL_VERSION = 2;
export const DISPLAY_OBJECT_COUNT = 8;
export const TARGET_GLYPH_COUNT = 4;
export const CSRF_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function sanitizeNextPath(candidate, fallback = '/index.html') {
  if (typeof candidate !== 'string' || candidate.trim() === '') {
    return fallback;
  }

  try {
    const resolved = new URL(candidate, window.location.origin);

    if (resolved.origin !== window.location.origin) {
      return fallback;
    }

    const pathname = resolved.pathname.replace(/\/{2,}/g, '/');

    if (pathname !== '/' && pathname !== '/index.html') {
      return fallback;
    }

    return `/index.html${resolved.search}${resolved.hash}`;
  } catch {
    return fallback;
  }
}

export function decodeAlpha4(value, pixelCount) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError('Challenge mask data is missing.');
  }

  const binary = window.atob(value);
  const expectedLength = Math.ceil(pixelCount / 2);

  if (binary.length !== expectedLength) {
    throw new RangeError('Challenge mask dimensions do not match its alpha data.');
  }

  const alpha = new Uint8Array(pixelCount);

  for (let packedIndex = 0, pixelIndex = 0; packedIndex < binary.length; packedIndex += 1) {
    const packed = binary.charCodeAt(packedIndex);
    alpha[pixelIndex] = (packed >>> 4) * 17;
    pixelIndex += 1;

    if (pixelIndex < pixelCount) {
      alpha[pixelIndex] = (packed & 0x0f) * 17;
      pixelIndex += 1;
    }
  }

  return alpha;
}

export function validateChallengePayload(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new TypeError('Challenge response is invalid.');
  }

  if (
    data.protocolVersion !== PROTOCOL_VERSION ||
    data.maskEncoding !== MASK_ENCODING_ALPHA4 ||
    data.selectionLimit !== TARGET_GLYPH_COUNT ||
    !UUID_PATTERN.test(data.challengeId) ||
    !Number.isInteger(data.issuedAt) ||
    !Number.isInteger(data.expiresAt) ||
    data.expiresAt <= data.issuedAt ||
    !Number.isInteger(data.epochDurationMs) ||
    data.epochDurationMs < 1_000 ||
    data.epochDurationMs > 30_000
  ) {
    throw new TypeError('Challenge metadata is invalid.');
  }

  const promptPattern = data.orderMode === 'numeric'
    ? /^[2-9]$/
    : data.orderMode === 'alphabetical'
      ? /^[A-HJ-NP-Z]$/
      : null;

  if (
    !promptPattern ||
    !Array.isArray(data.promptSequence) ||
    data.promptSequence.length !== TARGET_GLYPH_COUNT ||
    new Set(data.promptSequence).size !== TARGET_GLYPH_COUNT ||
    data.promptSequence.some((value) => typeof value !== 'string' || !promptPattern.test(value)) ||
    !Array.isArray(data.epochSeeds) ||
    data.epochSeeds.length !== 3 ||
    !Array.isArray(data.objects) ||
    data.objects.length !== DISPLAY_OBJECT_COUNT
  ) {
    throw new TypeError('Challenge structure is invalid.');
  }

  for (const seeds of data.epochSeeds) {
    if (
      !seeds ||
      !Number.isInteger(seeds.background) ||
      !Number.isInteger(seeds.foreground) ||
      !Number.isInteger(seeds.motion)
    ) {
      throw new TypeError('Challenge animation seeds are invalid.');
    }
  }

  const objectIds = new Set();

  for (const object of data.objects) {
    const finiteMotionValues = [
      object?.x,
      object?.y,
      object?.velocityX,
      object?.velocityY,
      object?.texturePhaseX,
      object?.texturePhaseY,
      object?.textureDirectionX,
      object?.textureDirectionY
    ];

    if (
      !object ||
      !UUID_PATTERN.test(object.id) ||
      objectIds.has(object.id) ||
      !Number.isInteger(object.width) ||
      !Number.isInteger(object.height) ||
      object.width < 1 ||
      object.width > 128 ||
      object.height < 1 ||
      object.height > 128 ||
      typeof object.alpha !== 'string' ||
      object.alpha.length > 16_384 ||
      !Number.isInteger(object.turnSeed) ||
      finiteMotionValues.some((value) => !Number.isFinite(value))
    ) {
      throw new TypeError('Challenge motion object is invalid.');
    }

    objectIds.add(object.id);
  }

  return data;
}
