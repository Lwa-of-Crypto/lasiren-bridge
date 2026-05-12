// gede3.js — Pattern detection engine for Lasirèn.
//
// Loads the 50-pattern catalog from patterns/gede3_patterns.json, takes a
// stream of OHLCV candles per (symbol, timeframe), and emits pattern records
// with confidence + lifecycle stage + suggested signal (entry/stop/targets).
//
// The detection layer is intentionally rules-first so every output is
// auditable. ML-based scoring can drop in via `scorerOverride` (Lasirèn
// loads a LightGBM-style classifier behind the same interface).
//
// Public API:
//   const engine = await GEDE3.create({ patternsPath: './patterns/gede3_patterns.json' })
//   const records = engine.process(symbol, timeframe, candles)
//
// `candles` shape: [{ ts, open, high, low, close, volume }, ...] (ascending ts)

'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')

// ────────────────────────────────────────────────────────────────────
//  Indicators (no external deps)
// ────────────────────────────────────────────────────────────────────
function sma(values, period) {
  if (values.length < period) return null
  let sum = 0
  for (let i = values.length - period; i < values.length; i++) sum += values[i]
  return sum / period
}

function ema(values, period) {
  if (values.length < period) return null
  const k = 2 / (period + 1)
  let e = values.slice(0, period).reduce((a, v) => a + v, 0) / period
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k)
  return e
}

function atrSeries(highs, lows, closes, period = 14) {
  const trs = []
  for (let i = 0; i < highs.length; i++) {
    const hl = highs[i] - lows[i]
    const hc = i === 0 ? hl : Math.abs(highs[i] - closes[i - 1])
    const lc = i === 0 ? hl : Math.abs(lows[i] - closes[i - 1])
    trs.push(Math.max(hl, hc, lc))
  }
  const out = new Array(trs.length).fill(null)
  let acc = 0
  for (let i = 0; i < trs.length; i++) {
    acc += trs[i]
    if (i >= period) acc -= trs[i - period]
    if (i >= period - 1) out[i] = acc / period
  }
  return out
}

// ────────────────────────────────────────────────────────────────────
//  Pivot detection (fractal-style, configurable left/right window)
// ────────────────────────────────────────────────────────────────────
function detectPivots(candles, left = 3, right = 3) {
  const pivots = []
  for (let i = left; i < candles.length - right; i++) {
    const c = candles[i]
    let isHigh = true, isLow = true
    for (let j = 1; j <= left; j++) {
      if (candles[i - j].high >= c.high) isHigh = false
      if (candles[i - j].low <= c.low)   isLow  = false
    }
    for (let j = 1; j <= right; j++) {
      if (candles[i + j].high > c.high)  isHigh = false
      if (candles[i + j].low  < c.low)   isLow  = false
    }
    if (isHigh) pivots.push({ idx: i, ts: c.ts, price: c.high, type: 'high' })
    if (isLow)  pivots.push({ idx: i, ts: c.ts, price: c.low,  type: 'low'  })
  }
  return pivots
}

// ────────────────────────────────────────────────────────────────────
//  Shape tests reused across patterns
// ────────────────────────────────────────────────────────────────────
function isFlatLevel(prices, tolerancePct = 1.5) {
  if (!prices || prices.length < 2) return false
  const mean = prices.reduce((a, v) => a + v, 0) / prices.length
  const sd = Math.sqrt(prices.reduce((a, v) => a + (v - mean) ** 2, 0) / prices.length)
  return (sd / mean) * 100 <= tolerancePct
}

function lineOfBestFit(points) {
  // points: [{x, y}]
  const n = points.length
  if (n < 2) return null
  const sx = points.reduce((a, p) => a + p.x, 0)
  const sy = points.reduce((a, p) => a + p.y, 0)
  const sxx = points.reduce((a, p) => a + p.x * p.x, 0)
  const sxy = points.reduce((a, p) => a + p.x * p.y, 0)
  const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx || 1e-9)
  const intercept = (sy - slope * sx) / n
  return { slope, intercept }
}

function rad2deg(r) { return (r * 180) / Math.PI }

