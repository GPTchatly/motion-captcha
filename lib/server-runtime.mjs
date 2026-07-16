import {
  createBoundedTtlStore,
  createFixedWindowLimiter,
  createSlidingWindowLimiter
} from './security-core.mjs';
import { createCookieSecurity, createSecurityHeaders } from './http-security.mjs';

const RATE_WINDOW_MS = 60_000;
const QUOTA_WINDOW_MS = 24 * 60 * 60_000;

export function parsePort(value) {
  if (!/^\d+$/.test(String(value))) {
    throw new RangeError('PORT must be an integer from 0 to 65535.');
  }

  const port = Number(value);

  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new RangeError('PORT must be an integer from 0 to 65535.');
  }

  return port;
}

export function createRuntimeState(config, onChallengeCreated) {
  const maxKeys = config.maxLimiterKeys;
  const state = {
    config,
    securityHeaders: createSecurityHeaders(config),
    cookies: createCookieSecurity(config),
    challenges: createBoundedTtlStore({ maxEntries: config.maxActiveChallenges }),
    sessions: createBoundedTtlStore({ maxEntries: config.maxActiveSessions }),
    challengeIpLimiter: createSlidingWindowLimiter({
      limit: config.challengeBurstLimit,
      windowMs: RATE_WINDOW_MS,
      maxKeys
    }),
    challengeIdentityLimiter: createSlidingWindowLimiter({
      limit: config.challengeBurstLimit,
      windowMs: RATE_WINDOW_MS,
      maxKeys
    }),
    verificationIpLimiter: createSlidingWindowLimiter({
      limit: config.verificationBurstLimit,
      windowMs: RATE_WINDOW_MS,
      maxKeys
    }),
    verificationIdentityLimiter: createSlidingWindowLimiter({
      limit: config.verificationBurstLimit,
      windowMs: RATE_WINDOW_MS,
      maxKeys
    }),
    globalChallengeLimiter: createSlidingWindowLimiter({
      limit: config.globalChallengeLimit,
      windowMs: RATE_WINDOW_MS,
      maxKeys: 1
    }),
    globalVerificationLimiter: createSlidingWindowLimiter({
      limit: config.globalVerificationLimit,
      windowMs: RATE_WINDOW_MS,
      maxKeys: 1
    }),
    dailyIpQuota: createFixedWindowLimiter({
      limit: config.dailyChallengeQuota,
      windowMs: QUOTA_WINDOW_MS,
      maxKeys
    }),
    dailyVisitorQuota: createFixedWindowLimiter({
      limit: config.dailyChallengeQuota,
      windowMs: QUOTA_WINDOW_MS,
      maxKeys
    }),
    activeRequests: 0,
    onChallengeCreated
  };

  state.cleanupTimer = setInterval(() => {
    const now = Date.now();
    state.challenges.prune(now);
    state.sessions.prune(now);
    state.challengeIpLimiter.prune(now);
    state.challengeIdentityLimiter.prune(now);
    state.verificationIpLimiter.prune(now);
    state.verificationIdentityLimiter.prune(now);
    state.globalChallengeLimiter.prune(now);
    state.globalVerificationLimiter.prune(now);
    state.dailyIpQuota.prune(now);
    state.dailyVisitorQuota.prune(now);
  }, 30_000);
  state.cleanupTimer.unref();
  return state;
}

export function disposeRuntimeState(state) {
  if (state?.cleanupTimer) {
    clearInterval(state.cleanupTimer);
  }
}
