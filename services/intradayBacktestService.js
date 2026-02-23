import { promises as fs } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { fetchOHLCV } from './marketData.js'
import { isMongoConnected } from '../config/mongo.js'
import { IntradaySignalSnapshot } from '../models/IntradaySignalSnapshot.js'
import { IntradayBacktestRun } from '../models/IntradayBacktestRun.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const DATA_DIR = path.join(__dirname, '..', 'data')
const SIGNAL_HISTORY_FILE = path.join(DATA_DIR, 'intradaySignalHistory.json')
const BACKTEST_HISTORY_FILE = path.join(DATA_DIR, 'intradayBacktestHistory.json')

const IST_PARTS_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23'
})

const SESSION_OPEN_MIN = 9 * 60 + 15
const SESSION_CLOSE_MIN = 15 * 60 + 30
const DEFAULT_INTRADAY_ROUND_TRIP_COST_BPS = Number(process.env.INTRADAY_ROUND_TRIP_COST_BPS || 18)
const BACKTEST_INTERVAL_PRIORITY = String(process.env.INTRADAY_BACKTEST_INTERVALS || '1m,2m,5m')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
const SIGNAL_HISTORY_LIMIT = Math.max(100, Number(process.env.INTRADAY_SIGNAL_HISTORY_LIMIT || 500))
const BACKTEST_HISTORY_LIMIT = Math.max(100, Number(process.env.INTRADAY_BACKTEST_HISTORY_LIMIT || 1000))

function toFiniteNumber(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function round2(value) {
  return Math.round(value * 100) / 100
}

function currentISTDate() {
  const parts = IST_PARTS_FORMATTER.formatToParts(new Date())
  const pick = (type) => parts.find(p => p.type === type)?.value || ''
  return `${pick('year')}-${pick('month')}-${pick('day')}`
}

function parseISTForDate(dateObj) {
  const parts = IST_PARTS_FORMATTER.formatToParts(dateObj)
  const pick = (type) => parts.find(p => p.type === type)?.value || ''
  const date = `${pick('year')}-${pick('month')}-${pick('day')}`
  const hour = Number(pick('hour'))
  const minute = Number(pick('minute'))
  const minutes = Number.isFinite(hour) && Number.isFinite(minute) ? (hour * 60 + minute) : null
  return {
    date,
    hour,
    minute,
    minutes,
    time: `${String(hour || 0).padStart(2, '0')}:${String(minute || 0).padStart(2, '0')}`
  }
}

function parseISTTimeToMinutes(istTime) {
  if (typeof istTime !== 'string') return null
  const [hRaw, mRaw] = istTime.split(':')
  const h = Number(hRaw)
  const m = Number(mRaw)
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null
  return h * 60 + m
}

function evaluateSnapshotExactness(snapshot, tradeDate) {
  const reasons = []
  if (!snapshot) {
    return { exact: false, reasons: ['missing_snapshot'] }
  }

  if (snapshot.istDate !== tradeDate) {
    reasons.push('snapshot_date_mismatch')
  }

  const snapshotMinute = parseISTTimeToMinutes(snapshot.istTime)
  if (snapshotMinute == null) {
    reasons.push('invalid_snapshot_time')
  } else if (snapshotMinute < SESSION_OPEN_MIN || snapshotMinute > SESSION_CLOSE_MIN) {
    reasons.push('snapshot_time_outside_market_session')
  }

  const meta = snapshot.meta || {}
  if (meta.snapshotDateOverride) reasons.push('snapshot_date_overridden')
  if (meta.marketState && meta.marketState.isOpen === false) {
    reasons.push('captured_when_market_closed')
  }

  return {
    exact: reasons.length === 0,
    reasons,
    snapshotIstDate: snapshot.istDate,
    snapshotIstTime: snapshot.istTime,
    marketStateReason: meta?.marketState?.reason || null
  }
}

function humanizeExactnessReason(reason) {
  if (reason === 'missing_snapshot') return 'No snapshot available'
  if (reason === 'snapshot_date_mismatch') return 'Snapshot date does not match selected trade date'
  if (reason === 'invalid_snapshot_time') return 'Snapshot time is invalid'
  if (reason === 'snapshot_time_outside_market_session') return 'Snapshot captured outside market session (09:15-15:30 IST)'
  if (reason === 'snapshot_date_overridden') return 'Snapshot date was manually overridden'
  if (reason === 'captured_when_market_closed') return 'Snapshot captured when market was closed'
  return reason
}

async function ensureDir() {
  await fs.mkdir(DATA_DIR, { recursive: true })
}

async function readJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, 'utf8')
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

