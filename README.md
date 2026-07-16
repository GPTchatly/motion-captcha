# Motion-CAPTCHA 

The motion-defined CAPTCHA with browser-only verification with a 30-second, one-attempt, server-authoritative flow.
<p align="center">
  <img src="./motion-captcha.gif" alt="motion captcha" width="800" />
</p>

## Run

```bash
npm start
```

Open:

```text
http://localhost:3000
```

No npm installation is required. Runtime code uses Node.js built-in modules only.

For an explicit production origin allowlist:

```bash
ALLOWED_ORIGINS=https://app.example.com npm start #Multiple origins may be comma-separated
```



## User flow

1. A request for `/` or `/index.html` without a valid server session redirects to `/captcha.html`.
2. The browser requests a fresh challenge from `POST /api/challenges`.
3. The server chooses two random unique characters, three symbol decoys, mask variants, motion parameters, and a 30-second expiration timestamp.
4. The browser receives opaque IDs and alpha masks, but not character labels or the expected order.
5. Each challenge contains either two digits or two letters, never a mixed pair. The user clicks digits from smaller to larger or letters in alphabetical order, then submits once.
6. The server rejects expired, replayed, malformed, origin-mismatched, or incorrectly ordered submissions.
7. Correct verification creates an HttpOnly, SameSite=Strict session cookie and the browser immediately opens the sanitized destination.

The post-verification demonstration session lasts 15 minutes. That session lifetime is separate from the 30-second unsolved-challenge lifetime.

## Visual changes

- Six independently moving background bands replace the single global vertical translation.
- Carrier textures and motion profiles re-key every 10 seconds.
- Character trajectories receive bounded randomized turns.
- Character masks use multiple bold font families and rotations.
- Three unlabelled non-character symbols act as visual decoys.
- Every challenge, including the first, is random.
- Freezing the view does not pause server expiration.
- A shared application header, focused challenge panel, and sidebar replace the earlier centered hero layout.
- The protected destination uses the same restrained visual system, with responsive layouts for narrow screens.

## Controls

- Click a selected item again to remove it and reorder the remaining selection.
- Submit becomes available only after exactly two items are selected.
- Refresh immediately abandons the current browser view and requests a new one-time challenge.
- The visible countdown is informative; the server timestamp is authoritative.
- Freeze and debug controls are retained only for reconstruction and **should be removed from production**.

## Validation

```bash
npm run validate
```

The suite covers:

- 30-second challenge duration;
- expiration boundary behavior;
- hidden character labels in public challenge objects;
- origin binding;
- one-attempt/replay rejection;
- rate-limiter behavior;
- protected-route redirects;
- non-public server mask assets;
- JavaScript syntax.

## Repository contents

- `server.mjs`: static server, challenge APIs, server verification, rate limits, HttpOnly sessions, and protected-route enforcement.
- `lib/security-core.mjs`: testable challenge creation, ordering, expiration, origin, cookie, and limiter logic.
- `server-assets/glyph-masks.json`: server-only character and decoy alpha-mask variants.
- `scripts/generate-mask-library.py`: optional build utility used to regenerate the mask library.
- `public/captcha.html`: challenge interface and 30-second countdown.
- `public/app.js`: mask decoding, motion rendering, hit testing, expiry UI, and verification requests.
- `public/challenge-timer.js`: pure countdown helpers.
- `public/index.html` and `public/index.js`: example protected destination and session display/logout flow.
- `REDDIT_DOCS_REVIEW.md`: analysis of the supplied thread, official docs, time-limit interpretation, and residual weaknesses.
- `ANALYSIS.md`: original frame-by-frame recording analysis.
- `SECURITY_NOTES.md`: threat model and deployment limitations.
- `analysis/`: original frame-difference artifacts plus a mask-variant preview.


