import { sanitizeNextPath } from './security-core.mjs';
import { canonicalizePathname, hasCanonicalHost } from './http-security.mjs';
import { handleApiRequest, readActiveSession } from './server-api.mjs';
import {
  logUnexpectedError,
  resolveStaticPath,
  sendFile,
  sendJson,
  sendRedirect,
  sendText
} from './server-http.mjs';

function parseRequestTarget(rawTarget, publicOrigin) {
  const queryIndex = rawTarget.indexOf('?');
  const rawPathname = queryIndex === -1 ? rawTarget : rawTarget.slice(0, queryIndex);
  const pathname = canonicalizePathname(rawPathname);

  if (!pathname) {
    return null;
  }

  const requestUrl = new URL(rawTarget, publicOrigin);
  return { pathname, rawPathname, search: requestUrl.search };
}

async function handleProtectedRoute(request, response, state, target, protectedIndexPath) {
  const session = readActiveSession(request, state);

  if (!session) {
    const nextPath = sanitizeNextPath(`/index.html${target.search}`);
    sendRedirect(
      response,
      state,
      `/captcha.html?next=${encodeURIComponent(nextPath)}`,
      request.method
    );
    return;
  }

  if (target.rawPathname !== '/' && target.rawPathname !== '/index.html') {
    sendRedirect(response, state, `/index.html${target.search}`, request.method, 308);
    return;
  }

  await sendFile(response, state, protectedIndexPath, request.method);
}

export async function handleRequest(request, response, state, resources) {
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

    const target = parseRequestTarget(rawTarget, state.config.publicOrigin);

    if (!target) {
      sendText(response, state, 400, 'Invalid path');
      return;
    }

    if (target.pathname.startsWith('/api/')) {
      await handleApiRequest(request, response, target.pathname, state, resources.maskLibrary);
      return;
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      sendText(response, state, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
      return;
    }

    if (target.pathname === '/' || target.pathname === '/index.html') {
      await handleProtectedRoute(request, response, state, target, resources.protectedIndexPath);
      return;
    }

    const absolutePath = resolveStaticPath(resources.publicDirectory, target.pathname);

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
