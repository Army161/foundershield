/**
 * Automation detection.
 *
 * Scores a request 0-100 from headers alone (no JS required), so it works on
 * the very first request and on non-browser clients. The score is advisory:
 * the policy decides what to do with it.
 *
 * Every rule carries a stable `id` because those ids end up in the evidence log
 * and, downstream, in an exhibit. A rule that fires must be explainable in one
 * sentence to someone non-technical.
 */

export interface BotSignalInput {
  userAgent: string;
  accept: string | null;
  acceptLanguage: string | null;
  acceptEncoding: string | null;
  secChUa: string | null;
  secFetchMode: string | null;
  secFetchSite: string | null;
  secFetchDest: string | null;
  connection: string | null;
  method: string;
  hasCookies: boolean;
  /** Cloudflare's own verified-crawler category, when available. */
  verifiedBotCategory?: string | null;
  /** Autonomous system organisation, e.g. "Amazon.com, Inc.". */
  asOrganisation?: string | null;
}

export interface BotSignal {
  id: string;
  score: number;
  /** Plain-English description used verbatim in evidence exports. */
  description: string;
}

interface UserAgentRule {
  id: string;
  pattern: RegExp;
  score: number;
  description: string;
}

/**
 * Self-identifying automation. These clients announce themselves, so a match is
 * high-confidence — but note that a *self-identifying* client is also evidence
 * that the operator was not attempting to conceal anything, which matters when
 * characterising intent later.
 */
