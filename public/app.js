import {
  challengeProgress,
  formatRemainingTime,
  isChallengeExpired,
  remainingChallengeMs
} from './challenge-timer.js';

const LOGICAL_WIDTH = 416;
const LOGICAL_HEIGHT = 250;
const TEXTURE_WIDTH = 384;
const TEXTURE_HEIGHT = 384;
const DEFAULT_BACKGROUND_SPEED = 300;
const DEFAULT_FOREGROUND_SPEED = 48;
const DEFAULT_OBJECT_SPEED = 46;
const BACKGROUND_BAND_COUNT = 6;
const MASK_ENCODING_ALPHA4 = 'alpha4-base64-v1';
const PROTOCOL_VERSION = 2;
const DISPLAY_OBJECT_COUNT = 8;
const TARGET_GLYPH_COUNT = 4;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CSRF_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/;

class SeededRandom {
  constructor(seed) {
    this.state = seed >>> 0 || 0x6d2b79f5;
  }

  nextUint32() {
    let value = this.state;
    value += 0x6d2b79f5;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    this.state = value >>> 0;
    return (value ^ (value >>> 14)) >>> 0;
  }

  next() {
    return this.nextUint32() / 4294967296;
  }

  between(minimum, maximum) {
    return minimum + (maximum - minimum) * this.next();
  }

  integer(minimum, maximumInclusive) {
    return Math.floor(this.between(minimum, maximumInclusive + 1));
  }

  pick(values) {
    return values[this.integer(0, values.length - 1)];
  }

  sign() {
    return this.next() < 0.5 ? -1 : 1;
  }
}

function createCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function modulo(value, modulus) {
  return ((value % modulus) + modulus) % modulus;
}

function rotateVector(x, y, radians) {
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);

  return {
    x: x * cosine - y * sine,
    y: x * sine + y * cosine
  };
}

function sanitizeNextPath(candidate, fallback = '/index.html') {
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

function decodeAlpha4(value, pixelCount) {
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

function createMask({ alpha: encodedAlpha, width, height, maskEncoding }) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new TypeError('Challenge mask dimensions are invalid.');
  }

  if (maskEncoding !== MASK_ENCODING_ALPHA4) {
    throw new TypeError('Challenge mask encoding is unsupported.');
  }

  const alpha = decodeAlpha4(encodedAlpha, width * height);
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');

  if (!context) {
    throw new Error('Unable to create a challenge-mask rendering context.');
  }

  const imageData = context.createImageData(width, height);

  for (let sourceIndex = 0, targetIndex = 0; sourceIndex < alpha.length; sourceIndex += 1, targetIndex += 4) {
    imageData.data[targetIndex] = 255;
    imageData.data[targetIndex + 1] = 255;
    imageData.data[targetIndex + 2] = 255;
    imageData.data[targetIndex + 3] = alpha[sourceIndex];
  }

  context.putImageData(imageData, 0, 0);

  return { alpha, canvas, width, height };
}

