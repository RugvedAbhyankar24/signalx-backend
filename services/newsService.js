import fetch from 'node-fetch';
import { fetchCompanyMeta } from './marketData.js';

// Canonical fragments — a source is trusted if its name contains ANY of these (case-insensitive).
// Kept broad so mid/small cap NSE 500 stocks covered by regional outlets still get the boost.
const TRUSTED_SOURCE_FRAGMENTS = [
  'moneycontrol',
  'economic times',
  'economictimes',
  'livemint',
  'mint',
  'business standard',
  'businessstandard',
  'cnbctv18',
  'cnbc tv18',
  'cnbc',
  'reuters',
  'financial express',
  'businessline',
  'hindu businessline',
  'ndtv profit',
  'ndtvprofit',
  'zeebiz',
  'zee business',
  'business today',
  'businesstoday',
  'bq prime',
  'bqprime',
  'bloomberg',
  'investing.com',
  'the print',
  'theprint',
  'hindu',
  'press trust',
  'pti',
  'ani',
]
const CATALYST_KEYWORDS = [
  'results', 'earnings', 'profit', 'loss', 'revenue', 'ebitda', 'margin',
  'order', 'deal', 'contract', 'approval', 'acquisition', 'merger', 'stake',
  'block deal', 'bulk deal', 'dividend', 'bonus', 'buyback', 'guidance',
  'target price', 'target', 'upgrade', 'downgrade', 'outperform', 'underperform',
  'investigation', 'penalty', 'default', 'fund raise', 'fundraise', 'capex',
  'shareholding', 'retail shareholding', 'promoter', 'fii', 'dii',
  'launch', 'plant', 'expansion', 'q1', 'q2', 'q3', 'q4'
]
const GENERIC_BUZZ_PATTERNS = [
  'short on capital to buy stocks',
  'stocks to buy',
  'share market',
  'stock market',
  'market wrap',
  'top gainers',
  'top losers',
  'sensex',
  'nifty',
  'mutual fund',
  'ipo',
  'drhp',
  'draft red herring prospectus',
  'red herring prospectus',
  'how to',
  'explained',
]

/* ===========================
   PUBLIC API
=========================== */

export async function fetchCompanyNews(symbol, options = {}) {
  const shouldLoadMeta = options.includeMeta !== false;
  const meta = shouldLoadMeta ? await safeCompanyMeta(symbol) : null;

  // Primary: Google News RSS (no API keys, stable)
  const googleItems = await fetchFromGoogleNews(symbol, meta, options);

  const filtered = filterAndSortNews(googleItems, symbol, meta);
  const deduped = dedupeNews(filtered);
  const verified = applyNewsOptions(deduped, symbol, meta, options);

  // Return top 5 price-moving stories.
  // `verified` has already been scored, threshold-filtered, and time-gated.
  // If options (requireCatalyst, trustedOnly, etc.) further narrow to <5,
  // fall back to the threshold-filtered list — still entity-verified, just less strict.
  if (verified.length >= 5) return verified.slice(0, 5);
  if (verified.length > 0)  return verified; // return what we have if < 5

  // Last resort: return scored+time-gated items that passed the entity gate
  // but may not have passed optional filters — still no hallucinations.
  return deduped.slice(0, 5);
}

/**
 * IMPORTANT:
 * This is NEWS TONE, not market sentiment.
 * It is purely based on headline wording.
 */
export function classifySentiment(text) {
  if (!text) return 'neutral';
  const t = text.toLowerCase();

  const positive = [
    'beats', 'surges', 'record profit', 'strong growth', 'strong results',
    'upgrade', 'outperform', 'rallies', 'profit jumps', 'profit rises',
    'net profit up', 'revenue up', 'revenue rises', 'buys stake', 'wins order',
    'bags order', 'secures deal', 'dividend declared', 'buyback', 'strong demand',
    'all-time high', 'multibagger', 'target raised',
  ];
  const negative = [
    'misses', 'probe', 'fraud', 'downgrade', 'underperform',
    'loss widens', 'net loss', 'plunge', 'plunges', 'defaults', 'investigation',
    'penalty', 'fine imposed', 'sebi notice', 'ed probe', 'cbi probe',
    'revenue falls', 'profit falls', 'profit declines', 'write-off', 'write off',
    'margin pressure', 'debt rises', 'rating downgrade', 'rating cut',
  ];

  let score = 0;
  for (const w of positive) if (t.includes(w)) score += 2;
  for (const w of negative) if (t.includes(w)) score -= 2;

  if (score > 0) return 'positive';
  if (score < 0) return 'negative';
  return 'neutral';
}

/* ===========================
   GOOGLE NEWS RSS
=========================== */

