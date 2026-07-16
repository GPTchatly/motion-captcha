import { CSRF_TOKEN_PATTERN, validateChallengePayload } from './captcha-protocol.js';

export class CaptchaApi {
  constructor() {
    this.csrfToken = null;
  }

  async ensureSecurityContext() {
    if (CSRF_TOKEN_PATTERN.test(this.csrfToken ?? '')) {
      return this.csrfToken;
    }

    const response = await fetch('/api/security-context', {
      method: 'GET',
      cache: 'no-store',
      credentials: 'same-origin'
    });
    const data = await response.json().catch(() => null);

    if (!response.ok || !data || !CSRF_TOKEN_PATTERN.test(data.csrfToken ?? '')) {
      throw new Error('security_context_unavailable');
    }

    this.csrfToken = data.csrfToken;
    return this.csrfToken;
  }

  async createChallenge() {
    const response = await fetch('/api/challenges', {
      method: 'POST',
      cache: 'no-store',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': await this.ensureSecurityContext()
      },
      body: '{}'
    });
    const responseData = await response.json().catch(() => null);

    if (!response.ok || !responseData) {
      if (responseData?.code === 'csrf_invalid') {
        this.csrfToken = null;
      }

      throw new Error(responseData?.code ?? `challenge_request_failed_${response.status}`);
    }

    return validateChallengePayload(responseData);
  }

  async verifyChallenge(challengeId, selectedIds, nextPath) {
    const response = await fetch(`/api/challenges/${encodeURIComponent(challengeId)}/verify`, {
      method: 'POST',
      cache: 'no-store',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': await this.ensureSecurityContext()
      },
      body: JSON.stringify({ selectedIds, nextPath })
    });
    const result = await response.json().catch(() => ({ success: false, code: 'invalid_response' }));

    if (result.code === 'csrf_invalid') {
      this.csrfToken = null;
    }

    return { response, result };
  }
}