export const AUTOMATION_USER_AGENTS: UserAgentRule[] = [
  { id: 'ua.curl', pattern: /\bcurl\//i, score: 60, description: 'Request sent by curl' },
  { id: 'ua.wget', pattern: /\bwget\b/i, score: 60, description: 'Request sent by wget' },
  { id: 'ua.python', pattern: /python-requests|python-urllib|aiohttp|httpx/i, score: 70, description: 'Request sent by a Python HTTP client' },
  { id: 'ua.scrapy', pattern: /\bscrapy\b/i, score: 90, description: 'Request sent by the Scrapy scraping framework' },
  { id: 'ua.node', pattern: /node-fetch|axios\/|undici|got\s*\(/i, score: 65, description: 'Request sent by a Node.js HTTP client' },
  { id: 'ua.go', pattern: /go-http-client|golang/i, score: 65, description: 'Request sent by a Go HTTP client' },
  { id: 'ua.java', pattern: /java\/|okhttp|apache-httpclient|jakarta/i, score: 65, description: 'Request sent by a Java HTTP client' },
  { id: 'ua.perl', pattern: /libwww-perl|lwp::/i, score: 70, description: 'Request sent by libwww-perl' },
  { id: 'ua.ruby', pattern: /ruby|faraday/i, score: 60, description: 'Request sent by a Ruby HTTP client' },
  { id: 'ua.php', pattern: /guzzlehttp|php\//i, score: 60, description: 'Request sent by a PHP HTTP client' },
  { id: 'ua.headless', pattern: /headlesschrome|phantomjs|electron\//i, score: 85, description: 'Request sent by a headless browser' },
  { id: 'ua.automation', pattern: /puppeteer|playwright|selenium|webdriver|cypress/i, score: 90, description: 'Request sent by a browser-automation framework' },
  { id: 'ua.scanner', pattern: /masscan|zgrab|nmap|nikto|sqlmap|nuclei|dirbuster|gobuster/i, score: 100, description: 'Request sent by a security scanner' },
  { id: 'ua.genericbot', pattern: /\b(bot|crawler|spider|scraper|harvest)\b/i, score: 45, description: 'User-agent self-identifies as an automated crawler' },
  { id: 'ua.ai', pattern: /gptbot|claudebot|anthropic-ai|ccbot|google-extended|perplexitybot|bytespider|amazonbot|applebot-extended|meta-externalagent|cohere-ai|diffbot|omgili|imagesiftbot|timpibot|youbot/i, score: 55, description: 'User-agent identifies as an AI training or retrieval crawler' },
  { id: 'ua.http', pattern: /^(mozilla\/4\.0 \(compatible;\)|-|null|undefined)$/i, score: 75, description: 'Placeholder or spoofed user-agent string' },
];

/** Crawlers we let through when `allowVerifiedBots` is on and the network verifies them. */
export const VERIFIABLE_SEARCH_BOTS = /googlebot|bingbot|duckduckbot|yandexbot|baiduspider|slurp|applebot(?!-extended)/i;

export interface BotAssessment {
  score: number;
  signals: BotSignal[];
  /** True when the network vouched for this being a real search crawler. */
  verifiedSearchBot: boolean;
}

const DATACENTRE_ASN = /amazon|google cloud|microsoft|azure|digitalocean|linode|hetzner|ovh|vultr|scaleway|oracle cloud|alibaba|tencent|contabo|choopa|leaseweb/i;

export function assessBotLikelihood(input: BotSignalInput): BotAssessment {
  const signals: BotSignal[] = [];
  const ua = (input.userAgent ?? '').trim();

  const verifiedSearchBot =
    Boolean(input.verifiedBotCategory && input.verifiedBotCategory.toLowerCase().includes('search')) ||
    (VERIFIABLE_SEARCH_BOTS.test(ua) && Boolean(input.verifiedBotCategory));

  if (ua.length === 0) {
    signals.push({ id: 'ua.absent', score: 55, description: 'Request sent with no user-agent header' });
  } else {
    for (const rule of AUTOMATION_USER_AGENTS) {
      if (rule.pattern.test(ua)) {
        signals.push({ id: rule.id, score: rule.score, description: rule.description });
      }
    }
  }

  const claimsBrowser = /mozilla\/5\.0/i.test(ua) && /(chrome|safari|firefox|edg)\//i.test(ua);

  // A real browser always sends Accept. Its absence on a GET is a strong tell.
  if (input.method === 'GET' && !input.accept) {
    signals.push({ id: 'hdr.no_accept', score: 35, description: 'Request omitted the Accept header, which every browser sends' });
  }

  if (claimsBrowser && !input.acceptLanguage) {
    signals.push({
      id: 'hdr.no_accept_language',
      score: 40,
      description: 'User-agent claims to be a browser but omitted Accept-Language',
    });
  }

  if (claimsBrowser && !input.acceptEncoding) {
    signals.push({
      id: 'hdr.no_accept_encoding',
      score: 30,
      description: 'User-agent claims to be a browser but omitted Accept-Encoding',
    });
  }

  // Chromium >= 89 always emits Sec-CH-UA and the Sec-Fetch-* family.
  const claimsChromium = /chrome\/(\d+)/i.test(ua) && !/edg\/|opr\//i.test(ua);
  if (claimsChromium) {
    const versionMatch = /chrome\/(\d+)/i.exec(ua);
    const major = versionMatch ? Number(versionMatch[1]) : 0;
    if (major >= 90 && !input.secChUa) {
      signals.push({
        id: 'hdr.no_sec_ch_ua',
        score: 50,
        description: 'User-agent claims a modern Chrome version but omitted the Sec-CH-UA client hint',
      });
    }
    if (major >= 90 && !input.secFetchMode) {
      signals.push({
        id: 'hdr.no_sec_fetch',
        score: 45,
        description: 'User-agent claims a modern Chrome version but omitted Sec-Fetch-Mode',
      });
    }
  }

  if (claimsBrowser && /\bclose\b/i.test(input.connection ?? '')) {
    signals.push({
      id: 'hdr.connection_close',
      score: 20,
      description: 'Browser-like request asked for Connection: close, typical of scripted clients',
    });
  }

  if (claimsBrowser && !input.hasCookies && input.secFetchDest === 'document') {
    signals.push({
      id: 'state.no_cookies',
      score: 15,
      description: 'Navigational request carried no cookies at all',
    });
  }

  if (input.asOrganisation && DATACENTRE_ASN.test(input.asOrganisation)) {
    signals.push({
      id: 'net.datacentre',
      score: 25,
      description: `Request originated from a datacentre network (${input.asOrganisation}) rather than a consumer ISP`,
    });
  }

  // Combine: take the strongest signal, then let the remainder add with
  // diminishing weight. Avoids three weak header quirks summing to a block.
  const sorted = [...signals].sort((a, b) => b.score - a.score);
  let score = 0;
  sorted.forEach((signal, index) => {
    score += signal.score * (index === 0 ? 1 : 0.35 / index);
  });

  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    signals,
    verifiedSearchBot,
  };
}

export function matchesUserAgentList(userAgent: string, needles: readonly string[]): string | null {
  const haystack = userAgent.toLowerCase();
  for (const needle of needles) {
    const trimmed = needle.trim().toLowerCase();
    if (trimmed.length > 0 && haystack.includes(trimmed)) return needle;
  }
  return null;
}
