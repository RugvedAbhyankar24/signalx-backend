export function buildProfessionalGate({
  mode = 'swing',
  signalView = null,
  eventRisk = null,
  microstructure = null,
  marketActivity = null,
} = {}) {
  const reasons = [];
  let blocked = false;
  let scorePenalty = 0;
  let blockerReason = null;

  if (eventRisk?.blocked) {
    blocked = true;
    blockerReason = 'event_risk';
    scorePenalty += 18;
    reasons.push(...(eventRisk.reasons || []));
  } else if (eventRisk?.severity === 'medium') {
    scorePenalty += 8;
    reasons.push(...(eventRisk.reasons || []));
  }

  const microStatus = microstructure?.signal?.status;
  if (microStatus === 'adverse' && ['positive', 'negative'].includes(signalView?.sentiment)) {
    blocked = true;
    blockerReason = blockerReason || 'microstructure_adverse';
    scorePenalty += 14;
    reasons.push(...(microstructure?.signal?.reasons || []));
  } else if (microStatus === 'unavailable') {
    scorePenalty += 4;
    reasons.push(...(microstructure?.signal?.reasons || []));
  } else if (microStatus === 'favorable') {
    reasons.push(...(microstructure?.signal?.reasons || []));
  }

  const activityStatus = marketActivity?.signal?.status;
  if (activityStatus === 'adverse') {
    scorePenalty += mode === 'intraday' ? 10 : 7;
    reasons.push(...(marketActivity?.signal?.reasons || []));
    if (mode === 'intraday' && ['positive', 'negative'].includes(signalView?.sentiment)) {
      blocked = true;
      blockerReason = blockerReason || 'institutional_flow_conflict';
    }
  } else if (activityStatus === 'supportive') {
    reasons.push(...(marketActivity?.signal?.reasons || []));
  }

  return {
    blocked,
    blockerReason,
    scorePenalty,
    reasons: Array.from(new Set(reasons)).slice(0, 6),
  };
}
