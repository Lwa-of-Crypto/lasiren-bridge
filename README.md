// gede2.js — Mempool priority-fee sampler for Lasirèn.
//
// Calls eth_feeHistory and aggregates priority-fee percentiles across the last
// N blocks. Returns a smoothed "marketPriority" wei value that downstream
// fee-builders feed into EIP-1559 maxPriorityFeePerGas.
//
// Resilience:
//   1. Primary path — eth_feeHistory percentiles (geth/erigon/Alchemy/Infura support).
//   2. Fallback A — provider.getFeeData() if feeHistory is unsupported.
//   3. Fallback B — static `fallbackPriorityGwei` constant (configurable).
//
// In-memory smoothing window prevents single-block outliers from blowing
// up tx fees. For multi-instance bridges, swap the global window for a
// shared store (Redis recommended).

'use strict'

const { ethers } = require('ethers')

const GLOBAL_WINDOW = '__lasiren_gede2_window__'
if (!global[GLOBAL_WINDOW]) global[GLOBAL_WINDOW] = []

/**
 * Sample mempool priority-fee percentiles.
 *
 * @param {ethers.JsonRpcProvider} provider
 * @param {object} opts
 * @param {number} [opts.blocks=12]                 Look-back blocks.
 * @param {number[]} [opts.percentiles=[10,25,50,75,90]]
 * @param {number} [opts.percentileTarget=50]       Which percentile to surface.
 * @param {number} [opts.baseMultiplier=1.0]        Multiplier applied to result.
 * @param {number} [opts.smoothingWindow=3]         In-mem window length.
 * @param {number} [opts.fallbackPriorityGwei=2]    Hard fallback constant.
 * @param {number} [opts.maxPriorityCapGwei=100]    Hard cap to never exceed.
 * @returns {Promise<{marketPriority: bigint, samples: object, baseFeePerGas: bigint, source: string}>}
 */
async function gede2Sample(provider, opts = {}) {
  const {
    blocks = 12,
    percentiles = [10, 25, 50, 75, 90],
    percentileTarget = 50,
    baseMultiplier = 1.0,
    smoothingWindow = 3,
    fallbackPriorityGwei = 2,
    maxPriorityCapGwei = 100,
  } = opts

  if (!provider || typeof provider.send !== 'function') {
    throw new Error('gede2: provider with .send() required')
  }

  const cap = ethers.parseUnits(String(maxPriorityCapGwei), 'gwei')

  let result
  try {
    // ── Path 1: eth_feeHistory ────────────────────────────────────────
    const blocksHex = '0x' + blocks.toString(16)
    const res = await provider.send('eth_feeHistory', [blocksHex, 'latest', percentiles])
    if (!res || !Array.isArray(res.reward) || !Array.isArray(res.baseFeePerGas)) {
      throw new Error('eth_feeHistory unexpected shape')
    }
    const sums = new Array(percentiles.length).fill(0n)
    let count = 0
    for (const blockRewards of res.reward) {
      if (!Array.isArray(blockRewards)) continue
      for (let j = 0; j < blockRewards.length; j++) {
        sums[j] += BigInt(blockRewards[j] || 0)
      }
      count++
    }
    const samples = {}
    for (let j = 0; j < percentiles.length; j++) {
      samples[percentiles[j]] = count > 0 ? sums[j] / BigInt(count) : 0n
    }
    const nearest = percentiles.includes(percentileTarget)
      ? percentileTarget
      : percentiles.reduce((a, b) =>
          Math.abs(b - percentileTarget) < Math.abs(a - percentileTarget) ? b : a,
          percentiles[0])
    let marketPriority = samples[nearest] || 0n
    if (baseMultiplier !== 1.0) {
      const scale = BigInt(Math.floor(baseMultiplier * 1000))
      marketPriority = (marketPriority * scale) / 1000n
    }
    if (marketPriority > cap) marketPriority = cap
    const baseFeePerGas = BigInt(res.baseFeePerGas[res.baseFeePerGas.length - 1] || 0)
    result = { marketPriority, samples, baseFeePerGas, source: 'feeHistory' }
  } catch (err1) {
    // ── Path 2: getFeeData() ──────────────────────────────────────────
    try {
      const feeData = await provider.getFeeData()
      let priority = feeData.maxPriorityFeePerGas
        || ethers.parseUnits(String(fallbackPriorityGwei), 'gwei')
      if (baseMultiplier !== 1.0) {
        const scale = BigInt(Math.floor(baseMultiplier * 1000))
        priority = (priority * scale) / 1000n
      }
      if (priority > cap) priority = cap
      const block = await provider.getBlock('latest')
      const baseFeePerGas = block?.baseFeePerGas ?? 0n
      result = { marketPriority: priority, samples: {}, baseFeePerGas, source: 'getFeeData' }
    } catch (_err2) {
      // ── Path 3: hard fallback ─────────────────────────────────────
      const priority = ethers.parseUnits(String(fallbackPriorityGwei), 'gwei')
      result = { marketPriority: priority, samples: {}, baseFeePerGas: 0n, source: 'static-fallback' }
    }
  }

  // ── Smoothing window (mean of last N samples) ──────────────────────
  const win = global[GLOBAL_WINDOW]
  win.push(result.marketPriority)
  while (win.length > smoothingWindow) win.shift()
  const sumAll = win.reduce((a, v) => a + v, 0n)
  result.smoothed = sumAll / BigInt(win.length)
  return result
}

// CLI self-probe: `node src/gede2.js --probe`
if (require.main === module && process.argv.includes('--probe')) {
  ;(async () => {
    const url = process.env.RPC_URL || 'https://cloudflare-eth.com'
    const provider = new ethers.JsonRpcProvider(url)
    const r = await gede2Sample(provider, {})
    console.log(JSON.stringify({
      source: r.source,
      marketPriorityGwei: ethers.formatUnits(r.marketPriority, 'gwei'),
      smoothedGwei: ethers.formatUnits(r.smoothed, 'gwei'),
      baseFeeGwei: ethers.formatUnits(r.baseFeePerGas, 'gwei'),
    }, null, 2))
  })().catch(e => { console.error(e); process.exit(1) })
}

module.exports = { gede2Sample }