// Heavy-movement catalyst terms — these events cause the biggest price swings
const HEAVY_CATALYST_TERMS =
  'results OR earnings OR profit OR loss OR order OR deal OR acquisition OR merger OR ' +
  'penalty OR dividend OR buyback OR upgrade OR downgrade OR block deal OR bulk deal OR ' +
  'fundraise OR approval OR capex OR investigation OR default OR stake OR guidance OR ' +
  'SEBI OR ED OR CBI OR FIR OR shareholding OR promoter OR FII OR DII';

/**
 * Fetches a single Google News RSS query and returns parsed items.
 * Returns [] on any failure — callers aggregate from multiple queries.
 */
async function fetchRSS(q) {
  const url =
    `https://news.google.com/rss/search?` +
    new URLSearchParams({ q, hl: 'en-IN', gl: 'IN', ceid: 'IN:en' }).toString();

  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'application/rss+xml, application/xml, */*',
        'Accept-Language': 'en-IN,en;q=0.9',
        'Cache-Control': 'no-cache',
      },
    });
    if (!res.ok) return [];
    const xml = await res.text();
    return parseGoogleRss(xml).map((it) => ({
      headline: it.title,
      summary: it.snippet,
      url: it.link,
      source: it.source || 'Google News',
      datetime: it.pubDate
        ? Math.floor(new Date(it.pubDate).getTime() / 1000)
        : Math.floor(Date.now() / 1000),
      keywords: extractKeywords(`${it.title || ''} ${it.snippet || ''}`),
    }));
  } catch {
    return [];
  } finally {
    clearTimeout(tid);
  }
}

async function fetchFromGoogleNews(symbol, meta, options = {}) {
  const qBase = String(symbol).trim().toUpperCase().replace(/\.(NS|BO)$/i, '');
  const company = String(options.companyName || meta?.companyName || '').trim();

  // Build the best entity string to search for.
  // Prefer full company name (e.g. "HDFC Bank") over raw symbol ("HDFCBANK")
  // because that's what headlines use.
  const primaryName = company || qBase;

  // Two parallel queries — open-web, no domain restriction:
  //
  // Q1: Broad — catches ALL recent coverage of this company from any source.
  //     Relies on entity gate in scoring to drop unrelated articles.
  //
  // Q2: Catalyst-focused — forces at least one heavy-movement keyword.
  //     Surfaces earnings, orders, penalties, deals even from small outlets
  //     that don't rank highly in general search.
  //
  // Both run simultaneously; results are merged and deduplicated by headline.
  // Scoring + entity gate decide what actually surfaces in the final output.
  const q1 = `"${primaryName}"`;
  const q2 = `"${primaryName}" (${HEAVY_CATALYST_TERMS})`;

  // For short/ambiguous symbols (≤4 chars like "ITC", "LT"), add the NSE suffix
  // as a disambiguation hint so we don't pick up unrelated companies.
  const q3 = qBase.length <= 4 && company
    ? `"${primaryName}" NSE OR BSE`
    : null;

  const fetchJobs = [fetchRSS(q1), fetchRSS(q2)];
  if (q3) fetchJobs.push(fetchRSS(q3));

  const resultSets = await Promise.all(fetchJobs);

  // Merge and deduplicate by normalised headline
  const seen = new Map();
  for (const items of resultSets) {
    for (const item of items) {
      const key = (item.headline || '').toLowerCase().trim();
      if (key && !seen.has(key)) seen.set(key, item);
    }
  }

  return [...seen.values()];
}

/* ===========================
   FILTERING & SCORING
=========================== */

function filterAndSortNews(items, symbol, meta) {
  const arr = Array.isArray(items) ? items : [];
  const now = Math.floor(Date.now() / 1000);
  const window72h = now - 72 * 3600;        // primary: 3 days (covers full weekend)
  const window7d  = now - 7 * 24 * 3600;   // fallback: 7 days (low-coverage symbols)

  // Time-gate first — score only items within the relevant window
  const fresh = arr.filter(n => (n.datetime || now) >= window72h);
  const pool  = fresh.length >= 3 ? fresh
              : arr.filter(n => (n.datetime || now) >= window7d);

  // Score threshold: 5 — requires at minimum a real entity match
  const THRESHOLD = 5;

  return pool
    .map(n => ({
      item: n,
      total: relevanceScore(n, symbol, meta) + calculateRecencyScore(n.datetime || now, now),
    }))
    .filter(x => x.total >= THRESHOLD)
    .sort((a, b) => b.total - a.total)
    .map(x => x.item);
}

function calculateRecencyScore(datetime, now) {
  if (!datetime) return 0;
  
  const hoursOld = (now - datetime) / 3600;
  
  if (hoursOld < 6) return 10;      // Very recent - high boost
  if (hoursOld < 24) return 8;     // Today - good boost
  if (hoursOld < 48) return 5;     // Yesterday - moderate boost
  if (hoursOld < 72) return 3;     // 2-3 days - small boost
  if (hoursOld < 168) return 1;    // 3-7 days - minimal boost
  
  return 0; // Older than 7 days - no boost
}

