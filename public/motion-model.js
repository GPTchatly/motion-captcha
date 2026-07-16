import { decodeAlpha4, MASK_ENCODING_ALPHA4 } from './captcha-protocol.js';

export const LOGICAL_WIDTH = 416;
export const LOGICAL_HEIGHT = 250;
export const DEFAULT_BACKGROUND_SPEED = 300;
export const DEFAULT_FOREGROUND_SPEED = 48;
export const DEFAULT_OBJECT_SPEED = 46;
export const BACKGROUND_BAND_COUNT = 6;

const TEXTURE_WIDTH = 384;
const TEXTURE_HEIGHT = 384;

export class SeededRandom {
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

export function createCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

export function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function modulo(value, modulus) {
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

export class NoiseTextureFactory {
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

export class MotionObject {
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
      ({ x: directionX, y: directionY } = rotateVector(directionX, directionY, epochTurn));
      this.lastEpochIndex = epochIndex;
      this.nextTurnAt = elapsedSeconds + this.random.between(1.0, 2.2);
    } else if (elapsedSeconds >= this.nextTurnAt) {
      const gentleTurn = this.random.sign() * this.random.between(0.08, 0.24);
      ({ x: directionX, y: directionY } = rotateVector(directionX, directionY, gentleTurn));
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