async function writeJson(filePath, payload) {
  await ensureDir()
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8')
}

function normalizeIso(value) {
  if (!value) return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

function mapSnapshotDocument(doc) {
  if (!doc) return null
  return {
    id: doc.id,
    createdAt: normalizeIso(doc.createdAt) || normalizeIso(new Date()),
    istDate: doc.istDate,
    istTime: doc.istTime,
    totalScanned: Number(doc.totalScanned) || 0,
    positiveCount: Number(doc.positiveCount) || 0,
    qualityScore: toFiniteNumber(doc.qualityScore) ?? 0,
    picks: Array.isArray(doc.picks) ? doc.picks : [],
    meta: doc.meta || {},
    rawPayload: doc.rawPayload || null
  }
}

function mapBacktestRunDocument(doc) {
  if (!doc) return null
  return {
    id: doc.id,
    createdAt: normalizeIso(doc.createdAt) || normalizeIso(new Date()),
    tradeDate: doc.tradeDate,
    capital: Number(doc.capital) || 0,
    allocationMode: doc.allocationMode,
    snapshotMode: doc.snapshotMode,
    snapshotId: doc.snapshotId,
    snapshotCreatedAt: normalizeIso(doc.snapshotCreatedAt),
    summary: doc.summary || {},
    trades: Array.isArray(doc.trades) ? doc.trades : []
  }
}

function sanitizePicks(picks) {
  if (!Array.isArray(picks)) return []
  return picks
    .filter(Boolean)
    .map(pick => ({
      symbol: String(pick.symbol || '').trim(),
      normalizedSymbol: pick.normalizedSymbol || null,
      resolvedSymbol: pick.resolvedSymbol || pick.symbol || null,
      companyName: pick.companyName || pick.symbol || null,
      entryType: pick.entryType || null,
      entryReason: pick.entryReason || null,
      entryPrice: toFiniteNumber(pick.entryPrice),
      stopLoss: toFiniteNumber(pick.stopLoss),
      target1: toFiniteNumber(pick.target1),
      target2: toFiniteNumber(pick.target2),
      currentPrice: toFiniteNumber(pick.currentPrice),
      riskReward: toFiniteNumber(pick.riskReward),
      riskRewardAfterCosts: toFiniteNumber(pick.riskRewardAfterCosts),
      riskRewardGross: toFiniteNumber(pick.riskRewardGross),
      estimatedRoundTripCostPct: toFiniteNumber(pick.estimatedRoundTripCostPct),
      volatilityPct: toFiniteNumber(pick.volatilityPct)
    }))
    .filter(pick =>
      pick.symbol &&
      pick.entryPrice != null &&
      pick.stopLoss != null &&
      pick.target1 != null &&
      pick.target2 != null &&
      pick.entryPrice > 0 &&
      pick.stopLoss > 0 &&
      pick.target1 > pick.entryPrice &&
      pick.target2 > pick.target1 &&
      pick.stopLoss < pick.entryPrice
    )
}

function normalizeSnapshotMode(mode) {
  const value = String(mode || 'latest').toLowerCase()
  if (value === 'earliest') return 'earliest'
  return 'latest'
}

function normalizeAllocationMode(mode) {
  const value = String(mode || 'per_pick').toLowerCase()
  if (value === 'split_across_picks') return 'split_across_picks'
  return 'per_pick'
}

function pickEntryExitForCandle({ low, high, stopLoss, target1, target2 }) {
  const hitSL = low <= stopLoss
  const hitT1 = high >= target1
  const hitT2 = high >= target2

  if (hitSL && (hitT1 || hitT2)) {
    return {
      exitType: 'stop_loss',
      exitPrice: stopLoss,
      reason: 'sl_and_target_same_candle_stop_priority'
    }
  }
  if (hitSL) {
    return {
      exitType: 'stop_loss',
      exitPrice: stopLoss,
      reason: 'stop_loss_hit'
    }
  }
  if (hitT2) {
    return {
      exitType: 'target2_hit',
      exitPrice: target2,
      reason: 'target2_hit'
    }
  }
  if (hitT1) {
    return {
      exitType: 'target1_hit',
      exitPrice: target1,
      reason: 'target1_hit'
    }
  }
  return null
}

function getRangeForDate(targetDate) {
  const now = new Date()
  const nowIST = parseISTForDate(now).date
  if (targetDate === nowIST) return '5d'

  const nowUtc = new Date(`${nowIST}T00:00:00Z`).getTime()
  const targetUtc = new Date(`${targetDate}T00:00:00Z`).getTime()
  const ageDays = Math.max(0, Math.round((nowUtc - targetUtc) / 86400000))

  if (ageDays <= 7) return '5d'
  if (ageDays <= 30) return '1mo'
  return '3mo'
}

function normalizeDayCandles(candles, tradeDate) {
  return (Array.isArray(candles) ? candles : [])
    .map(candle => {
      if (!candle?.timestamp) return null
      const dt = new Date(candle.timestamp)
      if (Number.isNaN(dt.getTime())) return null
      const ist = parseISTForDate(dt)
      const open = toFiniteNumber(candle.open)
      const high = toFiniteNumber(candle.high)
      const low = toFiniteNumber(candle.low)
      const close = toFiniteNumber(candle.close)
      if (open == null || high == null || low == null || close == null) return null
      return {
        timestamp: candle.timestamp,
        istDate: ist.date,
        istTime: ist.time,
        minutes: ist.minutes,
        open,
        high,
        low,
        close
      }
    })
    .filter(Boolean)
    .filter(c => c.istDate === tradeDate && c.minutes >= SESSION_OPEN_MIN && c.minutes <= SESSION_CLOSE_MIN)
    .sort((a, b) => a.minutes - b.minutes)
}

async function fetchBestGranularityCandles(symbol, tradeDate) {
  const range = getRangeForDate(tradeDate)
  for (const interval of BACKTEST_INTERVAL_PRIORITY) {
    const candles = await fetchOHLCV(symbol, 1, { interval, range })
    const dayCandles = normalizeDayCandles(candles, tradeDate)
    if (dayCandles.length) {
      return { interval, dayCandles }
    }
  }
  return {
    interval: BACKTEST_INTERVAL_PRIORITY[BACKTEST_INTERVAL_PRIORITY.length - 1] || '5m',
    dayCandles: []
  }
}

async function backtestSinglePick({
  pick,
  tradeDate,
  capitalPerPick,
  signalStartMinute,
  costBps
}) {
  const symbol = pick.resolvedSymbol || pick.symbol
  const { interval, dayCandles } = await fetchBestGranularityCandles(symbol, tradeDate)

  const baseResult = {
    symbol: pick.symbol,
    resolvedSymbol: symbol,
    companyName: pick.companyName,
    entryType: pick.entryType,
    entryReason: pick.entryReason,
    entryPrice: pick.entryPrice,
    stopLoss: pick.stopLoss,
    target1: pick.target1,
    target2: pick.target2,
    candleInterval: interval,
    capitalConfigured: round2(capitalPerPick)
  }

  if (!dayCandles.length) {
    return {
      ...baseResult,
      status: 'no_data',
      outcome: 'no_trade',
      reason: 'no_intraday_candles_for_date',
      quantity: 0,
      investedAmount: 0,
      grossPnl: 0,
      netPnl: 0,
      roundTripCost: 0
    }
  }

  const startMinute = Math.max(signalStartMinute ?? SESSION_OPEN_MIN, SESSION_OPEN_MIN)
  const tradableCandles = dayCandles.filter(c => c.minutes >= startMinute)
  if (!tradableCandles.length) {
    return {
      ...baseResult,
      status: 'no_trade',
      outcome: 'no_trade',
      reason: 'no_candles_after_signal_time',
      quantity: 0,
      investedAmount: 0,
      grossPnl: 0,
      netPnl: 0,
      roundTripCost: 0
    }
  }

  const quantity = Math.floor(capitalPerPick / pick.entryPrice)
  if (!Number.isFinite(quantity) || quantity < 1) {
    return {
      ...baseResult,
      status: 'no_trade',
      outcome: 'no_trade',
      reason: 'capital_too_low_for_one_share',
      quantity: 0,
      investedAmount: 0,
      grossPnl: 0,
      netPnl: 0,
      roundTripCost: 0
    }
  }

  let entryCandle = null
  for (const candle of tradableCandles) {
    if (candle.low <= pick.entryPrice && candle.high >= pick.entryPrice) {
      entryCandle = candle
      break
    }
  }

  if (!entryCandle) {
    return {
      ...baseResult,
      status: 'no_trade',
      outcome: 'no_trade',
      reason: 'entry_not_triggered',
      quantity: 0,
      investedAmount: 0,
      grossPnl: 0,
      netPnl: 0,
      roundTripCost: 0,
      evaluatedFromTime: tradableCandles[0]?.istTime || null
    }
  }

  const roundTripCost = (pick.entryPrice * quantity * (costBps / 10000))
  const startIdx = tradableCandles.findIndex(c => c.timestamp === entryCandle.timestamp)
  let exit = null
  for (let i = startIdx; i < tradableCandles.length; i += 1) {
    const candle = tradableCandles[i]
    exit = pickEntryExitForCandle({
      low: candle.low,
      high: candle.high,
      stopLoss: pick.stopLoss,
      target1: pick.target1,
      target2: pick.target2
    })
    if (exit) {
      exit = {
        ...exit,
        candleTimestamp: candle.timestamp,
        istTime: candle.istTime
      }
      break
    }
  }

  if (!exit) {
    return {
      ...baseResult,
      status: 'no_trade',
      outcome: 'no_trade',
      reason: 'no_exit_level_hit_by_close',
      quantity: 0,
      investedAmount: 0,
      grossPnl: 0,
      netPnl: 0,
      roundTripCost: 0,
      entryTriggeredAt: entryCandle.istTime,
      entryTriggeredTimestamp: entryCandle.timestamp,
      lastCheckedAt: tradableCandles[tradableCandles.length - 1]?.istTime || null
    }
  }

  const investedAmount = pick.entryPrice * quantity
  const grossPnl = (exit.exitPrice - pick.entryPrice) * quantity
  const netPnl = grossPnl - roundTripCost

  return {
    ...baseResult,
    status: 'closed',
    outcome: exit.exitType === 'stop_loss' ? 'loss' : 'win',
    reason: exit.reason,
    quantity,
    investedAmount: round2(investedAmount),
    entryTriggeredAt: entryCandle.istTime,
    entryTriggeredTimestamp: entryCandle.timestamp,
    exitTriggeredAt: exit.istTime,
    exitTriggeredTimestamp: exit.candleTimestamp,
    exitType: exit.exitType,
    exitPrice: round2(exit.exitPrice),
    grossPnl: round2(grossPnl),
    netPnl: round2(netPnl),
    roundTripCost: round2(roundTripCost)
  }
}

function buildSummary({ trades, capital, allocationMode, costBps }) {
  const wins = trades.filter(t => t.outcome === 'win').length
  const losses = trades.filter(t => t.outcome === 'loss').length
  const executed = trades.filter(t => t.status === 'closed')
  const noTrade = trades.filter(t => t.outcome === 'no_trade').length
  const target1Hits = trades.filter(t => t.exitType === 'target1_hit').length
  const target2Hits = trades.filter(t => t.exitType === 'target2_hit').length
  const stopLossHits = trades.filter(t => t.exitType === 'stop_loss').length
  const grossPnl = executed.reduce((sum, t) => sum + (toFiniteNumber(t.grossPnl) || 0), 0)
  const netPnl = executed.reduce((sum, t) => sum + (toFiniteNumber(t.netPnl) || 0), 0)
  const deployedCapital = executed.reduce((sum, t) => sum + (toFiniteNumber(t.investedAmount) || 0), 0)
  const configuredExposure =
    allocationMode === 'split_across_picks' ? capital : capital * trades.length
  const winRate = (wins + losses) > 0 ? (wins / (wins + losses)) * 100 : 0
  const roiOnConfiguredExposure = configuredExposure > 0 ? (netPnl / configuredExposure) * 100 : 0
  const roiOnDeployedCapital = deployedCapital > 0 ? (netPnl / deployedCapital) * 100 : 0
  const decisiveTrades = wins + losses
  const recommendationAccuracyPct = decisiveTrades > 0 ? (wins / decisiveTrades) * 100 : 0

  const byEntryType = new Map()
  const byLossReason = new Map()
  for (const trade of trades) {
    const entryType = trade.entryType || 'unknown'
    const slot = byEntryType.get(entryType) || { entryType, total: 0, wins: 0, losses: 0, noTrade: 0, netPnl: 0 }
    slot.total += 1
    if (trade.outcome === 'win') slot.wins += 1
    else if (trade.outcome === 'loss') slot.losses += 1
    else slot.noTrade += 1
    slot.netPnl += toFiniteNumber(trade.netPnl) || 0
    byEntryType.set(entryType, slot)

    if (trade.outcome === 'loss') {
      const reason = trade.reason || 'unknown_loss_reason'
      byLossReason.set(reason, (byLossReason.get(reason) || 0) + 1)
    }
  }
  const setupPerformance = [...byEntryType.values()]
    .map(s => ({
      ...s,
      winRate: round2((s.wins + s.losses) > 0 ? (s.wins / (s.wins + s.losses)) * 100 : 0),
      netPnl: round2(s.netPnl)
    }))
    .sort((a, b) => b.total - a.total)
  const lossReasons = [...byLossReason.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)

  let recommendationVerdict = 'insufficient_data'
  if (decisiveTrades >= 3) {
    if (recommendationAccuracyPct >= 55 && netPnl > 0) recommendationVerdict = 'working'
    else if (recommendationAccuracyPct >= 45) recommendationVerdict = 'mixed_refine'
    else recommendationVerdict = 'needs_refinement'
  }

  return {
    totalSignals: trades.length,
    tradesClosed: executed.length,
    wins,
    losses,
    noTrade,
    target1Hits,
    target2Hits,
    stopLossHits,
    decisiveTrades,
    winRate: round2(winRate),
    recommendationAccuracyPct: round2(recommendationAccuracyPct),
    recommendationVerdict,
    grossPnl: round2(grossPnl),
    netPnl: round2(netPnl),
    deployedCapital: round2(deployedCapital),
    configuredExposure: round2(configuredExposure),
    roiOnConfiguredExposurePct: round2(roiOnConfiguredExposure),
    roiOnDeployedCapitalPct: round2(roiOnDeployedCapital),
    setupPerformance,
    lossReasons,
    costModel: {
      roundTripCostBps: costBps
    }
  }
}

function sanitizeDateInput(input) {
  if (typeof input !== 'string') return currentISTDate()
  const value = input.trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return currentISTDate()
  return value
}

function sanitizeCapitalInput(input) {
  const value = Number(input)
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('Capital must be a positive number')
  }
  return value
}

