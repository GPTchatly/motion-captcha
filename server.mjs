import { randomUUID } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SESSION_TTL_MS,
  createBoundedTtlStore,
  createChallengeDefinition,
  createFixedWindowLimiter,
  createSlidingWindowLimiter,
  sanitizeNextPath,
  verifyChallengeSelection
} from './lib/security-core.mjs';
import {
  canonicalizePathname,
  createCookieSecurity,
  createRuntimeConfig,
  createSecurityHeaders,
  hasCanonicalHost,
  hashClientIdentity,
  resolveClientAddress,
  validateSameOriginRequest
} from './lib/http-security.mjs';
import {
  challengeRouteParametersSchema,
  emptyRequestSchema,
  validateRequestBody,
  verificationRequestSchema
} from './lib/request-schemas.mjs';

const projectDirectory = resolve(fileURLToPath(new URL('./', import.meta.url)));
const publicDirectory = resolve(projectDirectory, 'public');
const protectedIndexPath = resolve(projectDirectory, 'protected/index.html');
const maskLibraryPath = resolve(projectDirectory, 'server-assets/glyph-masks.json');
const maskLibrary = JSON.parse(await fs.readFile(maskLibraryPath, 'utf8'));
const CHALLENGE_BODY_LIMIT = 1_024;
const VERIFICATION_BODY_LIMIT = 8_192;
const RATE_WINDOW_MS = 60_000;
const QUOTA_WINDOW_MS = 24 * 60 * 60_000;

const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.webp', 'image/webp']
]);

function parsePort(value) {
  if (!/^\d+$/.test(String(value))) {
    throw new RangeError('PORT must be an integer from 0 to 65535.');
  }

  const port = Number(value);

  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new RangeError('PORT must be an integer from 0 to 65535.');
  }

  return port;
}

function createRequestError(statusCode, code) {
  const error = new Error(code);
  error.statusCode = statusCode;
  error.publicCode = code;
  return error;
}

function createRuntimeState(config, onChallengeCreated) {
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

function responseHeaders(state, extraHeaders = {}) {
  return { ...state.securityHeaders, ...extraHeaders };
}

function sendJson(response, state, statusCode, payload, extraHeaders = {}) {
  const serialized = JSON.stringify(payload);
  response.writeHead(
    statusCode,
    responseHeaders(state, {
      'Cache-Control': 'no-store, max-age=0',
      'Content-Length': Buffer.byteLength(serialized),
      'Content-Type': 'application/json; charset=utf-8',
      ...extraHeaders
    })
  );
  response.end(serialized);
}

function sendText(response, state, statusCode, body, extraHeaders = {}) {
  response.writeHead(
    statusCode,
    responseHeaders(state, {
      'Cache-Control': 'no-store, max-age=0',
      'Content-Length': Buffer.byteLength(body),
      'Content-Type': 'text/plain; charset=utf-8',
      ...extraHeaders
    })
  );
  response.end(body);
}

function sendRedirect(response, state, location, requestMethod, statusCode = 302) {
  const body = `Redirecting to ${location}`;
  response.writeHead(
    statusCode,
    responseHeaders(state, {
      'Cache-Control': 'no-store, max-age=0',
      'Content-Length': Buffer.byteLength(body),
      'Content-Type': 'text/plain; charset=utf-8',
      Location: location
    })
  );
  response.end(requestMethod === 'HEAD' ? undefined : body);
}

async function readValidatedJson(request, schema, maximumBytes) {
  const contentType = request.headers['content-type'];

  if (typeof contentType !== 'string' || contentType.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    throw createRequestError(415, 'unsupported_media_type');
  }

  const contentLength = request.headers['content-length'];

  if (typeof contentLength === 'string') {
    if (!/^\d+$/.test(contentLength) || Number(contentLength) > maximumBytes) {
      throw createRequestError(413, 'request_too_large');
    }
  }

  const chunks = [];
  let byteLength = 0;

  for await (const chunk of request) {
    byteLength += chunk.length;

    if (byteLength > maximumBytes) {
      request.resume();
      throw createRequestError(413, 'request_too_large');
    }

    chunks.push(chunk);
  }

  let parsedBody;

  try {
    parsedBody = chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw createRequestError(400, 'invalid_json');
  }

  const validation = validateRequestBody(schema, parsedBody);

  if (!validation.success) {
    throw createRequestError(400, 'invalid_request');
  }

  return validation.data;
}

function logUnexpectedError(context, error) {
  const errorName = error instanceof Error ? error.name : 'UnknownError';
  console.error(`[motion-captcha] ${context}: ${errorName}`);
}

function resolveStaticPath(canonicalPathname) {
  const relativePath = canonicalPathname.replace(/^\/+/, '');
  const absolutePath = resolve(publicDirectory, relativePath);

  if (absolutePath !== publicDirectory && !absolutePath.startsWith(`${publicDirectory}${sep}`)) {
    return null;
  }

  return absolutePath;
}

async function sendFile(response, state, absolutePath, requestMethod) {
  try {
    const stats = await fs.stat(absolutePath);

    if (!stats.isFile()) {
      sendText(response, state, 404, 'Not found');
      return;
    }

    const extension = extname(absolutePath).toLowerCase();
    response.writeHead(
      200,
      responseHeaders(state, {
        'Cache-Control': extension === '.html' ? 'no-store, max-age=0' : 'public, max-age=3600',
        'Content-Length': stats.size,
        'Content-Type': contentTypes.get(extension) ?? 'application/octet-stream'
      })
    );

    if (requestMethod === 'HEAD') {
      response.end();
      return;
    }

    const stream = createReadStream(absolutePath);
    stream.on('error', (error) => {
      logUnexpectedError('static stream', error);
      response.destroy();
    });
    stream.pipe(response);
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      sendText(response, state, 404, 'Not found');
      return;
    }

    logUnexpectedError('static response', error);
    sendText(response, state, 500, 'Internal server error');
  }
}

