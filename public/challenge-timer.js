export const CHALLENGE_DURATION_MS = 30_000;

export function remainingChallengeMs(expiresAt, now = Date.now()) {
  if (!Number.isFinite(expiresAt) || !Number.isFinite(now)) {
    return 0;
  }

  return Math.max(0, expiresAt - now);
}

export function challengeProgress(expiresAt, issuedAt, now = Date.now()) {
  const duration = Math.max(1, expiresAt - issuedAt);
  return Math.max(0, Math.min(1, remainingChallengeMs(expiresAt, now) / duration));
}

export function formatRemainingTime(milliseconds) {
  const clamped = Math.max(0, milliseconds);
  return `${(clamped / 1000).toFixed(1)}s`;
}

export function isChallengeExpired(expiresAt, now = Date.now()) {
  return remainingChallengeMs(expiresAt, now) <= 0;
}
