import {
  challengeProgress,
  formatRemainingTime,
  isChallengeExpired,
  remainingChallengeMs
} from './challenge-timer.js';
import { TARGET_GLYPH_COUNT } from './captcha-protocol.js';

export class CaptchaView {
  constructor(elements) {
    this.canvas = elements.canvas;
    this.messageElement = elements.messageElement;
    this.selectionElement = elements.selectionElement;
    this.instructionElement = elements.instructionElement;
    this.timerValueElement = elements.timerValueElement;
    this.timerBarElement = elements.timerBarElement;
    this.timerRegionElement = elements.timerRegionElement;
    this.submitButton = elements.submitButton;
    this.refreshButton = elements.refreshButton;
  }

  beginChallenge(selectionLimit, state) {
    this.hideStatus();
    this.updateSelectionReadout(0, selectionLimit);
    this.setInteractionState(state, false);
    this.timerValueElement.textContent = '30.0s';
    this.timerBarElement.value = 1;
    this.timerBarElement.classList.remove('is-warning', 'is-expired');
    this.timerRegionElement.classList.remove('is-warning', 'is-expired');
    this.instructionElement.textContent = 'Loading challenge instructions…';
    this.canvas.setAttribute('aria-label', 'Animated CAPTCHA challenge. Loading ordering instructions.');
    this.showStatus('Loading a new one-time challenge…', 'neutral');
  }

  showPrompt(promptSequence) {
    if (promptSequence.length === TARGET_GLYPH_COUNT) {
      this.instructionElement.textContent = `Select in this exact order: ${promptSequence.join(' → ')}.`;
      this.canvas.setAttribute(
        'aria-label',
        `Animated CAPTCHA challenge. Select ${promptSequence.join(', then ')}.`
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

  updateTimer(expiresAt, issuedAt) {
    if (!expiresAt) {
      return false;
    }

    const remaining = remainingChallengeMs(expiresAt);
    const progress = challengeProgress(expiresAt, issuedAt);
    this.timerValueElement.textContent = formatRemainingTime(remaining);
    this.timerBarElement.value = progress;
    const isWarning = remaining > 0 && remaining <= 10_000;
    this.timerRegionElement.classList.toggle('is-warning', isWarning);
    this.timerBarElement.classList.toggle('is-warning', isWarning);
    return isChallengeExpired(expiresAt);
  }

  markExpired() {
    this.timerRegionElement.classList.remove('is-warning');
    this.timerRegionElement.classList.add('is-expired');
    this.timerBarElement.classList.remove('is-warning');
    this.timerBarElement.classList.add('is-expired');
    this.timerValueElement.textContent = '0.0s';
    this.timerBarElement.value = 0;
  }

  updateSelectionReadout(selectedCount, selectionLimit) {
    this.selectionElement.textContent = `${selectedCount} / ${selectionLimit}`;
  }

  setInteractionState(state, selectionComplete) {
    const inactive = state.loading || state.expired || state.completed || state.submitting;
    this.submitButton.disabled = inactive || !selectionComplete;
    this.submitButton.textContent = state.submitting
      ? 'Verifying…'
      : state.completed
        ? 'Redirecting…'
        : state.expired
          ? 'Expired'
          : 'Verify';
    this.refreshButton.disabled = state.loading || state.submitting || state.completed;
    this.canvas.classList.toggle('is-inactive', inactive);
    this.canvas.setAttribute('aria-disabled', String(inactive));
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
}