function readActiveSession(request, state, now = Date.now()) {
  const visitorId = state.cookies.readSecurityContext(request)?.visitorId;
  const sessionId = state.cookies.readSessionId(request);

  if (!visitorId || !sessionId) {
    return null;
  }

  const session = state.sessions.get(sessionId, now);
  return session?.visitorId === visitorId ? { ...session, sessionId } : null;
}

function requireMutationSecurity(request, state) {
  if (!validateSameOriginRequest(request, state.config)) {
    return { success: false, statusCode: 403, code: 'origin_mismatch' };
  }

  const context = state.cookies.readSecurityContext(request);

  if (!context || !state.cookies.validateCsrf(request, context)) {
    return { success: false, statusCode: 403, code: 'csrf_invalid' };
  }

  const clientAddress = resolveClientAddress(request, state.config);
  return {
    success: true,
    context,
    clientAddress,
    ipKey: hashClientIdentity(state.config, clientAddress, 'ip'),
    identityKey: hashClientIdentity(state.config, clientAddress, context.visitorId),
    visitorKey: hashClientIdentity(state.config, 'visitor', context.visitorId)
  };
}

function consumeChallengeLimits(security, state, now = Date.now()) {
  if (
    !state.challengeIpLimiter.consume(security.ipKey, now) ||
    !state.challengeIdentityLimiter.consume(security.identityKey, now) ||
    !state.globalChallengeLimiter.consume('global', now)
  ) {
    return 'rate_limited';
  }

  if (
    !state.dailyIpQuota.consume(security.ipKey, now) ||
    !state.dailyVisitorQuota.consume(security.visitorKey, now)
  ) {
    return 'quota_exhausted';
  }

  return null;
}

