import { randomUUID } from 'node:crypto';
import {
  SESSION_TTL_MS,
  createChallengeDefinition,
  sanitizeNextPath,
  verifyChallengeSelection
} from './security-core.mjs';
import {
  consumeAccessAdmission,
  consumeChallengeAdmission,
  consumeChallengeQuota,
  consumeSecurityContextAdmission,
  consumeVerificationAdmission,
  requireMutationSecurity,
  validateSecurityContextFetch
} from './server-admission.mjs';
import {
  challengeRouteParametersSchema,
  emptyRequestSchema,
  validateRequestBody,
  verificationRequestSchema
} from './request-schemas.mjs';
import { readValidatedJson, sendJson, sendText } from './server-http.mjs';

const CHALLENGE_BODY_LIMIT = 1_024;
const VERIFICATION_BODY_LIMIT = 8_192;

export function readActiveSession(request, state, now = Date.now()) {
  const visitorId = state.cookies.readSecurityContext(request)?.visitorId;
  const sessionId = state.cookies.readSessionId(request);

  if (!visitorId || !sessionId) {
    return null;
  }

  const session = state.sessions.get(sessionId, now);
  return session?.visitorId === visitorId ? { ...session, sessionId } : null;
}

function mapVerificationStatus(code) {
  switch (code) {
    case 'challenge_expired':
      return 410;
    case 'origin_mismatch':
    case 'visitor_mismatch':
      return 403;
    case 'challenge_not_found':
    case 'challenge_consumed':
      return 409;
    default:
      return 400;
  }
}

function sendRequestError(response, state, error) {
  const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 400;
  const code = typeof error?.publicCode === 'string' ? error.publicCode : 'invalid_request';
  sendJson(response, state, statusCode, { success: false, code });
}

function sendRateLimited(response, state) {
  sendJson(
    response,
    state,
    429,
    { success: false, code: 'rate_limited' },
    { 'Retry-After': '60' }
  );
}

async function handleChallengeCreation(request, response, state, maskLibrary) {
  const security = requireMutationSecurity(request, state);

  if (!security.success) {
    sendJson(response, state, security.statusCode, { success: false, code: security.code });
    return;
  }

  if (!consumeChallengeAdmission(security, state)) {
    sendRateLimited(response, state);
    return;
  }

  try {
    await readValidatedJson(request, emptyRequestSchema, CHALLENGE_BODY_LIMIT);
  } catch (error) {
    sendRequestError(response, state, error);
    return;
  }

  if (!consumeChallengeQuota(security, state)) {
    sendJson(response, state, 429, { success: false, code: 'quota_exhausted' });
    return;
  }

  state.challenges.prune();
  state.challenges.deleteWhere((challenge) => challenge.visitorId === security.context.visitorId);

  if (state.challenges.size >= state.config.maxActiveChallenges) {
    sendJson(response, state, 503, { success: false, code: 'service_busy' }, { 'Retry-After': '30' });
    return;
  }

  const { publicChallenge, privateChallenge } = createChallengeDefinition({
    maskLibrary,
    origin: state.config.publicOrigin,
    visitorId: security.context.visitorId
  });

  if (!state.challenges.set(privateChallenge.challengeId, privateChallenge)) {
    sendJson(response, state, 503, { success: false, code: 'service_busy' }, { 'Retry-After': '30' });
    return;
  }

  if (typeof state.onChallengeCreated === 'function') {
    state.onChallengeCreated({
      challengeId: privateChallenge.challengeId,
      expectedIds: [...privateChallenge.expectedIds],
      visitorId: privateChallenge.visitorId
    });
  }

  sendJson(response, state, 201, publicChallenge);
}

