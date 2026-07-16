const verifiedState = document.getElementById('verified-state');
const expiryValue = document.getElementById('verified-expiry');
const restartButton = document.getElementById('restart-captcha');

if (!verifiedState || !expiryValue || !restartButton) {
  throw new Error('The protected page is missing one or more required elements.');
}

function redirectToCaptcha() {
  const destinationPath = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  const challengeUrl = new URL('/captcha.html', window.location.origin);
  challengeUrl.searchParams.set('next', destinationPath === '/' ? '/index.html' : destinationPath);
  window.location.replace(challengeUrl);
}

async function loadSession() {
  try {
    const response = await fetch('/api/session', {
      method: 'GET',
      cache: 'no-store',
      credentials: 'same-origin'
    });

    if (!response.ok) {
      redirectToCaptcha();
      return;
    }

    const session = await response.json();

    if (!session.authenticated || !Number.isFinite(session.expiresAt)) {
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
    await fetch('/api/logout', {
      method: 'POST',
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
  } finally {
    const challengeUrl = new URL('/captcha.html', window.location.origin);
    challengeUrl.searchParams.set('next', '/index.html');
    window.location.assign(challengeUrl);
  }
});

void loadSession();