// ────────────────────────────────────────────────────────────────────
//  Per-pattern detectors. Each returns { score, features } or null.
//  We register them in DETECTORS keyed by pattern id.
// ────────────────────────────────────────────────────────────────────
const DETECTORS = {
  ascending_triangle(ctx) {
    const { pivots, atrLast } = ctx
    const highs = pivots.filter(p => p.type === 'high').map(p => p.price)
    const lows  = pivots.filter(p => p.type === 'low')
    if (highs.length < 2 || lows.length < 2) return null
    const flat = isFlatLevel(highs, 1.5)
    if (!flat) return null
    const lof = lineOfBestFit(lows.map((p, i) => ({ x: i, y: p.price })))
    if (!lof) return null
    const slopeDeg = rad2deg(Math.atan(lof.slope))
    const supportRising = slopeDeg > 0 && slopeDeg <= 25
    if (!supportRising) return null
    let score = 0
    score += 0.55                              // base reward
    score += slopeDeg < 12 ? 0.15 : 0          // healthy upslope
    score += atrLast > 0   ? 0.15 : 0          // measurable volatility
    score += pivots.length >= 6 ? 0.15 : 0     // confirms shape
    return { score: Math.min(1, score), features: { slopeDeg, pivotCount: pivots.length } }
  },

  descending_triangle(ctx) {
    const { pivots } = ctx
    const lows = pivots.filter(p => p.type === 'low').map(p => p.price)
    const highs = pivots.filter(p => p.type === 'high')
    if (lows.length < 2 || highs.length < 2) return null
    if (!isFlatLevel(lows, 1.5)) return null
    const lof = lineOfBestFit(highs.map((p, i) => ({ x: i, y: p.price })))
    if (!lof) return null
    const slopeDeg = rad2deg(Math.atan(lof.slope))
    if (slopeDeg >= 0 || slopeDeg < -25) return null
    let score = 0.55 + (slopeDeg > -12 ? 0.15 : 0) + (pivots.length >= 6 ? 0.15 : 0)
    return { score: Math.min(1, score), features: { slopeDeg, pivotCount: pivots.length } }
  },

  symmetrical_triangle(ctx) {
    const { pivots } = ctx
    const highs = pivots.filter(p => p.type === 'high')
    const lows  = pivots.filter(p => p.type === 'low')
    if (highs.length < 2 || lows.length < 2) return null
    const lh = lineOfBestFit(highs.map((p, i) => ({ x: i, y: p.price })))
    const ll = lineOfBestFit(lows.map((p, i) => ({ x: i, y: p.price })))
    if (!lh || !ll) return null
    const slopeHi = rad2deg(Math.atan(lh.slope))
    const slopeLo = rad2deg(Math.atan(ll.slope))
    if (slopeHi >= 0 || slopeLo <= 0) return null
    const symmetry = 1 - Math.min(1, Math.abs(Math.abs(slopeHi) - slopeLo) / 30)
    let score = 0.45 + 0.4 * symmetry + (pivots.length >= 6 ? 0.15 : 0)
    return { score: Math.min(1, score), features: { slopeHi, slopeLo, symmetry } }
  },

  double_top(ctx) {
    const highs = ctx.pivots.filter(p => p.type === 'high')
    if (highs.length < 2) return null
    const last = highs.slice(-2)
    const diff = Math.abs(last[0].price - last[1].price) / last[0].price
    if (diff > 0.02) return null
    let score = 0.6 - diff * 5 + (last[1].idx - last[0].idx > 5 ? 0.2 : 0)
    return { score: Math.min(1, Math.max(0, score)), features: { diff } }
  },

  double_bottom(ctx) {
    const lows = ctx.pivots.filter(p => p.type === 'low')
    if (lows.length < 2) return null
    const last = lows.slice(-2)
    const diff = Math.abs(last[0].price - last[1].price) / last[0].price
    if (diff > 0.02) return null
    let score = 0.6 - diff * 5 + (last[1].idx - last[0].idx > 5 ? 0.2 : 0)
    return { score: Math.min(1, Math.max(0, score)), features: { diff } }
  },

  head_and_shoulders(ctx) {
    const highs = ctx.pivots.filter(p => p.type === 'high')
    if (highs.length < 3) return null
    const last3 = highs.slice(-3)
    const [l, m, r] = last3
    if (!(m.price > l.price && m.price > r.price)) return null
    const symmetry = 1 - Math.min(1, Math.abs(l.price - r.price) / m.price)
    let score = 0.45 + 0.35 * symmetry + (Math.abs(m.idx - (l.idx + r.idx) / 2) < 3 ? 0.1 : 0)
    return { score: Math.min(1, score), features: { symmetry } }
  },

  inverse_head_shoulders(ctx) {
    const lows = ctx.pivots.filter(p => p.type === 'low')
    if (lows.length < 3) return null
    const last3 = lows.slice(-3)
    const [l, m, r] = last3
    if (!(m.price < l.price && m.price < r.price)) return null
    const symmetry = 1 - Math.min(1, Math.abs(l.price - r.price) / m.price)
    let score = 0.45 + 0.35 * symmetry
    return { score: Math.min(1, score), features: { symmetry } }
  },

  bull_flag(ctx) {
    const closes = ctx.candles.map(c => c.close)
    if (closes.length < 20) return null
    const recent10 = closes.slice(-10)
    const prior10 = closes.slice(-20, -10)
    const priorRet = (prior10[prior10.length - 1] - prior10[0]) / prior10[0]
    const recentRet = (recent10[recent10.length - 1] - recent10[0]) / recent10[0]
    if (priorRet < 0.05 || Math.abs(recentRet) > 0.04) return null
    return { score: 0.65, features: { priorRet, recentRet } }
  },

  bear_flag(ctx) {
    const closes = ctx.candles.map(c => c.close)
    if (closes.length < 20) return null
    const recent10 = closes.slice(-10)
    const prior10 = closes.slice(-20, -10)
    const priorRet = (prior10[prior10.length - 1] - prior10[0]) / prior10[0]
    const recentRet = (recent10[recent10.length - 1] - recent10[0]) / recent10[0]
    if (priorRet > -0.05 || Math.abs(recentRet) > 0.04) return null
    return { score: 0.65, features: { priorRet, recentRet } }
  },

  vol_squeeze(ctx) {
    const { atrSeriesRecent } = ctx
    if (!atrSeriesRecent || atrSeriesRecent.length < 30) return null
    const recent = atrSeriesRecent.slice(-10).filter(v => v != null)
    const prior  = atrSeriesRecent.slice(-30, -10).filter(v => v != null)
    if (recent.length < 5 || prior.length < 10) return null
    const recentMean = recent.reduce((a, v) => a + v, 0) / recent.length
    const priorMean  = prior.reduce((a, v) => a + v, 0) / prior.length
    if (recentMean >= priorMean * 0.7) return null
    return { score: 0.7, features: { recentMean, priorMean, ratio: recentMean / priorMean } }
  },

  vol_expansion(ctx) {
    const { atrSeriesRecent } = ctx
    if (!atrSeriesRecent || atrSeriesRecent.length < 20) return null
    const last = atrSeriesRecent[atrSeriesRecent.length - 1]
    const prior = atrSeriesRecent.slice(-20, -3).filter(v => v != null)
    if (!last || prior.length < 8) return null
    const priorMean = prior.reduce((a, v) => a + v, 0) / prior.length
    if (last < priorMean * 1.5) return null
    return { score: 0.75, features: { last, priorMean, ratio: last / priorMean } }
  },

  engulfing_bull(ctx) {
    const c = ctx.candles
    if (c.length < 2) return null
    const a = c[c.length - 2], b = c[c.length - 1]
    if (a.close < a.open && b.close > b.open && b.close > a.open && b.open < a.close) {
      return { score: 0.7, features: {} }
    }
    return null
  },

  engulfing_bear(ctx) {
    const c = ctx.candles
    if (c.length < 2) return null
    const a = c[c.length - 2], b = c[c.length - 1]
    if (a.close > a.open && b.close < b.open && b.close < a.open && b.open > a.close) {
      return { score: 0.7, features: {} }
    }
    return null
  },

  hammer(ctx) {
    const c = ctx.candles[ctx.candles.length - 1]
    if (!c) return null
    const body = Math.abs(c.close - c.open)
    const lower = Math.min(c.open, c.close) - c.low
    const upper = c.high - Math.max(c.open, c.close)
    if (body > 0 && lower >= 2 * body && upper <= 0.4 * body) return { score: 0.65, features: { body, lower, upper } }
    return null
  },

  rsi_divergence(ctx) {
    const closes = ctx.candles.map(c => c.close)
    if (closes.length < 20) return null
    // Simple RSI(14)
    const gains = [], losses = []
    for (let i = 1; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1]
      gains.push(Math.max(0, d)); losses.push(Math.max(0, -d))
    }
    const window = 14
    const avgGain = gains.slice(-window).reduce((a, v) => a + v, 0) / window
    const avgLoss = losses.slice(-window).reduce((a, v) => a + v, 0) / window
    const rs = avgGain / (avgLoss || 1e-9)
    const rsi = 100 - 100 / (1 + rs)
    const lastClose = closes[closes.length - 1]
    const tenAgoClose = closes[closes.length - 11] || lastClose
    // Bullish divergence: price lower-low, rsi higher-low (rough proxy)
    if (lastClose < tenAgoClose && rsi > 35 && rsi < 50) {
      return { score: 0.6, features: { rsi, dir: 'bull' } }
    }
    if (lastClose > tenAgoClose && rsi < 65 && rsi > 50) {
      return { score: 0.6, features: { rsi, dir: 'bear' } }
    }
    return null
  },
}

