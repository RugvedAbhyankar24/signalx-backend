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

  // More comprehensive queries for different stock types
  const queries = [
    // Primary: Exact symbol match
    `"${qBase}" stock news site:moneycontrol.com OR site:economictimes.indiatimes.com OR site:livemint.com OR site:business-standard.com`,
    // Company name variations
    company ? `"${company}" stock news` : null,
    company ? `"${company}" share price` : null,
    // Symbol variations (for stocks like VBL)
    `${qBase} shares news`,
    `${qBase} stock price`,
    // Common variations for beverage companies (since VBL is Varun Beverages)
    qBase === 'VBL' ? 'Varun Beverages stock news' : null,
    qBase === 'VBL' ? 'Varun Beverages share price' : null,
    // Broader searches if specific ones fail
    `${qBase} company news`,
    company ? `${company} quarterly results` : null,
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
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'application/rss+xml, application/xml',
        'Accept-Language': 'en-IN,en;q=0.9',
        'Cache-Control': 'no-cache, no-store',
        'Pragma': 'no-cache'
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
        : Math.floor(Date.now() / 1000),
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
  const now = Math.floor(Date.now() / 1000);

  const scored = arr
    .map((n) => ({ 
      item: n, 
      score: relevanceScore(n, symbol, meta),
      recencyScore: calculateRecencyScore(n.datetime || now, now)
    }))
    .filter((x) => x.score >= 3); // Lowered threshold from 5 to 3

  let strong = scored
    .sort(
      (a, b) => {
        // Prioritize relevance first, then recency
        const aTotal = a.score + a.recencyScore;
        const bTotal = b.score + b.recencyScore;
        
        // First by total score (relevance + recency)
        if (bTotal !== aTotal) return bTotal - aTotal;
        
        // Then by relevance score alone
        if (b.score !== a.score) return b.score - a.score;
        
        // Finally by recency
        return (b.item.datetime || 0) - (a.item.datetime || 0);
      }
    )
    .map((x) => x.item);

  // Filter out very old news (older than 14 days - increased from 7 days)
  const fourteenDaysAgo = now - (14 * 24 * 60 * 60);
  strong = strong.filter(item => (item.datetime || now) > fourteenDaysAgo);

  // If we have less than 3 items, try to include more with lower relevance
  if (strong.length < 3) {
    const fallback = arr
      .filter(item => (item.datetime || now) > fourteenDaysAgo)
      .sort((a, b) => (b.datetime || 0) - (a.datetime || 0))
      .slice(0, 5);
    
    // Combine high relevance with recent items to reach 5
    const combined = [...strong];
    for (const item of fallback) {
      if (!combined.find(existing => existing.headline === item.headline)) {
        combined.push(item);
        if (combined.length >= 5) break;
      }
    }
    return combined.slice(0, 5);
  }

  // Always return top 5 most relevant news
  return strong.slice(0, 5);
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
  const title = (n.headline || '').toLowerCase();
  const summary = (n.summary || '').toLowerCase();
  const sym = String(symbol || '').toLowerCase().replace(/\.(ns|bo)$/i, '');
  const company = (meta?.companyName || '').toLowerCase();

  let score = 0;

  // High-relevance exact matches
  if (sym && title.includes(sym)) score += 15; // Increased from 8
  if (company && title.includes(company)) score += 12; // Increased from 6
  
  // Summary matches (less weight)
  if (sym && summary.includes(sym)) score += 6; // Increased from 3
  if (company && summary.includes(company)) score += 4; // Increased from 2

  // Stock-specific keywords (positive indicators)
  const stockKeywords = ['stock', 'share', 'shares', 'price', 'market', 'trading', 'nse', 'bse', 'equity'];
  const stockKeywordMatches = stockKeywords.filter(keyword => title.includes(keyword)).length;
  score += stockKeywordMatches * 3;

  // Financial indicators
  const financialKeywords = ['profit', 'loss', 'revenue', 'earnings', 'quarter', 'q1', 'q2', 'q3', 'q4', 'results', 'dividend'];
  const financialKeywordMatches = financialKeywords.filter(keyword => title.includes(keyword)).length;
  score += financialKeywordMatches * 2;

  // Strong negative penalties for generic market news
  const genericTerms = [
    'sensex', 'nifty 50', 'market today', 'global markets', 'stock market update',
    'market analysis', 'indices', 'sector overview', 'market watch'
  ];
  const genericMatches = genericTerms.filter(term => title.includes(term)).length;
  score -= genericMatches * 8; // Increased penalty

  // Extra penalty if no stock-specific keywords found
  if (stockKeywordMatches === 0 && financialKeywordMatches === 0) {
    score -= 5;
  }

  // Minimum threshold for relevance
  return Math.max(0, score);
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