function consumeVerificationLimits(security, state, now = Date.now()) {
  return (
    state.verificationIpLimiter.consume(security.ipKey, now) &&
    state.verificationIdentityLimiter.consume(security.identityKey, now) &&
    state.globalVerificationLimiter.consume('global', now)
  );
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

async function handleChallengeCreation(request, response, state) {
  const security = requireMutationSecurity(request, state);

  if (!security.success) {
    sendJson(response, state, security.statusCode, { success: false, code: security.code });
    return;
  }

  try {
    await readValidatedJson(request, emptyRequestSchema, CHALLENGE_BODY_LIMIT);
  } catch (error) {
    sendRequestError(response, state, error);
    return;
  }

  const limitFailure = consumeChallengeLimits(security, state);

  if (limitFailure) {
    sendJson(
      response,
      state,
      429,
      { success: false, code: limitFailure },
      limitFailure === 'rate_limited' ? { 'Retry-After': '60' } : {}
    );
    return;
  }

  state.challenges.deleteWhere((challenge) => challenge.visitorId === security.context.visitorId);
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
  const routeValidation = validateRequestBody(challengeRouteParametersSchema, { challengeId });

  if (!routeValidation.success) {
    sendJson(response, state, 400, { success: false, code: 'invalid_request' });
    return;
  }

  const security = requireMutationSecurity(request, state);

  if (!security.success) {
    sendJson(response, state, security.statusCode, { success: false, code: security.code });
    return;
  }

  let body;

  try {
    body = await readValidatedJson(request, verificationRequestSchema, VERIFICATION_BODY_LIMIT);
  } catch (error) {
    sendRequestError(response, state, error);
    return;
  }

  if (!consumeVerificationLimits(security, state)) {
    sendJson(
      response,
      state,
      429,
      { success: false, code: 'rate_limited' },
      { 'Retry-After': '60' }
    );
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

async function handleApiRequest(request, response, pathname, state) {
  if (pathname === '/api/security-context') {
    if (request.method !== 'GET') {
      sendText(response, state, 405, 'Method not allowed', { Allow: 'GET' });
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

    await handleChallengeCreation(request, response, state);
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

async function handleRequest(request, response, state) {
  if (!state) {
    response.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Service unavailable');
    return;
  }

  if (state.activeRequests >= state.config.maxActiveRequests) {
    sendJson(response, state, 503, { success: false, code: 'service_busy' }, { 'Retry-After': '5' });
    return;
  }

  state.activeRequests += 1;

  try {
    if (!hasCanonicalHost(request, state.config)) {
      sendText(response, state, 421, 'Misdirected request');
      return;
    }

    const rawTarget = request.url;

    if (typeof rawTarget !== 'string' || !rawTarget.startsWith('/')) {
      sendText(response, state, 400, 'Invalid request target');
      return;
    }

    const queryIndex = rawTarget.indexOf('?');
    const rawPathname = queryIndex === -1 ? rawTarget : rawTarget.slice(0, queryIndex);
    const pathname = canonicalizePathname(rawPathname);

    if (!pathname) {
      sendText(response, state, 400, 'Invalid path');
      return;
    }

    if (pathname.startsWith('/api/')) {
      await handleApiRequest(request, response, pathname, state);
      return;
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      sendText(response, state, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
      return;
    }

    if (pathname === '/' || pathname === '/index.html') {
      const session = readActiveSession(request, state);

      if (!session) {
        const requestUrl = new URL(rawTarget, state.config.publicOrigin);
        const nextPath = sanitizeNextPath(`/index.html${requestUrl.search}`);
        sendRedirect(
          response,
          state,
          `/captcha.html?next=${encodeURIComponent(nextPath)}`,
          request.method
        );
        return;
      }

      await sendFile(response, state, protectedIndexPath, request.method);
      return;
    }

    const absolutePath = resolveStaticPath(pathname);

    if (!absolutePath) {
      sendText(response, state, 400, 'Invalid path');
      return;
    }

    await sendFile(response, state, absolutePath, request.method);
  } catch (error) {
    logUnexpectedError('request', error);

    if (!response.headersSent) {
      sendText(response, state, 500, 'Internal server error');
    } else {
      response.destroy();
    }
  } finally {
    state.activeRequests -= 1;
  }
}

export async function startMotionCaptchaServer({
  env = process.env,
  host = '0.0.0.0',
  port = parsePort(env.PORT ?? '3000'),
  publicHostname = host === '0.0.0.0' || host === '::' ? 'localhost' : host,
  onChallengeCreated
} = {}) {
  let state = null;
  const needsDynamicDevelopmentOrigin = port === 0 && !env.PUBLIC_ORIGIN && env.NODE_ENV !== 'production';

  if (!needsDynamicDevelopmentOrigin) {
    state = createRuntimeState(createRuntimeConfig(env, port), onChallengeCreated);
  }

  const server = createServer((request, response) => {
    void handleRequest(request, response, state);
  });
  server.maxConnections = state?.config.maxConnections ?? 256;
  server.maxHeadersCount = 64;
  server.headersTimeout = 5_000;
  server.requestTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 100;
  server.timeout = 15_000;
  server.on('clientError', (error, socket) => {
    if (socket.writable && !socket.destroyed) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    }
  });

  await new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(port, host, () => {
      server.off('error', rejectPromise);
      resolvePromise();
    });
  });

  if (!state) {
    const address = server.address();
    const assignedPort = typeof address === 'object' && address ? address.port : port;
    const developmentEnv = {
      ...env,
      PUBLIC_ORIGIN: `http://${publicHostname}:${assignedPort}`
    };
    state = createRuntimeState(createRuntimeConfig(developmentEnv, assignedPort), onChallengeCreated);
    server.maxConnections = state.config.maxConnections;
  }

  return {
    server,
    publicOrigin: state.config.publicOrigin,
    async close() {
      clearInterval(state.cleanupTimer);
      await new Promise((resolvePromise, rejectPromise) => {
        server.close((error) => (error ? rejectPromise(error) : resolvePromise()));
        server.closeAllConnections?.();
      });
    }
  };
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  const runningServer = await startMotionCaptchaServer();
  console.log(`Motion-CAPTCHA running at ${runningServer.publicOrigin}`);
}