async function readSignalHistory() {
  const fallback = { version: 1, snapshots: [] }
  const data = await readJson(SIGNAL_HISTORY_FILE, fallback)
  if (!Array.isArray(data?.snapshots)) return fallback
  return data
}

async function readBacktestHistory() {
  const fallback = { version: 1, runs: [] }
  const data = await readJson(BACKTEST_HISTORY_FILE, fallback)
  if (!Array.isArray(data?.runs)) return fallback
  return data
}

function normalizeLimit(input, fallback) {
  return Math.max(1, Math.min(500, Number(input) || fallback))
}

function snapshotQualityFromPicks(picks) {
  const safePicks = Array.isArray(picks) ? picks : []
  if (!safePicks.length) return 0

  let rrSum = 0
  for (const pick of safePicks) {
    const rr =
      toFiniteNumber(pick?.riskRewardAfterCosts) ??
      toFiniteNumber(pick?.riskReward) ??
      0
    rrSum += Math.max(0, Math.min(5, rr))
  }
  const avgRR = rrSum / safePicks.length
  const breadthBonus = Math.min(safePicks.length, 20) * 0.1
  return round2(avgRR + breadthBonus)
}

function snapshotQuality(snapshot) {
  const explicit = toFiniteNumber(snapshot?.qualityScore)
  if (explicit != null) return explicit
  return snapshotQualityFromPicks(snapshot?.picks || [])
}

