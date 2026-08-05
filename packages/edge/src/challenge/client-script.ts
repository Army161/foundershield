/**
 * The browser half of the technological protection measure.
 *
 * Served from `/__fs/v1/c.js` (same-origin, so it survives a `script-src 'self'`
 * CSP without needing a nonce) and referenced from injected HTML or from the
 * interstitial page.
 *
 * It:
 *   1. requests a signed challenge,
 *   2. solves a SHA-256 proof-of-work in a chunked loop that yields to the UI,
 *   3. reports the solution plus environment attestation,
 *   4. holds the resulting access token fresh for as long as the tab is open.
 *
 * SHA-256 is implemented inline rather than via `crypto.subtle` because the
 * WebCrypto API is promise-based: tens of thousands of awaited digests is
 * dramatically slower than a synchronous loop.
 *
 * Written as a plain string (ES5-compatible, no template literals) so it can be
 * served verbatim with no build step and parsed by anything.
 */
export const CLIENT_SCRIPT = String.raw`
(function () {
  'use strict';

  var BASE = '/__fs/v1';
  var MAX_ATTEMPTS = 3;

  var K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];

  var W = new Uint32Array(64);

  /** Returns only the first word of the digest -- all a difficulty check needs. */
  function sha256FirstWord(bytes, length) {
    var h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
    var h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;

    var padded = ((length + 9 + 63) >> 6) << 6;
    var m = new Uint8Array(padded);
    for (var c = 0; c < length; c++) m[c] = bytes[c];
    m[length] = 0x80;

    var bits = length * 8;
    m[padded - 4] = (bits >>> 24) & 0xff;
    m[padded - 3] = (bits >>> 16) & 0xff;
    m[padded - 2] = (bits >>> 8) & 0xff;
    m[padded - 1] = bits & 0xff;

    for (var i = 0; i < padded; i += 64) {
      for (var t = 0; t < 16; t++) {
        var o = i + t * 4;
        W[t] = (m[o] << 24) | (m[o + 1] << 16) | (m[o + 2] << 8) | m[o + 3];
      }
      for (t = 16; t < 64; t++) {
        var x = W[t - 15], y = W[t - 2];
        var s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
        var s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
        W[t] = (W[t - 16] + s0 + W[t - 7] + s1) >>> 0;
      }

      var a = h0, b = h1, c2 = h2, d = h3, e = h4, f = h5, g = h6, hh = h7;
      for (t = 0; t < 64; t++) {
        var S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        var ch = (e & f) ^ (~e & g);
        var t1 = (hh + S1 + ch + K[t] + W[t]) >>> 0;
        var S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        var maj = (a & b) ^ (a & c2) ^ (b & c2);
        var t2 = (S0 + maj) >>> 0;
        hh = g; g = f; f = e; e = (d + t1) >>> 0;
        d = c2; c2 = b; b = a; a = (t1 + t2) >>> 0;
      }

      h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c2) >>> 0; h3 = (h3 + d) >>> 0;
      h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + hh) >>> 0;
    }

    return h0;
  }

  var clz = Math.clz32 || function (n) {
    if (n === 0) return 32;
    var count = 0;
    while ((n & 0x80000000) === 0) { n <<= 1; count++; }
    return count;
  };

  function asciiBytes(str) {
    var out = new Uint8Array(str.length);
    for (var i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
    return out;
  }

  /**
   * Chunked so a slow device never blocks paint. Each slice runs for at most
   * ~12ms, then yields.
   */
  function solve(salt, difficulty, done, failed) {
    var prefix = asciiBytes(salt + '.');
    var buffer = new Uint8Array(prefix.length + 24);
    buffer.set(prefix, 0);

    var nonce = 0;
    var startedAt = Date.now();
    var ceiling = 1 << Math.min(28, difficulty + 8);

    function slice() {
      var deadline = Date.now() + 12;
      do {
        for (var i = 0; i < 256; i++) {
          var text = '' + nonce;
          for (var j = 0; j < text.length; j++) buffer[prefix.length + j] = text.charCodeAt(j);
          if (clz(sha256FirstWord(buffer, prefix.length + text.length)) >= difficulty) {
            done(text, Date.now() - startedAt, nonce + 1);
            return;
          }
          nonce++;
        }
      } while (Date.now() < deadline);

      if (nonce > ceiling) { failed('exhausted'); return; }
      setTimeout(slice, 0);
    }

    slice();
  }

  function attest(solveMs, attempts) {
    var n = navigator || {};
    var s = {};
    try {
      s.wd = n.webdriver === true;
      s.hc = n.hardwareConcurrency || 0;
      s.dm = n.deviceMemory || 0;
      s.langs = (n.languages || []).length;
      s.tz = (Intl.DateTimeFormat().resolvedOptions() || {}).timeZone || '';
      s.scr = [screen.width, screen.height, screen.colorDepth].join('x');
      s.dpr = window.devicePixelRatio || 1;
      s.touch = 'ontouchstart' in window;
      s.solveMs = solveMs;
      s.attempts = attempts;
    } catch (e) { /* attestation is best-effort */ }
    return s;
  }

  var state = { verified: false, refreshTimer: null };
  var waiters = [];

  function announce(ok) {
    state.verified = ok;
    for (var i = 0; i < waiters.length; i++) { try { waiters[i](ok); } catch (e) {} }
    waiters = [];
    try {
      document.dispatchEvent(new CustomEvent('foundershield:' + (ok ? 'verified' : 'failed')));
    } catch (e) {
      var legacy = document.createEvent('Event');
      legacy.initEvent('foundershield:' + (ok ? 'verified' : 'failed'), true, true);
      document.dispatchEvent(legacy);
    }
  }

  function run(attempt, onSettled) {
    fetch(BASE + '/challenge', { credentials: 'same-origin', headers: { accept: 'application/json' } })
      .then(function (response) {
        if (!response.ok) throw new Error('challenge ' + response.status);
        return response.json();
      })
      .then(function (challenge) {
        if (!challenge || !challenge.cid) throw new Error('malformed challenge');
        solve(
          challenge.salt,
          challenge.difficulty,
          function (nonce, solveMs, attempts) {
            fetch(BASE + '/verify', {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ cid: challenge.cid, nonce: nonce, signals: attest(solveMs, attempts) })
            })
              .then(function (response) { return response.json(); })
              .then(function (result) {
                if (result && result.ok) {
                  scheduleRefresh(result.expiresIn);
                  onSettled(true);
                } else {
                  retry(attempt, onSettled);
                }
              })
              .catch(function () { retry(attempt, onSettled); });
          },
          function () { retry(attempt, onSettled); }
        );
      })
      .catch(function () { retry(attempt, onSettled); });
  }

  function retry(attempt, onSettled) {
    if (attempt >= MAX_ATTEMPTS) { onSettled(false); return; }
    setTimeout(function () { run(attempt + 1, onSettled); }, 250 * Math.pow(2, attempt));
  }

  /** Re-solve before the token expires so long-lived tabs never stall. */
  function scheduleRefresh(expiresIn) {
    if (state.refreshTimer) clearTimeout(state.refreshTimer);
    var seconds = typeof expiresIn === 'number' && expiresIn > 60 ? expiresIn : 3600;
    state.refreshTimer = setTimeout(function () {
      run(0, function () {});
    }, seconds * 800);
  }

  function verify() {
    return new Promise(function (resolve) {
      if (state.verified) { resolve(true); return; }
      waiters.push(resolve);
      if (waiters.length === 1) run(0, announce);
    });
  }

  /**
   * When the proxy rejects a subresource request because the token went stale,
   * transparently re-verify and replay it once. Without this, a tab left open
   * over a key rotation would surface a 403 to application code.
   */
  function installFetchRecovery() {
    if (!window.fetch || window.__fsFetchPatched) return;
    var original = window.fetch;
    window.__fsFetchPatched = true;
    window.fetch = function (input, init) {
      return original.call(this, input, init).then(function (response) {
        if (response.status !== 403 || response.headers.get('x-fs-challenge') !== 'required') return response;
        state.verified = false;
        return verify().then(function (ok) {
          return ok ? original.call(window, input, init) : response;
        });
      });
    };
  }

  var script = document.currentScript;
  var interstitial = script && script.getAttribute('data-fs-interstitial') === '1';
  var returnTo = (script && script.getAttribute('data-fs-return')) || '/';

  window.__foundershield = {
    verify: verify,
    isVerified: function () { return state.verified; }
  };

  if (interstitial) {
    verify().then(function (ok) {
      var status = document.getElementById('fs-status');
      if (ok) {
        if (status) status.textContent = 'Verified. Continuing...';
        window.location.replace(returnTo);
      } else if (status) {
        status.textContent = 'Verification could not be completed. Please refresh, or disable any extension that blocks scripts.';
      }
    });
  } else {
    installFetchRecovery();
    if (document.readyState === 'complete') verify();
    else window.addEventListener('load', function () { verify(); });
  }
})();
`;
