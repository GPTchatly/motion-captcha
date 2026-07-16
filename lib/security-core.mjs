import { randomInt, randomUUID } from 'node:crypto';
import { MASK_ENCODING_ALPHA4, createEphemeralMask } from './ephemeral-mask.mjs';

export const CHALLENGE_TTL_MS = 30_000;
export const SESSION_TTL_MS = 15 * 60_000;
export const TARGET_GLYPH_COUNT = 4;
export const DISTRACTOR_GLYPH_COUNT = 4;
export const DISPLAY_OBJECT_COUNT = TARGET_GLYPH_COUNT + DISTRACTOR_GLYPH_COUNT;
export const ORDER_MODE_NUMERIC = 'numeric';
export const ORDER_MODE_ALPHABETICAL = 'alphabetical';
export const BLIND_ANSWER_SPACE = Array.from(
  { length: TARGET_GLYPH_COUNT },
  (_, index) => DISPLAY_OBJECT_COUNT - index
).reduce((total, value) => total * value, 1);

const POSITION_SLOTS = [
  { x: 10, y: 8 },
  { x: 92, y: 16 },
  { x: 178, y: 8 },
  { x: 264, y: 16 },
  { x: 326, y: 82 },
  { x: 236, y: 132 },
  { x: 132, y: 138 },
  { x: 24, y: 132 }
];

function defaultRandomInt(maximumExclusive) {
  return randomInt(0, maximumExclusive);
}

function pick(values, randomIntFn) {
  return values[randomIntFn(values.length)];
}

function shuffle(values, randomIntFn) {
  const output = [...values];

  for (let index = output.length - 1; index > 0; index -= 1) {
    const swapIndex = randomIntFn(index + 1);
    [output[index], output[swapIndex]] = [output[swapIndex], output[index]];
  }

  return output;
}

function randomBetween(minimum, maximum, randomIntFn) {
  const resolution = 1_000_000;
  return minimum + ((maximum - minimum) * randomIntFn(resolution)) / resolution;
}

function randomSign(randomIntFn) {
  return randomIntFn(2) === 0 ? -1 : 1;
}

function makeMotionObject({ id, mask, slot, randomIntFn }) {
  const baseSpeed = randomBetween(35, 54, randomIntFn);
  const angle = randomBetween(-Math.PI, Math.PI, randomIntFn);
  const jitterX = randomBetween(-7, 7, randomIntFn);
  const jitterY = randomBetween(-7, 7, randomIntFn);

  return {
    id,
    width: mask.width,
    height: mask.height,
    alpha: mask.alpha,
    x: Math.max(0, Math.min(416 - mask.width, slot.x + jitterX)),
    y: Math.max(0, Math.min(250 - mask.height, slot.y + jitterY)),
    velocityX: Math.cos(angle) * baseSpeed,
    velocityY: Math.sin(angle) * baseSpeed,
    texturePhaseX: randomBetween(0, 512, randomIntFn),
    texturePhaseY: randomBetween(0, 512, randomIntFn),
    textureDirectionX: randomSign(randomIntFn) * randomBetween(0.62, 1.08, randomIntFn),
    textureDirectionY: randomSign(randomIntFn) * randomBetween(0.52, 0.98, randomIntFn),
    turnSeed: randomIntFn(0x7fffffff)
  };
}

function chooseUniqueCharacters(characterSet, count, randomIntFn) {
  const available = [...new Set(characterSet)];

  if (available.length < count) {
    throw new RangeError('The mask library does not contain enough unique characters.');
  }

  return shuffle(available, randomIntFn).slice(0, count);
}

export function chooseChallengeCharacters(
  characterSet,
  count,
  randomIntFn = defaultRandomInt
) {
  if (typeof characterSet !== 'string' && !Array.isArray(characterSet)) {
    throw new TypeError('The challenge character set must be a string or array.');
  }

  if (!Number.isInteger(count) || count < 1) {
    throw new RangeError('The challenge character count must be a positive integer.');
  }

  const uniqueCharacters = [...new Set(characterSet)];
  const numericCharacters = uniqueCharacters.filter((value) => /^[2-9]$/.test(value));
  const alphabeticalCharacters = uniqueCharacters.filter((value) => /^[A-HJ-NP-Z]$/.test(value));
  const eligibleModes = [];

  if (numericCharacters.length >= count) {
    eligibleModes.push({
      orderMode: ORDER_MODE_NUMERIC,
      characters: numericCharacters
    });
  }

  if (alphabeticalCharacters.length >= count) {
    eligibleModes.push({
      orderMode: ORDER_MODE_ALPHABETICAL,
      characters: alphabeticalCharacters
    });
  }

  if (eligibleModes.length === 0) {
    throw new RangeError(
      'The mask library must contain enough unique digits or enough unique letters for one challenge.'
    );
  }

  const selectedMode = pick(eligibleModes, randomIntFn);

  return {
    orderMode: selectedMode.orderMode,
    values: chooseUniqueCharacters(selectedMode.characters, count, randomIntFn)
  };
}