function pickBestSnapshotForDate(snapshots) {
  if (!Array.isArray(snapshots) || !snapshots.length) return null
  return snapshots
    .slice()
    .sort((a, b) => {
      const scoreDiff = snapshotQuality(b) - snapshotQuality(a)
      if (scoreDiff !== 0) return scoreDiff
      return String(b?.createdAt || '').localeCompare(String(a?.createdAt || ''))
    })[0] || null
}

function collapseToBestByDate(snapshots) {
  const byDate = new Map()
  for (const snapshot of Array.isArray(snapshots) ? snapshots : []) {
    const key = String(snapshot?.istDate || '')
    if (!key) continue
    const current = byDate.get(key)
    if (!current) {
      byDate.set(key, snapshot)
      continue
    }
    byDate.set(key, pickBestSnapshotForDate([current, snapshot]))
  }
  return Array.from(byDate.values()).sort(
    (a, b) => String(b?.createdAt || '').localeCompare(String(a?.createdAt || ''))
  )
}

async function persistSignalSnapshotFile(snapshot) {
  const history = await readSignalHistory()
  const sameDate = history.snapshots.filter(s => s?.istDate === snapshot.istDate)
  const bestExisting = pickBestSnapshotForDate(sameDate)
  if (bestExisting && snapshotQuality(bestExisting) >= snapshotQuality(snapshot)) {
    return bestExisting
  }

  history.snapshots = history.snapshots.filter(s => s?.istDate !== snapshot.istDate)
  history.snapshots.push(snapshot)
  history.snapshots = collapseToBestByDate(history.snapshots)
  if (history.snapshots.length > SIGNAL_HISTORY_LIMIT) {
    history.snapshots = history.snapshots.slice(-SIGNAL_HISTORY_LIMIT)
  }
  await writeJson(SIGNAL_HISTORY_FILE, history)
  return snapshot
}