function relevanceScore(n, symbol, meta) {
  const title   = (n.headline || '').toLowerCase();
  const summary = (n.summary  || '').toLowerCase();
  const sym     = String(symbol || '').toLowerCase().replace(/\.(ns|bo)$/i, '');
  const company = (meta?.companyName || '').toLowerCase();

  // ── Anti-hallucination gate ──────────────────────────────────────────────
  // The article MUST mention this company or symbol somewhere.
  // Without this hard gate, high catalyst-keyword density alone could push
  // generic market roundups past the threshold.
  const titleMatchesSym = sym     && matchesEntity(title,   sym);
  const titleMatchesCo  = company && matchesEntity(title,   company);
  const bodyMatchesSym  = sym     && matchesEntity(summary, sym);
  const bodyMatchesCo   = company && matchesEntity(summary, company);

  if (!titleMatchesSym && !titleMatchesCo && !bodyMatchesSym && !bodyMatchesCo) {
    return 0; // not about this stock — hard zero, cannot be rescued by catalysts
  }

  let score = 0;

  // Entity match weight — title is a stronger signal than summary
  if (titleMatchesCo)  score += 12;
  if (titleMatchesSym) score += 10;
  if (bodyMatchesCo)   score += 4;
  if (bodyMatchesSym)  score += 2;

  // Catalyst boost — capped so it adds colour, not overrides entity signal
  const combined     = `${title} ${summary}`;
  const catalystHits = CATALYST_KEYWORDS.filter(kw => combined.includes(kw)).length;
  score += Math.min(catalystHits * 2, 10); // max +10 from catalysts

  // Pre/post market relevance bonus
  if (/pre.?market|before market|ahead of open/i.test(combined))  score += 2;
  if (/post.?market|after.?hours|after close/i.test(combined))    score += 2;

  // Trusted source adds a small lift
  if (isTrustedSource(n.source)) score += 2;

  // Generic market noise penalty — even if the article mentions the company,
  // "Top 10 stocks to watch" isn't actionable price news for this stock
  const noiseTerms = [
    'sensex', 'nifty 50', 'market today', 'global markets',
    'stocks to buy', 'top gainers', 'top losers', 'market wrap',
    'stock market update', 'market analysis', 'sector overview',
  ];
  const noiseHits = noiseTerms.filter(t => title.includes(t)).length;
  score -= noiseHits * 5;

  return Math.max(0, score);
}

function applyNewsOptions(items, symbol, meta, options = {}) {
  let result = Array.isArray(items) ? [...items] : []

  if (Number.isFinite(options.maxAgeHours)) {
    const maxAgeSeconds = Number(options.maxAgeHours) * 3600
    const now = Math.floor(Date.now() / 1000)
    result = result.filter((item) => !item?.datetime || (now - Number(item.datetime)) <= maxAgeSeconds)
  }

  if (options.trustedOnly) {
    result = result.filter((item) => isTrustedSource(item.source))
  }

  if (options.strictEntity) {
    const aliases = buildEntityAliases(symbol, meta, options)
    result = result.filter((item) => isEntityVerifiedItem(item, aliases, options))
  }

  if (options.requireCatalyst) {
    result = result.filter((item) => hasCatalyst(`${item.headline || ''} ${item.summary || ''}`))
  }

  if (result.length === 0 && options.strictEntity) {
    return []
  }

  return result
}

function buildEntityAliases(symbol, meta, options = {}) {
  return Array.from(
    new Set(
      [
        ...(Array.isArray(options.aliases) ? options.aliases : []),
        options.companyName,
        meta?.companyName,
        options.includeSymbolAlias === false ? null : symbol,
      ]
        .map((value) => String(value || '').trim())
        .filter(Boolean)
    )
  )
}

function isTrustedSource(source) {
  const normalized = String(source || '').trim().toLowerCase()
  return TRUSTED_SOURCE_FRAGMENTS.some((fragment) => normalized.includes(fragment))
}

function hasCatalyst(text) {
  const lower = String(text || '').toLowerCase()
  return CATALYST_KEYWORDS.some((keyword) => lower.includes(keyword))
}

function isGenericBuzzText(text) {
  const lower = String(text || '').toLowerCase()
  return GENERIC_BUZZ_PATTERNS.some((pattern) => lower.includes(pattern))
}

