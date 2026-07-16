import {
  BACKGROUND_BAND_COUNT,
  clamp,
  createCanvas,
  DEFAULT_BACKGROUND_SPEED,
  DEFAULT_FOREGROUND_DRIFT_SPEED,
  DEFAULT_OBJECT_SPEED,
  LOGICAL_HEIGHT,
  LOGICAL_WIDTH,
  MAX_BACKGROUND_SPEED_SCALE,
  MIN_BACKGROUND_SPEED_SCALE,
  modulo,
  normalizeVector,
  NoiseTextureFactory,
  SeededRandom
} from './motion-model.js?v=1.3.1-phase-lock-v2';

export class MotionRenderer {
  constructor(canvas) {
    const context = canvas.getContext('2d', { alpha: false, desynchronized: true });

    if (!context) {
      throw new Error('Canvas 2D is unavailable.');
    }

    this.canvas = canvas;
    this.context = context;
    this.scene = createCanvas(LOGICAL_WIDTH, LOGICAL_HEIGHT);
    this.sceneContext = this.scene.getContext('2d', { alpha: false });
    this.objectLayer = createCanvas(LOGICAL_WIDTH, LOGICAL_HEIGHT);
    this.objectLayerContext = this.objectLayer.getContext('2d');
    this.noiseFactory = new NoiseTextureFactory();
    this.objects = [];
    this.epochDurationMs = 10_000;
    this.epochSeeds = [];
    this.textureCache = new Map();
    this.bandProfileCache = new Map();
    this.visualStartedAt = performance.now();
    this.lastFrameAt = performance.now();

    if (!this.sceneContext || !this.objectLayerContext) {
      throw new Error('Unable to create offscreen rendering contexts.');
    }
  }

  reset() {
    this.objects = [];
    this.epochSeeds = [];
    this.textureCache.clear();
    this.bandProfileCache.clear();
  }

  load(objects, epochDurationMs, epochSeeds) {
    this.objects = objects;
    this.epochDurationMs = epochDurationMs;
    this.epochSeeds = epochSeeds;
    this.visualStartedAt = performance.now();
    this.lastFrameAt = this.visualStartedAt;
    this.ensureEpochResources(0);
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
        const direction = normalizeVector(
          random.sign() * random.between(mostlyVertical ? 0.06 : 0.38, mostlyVertical ? 0.28 : 0.78),
          random.sign() * random.between(mostlyVertical ? 0.7 : 0.18, mostlyVertical ? 1.16 : 0.55)
        );

        return {
          directionX: direction.x,
          directionY: direction.y,
          speedScale: random.between(MIN_BACKGROUND_SPEED_SCALE, MAX_BACKGROUND_SPEED_SCALE),
          phase: random.between(0, Math.PI * 2),
          frequency: random.between(0.32, 0.72),
          wobbleAmplitude: random.between(2, 7)
        };
      });
      this.bandProfileCache.set(boundedIndex, profiles);
    }

    return {
      textures: this.textureCache.get(boundedIndex),
      bands: this.bandProfileCache.get(boundedIndex)
    };
  }

  render(now, isActive) {
    const elapsedSeconds = Math.max(0, now - this.visualStartedAt) / 1000;
    const epochDurationSeconds = Math.max(1, this.epochDurationMs / 1000);
    const epochIndex = clamp(
      Math.floor(elapsedSeconds / epochDurationSeconds),
      0,
      Math.max(0, this.epochSeeds.length - 1)
    );
    const rawDeltaSeconds = Math.max(0, now - this.lastFrameAt) / 1000;
    const deltaSeconds = Math.min(rawDeltaSeconds, 0.05);
    this.lastFrameAt = now;

    if (isActive) {
      for (const object of this.objects) {
        object.update(deltaSeconds, elapsedSeconds, DEFAULT_OBJECT_SPEED, epochIndex);
      }
    }

    this.drawScene(elapsedSeconds, epochIndex);
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

    const renderedX = Math.round(object.x);
    const renderedY = Math.round(object.y);
    const textureTravel = elapsedSeconds * DEFAULT_FOREGROUND_DRIFT_SPEED;
    const textureOffsetX = object.texturePhaseX - renderedX + textureTravel * object.textureDirectionX;
    const textureOffsetY = object.texturePhaseY - renderedY + textureTravel * object.textureDirectionY;
    this.drawTiledTexture(layerContext, foregroundTexture, textureOffsetX, textureOffsetY);

    layerContext.globalCompositeOperation = 'destination-in';
    layerContext.drawImage(object.mask.canvas, renderedX, renderedY);
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
}