async function persistBacktestRunFile(run) {
  const history = await readBacktestHistory()
  history.runs.push(run)
  if (history.runs.length > BACKTEST_HISTORY_LIMIT) {
    history.runs = history.runs.slice(-BACKTEST_HISTORY_LIMIT)
  }
  await writeJson(BACKTEST_HISTORY_FILE, history)
}

function comparableRunPayload(run) {
  return JSON.stringify({
    tradeDate: run?.tradeDate || '',
    capital: Number(run?.capital) || 0,
    allocationMode: run?.allocationMode || '',
    snapshotId: run?.snapshotId || '',
    summary: run?.summary || {},
    trades: Array.isArray(run?.trades) ? run.trades : []
  })
}

function isSameBacktestOutcome(a, b) {
  if (!a || !b) return false
  return comparableRunPayload(a) === comparableRunPayload(b)
}

function backtestDedupFilter(run) {
  return {
    tradeDate: run.tradeDate,
    capital: Number(run.capital) || 0,
    allocationMode: run.allocationMode,
    snapshotId: run.snapshotId
  }
}

async function latestComparableRunFile(run) {
  const history = await readBacktestHistory()
  return history.runs
    .filter(r =>
      r?.tradeDate === run.tradeDate &&
      Number(r?.capital) === Number(run.capital) &&
      r?.allocationMode === run.allocationMode &&
      r?.snapshotId === run.snapshotId
    )
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0] || null
}