function validateChallengePayload(data) {
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

class NoiseTextureFactory {
  create(seed) {
    const random = new SeededRandom(seed);
    const canvas = createCanvas(TEXTURE_WIDTH, TEXTURE_HEIGHT);
    const context = canvas.getContext('2d', { alpha: false });

    if (!context) {
      throw new Error('Unable to create a 2D texture context.');
    }

    const baseImage = context.createImageData(TEXTURE_WIDTH, TEXTURE_HEIGHT);
    const pixels = baseImage.data;

    for (let index = 0; index < pixels.length; index += 4) {
      const neutral = random.integer(118, 182);
      const chroma = random.integer(-18, 18);
      const channelChoice = random.integer(0, 2);
      const red = neutral + (channelChoice === 0 ? chroma : random.integer(-9, 9));
      const green = neutral + (channelChoice === 1 ? chroma : random.integer(-9, 9));
      const blue = neutral + (channelChoice === 2 ? chroma : random.integer(-9, 9));

      pixels[index] = clamp(red, 55, 225);
      pixels[index + 1] = clamp(green, 55, 225);
      pixels[index + 2] = clamp(blue, 55, 225);
      pixels[index + 3] = 255;
    }

    context.putImageData(baseImage, 0, 0);
    context.globalCompositeOperation = 'source-over';
    context.lineCap = 'round';

    const palette = [
      [43, 116, 84],
      [47, 93, 146],
      [131, 57, 128],
      [169, 73, 79],
      [171, 136, 48],
      [62, 137, 145],
      [95, 70, 153],
      [199, 109, 154],
      [80, 152, 91],
      [42, 42, 47],
      [222, 216, 201]
    ];

    for (let index = 0; index < 14_000; index += 1) {
      const [red, green, blue] = random.pick(palette);
      const x = random.between(-5, TEXTURE_WIDTH + 5);
      const y = random.between(-5, TEXTURE_HEIGHT + 5);
      const angle = random.between(-Math.PI, Math.PI);
      const length = random.between(1.1, 5.8);
      const width = random.between(0.45, 1.7);
      const opacity = random.between(0.12, 0.55);

      context.beginPath();
      context.moveTo(x, y);
      context.lineTo(x + Math.cos(angle) * length, y + Math.sin(angle) * length);
      context.lineWidth = width;
      context.strokeStyle = `rgb(${red} ${green} ${blue} / ${opacity})`;
      context.stroke();
    }

    context.globalAlpha = 0.28;
    context.fillStyle = '#d2d0cf';

    for (let index = 0; index < 900; index += 1) {
      const x = random.integer(0, TEXTURE_WIDTH - 1);
      const y = random.integer(0, TEXTURE_HEIGHT - 1);
      const radius = random.between(0.4, 1.7);
      context.beginPath();
      context.arc(x, y, radius, 0, Math.PI * 2);
      context.fill();
    }

    context.globalAlpha = 1;

    const softened = createCanvas(TEXTURE_WIDTH, TEXTURE_HEIGHT);
    const softenedContext = softened.getContext('2d', { alpha: false });

    if (!softenedContext) {
      throw new Error('Unable to create a softened texture context.');
    }

    softenedContext.filter = 'blur(0.55px) contrast(108%) saturate(78%)';
    softenedContext.drawImage(canvas, 0, 0);
    softenedContext.filter = 'none';
    softenedContext.fillStyle = 'rgb(142 142 145 / 0.08)';
    softenedContext.fillRect(0, 0, TEXTURE_WIDTH, TEXTURE_HEIGHT);

    return softened;
  }
}

class MotionObject {
  constructor(configuration) {
    this.id = configuration.id;
    this.mask = createMask(configuration);
    this.selected = false;
    this.selectionOrder = null;
    this.radiusX = this.mask.width / 2;
    this.radiusY = this.mask.height / 2;
    this.x = configuration.x;
    this.y = configuration.y;
    this.velocityX = configuration.velocityX;
    this.velocityY = configuration.velocityY;
    this.initialSpeed = Math.max(1, Math.hypot(this.velocityX, this.velocityY));
    this.speedScale = this.initialSpeed / DEFAULT_OBJECT_SPEED;
    this.texturePhaseX = configuration.texturePhaseX;
    this.texturePhaseY = configuration.texturePhaseY;
    this.textureDirectionX = configuration.textureDirectionX;
    this.textureDirectionY = configuration.textureDirectionY;
    this.random = new SeededRandom(configuration.turnSeed);
    this.nextTurnAt = this.random.between(1.2, 2.7);
    this.lastEpochIndex = 0;
  }

  update(deltaSeconds, elapsedSeconds, travelSpeed, epochIndex) {
    if (deltaSeconds <= 0) {
      return;
    }

    let magnitude = Math.hypot(this.velocityX, this.velocityY);

    if (magnitude < 0.0001) {
      this.velocityX = travelSpeed * this.speedScale;
      this.velocityY = 0;
      magnitude = Math.abs(this.velocityX);
    }

    let directionX = this.velocityX / magnitude;
    let directionY = this.velocityY / magnitude;

    if (epochIndex !== this.lastEpochIndex) {
      const epochTurn = this.random.sign() * this.random.between(0.22, 0.48);
      const rotated = rotateVector(directionX, directionY, epochTurn);
      directionX = rotated.x;
      directionY = rotated.y;
      this.lastEpochIndex = epochIndex;
      this.nextTurnAt = elapsedSeconds + this.random.between(1.0, 2.2);
    } else if (elapsedSeconds >= this.nextTurnAt) {
      const gentleTurn = this.random.sign() * this.random.between(0.08, 0.24);
      const rotated = rotateVector(directionX, directionY, gentleTurn);
      directionX = rotated.x;
      directionY = rotated.y;
      this.nextTurnAt = elapsedSeconds + this.random.between(1.2, 2.9);
    }

    const targetSpeed = Math.max(0, travelSpeed * this.speedScale);
    this.velocityX = directionX * targetSpeed;
    this.velocityY = directionY * targetSpeed;
    this.x += this.velocityX * deltaSeconds;
    this.y += this.velocityY * deltaSeconds;

    const maximumX = LOGICAL_WIDTH - this.mask.width;
    const maximumY = LOGICAL_HEIGHT - this.mask.height;

    if (this.x < 0) {
      this.x = -this.x;
      this.velocityX = Math.abs(this.velocityX);
    } else if (this.x > maximumX) {
      this.x = maximumX - (this.x - maximumX);
      this.velocityX = -Math.abs(this.velocityX);
    }

    if (this.y < 0) {
      this.y = -this.y;
      this.velocityY = Math.abs(this.velocityY);
    } else if (this.y > maximumY) {
      this.y = maximumY - (this.y - maximumY);
      this.velocityY = -Math.abs(this.velocityY);
    }
  }

  hitTest(x, y) {
    const localX = Math.floor(x - this.x);
    const localY = Math.floor(y - this.y);

    if (localX < 0 || localY < 0 || localX >= this.mask.width || localY >= this.mask.height) {
      return false;
    }

    return this.mask.alpha[localY * this.mask.width + localX] >= 72;
  }
}

class MotionCaptcha {
  constructor(elements) {
    const context = elements.canvas.getContext('2d', { alpha: false, desynchronized: true });

    if (!context) {
      throw new Error('Canvas 2D is unavailable.');
    }

    this.canvas = elements.canvas;
    this.context = context;
    this.messageElement = elements.messageElement;
    this.selectionElement = elements.selectionElement;
    this.instructionElement = elements.instructionElement;
    this.timerValueElement = elements.timerValueElement;
    this.timerBarElement = elements.timerBarElement;
    this.timerRegionElement = elements.timerRegionElement;
    this.submitButton = elements.submitButton;
    this.refreshButton = elements.refreshButton;
    this.nextPath = sanitizeNextPath(new URLSearchParams(window.location.search).get('next'));
    this.scene = createCanvas(LOGICAL_WIDTH, LOGICAL_HEIGHT);
    this.sceneContext = this.scene.getContext('2d', { alpha: false });
    this.objectLayer = createCanvas(LOGICAL_WIDTH, LOGICAL_HEIGHT);
    this.objectLayerContext = this.objectLayer.getContext('2d');
    this.noiseFactory = new NoiseTextureFactory();
    this.objects = [];
    this.selectedObjects = [];
    this.challengeId = null;
    this.issuedAt = 0;
    this.expiresAt = 0;
    this.selectionLimit = TARGET_GLYPH_COUNT;
    this.orderMode = null;
    this.promptSequence = [];
    this.epochDurationMs = 10_000;
    this.epochSeeds = [];
    this.textureCache = new Map();
    this.bandProfileCache = new Map();
    this.visualStartedAt = performance.now();
    this.lastFrameAt = performance.now();
    this.animationFrame = null;
    this.csrfToken = null;
    this.completed = false;
    this.expired = false;
    this.loading = false;
    this.submitting = false;
    this.loadVersion = 0;

    if (!this.sceneContext || !this.objectLayerContext) {
      throw new Error('Unable to create offscreen rendering contexts.');
    }

    this.handlePointerDown = this.handlePointerDown.bind(this);
    this.renderFrame = this.renderFrame.bind(this);
    this.canvas.addEventListener('pointerdown', this.handlePointerDown);
    this.animationFrame = requestAnimationFrame(this.renderFrame);
    void this.generateChallenge();
  }

  async ensureSecurityContext() {
    if (CSRF_TOKEN_PATTERN.test(this.csrfToken ?? '')) {
      return this.csrfToken;
    }

    const response = await fetch('/api/security-context', {
      method: 'GET',
      cache: 'no-store',
      credentials: 'same-origin'
    });
    const data = await response.json().catch(() => null);

    if (!response.ok || !data || !CSRF_TOKEN_PATTERN.test(data.csrfToken ?? '')) {
      throw new Error('security_context_unavailable');
    }

    this.csrfToken = data.csrfToken;
    return this.csrfToken;
  }

  async generateChallenge() {
    const currentVersion = this.loadVersion + 1;
    this.loadVersion = currentVersion;
    this.loading = true;
    this.submitting = false;
    this.completed = false;
    this.expired = false;
    this.challengeId = null;
    this.orderMode = null;
    this.promptSequence = [];
    this.objects = [];
    this.selectedObjects = [];
    this.textureCache.clear();
    this.bandProfileCache.clear();
    this.hideStatus();
    this.updateSelectionReadout();
    this.setInteractionState();
    this.timerValueElement.textContent = '30.0s';
    this.timerBarElement.value = 1;
    this.timerBarElement.classList.remove('is-warning', 'is-expired');
    this.timerRegionElement.classList.remove('is-warning', 'is-expired');
    this.instructionElement.textContent = 'Loading challenge instructions…';
    this.canvas.setAttribute(
      'aria-label',
      'Animated CAPTCHA challenge. Loading ordering instructions.'
    );
    this.showStatus('Loading a new one-time challenge…', 'neutral');

    try {
      const csrfToken = await this.ensureSecurityContext();
      const response = await fetch('/api/challenges', {
        method: 'POST',
        cache: 'no-store',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken
        },
        body: '{}'
      });
      const responseData = await response.json().catch(() => null);

      if (!response.ok || !responseData) {
        throw new Error(responseData?.code ?? `challenge_request_failed_${response.status}`);
      }

      const data = validateChallengePayload(responseData);

      if (currentVersion !== this.loadVersion) {
        return;
      }

      this.challengeId = data.challengeId;
      this.issuedAt = data.issuedAt;
      this.expiresAt = data.expiresAt;
      this.selectionLimit = data.selectionLimit;
      this.orderMode = data.orderMode;
      this.promptSequence = [...data.promptSequence];
      this.epochDurationMs = data.epochDurationMs;
      this.epochSeeds = data.epochSeeds;
      this.objects = data.objects.map(
        (configuration) => new MotionObject({ ...configuration, maskEncoding: data.maskEncoding })
      );
      this.selectedObjects = [];
      this.visualStartedAt = performance.now();
      this.lastFrameAt = this.visualStartedAt;
      this.loading = false;
      this.updateInstruction();
      this.hideStatus();
      this.updateSelectionReadout();
      this.setInteractionState();
      this.ensureEpochResources(0);
      this.canvas.dispatchEvent(
        new CustomEvent('motioncaptcha:load', {
          bubbles: true,
          detail: {
            challengeId: this.challengeId,
            expiresAt: this.expiresAt,
            orderMode: this.orderMode,
            promptSequence: [...this.promptSequence]
          }
        })
      );
    } catch (error) {
      if (currentVersion !== this.loadVersion) {
        return;
      }

      console.error('Unable to load challenge.', error);
      if (error instanceof Error && error.message === 'csrf_invalid') {
        this.csrfToken = null;
      }
      this.loading = false;
      this.expired = true;
      this.setInteractionState();
      const message = error instanceof Error && ['rate_limited', 'quota_exhausted'].includes(error.message)
        ? 'Challenge limit reached. Wait before requesting another challenge.'
        : error instanceof Error && error.message === 'service_busy'
          ? 'The challenge service is at capacity. Try again shortly.'
          : 'Challenge could not be loaded. Use New challenge to retry.';
      this.showStatus(message, 'error');
      this.canvas.dispatchEvent(new CustomEvent('motioncaptcha:error', { bubbles: true }));
    }
  }

  updateInstruction() {
    if (this.promptSequence.length === TARGET_GLYPH_COUNT) {
      this.instructionElement.textContent = `Select in this exact order: ${this.promptSequence.join(' → ')}.`;
      this.canvas.setAttribute(
        'aria-label',
        `Animated CAPTCHA challenge. Select ${this.promptSequence.join(', then ')}.`
      );
      return;
    }

    this.instructionElement.textContent =
      'Challenge instructions are unavailable. Refresh to generate a new challenge.';
    this.canvas.setAttribute(
      'aria-label',
      'Animated CAPTCHA challenge with unavailable ordering instructions.'
    );
  }

  ensureEpochResources(epochIndex) {
    const boundedIndex = clamp(epochIndex, 0, Math.max(0, this.epochSeeds.length - 1));

    if (!this.textureCache.has(boundedIndex)) {
      const seeds = this.epochSeeds[boundedIndex];
      this.textureCache.set(boundedIndex, {
        background: this.noiseFactory.create(seeds.background),
        foreground: this.noiseFactory.create(seeds.foreground)
      });
    }

    if (!this.bandProfileCache.has(boundedIndex)) {
      const random = new SeededRandom(this.epochSeeds[boundedIndex].motion);
      const profiles = Array.from({ length: BACKGROUND_BAND_COUNT }, (_, index) => {
        const mostlyVertical = index % 2 === 0;

        return {
          directionX: random.sign() * random.between(mostlyVertical ? 0.06 : 0.38, mostlyVertical ? 0.28 : 0.78),
          directionY: random.sign() * random.between(mostlyVertical ? 0.7 : 0.18, mostlyVertical ? 1.16 : 0.55),
          speedScale: random.between(0.72, 1.22),
          phase: random.between(0, Math.PI * 2),
          frequency: random.between(0.45, 1.05),
          wobbleAmplitude: random.between(4, 13)
        };
      });
      this.bandProfileCache.set(boundedIndex, profiles);
    }

    return {
      textures: this.textureCache.get(boundedIndex),
      bands: this.bandProfileCache.get(boundedIndex)
    };
  }

  getVisualElapsedSeconds(now) {
    return Math.max(0, now - this.visualStartedAt) / 1000;
  }

  getEpochIndex(elapsedSeconds) {
    const epochDurationSeconds = Math.max(1, this.epochDurationMs / 1000);
    return clamp(Math.floor(elapsedSeconds / epochDurationSeconds), 0, Math.max(0, this.epochSeeds.length - 1));
  }

  renderFrame(now) {
    const elapsedSeconds = this.getVisualElapsedSeconds(now);
    const epochIndex = this.getEpochIndex(elapsedSeconds);
    const rawDeltaSeconds = Math.max(0, now - this.lastFrameAt) / 1000;
    const deltaSeconds = Math.min(rawDeltaSeconds, 0.05);
    this.lastFrameAt = now;

    this.updateTimer();

    if (!this.loading && !this.expired) {
      for (const object of this.objects) {
        object.update(deltaSeconds, elapsedSeconds, DEFAULT_OBJECT_SPEED, epochIndex);
      }
    }

    this.drawScene(elapsedSeconds, epochIndex);
    this.animationFrame = requestAnimationFrame(this.renderFrame);
  }

  updateTimer() {
    if (!this.expiresAt) {
      return;
    }

    const remaining = remainingChallengeMs(this.expiresAt);
    const progress = challengeProgress(this.expiresAt, this.issuedAt);
    this.timerValueElement.textContent = formatRemainingTime(remaining);
    this.timerBarElement.value = progress;
    const isWarning = remaining > 0 && remaining <= 10_000;
    this.timerRegionElement.classList.toggle('is-warning', isWarning);
    this.timerBarElement.classList.toggle('is-warning', isWarning);

    if (!this.expired && !this.completed && isChallengeExpired(this.expiresAt)) {
      this.expireChallenge();
    }
  }

  expireChallenge() {
    if (this.expired) {
      return;
    }

    this.expired = true;
    this.selectedObjects = [];

    for (const object of this.objects) {
      object.selected = false;
      object.selectionOrder = null;
    }

    this.timerRegionElement.classList.remove('is-warning');
    this.timerRegionElement.classList.add('is-expired');
    this.timerBarElement.classList.remove('is-warning');
    this.timerBarElement.classList.add('is-expired');
    this.timerValueElement.textContent = '0.0s';
    this.timerBarElement.value = 0;
    this.updateSelectionReadout();
    this.setInteractionState();
    this.showStatus('Challenge expired after 30 seconds. Use New challenge to try again.', 'error');
    this.canvas.dispatchEvent(
      new CustomEvent('motioncaptcha:expire', {
        bubbles: true,
        detail: { challengeId: this.challengeId }
      })
    );
  }

  drawScene(elapsedSeconds, epochIndex) {
    const sceneContext = this.sceneContext;
    sceneContext.save();
    sceneContext.clearRect(0, 0, LOGICAL_WIDTH, LOGICAL_HEIGHT);
    sceneContext.imageSmoothingEnabled = true;

    if (this.epochSeeds.length > 0) {
      const resources = this.ensureEpochResources(epochIndex);
      this.drawBandedBackground(sceneContext, resources.textures.background, resources.bands, elapsedSeconds);

      for (const object of this.objects) {
        this.drawObjectTexture(object, resources.textures.foreground, elapsedSeconds);
      }
    } else {
      sceneContext.fillStyle = '#969699';
      sceneContext.fillRect(0, 0, LOGICAL_WIDTH, LOGICAL_HEIGHT);
    }

    sceneContext.fillStyle = 'rgb(142 142 146 / 0.06)';
    sceneContext.fillRect(0, 0, LOGICAL_WIDTH, LOGICAL_HEIGHT);

    this.drawSelectionMarkers(sceneContext);
    sceneContext.restore();
    this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.context.drawImage(this.scene, 0, 0, this.canvas.width, this.canvas.height);
  }

  drawBandedBackground(context, texture, bands, elapsedSeconds) {
    const bandHeight = LOGICAL_HEIGHT / BACKGROUND_BAND_COUNT;

    for (let index = 0; index < BACKGROUND_BAND_COUNT; index += 1) {
      const profile = bands[index];
      const travel = elapsedSeconds * DEFAULT_BACKGROUND_SPEED * profile.speedScale;
      const wobble = Math.sin(elapsedSeconds * profile.frequency * Math.PI * 2 + profile.phase) * profile.wobbleAmplitude;
      const offsetX = travel * profile.directionX + wobble;
      const offsetY = travel * profile.directionY + Math.cos(elapsedSeconds * profile.frequency + profile.phase) * profile.wobbleAmplitude;

      context.save();
      context.beginPath();
      context.rect(0, Math.floor(index * bandHeight), LOGICAL_WIDTH, Math.ceil(bandHeight + 1));
      context.clip();
      this.drawTiledTexture(context, texture, offsetX, offsetY);
      context.restore();
    }
  }

  drawTiledTexture(context, texture, offsetX, offsetY) {
    if (!texture) {
      return;
    }

    const normalizedOffsetX = modulo(offsetX, texture.width);
    const normalizedOffsetY = modulo(offsetY, texture.height);
    const startX = -normalizedOffsetX - texture.width;
    const startY = -normalizedOffsetY - texture.height;

    for (let y = startY; y < LOGICAL_HEIGHT + texture.height; y += texture.height) {
      for (let x = startX; x < LOGICAL_WIDTH + texture.width; x += texture.width) {
        context.drawImage(texture, Math.round(x), Math.round(y));
      }
    }
  }

  drawObjectTexture(object, foregroundTexture, elapsedSeconds) {
    const layerContext = this.objectLayerContext;
    layerContext.save();
    layerContext.clearRect(0, 0, LOGICAL_WIDTH, LOGICAL_HEIGHT);
    layerContext.globalCompositeOperation = 'source-over';

    const textureTravel = elapsedSeconds * DEFAULT_FOREGROUND_SPEED;
    const textureOffsetX = object.texturePhaseX + textureTravel * object.textureDirectionX;
    const textureOffsetY = object.texturePhaseY + textureTravel * object.textureDirectionY;
    this.drawTiledTexture(layerContext, foregroundTexture, textureOffsetX, textureOffsetY);

    layerContext.globalCompositeOperation = 'destination-in';
    layerContext.drawImage(object.mask.canvas, Math.round(object.x), Math.round(object.y));
    layerContext.restore();
    this.sceneContext.drawImage(this.objectLayer, 0, 0);
  }

  drawSelectionMarkers(context) {
    context.save();
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.font = '700 13px Aptos, Calibri, sans-serif';

    for (const object of this.objects) {
      if (!object.selected || object.selectionOrder === null) {
        continue;
      }

      const markerX = clamp(object.x + object.mask.width - 10, 12, LOGICAL_WIDTH - 12);
      const markerY = clamp(object.y + 10, 12, LOGICAL_HEIGHT - 12);
      context.beginPath();
      context.arc(markerX, markerY, 10, 0, Math.PI * 2);
      context.fillStyle = 'rgb(255 255 255 / 0.94)';
      context.fill();
      context.lineWidth = 1.5;
      context.strokeStyle = 'rgb(18 18 20 / 0.9)';
      context.stroke();
      context.fillStyle = '#111114';
      context.fillText(String(object.selectionOrder), markerX, markerY + 0.5);
    }

    context.restore();
  }

  handlePointerDown(event) {
    if (this.loading || this.completed || this.expired || this.submitting) {
      return;
    }

    const bounds = this.canvas.getBoundingClientRect();
    const x = ((event.clientX - bounds.left) / bounds.width) * LOGICAL_WIDTH;
    const y = ((event.clientY - bounds.top) / bounds.height) * LOGICAL_HEIGHT;
    const hits = this.objects
      .filter((object) => object.hitTest(x, y))
      .sort((left, right) => {
        const leftDistance = Math.hypot(x - (left.x + left.radiusX), y - (left.y + left.radiusY));
        const rightDistance = Math.hypot(x - (right.x + right.radiusX), y - (right.y + right.radiusY));
        return leftDistance - rightDistance;
      });
    const object = hits[0];

    if (!object) {
      this.showStatus('Click directly on one of the moving characters.', 'error');
      return;
    }

    if (object.selected) {
      this.selectedObjects = this.selectedObjects.filter((selected) => selected.id !== object.id);
      object.selected = false;
      object.selectionOrder = null;
      this.renumberSelections();
      this.hideStatus();
      return;
    }

    if (this.selectedObjects.length >= this.selectionLimit) {
      this.showStatus(
        `${this.selectionLimit} items are already selected. Click one again to remove it.`,
        'error'
      );
      return;
    }

    object.selected = true;
    object.selectionOrder = this.selectedObjects.length + 1;
    this.selectedObjects.push(object);
    this.updateSelectionReadout();
    this.setInteractionState();
    this.hideStatus();
  }

  renumberSelections() {
    this.selectedObjects.forEach((object, index) => {
      object.selectionOrder = index + 1;
    });
    this.updateSelectionReadout();
    this.setInteractionState();
  }

  async submit() {
    if (this.completed || this.loading || this.submitting) {
      return;
    }

    if (this.expired || isChallengeExpired(this.expiresAt)) {
      this.expireChallenge();
      return;
    }

    if (this.selectedObjects.length !== this.selectionLimit) {
      this.showStatus(`Select exactly ${this.selectionLimit} characters first.`, 'error');
      return;
    }

    this.submitting = true;
    this.setInteractionState();
    this.showStatus('Verifying the one-time challenge…', 'neutral');

    try {
      const response = await fetch(`/api/challenges/${encodeURIComponent(this.challengeId)}/verify`, {
        method: 'POST',
        cache: 'no-store',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': await this.ensureSecurityContext()
        },
        body: JSON.stringify({
          selectedIds: this.selectedObjects.map((object) => object.id),
          nextPath: this.nextPath
        })
      });
      const result = await response.json().catch(() => ({ success: false, code: 'invalid_response' }));

      if (!response.ok || !result.success) {
        this.submitting = false;

        if (result.code === 'challenge_expired') {
          this.expireChallenge();
          return;
        }

        if (result.code === 'csrf_invalid') {
          this.csrfToken = null;
        }

        const message = result.code === 'rate_limited'
          ? 'Too many attempts. Wait briefly, then request a new challenge.'
          : result.code === 'service_busy'
            ? 'Verification succeeded, but the session service is at capacity. Request a new challenge shortly.'
            : result.code === 'origin_mismatch' || result.code === 'csrf_invalid'
              ? 'The request security context was rejected. Request a new challenge.'
              : 'The selection was not accepted. Request a new challenge to try again.';
        this.expired = true;
        this.showStatus(message, 'error');
        this.canvas.dispatchEvent(
          new CustomEvent('motioncaptcha:error', {
            bubbles: true,
            detail: { code: result.code }
          })
        );

        this.setInteractionState();
        return;
      }

      this.completed = true;
      this.submitting = false;
      this.setInteractionState();
      this.showStatus('Verified. Redirecting…', 'success');
      this.canvas.dispatchEvent(
        new CustomEvent('motioncaptcha:complete', {
          bubbles: true,
          detail: {
            sessionExpiresAt: result.sessionExpiresAt,
            nextPath: result.nextPath
          }
        })
      );
      window.location.assign(sanitizeNextPath(result.nextPath));
    } catch (error) {
      console.error('Verification request failed.', error);
      this.submitting = false;
      this.expired = true;
      this.setInteractionState();
      this.showStatus('Verification outcome is unknown. Request a new challenge.', 'error');
      this.canvas.dispatchEvent(new CustomEvent('motioncaptcha:error', { bubbles: true }));
    }
  }

  updateSelectionReadout() {
    this.selectionElement.textContent = `${this.selectedObjects.length} / ${this.selectionLimit}`;
  }

  setInteractionState() {
    const selectionComplete = this.selectedObjects.length === this.selectionLimit;
    this.submitButton.disabled =
      this.loading ||
      this.expired ||
      this.completed ||
      this.submitting ||
      !selectionComplete;
    this.submitButton.textContent = this.submitting
      ? 'Verifying…'
      : this.completed
        ? 'Redirecting…'
        : this.expired
          ? 'Expired'
          : 'Verify';
    this.refreshButton.disabled = this.loading || this.submitting || this.completed;
    this.canvas.classList.toggle('is-inactive', this.loading || this.expired || this.completed || this.submitting);
    this.canvas.setAttribute(
      'aria-disabled',
      String(this.loading || this.expired || this.completed || this.submitting)
    );
  }

  showStatus(message, type) {
    this.messageElement.textContent = message;
    this.messageElement.classList.remove('is-success', 'is-error', 'is-neutral');
    this.messageElement.classList.add(
      'is-visible',
      type === 'success' ? 'is-success' : type === 'error' ? 'is-error' : 'is-neutral'
    );

  }

  hideStatus() {
    this.messageElement.classList.remove('is-visible', 'is-success', 'is-error', 'is-neutral');
    this.messageElement.textContent = '';
  }

  destroy() {
    this.loadVersion += 1;

    if (this.animationFrame !== null) {
      cancelAnimationFrame(this.animationFrame);
    }

    this.canvas.removeEventListener('pointerdown', this.handlePointerDown);
  }
}