async function handleChallengeVerification(request, response, state, challengeId) {
  const security = requireMutationSecurity(request, state);

  if (!security.success) {
    sendJson(response, state, security.statusCode, { success: false, code: security.code });
    return;
  }

  if (!consumeVerificationAdmission(security, state)) {
    sendRateLimited(response, state);
    return;
  }

  const routeValidation = validateRequestBody(challengeRouteParametersSchema, { challengeId });

  if (!routeValidation.success) {
    sendJson(response, state, 400, { success: false, code: 'invalid_request' });
    return;
  }

  let body;

  try {
    body = await readValidatedJson(request, verificationRequestSchema, VERIFICATION_BODY_LIMIT);
  } catch (error) {
    sendRequestError(response, state, error);
    return;
  }

  const availableChallenge = state.challenges.get(routeValidation.data.challengeId);

  if (availableChallenge && availableChallenge.visitorId !== security.context.visitorId) {
    sendJson(response, state, 403, { success: false, code: 'visitor_mismatch' });
    return;
  }

  const challenge = state.challenges.take(routeValidation.data.challengeId);
  const result = verifyChallengeSelection({
    challenge,
    selectedIds: body.selectedIds,
    origin: state.config.publicOrigin,
    visitorId: security.context.visitorId
  });

  if (!result.success) {
    sendJson(response, state, mapVerificationStatus(result.code), result);
    return;
  }

  state.sessions.deleteWhere((session) => session.visitorId === security.context.visitorId);
  const sessionId = randomUUID();
  const verifiedAt = Date.now();
  const session = {
    visitorId: security.context.visitorId,
    verifiedAt,
    expiresAt: verifiedAt + SESSION_TTL_MS
  };

  if (!state.sessions.set(sessionId, session)) {
    sendJson(response, state, 503, { success: false, code: 'service_busy' }, { 'Retry-After': '30' });
    return;
  }

  const nextPath = sanitizeNextPath(body.nextPath);
  sendJson(
    response,
    state,
    200,
    { success: true, nextPath, sessionExpiresAt: session.expiresAt },
    {
      'Set-Cookie': state.cookies.createSessionCookie(
        sessionId,
        Math.floor(SESSION_TTL_MS / 1_000)
      )
    }
  );
}

async function handleLogout(request, response, state) {
  const security = requireMutationSecurity(request, state);

  if (!security.success) {
    sendJson(response, state, security.statusCode, { success: false, code: security.code });
    return;
  }

  if (!consumeAccessAdmission(request, state, security)) {
    sendRateLimited(response, state);
    return;
  }

  try {
    await readValidatedJson(request, emptyRequestSchema, CHALLENGE_BODY_LIMIT);
  } catch (error) {
    sendRequestError(response, state, error);
    return;
  }

  const sessionId = state.cookies.readSessionId(request);
  const session = sessionId ? state.sessions.get(sessionId) : null;

  if (sessionId && session?.visitorId === security.context.visitorId) {
    state.sessions.delete(sessionId);
  }

  sendJson(
    response,
    state,
    200,
    { success: true },
    { 'Set-Cookie': state.cookies.clearSessionCookie() }
  );
}

export async function handleApiRequest(request, response, pathname, state, maskLibrary) {
  if (pathname === '/api/security-context') {
    if (request.method !== 'GET') {
      sendText(response, state, 405, 'Method not allowed', { Allow: 'GET' });
      return;
    }

    if (!validateSecurityContextFetch(request)) {
      sendJson(response, state, 403, { success: false, code: 'cross_site_request' });
      return;
    }

    if (!consumeSecurityContextAdmission(request, state)) {
      sendRateLimited(response, state);
      return;
    }

    const context = state.cookies.issueSecurityContext(request);
    const headers = context.cookies.length > 0 ? { 'Set-Cookie': context.cookies } : {};
    sendJson(response, state, 200, { csrfToken: context.csrfToken }, headers);
    return;
  }

  if (pathname === '/api/challenges') {
    if (request.method !== 'POST') {
      sendText(response, state, 405, 'Method not allowed', { Allow: 'POST' });
      return;
    }

    await handleChallengeCreation(request, response, state, maskLibrary);
    return;
  }

  const verificationMatch = pathname.match(/^\/api\/challenges\/([^/]+)\/verify$/);

  if (verificationMatch) {
    if (request.method !== 'POST') {
      sendText(response, state, 405, 'Method not allowed', { Allow: 'POST' });
      return;
    }

    await handleChallengeVerification(request, response, state, verificationMatch[1]);
    return;
  }

  if (pathname === '/api/session') {
    if (request.method !== 'GET') {
      sendText(response, state, 405, 'Method not allowed', { Allow: 'GET' });
      return;
    }

    if (!consumeAccessAdmission(request, state)) {
      sendRateLimited(response, state);
      return;
    }

    const session = readActiveSession(request, state);

    if (!session) {
      sendJson(response, state, 401, { authenticated: false });
      return;
    }

    sendJson(response, state, 200, {
      authenticated: true,
      verifiedAt: session.verifiedAt,
      expiresAt: session.expiresAt
    });
    return;
  }

  if (pathname === '/api/logout') {
    if (request.method !== 'POST') {
      sendText(response, state, 405, 'Method not allowed', { Allow: 'POST' });
      return;
    }

    await handleLogout(request, response, state);
    return;
  }

  sendJson(response, state, 404, { success: false, code: 'not_found' });
}