async function persistBacktestRunWithDedup(run) {
  if (isMongoConnected()) {
    try {
      const latestDoc = await IntradayBacktestRun.findOne(backtestDedupFilter(run))
        .sort({ createdAt: -1 })
        .lean()
      const latest = mapBacktestRunDocument(latestDoc)
      if (latest && isSameBacktestOutcome(run, latest)) {
        return {
          saved: false,
          storage: 'mongo',
          existingRunId: latest.id || null
        }
      }

      await IntradayBacktestRun.create({
        ...run,
        createdAt: new Date(run.createdAt),
        snapshotCreatedAt: new Date(run.snapshotCreatedAt)
      })
      return {
        saved: true,
        storage: 'mongo',
        existingRunId: null
      }
    } catch (error) {
      console.error('Failed to save intraday backtest run to MongoDB, falling back to file:', error?.message || error)
    }
  }

  const latest = await latestComparableRunFile(run)
  if (latest && isSameBacktestOutcome(run, latest)) {
    return {
      saved: false,
      storage: 'file',
      existingRunId: latest.id || null
    }
  }

  await persistBacktestRunFile(run)
  return {
    saved: true,
    storage: 'file',
    existingRunId: null
  }
}

export async function saveIntradaySignalSnapshot({
  positiveStocks,
  totalScanned,
  positiveCount,
  meta,
  rawPayload = null
}) {
  const picks = sanitizePicks(positiveStocks)
  const snapshotMeta = meta || {}
  const now = new Date()
  const createdAt = now.toISOString()
  const ist = parseISTForDate(now)
  const snapshot = {
    id: `intraday-signal-${Date.now()}`,
    createdAt,
    istDate: snapshotMeta?.marketState?.istDate || ist.date,
    istTime: snapshotMeta?.marketState?.istTime || ist.time,
    totalScanned: Number(totalScanned) || 0,
    positiveCount: Number(positiveCount) || picks.length,
    qualityScore: snapshotQualityFromPicks(picks),
    picks,
    meta: snapshotMeta,
    rawPayload
  }

  if (isMongoConnected()) {
    try {
      const existingDocs = await IntradaySignalSnapshot.find({ istDate: snapshot.istDate }).lean()
      const existingBest = pickBestSnapshotForDate(existingDocs.map(mapSnapshotDocument).filter(Boolean))
      if (existingBest && snapshotQuality(existingBest) >= snapshotQuality(snapshot)) {
        return existingBest
      }

      if (existingDocs.length) {
        await IntradaySignalSnapshot.deleteMany({ istDate: snapshot.istDate })
      }
      await IntradaySignalSnapshot.create({
        ...snapshot,
        createdAt: new Date(snapshot.createdAt)
      })
      return snapshot
    } catch (error) {
      console.error('Failed to save intraday snapshot to MongoDB, falling back to file:', error?.message || error)
    }
  }

  return persistSignalSnapshotFile(snapshot)
}

