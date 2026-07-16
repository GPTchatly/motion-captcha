import { createReadStream, promises as fs } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { validateRequestBody } from './request-schemas.mjs';

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

function createRequestError(statusCode, code) {
  const error = new Error(code);
  error.statusCode = statusCode;
  error.publicCode = code;
  return error;
}

function responseHeaders(state, extraHeaders = {}) {
  return { ...state.securityHeaders, ...extraHeaders };
}

export function sendJson(response, state, statusCode, payload, extraHeaders = {}) {
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

export function sendText(response, state, statusCode, body, extraHeaders = {}) {
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

export function sendRedirect(response, state, location, requestMethod, statusCode = 302) {
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

export async function readValidatedJson(request, schema, maximumBytes) {
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

export function logUnexpectedError(context, error) {
  const errorName = error instanceof Error ? error.name : 'UnknownError';
  console.error(`[motion-captcha] ${context}: ${errorName}`);
}

export function resolveStaticPath(publicDirectory, canonicalPathname) {
  const relativePath = canonicalPathname.replace(/^\/+/, '');
  const absolutePath = resolve(publicDirectory, relativePath);

  if (absolutePath !== publicDirectory && !absolutePath.startsWith(`${publicDirectory}${sep}`)) {
    return null;
  }

  return absolutePath;
}

export async function sendFile(response, state, absolutePath, requestMethod) {
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