function isEntityVerifiedItem(item, aliases, options = {}) {
  const title = cleanSnippetText(item?.headline || '')
  const summary = cleanSnippetText(item?.summary || '')
  const combined = `${title} ${summary}`.trim()

  if (!combined) return false
  if (isGenericBuzzText(title) || isGenericBuzzText(combined)) return false

  const hasTitleMatch = aliases.some((alias) => matchesEntity(title, alias))
  const hasAnyMatch = hasTitleMatch || aliases.some((alias) => matchesEntity(summary, alias))

  if (!hasAnyMatch) return false
  if (options.requireHeadlineAlias && !hasTitleMatch) return false

  return true
}

function normalizeEntityForMatch(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\.(ns|bo)$/i, '')
    .replace(/[^a-z0-9&]+/g, ' ')
    .trim();
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchesEntity(text, entity) {
  const haystack = normalizeEntityForMatch(text);
  const needle = normalizeEntityForMatch(entity);
  if (!haystack || !needle) return false;
  if (needle.length < 2) return false;

  if (needle.length <= 3 || needle.includes('&')) {
    const compactHaystack = haystack.replace(/\s+/g, '');
    const compactNeedle = needle.replace(/\s+/g, '');
    if (!compactNeedle) return false;
    const compactRegex = new RegExp(`(^|[^a-z0-9])${escapeRegex(compactNeedle)}([^a-z0-9]|$)`);
    return compactRegex.test(compactHaystack);
  }

  const regex = new RegExp(`(^|\\b)${escapeRegex(needle).replace(/\s+/g, '\\s+')}(\\b|$)`);
  return regex.test(haystack);
}

/* ===========================
   UTILITIES
=========================== */

function dedupeNews(items) {
  const seen = new Set();
  return items.filter((n) => {
    const key = (n.headline || '').toLowerCase().trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function extractKeywords(text) {
  if (!text) return [];
  const stop = new Set([
    'the','a','an','and','or','of','to','in','on','for','with','by',
    'is','are','was','were','as','that','this','will','has','have','had'
  ]);
  const words = String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

  const counts = new Map();
  for (const w of words) {
    if (w.length < 3 || stop.has(w)) continue;
    counts.set(w, (counts.get(w) || 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([w]) => w);
}

async function safeCompanyMeta(symbol) {
  try {
    return await fetchCompanyMeta(symbol);
  } catch {
    return null;
  }
}

/* ===========================
   RSS PARSING
=========================== */

function parseGoogleRss(xml) {
  const out = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = itemRegex.exec(xml))) {
    const block   = m[1];
    const title   = decodeEntities(extractTag(block, 'title'));
    const rawSnip = sanitizeSnippet(extractTag(block, 'description'));

    // Google News RSS puts the headline (+ source name) into <description>.
    // Detect and discard it so we never show a duplicate summary.
    const snippet = isDuplicateSnippet(rawSnip, title) ? '' : rawSnip;

    out.push({
      title,
      link:    decodeEntities(extractTag(block, 'link')),
      pubDate: extractTag(block, 'pubDate'),
      source:  decodeEntities(extractTag(block, 'source')),
      snippet,
    });
  }
  return out;
}

/**
 * Returns true when the snippet is just a noisy echo of the headline.
 * Google News RSS puts the headline + source name into <description>, e.g.:
 *   title:   "NTPC Profit Zooms 38% - NDTV Profit"
 *   snippet: "NTPC Profit Zooms 38% NDTV Profit"
 * We normalise both (strip punctuation / source suffix) and compare.
 */
function isDuplicateSnippet(snippet, title) {
  if (!snippet || !title) return false;

  const normalise = (s) =>
    s.toLowerCase()
     .replace(/[-–—|·•]/g, ' ')   // separators often used before source name
     .replace(/[^a-z0-9\s]/g, '')
     .replace(/\s+/g, ' ')
     .trim();

  const ns = normalise(snippet);
  const nt = normalise(title);

  // Exact or near-exact match
  if (ns === nt) return true;

  // Snippet starts with the headline text (headline + source appended)
  if (ns.startsWith(nt)) return true;

  // Title starts with most of the snippet (snippet is a truncated headline)
  if (nt.startsWith(ns) && ns.length > 20) return true;

  // Levenshtein would be overkill — word-overlap ratio covers the rest
  const titleWords   = new Set(nt.split(' ').filter(w => w.length > 3));
  const snippetWords = ns.split(' ').filter(w => w.length > 3);
  if (!snippetWords.length || !titleWords.size) return false;

  const overlap = snippetWords.filter(w => titleWords.has(w)).length;
  return overlap / snippetWords.length >= 0.80; // ≥80% words shared → duplicate
}

function extractTag(block, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = re.exec(block);
  return m ? m[1] : '';
}

function decodeEntities(s) {
  return s
    ?.replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function sanitizeSnippet(s) {
  return cleanSnippetText(s)
}

function cleanSnippetText(s) {
  if (!s) return ''
  return decodeEntities(String(s))
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