export function rankCharacter(value) {
  if (typeof value !== 'string' || value.length !== 1) {
    throw new TypeError('A single challenge character is required.');
  }

  const normalized = value.toUpperCase();

  if (/^[2-9]$/.test(normalized)) {
    return Number.parseInt(normalized, 10);
  }

  if (/^[A-HJ-NP-Z]$/.test(normalized)) {
    return 10 + normalized.charCodeAt(0) - 'A'.charCodeAt(0);
  }

  throw new RangeError(`Unsupported challenge character: ${value}`);
}

export function sanitizeNextPath(candidate, fallback = '/index.html') {
  if (typeof candidate !== 'string' || candidate.trim() === '') {
    return fallback;
  }

  try {
    const resolved = new URL(candidate, 'https://local.invalid');

    if (resolved.origin !== 'https://local.invalid') {
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

export function createChallengeDefinition({
  maskLibrary,
  now = Date.now(),
  origin,
  visitorId,
  randomIntFn = defaultRandomInt,
  randomUuidFn = randomUUID
}) {
  if (!maskLibrary || typeof maskLibrary !== 'object') {
    throw new TypeError('A server-side glyph mask library is required.');
  }

  if (typeof origin !== 'string' || origin.length === 0) {
    throw new TypeError('A challenge origin is required.');
  }

  if (typeof visitorId !== 'string' || visitorId.length === 0) {
    throw new TypeError('A server-authenticated visitor ID is required.');
  }

  const characterSet = maskLibrary.characterSet;
  const { orderMode, values } = chooseChallengeCharacters(characterSet, DISPLAY_OBJECT_COUNT, randomIntFn);
  const promptSequence = shuffle(values, randomIntFn)
    .slice(0, TARGET_GLYPH_COUNT)
    .sort((left, right) => rankCharacter(left) - rankCharacter(right));
  const slots = shuffle(POSITION_SLOTS, randomIntFn).slice(0, DISPLAY_OBJECT_COUNT);
  const usedMasks = new Set();
  const glyphEntries = values.map((value, index) => {
    const variants = maskLibrary.characters[value];
    const id = randomUuidFn();
    const mask = createEphemeralMask({
      variants,
      sourceWidth: maskLibrary.width,
      sourceHeight: maskLibrary.height,
      randomIntFn,
      usedMasks
    });

    return {
      value,
      id,
      object: makeMotionObject({
        id,
        mask,
        slot: slots[index],
        randomIntFn
      })
    };
  });

  const challengeId = randomUuidFn();
  const expiresAt = now + CHALLENGE_TTL_MS;
  const entriesByValue = new Map(glyphEntries.map((entry) => [entry.value, entry]));
  const expectedIds = promptSequence.map((value) => entriesByValue.get(value).id);
  const objects = shuffle(glyphEntries.map((entry) => entry.object), randomIntFn);
  const epochSeeds = Array.from({ length: 3 }, () => ({
    background: randomIntFn(0x7fffffff),
    foreground: randomIntFn(0x7fffffff),
    motion: randomIntFn(0x7fffffff)
  }));

  return {
    publicChallenge: {
      protocolVersion: 2,
      challengeId,
      expiresAt,
      issuedAt: now,
      selectionLimit: TARGET_GLYPH_COUNT,
      orderMode,
      promptSequence,
      maskEncoding: MASK_ENCODING_ALPHA4,
      epochDurationMs: 10_000,
      epochSeeds,
      objects
    },
    privateChallenge: {
      challengeId,
      expiresAt,
      issuedAt: now,
      origin,
      visitorId,
      expectedIds,
      objectIds: new Set(objects.map((object) => object.id)),
      orderMode,
      promptSequence,
      consumed: false
    }
  };
}

export function verifyChallengeSelection({ challenge, selectedIds, now = Date.now(), origin, visitorId }) {
  if (!challenge) {
    return { success: false, code: 'challenge_not_found' };
  }

  if (challenge.consumed) {
    return { success: false, code: 'challenge_consumed' };
  }

  if (now >= challenge.expiresAt) {
    return { success: false, code: 'challenge_expired' };
  }

  if (origin !== challenge.origin) {
    return { success: false, code: 'origin_mismatch' };
  }

  if (visitorId !== challenge.visitorId) {
    return { success: false, code: 'visitor_mismatch' };
  }

  if (
    !Array.isArray(selectedIds) ||
    selectedIds.length !== TARGET_GLYPH_COUNT ||
    new Set(selectedIds).size !== TARGET_GLYPH_COUNT ||
    selectedIds.some((id) => typeof id !== 'string' || !challenge.objectIds.has(id))
  ) {
    return { success: false, code: 'invalid_selection' };
  }

  const success = challenge.expectedIds.every((id, index) => selectedIds[index] === id);

  return success
    ? { success: true, code: 'verified' }
    : { success: false, code: 'incorrect_order' };
}

export function parseCookies(cookieHeader) {
  if (typeof cookieHeader !== 'string' || cookieHeader.length === 0) {
    return new Map();
  }

  return new Map(
    cookieHeader
      .split(';')
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => {
        const separator = item.indexOf('=');
        const rawName = separator === -1 ? item : item.slice(0, separator);
        const rawValue = separator === -1 ? '' : item.slice(separator + 1);

        try {
          return [decodeURIComponent(rawName), decodeURIComponent(rawValue)];
        } catch {
          return [rawName, rawValue];
        }
      })
  );
}

export function createBoundedTtlStore({ maxEntries }) {
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new RangeError('A bounded store requires a positive entry limit.');
  }

  const entries = new Map();

  function prune(now = Date.now()) {
    for (const [key, value] of entries) {
      if (!value || !Number.isFinite(value.expiresAt) || value.expiresAt <= now) {
        entries.delete(key);
      }
    }
  }

  function get(key, now = Date.now()) {
    const value = entries.get(key);

    if (!value || !Number.isFinite(value.expiresAt) || value.expiresAt <= now) {
      entries.delete(key);
      return null;
    }

    return value;
  }

  return {
    get size() {
      return entries.size;
    },
    get,
    set(key, value, now = Date.now()) {
      prune(now);

      if (!entries.has(key) && entries.size >= maxEntries) {
        return false;
      }

      entries.set(key, value);
      return true;
    },
    take(key, now = Date.now()) {
      const value = get(key, now);

      if (!value) {
        return null;
      }

      entries.delete(key);
      return value;
    },
    delete(key) {
      return entries.delete(key);
    },
    deleteWhere(predicate) {
      let deleted = 0;

      for (const [key, value] of entries) {
        if (predicate(value, key)) {
          entries.delete(key);
          deleted += 1;
        }
      }

      return deleted;
    },
    entries() {
      return [...entries.entries()];
    },
    prune
  };
}

export function createSlidingWindowLimiter({ limit, windowMs, maxKeys = 10_000 }) {
  if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(windowMs) || windowMs < 1) {
    throw new RangeError('A sliding-window limiter requires positive integer limits.');
  }

  if (!Number.isInteger(maxKeys) || maxKeys < 1) {
    throw new RangeError('A sliding-window limiter requires a positive key limit.');
  }

  const entries = new Map();

  function prune(now = Date.now()) {
    for (const [key, timestamps] of entries) {
      const recent = timestamps.filter((timestamp) => now - timestamp < windowMs);

      if (recent.length === 0) {
        entries.delete(key);
      } else {
        entries.set(key, recent);
      }
    }
  }

  return {
    get size() {
      return entries.size;
    },
    consume(key, now = Date.now()) {
      const recent = (entries.get(key) ?? []).filter((timestamp) => now - timestamp < windowMs);

      if (recent.length >= limit) {
        entries.set(key, recent);
        return false;
      }

      if (!entries.has(key) && entries.size >= maxKeys) {
        prune(now);

        if (entries.size >= maxKeys) {
          return false;
        }
      }

      recent.push(now);
      entries.set(key, recent);
      return true;
    },
    prune
  };
}

export function createFixedWindowLimiter({ limit, windowMs, maxKeys = 10_000 }) {
  if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(windowMs) || windowMs < 1) {
    throw new RangeError('A fixed-window limiter requires positive integer limits.');
  }

  if (!Number.isInteger(maxKeys) || maxKeys < 1) {
    throw new RangeError('A fixed-window limiter requires a positive key limit.');
  }

  const entries = new Map();

  function prune(now = Date.now()) {
    for (const [key, entry] of entries) {
      if (now - entry.startedAt >= windowMs) {
        entries.delete(key);
      }
    }
  }

  return {
    get size() {
      return entries.size;
    },
    consume(key, now = Date.now()) {
      const existing = entries.get(key);

      if (existing && now - existing.startedAt < windowMs) {
        if (existing.count >= limit) {
          return false;
        }

        existing.count += 1;
        return true;
      }

      if (!existing && entries.size >= maxKeys) {
        prune(now);

        if (entries.size >= maxKeys) {
          return false;
        }
      }

      entries.set(key, { count: 1, startedAt: now });
      return true;
    },
    prune
  };
}