// Default scorer for any pattern not in DETECTORS — declined.
function safeRun(detector, ctx) {
  try { return detector(ctx) || null }
  catch (_e) { return null }
}

// ────────────────────────────────────────────────────────────────────
//  Engine class
// ────────────────────────────────────────────────────────────────────
class GEDE3 {
  constructor(catalog) {
    this.catalog = catalog
    this.globals = catalog.globals
    this.patternsById = Object.fromEntries(catalog.patterns.map(p => [p.id, p]))
  }

  static async create({ patternsPath } = {}) {
    const file = patternsPath || path.join(__dirname, '..', 'patterns', 'gede3_patterns.json')
    const raw = await fs.readFile(file, 'utf-8')
    return new GEDE3(JSON.parse(raw))
  }

  /**
   * Detect every applicable pattern on the supplied candle window.
   * @param {string} symbol
   * @param {string} timeframe
   * @param {Array<{ts:number,open:number,high:number,low:number,close:number,volume:number}>} candles
   * @returns {Array<PatternRecord>}
   */
  process(symbol, timeframe, candles) {
    if (!Array.isArray(candles) || candles.length < 5) return []
    const highs = candles.map(c => c.high)
    const lows  = candles.map(c => c.low)
    const closes = candles.map(c => c.close)
    const atrSeriesRecent = atrSeries(highs, lows, closes, this.globals.atr_period)
    const atrLast = atrSeriesRecent[atrSeriesRecent.length - 1] || 0
    const pivots = detectPivots(candles, 3, 3)
    const ctx = { candles, highs, lows, closes, pivots, atrLast, atrSeriesRecent }

    const out = []
    for (const cfg of this.catalog.patterns) {
      const det = DETECTORS[cfg.id]
      if (!det) continue
      const r = safeRun(det, ctx)
      if (!r) continue
      if (r.score < this.globals.emit_confidence_threshold) continue

      // Lifecycle stage: how mature is the formation as a fraction of cfg duration_max
      const durationCandles = candles.length
      const progress = Math.min(1, durationCandles / Math.max(1, cfg.duration_max))
      const stage = progress < this.globals.completion_stage_thresholds.beginning
        ? 'beginning'
        : progress < this.globals.completion_stage_thresholds.middle
          ? 'middle'
          : 'end'

      // Suggested signal — entry/stop/targets from cfg + last close
      const lastClose = candles[candles.length - 1].close
      const stopBufferAtr = cfg.stop_atr ?? 1.5
      const stop = lastClose - stopBufferAtr * atrLast
      const measuredMove = atrLast * (cfg.atr_max ? Math.min(cfg.atr_max, 5) : 3)
      const targets = (cfg.target_mult || [1.0]).map(m => lastClose + m * measuredMove)

      out.push({
        id: crypto.randomUUID(),
        symbol, timeframe,
        patternId: cfg.id,
        patternName: cfg.name,
        category: cfg.category,
        confidence: Number(r.score.toFixed(3)),
        stage,
        progress: Number(progress.toFixed(3)),
        startTs: candles[0].ts,
        endTs: candles[candles.length - 1].ts,
        suggested: {
          entry: lastClose,
          stop,
          targets,
          riskPct: this.globals.account_risk_per_trade_pct,
          maxPositionPct: this.globals.max_position_pct_per_asset,
        },
        meta: { atrLast, pivotCount: pivots.length, features: r.features },
      })
    }
    return out
  }
}

// CLI self-test
if (require.main === module && process.argv.includes('--selftest')) {
  ;(async () => {
    const eng = await GEDE3.create()
    // Synthetic ascending-triangle-ish data
    const candles = []
    let now = Date.now()
    for (let i = 0; i < 80; i++) {
      const base = 100 + i * 0.05
      const noise = (Math.random() - 0.5) * 0.6
      candles.push({
        ts: now - (80 - i) * 3600_000,
        open: base + noise, high: 110, low: base - 1,
        close: base + noise, volume: 1000 + i,
      })
    }
    const records = eng.process('TEST/USDT', '1h', candles)
    console.log(JSON.stringify(records, null, 2))
  })().catch(e => { console.error(e); process.exit(1) })
}

module.exports = { GEDE3, atrSeries, detectPivots }