export async function listIntradaySignalSnapshots({ date, limit = 50 } = {}) {
  const normalizedDate = date ? sanitizeDateInput(date) : null
  const normalizedLimit = normalizeLimit(limit, 50)

  if (isMongoConnected()) {
    try {
      const query = normalizedDate ? { istDate: normalizedDate } : {}
      const docs = await IntradaySignalSnapshot.find(query)
        .sort({ createdAt: -1, qualityScore: -1 })
        .limit(normalizedLimit)
        .lean()
      const mapped = docs.map(mapSnapshotDocument).filter(Boolean)
      const collapsed = collapseToBestByDate(mapped)
      if (normalizedDate) return collapsed.slice(0, 1)
      return collapsed.slice(0, normalizedLimit)
    } catch (error) {
      console.error('Failed to fetch intraday snapshots from MongoDB, falling back to file:', error?.message || error)
    }
  }

  const history = await readSignalHistory()
  let snapshots = history.snapshots
  if (normalizedDate) snapshots = snapshots.filter(s => s?.istDate === normalizedDate)
  const collapsed = collapseToBestByDate(snapshots)
  if (normalizedDate) return collapsed.slice(0, 1)
  return collapsed
    .slice()
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, normalizedLimit)
}

export async function listIntradayBacktestRuns({ date, limit = 30 } = {}) {
  const normalizedDate = date ? sanitizeDateInput(date) : null
  const normalizedLimit = normalizeLimit(limit, 30)

  if (isMongoConnected()) {
    try {
      const query = normalizedDate ? { tradeDate: normalizedDate } : {}
      const docs = await IntradayBacktestRun.find(query)
        .sort({ createdAt: -1 })
        .limit(normalizedLimit)
        .lean()
      return docs.map(mapBacktestRunDocument).filter(Boolean)
    } catch (error) {
      console.error('Failed to fetch intraday backtest runs from MongoDB, falling back to file:', error?.message || error)
    }
  }

  const history = await readBacktestHistory()
  let runs = history.runs
  if (normalizedDate) runs = runs.filter(r => r?.tradeDate === normalizedDate)
  return runs
    .slice()
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, normalizedLimit)
}

