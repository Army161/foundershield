/**
 * The three pages the proxy can serve itself.
 *
 * Deliberately plain: no external assets, no fonts, no analytics, and copy that
 * says what happened without accusing the visitor of anything. A real customer
 * behind a corporate proxy will see the interstitial, and a person who lands on
 * the block page is usually a false positive, not a defendant.
 */

import type { DecisionReason } from '@foundershield/shared';

const STYLE = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: #fbfbfd; color: #16161d; padding: 24px;
  }
  main { max-width: 32rem; width: 100%; }
  h1 { font-size: 1.35rem; margin: 0 0 .6rem; letter-spacing: -0.01em; }
  p { margin: 0 0 .9rem; color: #4a4a55; }
  .card {
    background: #fff; border: 1px solid #e6e6ec; border-radius: 14px;
    padding: 28px; box-shadow: 0 1px 2px rgba(0,0,0,.04);
  }
  .spinner {
    width: 18px; height: 18px; border: 2px solid #d5d5de; border-top-color: #16161d;
    border-radius: 50%; animation: spin .7s linear infinite; display: inline-block;
    vertical-align: -3px; margin-right: 10px;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spinner { animation-duration: 3s; } }
  code { font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; color: #6a6a78; }
  .meta { font-size: 13px; color: #8a8a99; margin-top: 1.25rem; }
  button {
    font: inherit; font-weight: 550; padding: 10px 18px; border-radius: 9px;
    border: 1px solid #16161d; background: #16161d; color: #fff; cursor: pointer;
  }
  button:hover { opacity: .88; }
  a { color: inherit; }
  @media (prefers-color-scheme: dark) {
    body { background: #0d0d11; color: #f2f2f5; }
    .card { background: #16161c; border-color: #2a2a33; box-shadow: none; }
    p { color: #a5a5b3; }
    .spinner { border-color: #3a3a45; border-top-color: #f2f2f5; }
    button { background: #f2f2f5; color: #16161d; border-color: #f2f2f5; }
  }
`;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function shell(title: string, body: string, head = ''): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
${head}
</head>
<body><main class="card">${body}</main></body>
</html>`;
}

/**
 * Served in `strict` mode when a request arrives without a valid token. The
 * page itself contains none of the protected work — only the challenge.
 */
export function interstitialPage(returnTo: string): string {
  const safeReturn = escapeHtml(returnTo);
  return shell(
    'Checking your browser',
    `<h1><span class="spinner" aria-hidden="true"></span>Checking your browser</h1>
     <p id="fs-status">This takes a moment and happens once. No action is needed.</p>
     <noscript><p><strong>JavaScript is required to continue.</strong> This site verifies browsers before serving content.</p></noscript>
     <p class="meta">Protected by FounderShield</p>`,
    `<script src="/__fs/v1/c.js" data-fs-interstitial="1" data-fs-return="${safeReturn}"></script>`,
  );
}

export function blockedPage(reasons: readonly DecisionReason[], requestId: string | null): string {
  const primary = reasons[0];
  const explanation = primary
    ? escapeHtml(primary.description)
    : 'This request did not pass the site owner&rsquo;s access checks.';

  return shell(
    'Request blocked',
    `<h1>Request blocked</h1>
     <p>This site is protected against automated access, and this request was stopped before it reached the server.</p>
     <p>${explanation}.</p>
     <p>If you are a person and you are seeing this, it is very likely a mistake on our side. Contact the site owner and quote the reference below.</p>
     <p class="meta">Reference <code>${escapeHtml(requestId ?? 'unavailable')}</code><br>Protected by FounderShield</p>`,
  );
}

export function rateLimitedPage(retryAfterSeconds: number, requestId: string | null): string {
  return shell(
    'Too many requests',
    `<h1>Too many requests</h1>
     <p>This site limits how quickly a single client may request pages. Please wait about ${retryAfterSeconds} seconds and try again.</p>
     <p class="meta">Reference <code>${escapeHtml(requestId ?? 'unavailable')}</code><br>Protected by FounderShield</p>`,
  );
}

export function clickwrapPage(options: {
  returnTo: string;
  tosUrl: string;
  version: string;
  siteName: string;
}): string {
  const safeReturn = escapeHtml(options.returnTo);
  const safeTos = escapeHtml(options.tosUrl);

  return shell(
    'Terms of use',
    `<h1>Before you continue</h1>
     <p>Access to ${escapeHtml(options.siteName)} is subject to its
        <a href="${safeTos}" target="_blank" rel="noopener">terms of use</a>
        (version ${escapeHtml(options.version)}), which restrict automated collection and re-use of the content.</p>
     <p>Select <strong>I agree</strong> to continue.</p>
     <form method="POST" action="/__fs/v1/clickwrap">
       <input type="hidden" name="returnTo" value="${safeReturn}">
       <input type="hidden" name="version" value="${escapeHtml(options.version)}">
       <button type="submit">I agree</button>
     </form>
     <p class="meta">Your acceptance is recorded with a timestamp. Protected by FounderShield</p>`,
  );
}
