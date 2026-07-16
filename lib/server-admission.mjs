import {
  hashClientIdentity,
  resolveClientAddress,
  validateSameOriginRequest
} from './http-security.mjs';

function createClientKeys(request, state, visitorId = 'anonymous') {
  const clientAddress = resolveClientAddress(request, state.config);
  return {
    clientAddress,
    ipKey: hashClientIdentity(state.config, clientAddress, 'ip'),
    identityKey: hashClientIdentity(state.config, clientAddress, visitorId),
    visitorKey: hashClientIdentity(state.config, 'visitor', visitorId)
  };
}

export function requireMutationSecurity(request, state) {
  if (!validateSameOriginRequest(request, state.config)) {
    return { success: false, statusCode: 403, code: 'origin_mismatch' };
  }

  const context = state.cookies.readSecurityContext(request);

  if (!context || !state.cookies.validateCsrf(request, context)) {
    return { success: false, statusCode: 403, code: 'csrf_invalid' };
  }

  return {
    success: true,
    context,
    ...createClientKeys(request, state, context.visitorId)
  };
}

export function consumeChallengeAdmission(security, state, now = Date.now()) {
  return (
    state.challengeIpLimiter.consume(security.ipKey, now) &&
    state.challengeIdentityLimiter.consume(security.identityKey, now) &&
    state.globalChallengeLimiter.consume('global', now)
  );
}

export function consumeChallengeQuota(security, state, now = Date.now()) {
  return (
    state.dailyIpQuota.consume(security.ipKey, now) &&
    state.dailyVisitorQuota.consume(security.visitorKey, now)
  );
}

export function consumeVerificationAdmission(security, state, now = Date.now()) {
  return (
    state.verificationIpLimiter.consume(security.ipKey, now) &&
    state.verificationIdentityLimiter.consume(security.identityKey, now) &&
    state.globalVerificationLimiter.consume('global', now)
  );
}

export function validateSecurityContextFetch(request) {
  const fetchSite = request.headers['sec-fetch-site'];
  return fetchSite === undefined || fetchSite === 'same-origin' || fetchSite === 'none';
}

export function consumeSecurityContextAdmission(request, state, now = Date.now()) {
  const { ipKey } = createClientKeys(request, state);
  return (
    state.securityContextIpLimiter.consume(ipKey, now) &&
    state.globalSecurityContextLimiter.consume('global', now)
  );
}

export function consumeAccessAdmission(request, state, security, now = Date.now()) {
  const visitorId = security?.context?.visitorId ??
    state.cookies.readSecurityContext(request)?.visitorId ??
    'anonymous';
  const keys = security?.success ? security : createClientKeys(request, state, visitorId);
  return (
    state.accessIpLimiter.consume(keys.ipKey, now) &&
    state.accessIdentityLimiter.consume(keys.identityKey, now) &&
    state.globalAccessLimiter.consume('global', now)
  );
}
