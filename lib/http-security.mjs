import { createHmac, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { posix } from 'node:path';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const MAX_FORWARDED_HOPS = 32;

function parseIntegerSetting(env, name, fallback, minimum, maximum) {
  const rawValue = env[name];

  if (rawValue === undefined || rawValue === '') {
    return fallback;
  }

  if (!/^\d+$/.test(rawValue)) {
    throw new RangeError(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }

  const parsed = Number(rawValue);

  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new RangeError(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }

  return parsed;
}

function parseBooleanSetting(value, name) {
  if (value === undefined || value === '') {
    return false;
  }

  if (value === '1' || value === 'true') {
    return true;
  }

  if (value === '0' || value === 'false') {
    return false;
  }

  throw new Error(`${name} must be one of: 0, 1, false, true.`);
}

function normalizeIpAddress(address) {
  if (typeof address !== 'string' || address.length === 0) {
    return 'unknown';
  }

  const normalized = address.startsWith('::ffff:') ? address.slice(7) : address;
  return isIP(normalized) > 0 ? normalized : address;
}

export function createRuntimeConfig(env = process.env, port = 3000) {
  const isProduction = env.NODE_ENV === 'production';

  if (isProduction && !env.PUBLIC_ORIGIN) {
    throw new Error('PUBLIC_ORIGIN is required in production.');
  }

  const publicOriginUrl = new URL(env.PUBLIC_ORIGIN ?? `http://localhost:${port}`);

  if (
    !['http:', 'https:'].includes(publicOriginUrl.protocol) ||
    publicOriginUrl.username ||
    publicOriginUrl.password ||
    publicOriginUrl.pathname !== '/' ||
    publicOriginUrl.search ||
    publicOriginUrl.hash
  ) {
    throw new Error('PUBLIC_ORIGIN must be an HTTP(S) origin without credentials, a path, query, or fragment.');
  }

  const secureCookies = publicOriginUrl.protocol === 'https:';

  if (isProduction && !secureCookies) {
    throw new Error('Production PUBLIC_ORIGIN must use HTTPS.');
  }

  if (!secureCookies && !LOOPBACK_HOSTS.has(publicOriginUrl.hostname)) {
    throw new Error('Plain-HTTP development is restricted to loopback hosts.');
  }

  const configuredSecret = env.COOKIE_SIGNING_SECRET;

  if (isProduction && (!configuredSecret || configuredSecret.length < 32)) {
    throw new Error('COOKIE_SIGNING_SECRET must contain at least 32 characters in production.');
  }

  if (configuredSecret && configuredSecret.length < 32) {
    throw new Error('COOKIE_SIGNING_SECRET must contain at least 32 characters.');
  }

  const trustedProxyAddresses = new Set();

  for (const rawAddress of (env.TRUSTED_PROXY_IPS ?? '').split(',').map((value) => value.trim()).filter(Boolean)) {
    const address = normalizeIpAddress(rawAddress);

    if (isIP(address) === 0) {
      throw new Error('TRUSTED_PROXY_IPS accepts exact IPv4 or IPv6 addresses only.');
    }

    trustedProxyAddresses.add(address);
  }

  const requestedHsts = parseBooleanSetting(env.ENABLE_HSTS, 'ENABLE_HSTS');
  const enableHsts = isProduction || requestedHsts;

  if (enableHsts && !secureCookies) {
    throw new Error('ENABLE_HSTS requires an HTTPS PUBLIC_ORIGIN.');
  }

  return {
    isProduction,
    publicOrigin: publicOriginUrl.origin,
    publicHost: publicOriginUrl.host,
    secureCookies,
    enableHsts,
    signingSecret: Buffer.from(configuredSecret ?? randomBytes(32).toString('base64url')),
    trustedProxyAddresses,
    maxActiveChallenges: parseIntegerSetting(env, 'MAX_ACTIVE_CHALLENGES', 2_000, 1, 10_000),
    maxActiveSessions: parseIntegerSetting(env, 'MAX_ACTIVE_SESSIONS', 10_000, 1, 100_000),
    maxLimiterKeys: parseIntegerSetting(env, 'MAX_LIMITER_KEYS', 20_000, 10, 100_000),
    maxActiveRequests: parseIntegerSetting(env, 'MAX_ACTIVE_REQUESTS', 128, 8, 2_000),
    maxConnections: parseIntegerSetting(env, 'MAX_CONNECTIONS', 256, 8, 10_000),
    challengeBurstLimit: parseIntegerSetting(env, 'CHALLENGE_BURST_LIMIT', 10, 1, 100),
    verificationBurstLimit: parseIntegerSetting(env, 'VERIFICATION_BURST_LIMIT', 6, 1, 100),
    globalChallengeLimit: parseIntegerSetting(env, 'GLOBAL_CHALLENGE_LIMIT', 200, 1, 10_000),
    globalVerificationLimit: parseIntegerSetting(env, 'GLOBAL_VERIFICATION_LIMIT', 500, 1, 20_000),
    dailyChallengeQuota: parseIntegerSetting(env, 'DAILY_CHALLENGE_QUOTA', 200, 1, 1_000)
  };
}

export function createSecurityHeaders(config) {
  const headers = {
    'Content-Security-Policy': [
      "default-src 'none'",
      "base-uri 'none'",
      "connect-src 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "img-src 'self' data:",
      "object-src 'none'",
      "script-src 'self'",
      "style-src 'self'"
    ].join('; '),
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Origin-Agent-Cluster': '?1',
    'Permissions-Policy': 'camera=(), geolocation=(), microphone=()',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-Permitted-Cross-Domain-Policies': 'none'
  };

  if (config.enableHsts) {
    headers['Strict-Transport-Security'] = 'max-age=31536000';
  }

  return Object.freeze(headers);
}

export function canonicalizePathname(pathname) {
  if (typeof pathname !== 'string' || pathname.length === 0 || pathname.length > 2_048) {
    return null;
  }

  let decoded;

  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  if (!decoded.startsWith('/') || /[\\\u0000-\u001f\u007f]/.test(decoded)) {
    return null;
  }

  let canonical = posix.normalize(decoded.replace(/\/{2,}/g, '/'));

  while (canonical.length > 1 && canonical.endsWith('/')) {
    canonical = canonical.slice(0, -1);
  }

  return canonical;
}

export function hasCanonicalHost(request, config) {
  return typeof request.headers.host === 'string' && request.headers.host.toLowerCase() === config.publicHost.toLowerCase();
}

export function validateSameOriginRequest(request, config) {
  const fetchSite = request.headers['sec-fetch-site'];
  return (
    hasCanonicalHost(request, config) &&
    request.headers.origin === config.publicOrigin &&
    (fetchSite === undefined || fetchSite === 'same-origin' || fetchSite === 'none')
  );
}

export function resolveClientAddress(request, config) {
  const remoteAddress = normalizeIpAddress(request.socket.remoteAddress);

  if (!config.trustedProxyAddresses.has(remoteAddress)) {
    return remoteAddress;
  }

  const forwardedHeader = request.headers['x-forwarded-for'];

  if (typeof forwardedHeader !== 'string') {
    return remoteAddress;
  }

  const forwardedParts = forwardedHeader.split(',');

  if (forwardedParts.length > MAX_FORWARDED_HOPS) {
    return remoteAddress;
  }

  const forwardedAddresses = forwardedParts.map((value) => normalizeIpAddress(value.trim()));

  if (forwardedAddresses.length === 0 || forwardedAddresses.some((address) => isIP(address) === 0)) {
    return remoteAddress;
  }

  let candidate = remoteAddress;

  for (let index = forwardedAddresses.length - 1; index >= 0; index -= 1) {
    if (!config.trustedProxyAddresses.has(candidate)) {
      break;
    }

    candidate = forwardedAddresses[index];
  }

  return candidate;
}

export function hashClientIdentity(config, clientAddress, visitorId) {
  return createHmac('sha256', config.signingSecret)
    .update(`${clientAddress}\u0000${visitorId}`)
    .digest('base64url');
}

export { createCookieSecurity } from './cookie-security.mjs';