const elements = {
  canvas: document.getElementById('captcha-canvas'),
  messageElement: document.getElementById('canvas-message'),
  selectionElement: document.getElementById('selection-value'),
  instructionElement: document.getElementById('captcha-instruction'),
  timerValueElement: document.getElementById('challenge-timer-value'),
  timerBarElement: document.getElementById('challenge-timer-bar'),
  timerRegionElement: document.getElementById('challenge-timer'),
  refreshButton: document.getElementById('refresh-button'),
  submitButton: document.getElementById('submit-button'),
  fallbackButton: document.getElementById('fallback-button'),
  fallbackDialog: document.getElementById('fallback-dialog'),
};

if (Object.values(elements).some((element) => element === null)) {
  throw new Error('The page is missing one or more required elements.');
}

const motionCaptcha = new MotionCaptcha(elements);

elements.refreshButton.addEventListener('click', () => void motionCaptcha.generateChallenge());
elements.submitButton.addEventListener('click', () => void motionCaptcha.submit());
elements.fallbackButton.addEventListener('click', () => elements.fallbackDialog.showModal());

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && elements.fallbackDialog.open) {
    elements.fallbackDialog.close();
    return;
  }

  if (event.key.toLowerCase() === 'r' && !event.ctrlKey && !event.metaKey && !event.altKey) {
    void motionCaptcha.generateChallenge();
  }
});

window.addEventListener('beforeunload', () => motionCaptcha.destroy());
