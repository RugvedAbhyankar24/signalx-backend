const DEFAULT_INTERVAL_MIN = 10

function parseBool(value, fallback = false) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase()
    if (v === 'true') return true
    if (v === 'false') return false
  }
  return fallback
}

function parseIntervalMinutes(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_INTERVAL_MIN
  return Math.max(1, Math.min(120, Math.round(n)))
}

async function triggerIntradayScanStart(port, forceRunWhenClosed) {
  const baseUrl = `http://127.0.0.1:${port}`
  const response = await fetch(`${baseUrl}/api/intraday/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ forceRunWhenClosed })
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`Auto uploader start failed (${response.status}): ${text}`)
  }

  const payload = await response.json().catch(() => ({}))
  return payload
}

export function startIntradayAutoUploader({ port }) {
  const enabled = parseBool(process.env.INTRADAY_AUTO_UPLOAD_ENABLED, false)
  if (!enabled) return null

  const forceRunWhenClosed = parseBool(process.env.INTRADAY_AUTO_UPLOAD_FORCE_WHEN_CLOSED, false)
  const runOnBoot = parseBool(process.env.INTRADAY_AUTO_UPLOAD_RUN_ON_BOOT, true)
  const intervalMin = parseIntervalMinutes(process.env.INTRADAY_AUTO_UPLOAD_INTERVAL_MIN)
  const intervalMs = intervalMin * 60 * 1000

  let running = false
  const tick = async () => {
    if (running) return
    running = true
    try {
      const result = await triggerIntradayScanStart(port, forceRunWhenClosed)
      const status = result?.status || 'unknown'
      const reason = result?.marketState?.reason ? ` (${result.marketState.reason})` : ''
      console.log(`[intraday-auto-uploader] tick status=${status}${reason}`)
    } catch (error) {
      console.error('[intraday-auto-uploader] tick failed:', error?.message || error)
    } finally {
      running = false
    }
  }

  if (runOnBoot) {
    setTimeout(() => { void tick() }, 1000)
  }
  const timer = setInterval(() => { void tick() }, intervalMs)

  console.log(`[intraday-auto-uploader] enabled interval=${intervalMin}m runOnBoot=${runOnBoot} forceWhenClosed=${forceRunWhenClosed}`)
  return () => clearInterval(timer)
}

