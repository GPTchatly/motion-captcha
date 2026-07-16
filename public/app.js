import { isChallengeExpired } from './challenge-timer.js';
import { CaptchaApi } from './captcha-api.js';
import { TARGET_GLYPH_COUNT, sanitizeNextPath } from './captcha-protocol.js';
import { CaptchaView } from './captcha-view.js';
import { LOGICAL_HEIGHT, LOGICAL_WIDTH, MotionObject } from './motion-model.js?v=1.3.1-phase-lock-v2';
import { MotionRenderer } from './motion-renderer.js?v=1.3.1-phase-lock-v2';

class MotionCaptcha {
  constructor(elements) {
    this.canvas = elements.canvas;
    this.view = new CaptchaView(elements);
    this.api = new CaptchaApi();
    this.renderer = new MotionRenderer(elements.canvas);
    this.nextPath = sanitizeNextPath(new URLSearchParams(window.location.search).get('next'));
    this.objects = [];
    this.selectedObjects = [];
    this.challengeId = null;
    this.issuedAt = 0;
    this.expiresAt = 0;
    this.selectionLimit = TARGET_GLYPH_COUNT;
    this.orderMode = null;
    this.promptSequence = [];
    this.completed = false;
    this.expired = false;
    this.loading = false;
    this.submitting = false;
    this.loadVersion = 0;
    this.animationFrame = null;
    this.handlePointerDown = this.handlePointerDown.bind(this);
    this.renderFrame = this.renderFrame.bind(this);
    this.canvas.addEventListener('pointerdown', this.handlePointerDown);
    this.animationFrame = requestAnimationFrame(this.renderFrame);
    void this.generateChallenge();
  }

  get state() {
    return {
      loading: this.loading,
      expired: this.expired,
      completed: this.completed,
      submitting: this.submitting
    };
  }

  resetChallenge() {
    this.loading = true;
    this.submitting = false;
    this.completed = false;
    this.expired = false;
    this.challengeId = null;
    this.issuedAt = 0;
    this.expiresAt = 0;
    this.orderMode = null;
    this.promptSequence = [];
    this.objects = [];
    this.selectedObjects = [];
    this.renderer.reset();
    this.view.beginChallenge(this.selectionLimit, this.state);
  }

  async generateChallenge() {
    const currentVersion = this.loadVersion + 1;
    this.loadVersion = currentVersion;
    this.resetChallenge();

    try {
      const data = await this.api.createChallenge();

      if (currentVersion !== this.loadVersion) {
        return;
      }

      this.challengeId = data.challengeId;
      this.issuedAt = data.issuedAt;
      this.expiresAt = data.expiresAt;
      this.selectionLimit = data.selectionLimit;
      this.orderMode = data.orderMode;
      this.promptSequence = [...data.promptSequence];
      this.objects = data.objects.map(
        (configuration) => new MotionObject({ ...configuration, maskEncoding: data.maskEncoding })
      );
      this.selectedObjects = [];
      this.renderer.load(this.objects, data.epochDurationMs, data.epochSeeds);
      this.loading = false;
      this.view.showPrompt(this.promptSequence);
      this.view.hideStatus();
      this.updateSelectionReadout();
      this.setInteractionState();
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
      this.loading = false;
      this.expired = true;
      this.setInteractionState();
      const message = error instanceof Error && ['rate_limited', 'quota_exhausted'].includes(error.message)
        ? 'Challenge limit reached. Wait before requesting another challenge.'
        : error instanceof Error && error.message === 'service_busy'
          ? 'The challenge service is at capacity. Try again shortly.'
          : 'Challenge could not be loaded. Use New challenge to retry.';
      this.view.showStatus(message, 'error');
      this.canvas.dispatchEvent(new CustomEvent('motioncaptcha:error', { bubbles: true }));
    }
  }

  renderFrame(now) {
    if (
      this.view.updateTimer(this.expiresAt, this.issuedAt) &&
      !this.expired &&
      !this.completed
    ) {
      this.expireChallenge();
    }

    this.renderer.render(now, !this.loading && !this.expired);
    this.animationFrame = requestAnimationFrame(this.renderFrame);
  }

  expireChallenge() {
    if (this.expired) {
      return;
    }

    this.expired = true;
    this.clearSelections();
    this.view.markExpired();
    this.updateSelectionReadout();
    this.setInteractionState();
    this.view.showStatus('Challenge expired after 30 seconds. Use New challenge to try again.', 'error');
    this.canvas.dispatchEvent(
      new CustomEvent('motioncaptcha:expire', {
        bubbles: true,
        detail: { challengeId: this.challengeId }
      })
    );
  }

  clearSelections() {
    this.selectedObjects = [];

    for (const object of this.objects) {
      object.selected = false;
      object.selectionOrder = null;
    }
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
      this.view.showStatus('Click directly on one of the moving characters.', 'error');
      return;
    }

    if (object.selected) {
      this.selectedObjects = this.selectedObjects.filter((selected) => selected.id !== object.id);
      object.selected = false;
      object.selectionOrder = null;
      this.renumberSelections();
      this.view.hideStatus();
      return;
    }

    if (this.selectedObjects.length >= this.selectionLimit) {
      this.view.showStatus(
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
    this.view.hideStatus();
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
      this.view.showStatus(`Select exactly ${this.selectionLimit} characters first.`, 'error');
      return;
    }

    this.submitting = true;
    this.setInteractionState();
    this.view.showStatus('Verifying the one-time challenge…', 'neutral');

    try {
      const selectedIds = this.selectedObjects.map((object) => object.id);
      const { response, result } = await this.api.verifyChallenge(this.challengeId, selectedIds, this.nextPath);

      if (!response.ok || !result.success) {
        this.handleRejectedVerification(result);
        return;
      }

      this.completed = true;
      this.submitting = false;
      this.setInteractionState();
      this.view.showStatus('Verified. Redirecting…', 'success');
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
      this.view.showStatus('Verification outcome is unknown. Request a new challenge.', 'error');
      this.canvas.dispatchEvent(new CustomEvent('motioncaptcha:error', { bubbles: true }));
    }
  }

  handleRejectedVerification(result) {
    this.submitting = false;

    if (result.code === 'challenge_expired') {
      this.expireChallenge();
      return;
    }

    const message = result.code === 'rate_limited'
      ? 'Too many attempts. Wait briefly, then request a new challenge.'
      : result.code === 'service_busy'
        ? 'Verification succeeded, but the session service is at capacity. Request a new challenge shortly.'
        : result.code === 'origin_mismatch' || result.code === 'csrf_invalid'
          ? 'The request security context was rejected. Request a new challenge.'
          : 'The selection was not accepted. Request a new challenge to try again.';
    this.expired = true;
    this.view.showStatus(message, 'error');
    this.canvas.dispatchEvent(
      new CustomEvent('motioncaptcha:error', {
        bubbles: true,
        detail: { code: result.code }
      })
    );
    this.setInteractionState();
  }

  updateSelectionReadout() {
    this.view.updateSelectionReadout(this.selectedObjects.length, this.selectionLimit);
  }

  setInteractionState() {
    this.view.setInteractionState(
      this.state,
      this.selectedObjects.length === this.selectionLimit
    );
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
  fallbackDialog: document.getElementById('fallback-dialog')
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
