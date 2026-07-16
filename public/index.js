const verifiedState = document.getElementById('verified-state');
const expiryValue = document.getElementById('verified-expiry');
const restartButton = document.getElementById('restart-captcha');
const CSRF_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/;
let csrfToken = null;

if (!verifiedState || !expiryValue || !restartButton) {
  throw new Error('The protected page is missing one or more required elements.');
}

function redirectToCaptcha() {
  const destinationPath = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  const challengeUrl = new URL('/captcha.html', window.location.origin);
  challengeUrl.searchParams.set('next', destinationPath === '/' ? '/index.html' : destinationPath);
  window.location.replace(challengeUrl);
}

async function loadSecurityContext() {
  const response = await fetch('/api/security-context', {
    method: 'GET',
    cache: 'no-store',
    credentials: 'same-origin'
  });
  const data = await response.json().catch(() => null);

  if (!response.ok || !data || !CSRF_TOKEN_PATTERN.test(data.csrfToken ?? '')) {
    throw new Error('Unable to establish a request security context.');
  }

  csrfToken = data.csrfToken;
}

async function loadSession() {
  try {
    await loadSecurityContext();
    const response = await fetch('/api/session', {
      method: 'GET',
      cache: 'no-store',
      credentials: 'same-origin'
    });

    if (!response.ok) {
      redirectToCaptcha();
      return;
    }

    const session = await response.json().catch(() => null);

    if (!session || session.authenticated !== true || !Number.isFinite(session.expiresAt)) {
      redirectToCaptcha();
      return;
    }

    expiryValue.textContent = new Intl.DateTimeFormat(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    }).format(new Date(session.expiresAt));
    verifiedState.hidden = false;
    document.documentElement.classList.remove('access-pending');
  } catch (error) {
    console.error('Unable to read the protected session.', error);
    redirectToCaptcha();
  }
}

restartButton.addEventListener('click', async () => {
  restartButton.disabled = true;

  try {
    if (!CSRF_TOKEN_PATTERN.test(csrfToken ?? '')) {
      await loadSecurityContext();
    }

    const response = await fetch('/api/logout', {
      method: 'POST',
      cache: 'no-store',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfToken
      },
      body: '{}'
    });

    if (!response.ok) {
      throw new Error('Logout request was rejected.');
    }

    const challengeUrl = new URL('/captcha.html', window.location.origin);
    challengeUrl.searchParams.set('next', '/index.html');
    window.location.assign(challengeUrl);
  } catch (error) {
    console.error('Unable to close the protected session.', error);
    restartButton.disabled = false;
    restartButton.textContent = 'Try again';
  }
});

void loadSession();
