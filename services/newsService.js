import fetch from 'node-fetch';
import { fetchCompanyMeta } from './marketData.js';

/* ===========================
   PUBLIC API
=========================== */

export async function fetchCompanyNews(symbol) {
  const meta = await safeCompanyMeta(symbol);

  // Primary: Google News RSS (no API keys, stable)
  const googleItems = await fetchFromGoogleNews(symbol, meta);

  const filtered = filterAndSortNews(googleItems, symbol, meta);
  const deduped = dedupeNews(filtered);

  // Always return 3–5 items if available
  return deduped.slice(0, Math.min(5, Math.max(3, deduped.length)));
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
    'beats', 'surges', 'record profit', 'strong growth',
    'upgrade', 'outperform', 'rallies', 'profit jumps'
  ];
  const negative = [
    'misses', 'probe', 'fraud', 'downgrade',
    'loss widens', 'plunge', 'defaults', 'investigation'
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

async function fetchFromGoogleNews(symbol, meta) {
  const qBase = String(symbol).trim().toUpperCase().replace(/\.(NS|BO)$/i, '');
  const company = (meta?.companyName || '').trim();
  const industry = (meta?.industry || '').trim();

  const queries = [
    `${qBase} stock site:moneycontrol.com OR site:economictimes.indiatimes.com OR site:livemint.com`,
    company ? `${company} India stock` : null,
    industry ? `${industry} sector India` : null,
  ].filter(Boolean);

  for (const q of queries) {
    const rssUrl =
      `https://news.google.com/rss/search?` +
      new URLSearchParams({
        q,
        hl: 'en-IN',
        gl: 'IN',
        ceid: 'IN:en',
      }).toString();

    const res = await fetch(rssUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/rss+xml, application/xml',
      },
    });

    if (!res.ok) continue;

    const xml = await res.text();
    const items = parseGoogleRss(xml).map((it) => ({
      headline: it.title,
      summary: it.snippet,
      url: it.link,
      source: it.source || 'Google News',
      datetime: it.pubDate
        ? Math.floor(new Date(it.pubDate).getTime() / 1000)
        : undefined,
      keywords: extractKeywords(`${it.title || ''} ${it.snippet || ''}`),
    }));

    if (items.length) return items;
  }
  return [];
}

/* ===========================
   FILTERING & SCORING
=========================== */

function filterAndSortNews(items, symbol, meta) {
  const arr = Array.isArray(items) ? items : [];

  const scored = arr
    .map((n) => ({ item: n, score: relevanceScore(n, symbol, meta) }))
    .filter((x) => x.score >= 0);

  let strong = scored
    .sort(
      (a, b) =>
        b.score - a.score ||
        (b.item.datetime || 0) - (a.item.datetime || 0)
    )
    .map((x) => x.item);

  // If relevance filtering is too strict, fallback to recency
  if (strong.length < 3) {
    strong = arr.sort(
      (a, b) => (b.datetime || 0) - (a.datetime || 0)
    );
  }

  return strong;
}

function relevanceScore(n, symbol, meta) {
  const title = (n.headline || '').toLowerCase();
  const summary = (n.summary || '').toLowerCase();
  const sym = String(symbol || '').toLowerCase().replace(/\.(ns|bo)$/i, '');
  const company = (meta?.companyName || '').toLowerCase();

  let score = 0;

  if (sym && title.includes(sym)) score += 8;
  if (company && title.includes(company)) score += 6;
  if (sym && summary.includes(sym)) score += 3;
  if (company && summary.includes(company)) score += 2;

  // Soft penalty instead of hard rejection
  const genericTerms = ['sensex', 'market today', 'global markets'];
  if (genericTerms.some((t) => title.includes(t))) score -= 2;

  return score;
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
    const block = m[1];
    out.push({
      title: decodeEntities(extractTag(block, 'title')),
      link: decodeEntities(extractTag(block, 'link')),
      pubDate: extractTag(block, 'pubDate'),
      source: decodeEntities(extractTag(block, 'source')),
      snippet: sanitizeSnippet(extractTag(block, 'description')),
    });
  }
  return out;
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
  return s ? s.replace(/<[^>]+>/g, '') : s;
}
