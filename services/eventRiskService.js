import { fetchCompanyNews } from './newsService.js';
import { assessStructuredCalendarRisk, fetchStructuredEventCalendar } from './eventCalendarService.js';

const SEVERE_KEYWORDS = [
  'results', 'earnings', 'board meeting', 'rbi', 'policy', 'default', 'penalty',
  'investigation', 'sebi', 'ed', 'cbi', 'fraud', 'rating downgrade', 'downgrade'
];

const IMPORTANT_KEYWORDS = [
  'block deal', 'bulk deal', 'guidance', 'dividend', 'buyback', 'stake sale',
  'fund raise', 'fundraise', 'acquisition', 'merger', 'order', 'contract'
];

const IMMINENT_PATTERNS = [
  /\btoday\b/i,
  /\btomorrow\b/i,
  /\bahead of\b/i,
  /\blater today\b/i,
  /\bthis week\b/i,
  /\bon\s+\d{1,2}\s+[a-z]{3,9}\b/i,
];

function scoreHeadlineRisk(text = '', ageHours = 999) {
  const lower = String(text).toLowerCase();
  let score = 0;

  for (const keyword of SEVERE_KEYWORDS) {
    if (lower.includes(keyword)) score += 4;
  }
  for (const keyword of IMPORTANT_KEYWORDS) {
    if (lower.includes(keyword)) score += 2;
  }
  for (const pattern of IMMINENT_PATTERNS) {
    if (pattern.test(text)) score += 3;
  }

  if (ageHours <= 6) score += 3;
  else if (ageHours <= 24) score += 2;
  else if (ageHours <= 48) score += 1;

  return score;
}

export function assessEventRiskFromNews(items = []) {
  const nowMs = Date.now();
  const findings = [];

  for (const item of Array.isArray(items) ? items : []) {
    const headline = String(item?.headline || '');
    const summary = String(item?.summary || '');
    const datetime = Number(item?.datetime);
    const ageHours = Number.isFinite(datetime)
      ? (nowMs - (datetime * 1000)) / (1000 * 60 * 60)
      : 999;
    const score = scoreHeadlineRisk(`${headline} ${summary}`, ageHours);
    if (score <= 0) continue;
    findings.push({
      headline,
      source: item?.source || null,
      datetime: Number.isFinite(datetime) ? datetime : null,
      ageHours: Number.isFinite(ageHours) ? Number(ageHours.toFixed(1)) : null,
      score,
    });
  }

  findings.sort((a, b) => b.score - a.score);
  const top = findings[0] || null;
  const aggregateScore = findings.slice(0, 3).reduce((sum, item) => sum + item.score, 0);

  let severity = 'low';
  let blocked = false;
  if (aggregateScore >= 10) {
    severity = 'high';
    blocked = true;
  } else if (aggregateScore >= 6) {
    severity = 'medium';
  }

  const reasons = [];
  if (top) reasons.push(`News/event risk: ${top.headline}`);
  if (!top) reasons.push('No fresh catalyst headlines detected');

  return {
    blocked,
    severity,
    aggregateScore,
    reasons,
    topFindings: findings.slice(0, 3),
  };
}

export async function getEventRiskProfile(symbol, options = {}) {
  const [structuredCalendar, newsResult] = await Promise.all([
    fetchStructuredEventCalendar(symbol, { limit: 20 }).catch(() => ({
      symbol,
      companyEvents: [],
      macroEvents: [],
      updatedAt: new Date().toISOString(),
    })),
    fetchCompanyNews(symbol, {
      includeMeta: false,
      strictEntity: true,
      requireCatalyst: true,
      maxAgeHours: Number.isFinite(options.maxAgeHours) ? options.maxAgeHours : 72,
      trustedOnly: options.trustedOnly !== false,
    }).catch((error) => ({ __error: error })),
  ]);

  const calendarRisk = assessStructuredCalendarRisk(structuredCalendar);

  try {
    if (newsResult?.__error) throw newsResult.__error;
    const newsItems = Array.isArray(newsResult) ? newsResult : [];
    const newsRisk = assessEventRiskFromNews(newsItems);
    const combinedBlocked = calendarRisk.blocked || newsRisk.blocked;
    const aggregateScore = calendarRisk.score + newsRisk.aggregateScore;
    const severity = combinedBlocked || aggregateScore >= 10
      ? 'high'
      : aggregateScore >= 6
      ? 'medium'
      : 'low';

    return {
      available: true,
      blocked: combinedBlocked,
      severity,
      aggregateScore,
      reasons: Array.from(new Set([
        ...(calendarRisk.reasons || []),
        ...(newsRisk.reasons || []),
      ])).slice(0, 6),
      topFindings: newsRisk.topFindings,
      newsCount: newsItems.length,
      structuredCalendar,
      calendarRisk,
      newsRisk,
    };
  } catch (error) {
    return {
      available: structuredCalendar.companyEvents.length > 0 || structuredCalendar.macroEvents.length > 0,
      blocked: calendarRisk.blocked,
      severity: calendarRisk.severity === 'low' ? 'unknown' : calendarRisk.severity,
      aggregateScore: calendarRisk.score,
      reasons: Array.from(new Set([
        ...(calendarRisk.reasons || []),
        error.message || 'News event filter unavailable',
      ])).slice(0, 6),
      topFindings: [],
      newsCount: 0,
      structuredCalendar,
      calendarRisk,
      newsRisk: null,
    };
  }
}
