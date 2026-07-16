import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { parseCookies } from './security-core.mjs';

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function createSignature(secret, namespace, value) {
  return createHmac('sha256', secret).update(`${namespace}:${value}`).digest('base64url');
}

function constantTimeEquals(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') {
    return false;
  }

  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function signValue(secret, namespace, value) {
  return `${value}.${createSignature(secret, namespace, value)}`;
}

function verifySignedValue(secret, namespace, signedValue, valuePattern) {
  if (typeof signedValue !== 'string') {
    return null;
  }

  const separator = signedValue.lastIndexOf('.');

  if (separator <= 0) {
    return null;
  }

  const value = signedValue.slice(0, separator);
  const suppliedSignature = signedValue.slice(separator + 1);

  if (valuePattern && !valuePattern.test(value)) {
    return null;
  }

  const expectedSignature = createSignature(secret, namespace, value);
  return constantTimeEquals(suppliedSignature, expectedSignature) ? value : null;
}

function serializeCookie(config, name, value, { httpOnly, maxAgeSeconds }) {
  const attributes = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    `Max-Age=${maxAgeSeconds}`,
    'SameSite=Strict'
  ];

  if (httpOnly) {
    attributes.push('HttpOnly');
  }

  if (config.secureCookies) {
    attributes.push('Secure');
  }

  return attributes.join('; ');
}

export function createCookieSecurity(config) {
  const cookieNames = config.secureCookies
    ? {
        visitor: '__Host-MotionCaptchaVisitor',
        csrf: '__Host-MotionCaptchaCsrf',
        session: '__Host-MotionCaptchaSession'
      }
    : {
        visitor: 'MotionCaptchaVisitorDev',
        csrf: 'MotionCaptchaCsrfDev',
        session: 'MotionCaptchaSessionDev'
      };

  function readVisitorId(request) {
    const signedVisitor = parseCookies(request.headers.cookie).get(cookieNames.visitor);
    return verifySignedValue(config.signingSecret, 'visitor', signedVisitor, UUID_V4_PATTERN);
  }

  function readCsrfToken(request, visitorId) {
    const token = parseCookies(request.headers.cookie).get(cookieNames.csrf);

    if (typeof token !== 'string') {
      return null;
    }

    const randomValue = verifySignedValue(config.signingSecret, `csrf:${visitorId}`, token, /^[A-Za-z0-9_-]{43}$/);
    return randomValue ? token : null;
  }

  function issueSecurityContext(request) {
    const cookies = [];
    let visitorId = readVisitorId(request);

    if (!visitorId) {
      visitorId = randomUUID();
      cookies.push(
        serializeCookie(config, cookieNames.visitor, signValue(config.signingSecret, 'visitor', visitorId), {
          httpOnly: true,
          maxAgeSeconds: 86_400
        })
      );
    }

    let csrfToken = readCsrfToken(request, visitorId);

    if (!csrfToken) {
      const randomValue = randomBytes(32).toString('base64url');
      csrfToken = signValue(config.signingSecret, `csrf:${visitorId}`, randomValue);
      cookies.push(
        serializeCookie(config, cookieNames.csrf, csrfToken, {
          httpOnly: true,
          maxAgeSeconds: 86_400
        })
      );
    }

    return { visitorId, csrfToken, cookies };
  }

  function readSecurityContext(request) {
    const visitorId = readVisitorId(request);

    if (!visitorId) {
      return null;
    }

    const csrfToken = readCsrfToken(request, visitorId);
    return csrfToken ? { visitorId, csrfToken } : null;
  }

  function validateCsrf(request, context) {
    const headerToken = request.headers['x-csrf-token'];
    return (
      typeof headerToken === 'string' &&
      typeof context?.csrfToken === 'string' &&
      constantTimeEquals(headerToken, context.csrfToken)
    );
  }

  function createSessionCookie(sessionId, maximumAgeSeconds) {
    return serializeCookie(
      config,
      cookieNames.session,
      signValue(config.signingSecret, 'session', sessionId),
      { httpOnly: true, maxAgeSeconds: maximumAgeSeconds }
    );
  }

  function clearSessionCookie() {
    return serializeCookie(config, cookieNames.session, '', { httpOnly: true, maxAgeSeconds: 0 });
  }

  function readSessionId(request) {
    const signedSession = parseCookies(request.headers.cookie).get(cookieNames.session);
    return verifySignedValue(config.signingSecret, 'session', signedSession, UUID_V4_PATTERN);
  }

  return {
    cookieNames,
    issueSecurityContext,
    readSecurityContext,
    validateCsrf,
    createSessionCookie,
    clearSessionCookie,
    readSessionId
  };
}