export async function runIntradayBacktest({
  date,
  capital,
  allocationMode,
  snapshotMode,
  snapshotId,
  requireExactSnapshot = false
}) {
  const tradeDate = sanitizeDateInput(date)
  const parsedCapital = sanitizeCapitalInput(capital)
  const normalizedAllocationMode = normalizeAllocationMode(allocationMode)
  const normalizedSnapshotMode = normalizeSnapshotMode(snapshotMode)
  const costBps = DEFAULT_INTRADAY_ROUND_TRIP_COST_BPS

  const snapshots = await listIntradaySignalSnapshots({ date: tradeDate, limit: 500 })
  if (!snapshots.length) {
    throw new Error(`No intraday signal snapshots found for ${tradeDate}`)
  }

  const sourceSnapshots = requireExactSnapshot
    ? snapshots.filter(s => evaluateSnapshotExactness(s, tradeDate).exact)
    : snapshots
  if (!sourceSnapshots.length) {
    const candidate = snapshots[0]
    const details = evaluateSnapshotExactness(candidate, tradeDate)
    const reasonText = details.reasons.map(humanizeExactnessReason).join('; ')
    throw new Error(
      `No exact intraday snapshot for ${tradeDate}. ` +
      `Closest snapshot: ${details.snapshotIstDate || 'unknown'} ${details.snapshotIstTime || 'unknown'}. ` +
      `Issues: ${reasonText}`
    )
  }

  let snapshot = null
  if (snapshotId) {
    snapshot = sourceSnapshots.find(s => s.id === snapshotId) || null
    if (!snapshot) throw new Error(`Snapshot not found: ${snapshotId}`)
  } else if (normalizedSnapshotMode === 'earliest') {
    snapshot = sourceSnapshots[sourceSnapshots.length - 1]
  } else {
    snapshot = sourceSnapshots[0]
  }

  const snapshotValidation = evaluateSnapshotExactness(snapshot, tradeDate)
  if (requireExactSnapshot && !snapshotValidation.exact) {
    throw new Error(
      `No exact intraday snapshot for ${tradeDate}. ` +
      `Found ${snapshotValidation.snapshotIstDate} ${snapshotValidation.snapshotIstTime}. ` +
      `Reasons: ${snapshotValidation.reasons.join(', ')}`
    )
  }

  const picks = sanitizePicks(snapshot?.picks || [])
  if (!picks.length) {
    throw new Error(`No valid picks in snapshot ${snapshot.id}`)
  }

  const perPickCapital =
    normalizedAllocationMode === 'split_across_picks'
      ? parsedCapital / picks.length
      : parsedCapital
  const signalStartMinute = parseISTTimeToMinutes(snapshot.istTime)

  const trades = []
  for (const pick of picks) {
    try {
      const trade = await backtestSinglePick({
        pick,
        tradeDate,
        capitalPerPick: perPickCapital,
        signalStartMinute,
        costBps
      })
      trades.push(trade)
    } catch (error) {
      trades.push({
        symbol: pick.symbol,
        resolvedSymbol: pick.resolvedSymbol || pick.symbol,
        companyName: pick.companyName,
        entryType: pick.entryType,
        entryReason: pick.entryReason,
        entryPrice: pick.entryPrice,
        stopLoss: pick.stopLoss,
        target1: pick.target1,
        target2: pick.target2,
        capitalConfigured: round2(perPickCapital),
        status: 'error',
        outcome: 'no_trade',
        reason: error?.message || 'backtest_failed',
        quantity: 0,
        investedAmount: 0,
        grossPnl: 0,
        netPnl: 0,
        roundTripCost: 0
      })
    }
  }

  const summary = buildSummary({
    trades,
    capital: parsedCapital,
    allocationMode: normalizedAllocationMode,
    costBps
  })

  const run = {
    id: `intraday-backtest-${Date.now()}`,
    createdAt: new Date().toISOString(),
    tradeDate,
    capital: round2(parsedCapital),
    allocationMode: normalizedAllocationMode,
    snapshotMode: normalizedSnapshotMode,
    snapshotId: snapshot.id,
    snapshotCreatedAt: snapshot.createdAt,
    snapshotValidation,
    summary,
    trades
  }

  const persistResult = await persistBacktestRunWithDedup(run)
  return {
    ...run,
    id: persistResult.saved ? run.id : (persistResult.existingRunId || run.id),
    persisted: persistResult.saved,
    duplicateOfRunId: persistResult.saved ? null : persistResult.existingRunId,
    storage: persistResult.storage
  }
}
