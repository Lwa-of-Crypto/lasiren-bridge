// fees.js — EIP-1559 fee builder. Combines a marketPriority baseline (from
// GEDE2) with urgency, caps, and a Flashbots-aware path for large swaps.
//
// Output shape:
//   {
//     gasLimit:               bigint   // estimated × (1 + safety buffer)
//     maxPriorityFeePerGas:   bigint
//     maxFeePerGas:           bigint
//     baseFeePerGas:          bigint   // from the latest block
//     method:                'rpc' | 'flashbots'
//   }

'use strict'

const { ethers } = require('ethers')

/**
 * @param {ethers.JsonRpcProvider} provider
 * @param {bigint} estimatedGasLimit
 * @param {object} opts
 * @param {number} [opts.urgency=0.5]                 0.0 = chill, 1.0 = top-of-block
 * @param {number} [opts.priorityFeeCapGwei=50]
 * @param {number} [opts.maxFeeMultiplier=3]          maxFee ≤ multiplier × baseFee
 * @param {number} [opts.safetyBufferPercent=20]      gasLimit buffer
 * @param {boolean}[opts.useFlashbots=false]
 * @param {bigint} [opts.marketPriorityOverride]      Preferred baseline (GEDE2)
 */
async function computeFeesForSwap(provider, estimatedGasLimit, opts = {}) {
  const {
    urgency = 0.5,
    priorityFeeCapGwei = 50,
    maxFeeMultiplier = 3,
    safetyBufferPercent = 20,
    useFlashbots = false,
    marketPriorityOverride,
  } = opts

  const feeData = await provider.getFeeData()
  const block = await provider.getBlock('latest')
  const baseFeePerGas = block?.baseFeePerGas
    ?? feeData.lastBaseFeePerGas
    ?? 0n

  let marketPriority = (typeof marketPriorityOverride === 'bigint')
    ? marketPriorityOverride
    : (feeData.maxPriorityFeePerGas ?? ethers.parseUnits('2', 'gwei'))

  const priorityCap = ethers.parseUnits(String(priorityFeeCapGwei), 'gwei')
  if (marketPriority > priorityCap) marketPriority = priorityCap

  // Scale toward the cap by urgency (clamped 0..1)
  const u = Math.max(0, Math.min(1, Number(urgency)))
  const headroomToCap = priorityCap > marketPriority ? priorityCap - marketPriority : 0n
  const scaledHeadroom = (headroomToCap * BigInt(Math.floor(u * 1000))) / 1000n
  const targetPriority = marketPriority + scaledHeadroom

  // baseFeeScaled bounds maxFeePerGas
  const baseScaleFloat = 1 + (maxFeeMultiplier - 1) * u
  const baseScale = BigInt(Math.floor(baseScaleFloat * 100))
  const baseScaled = (baseFeePerGas * baseScale) / 100n

  // 5% extra headroom for late-block volatility
  const extra = (targetPriority * 5n) / 100n
  let maxFeePerGas = baseScaled + targetPriority + extra

  const gasLimit = (estimatedGasLimit * (100n + BigInt(safetyBufferPercent))) / 100n

  let method = 'rpc'
  let finalPriority = targetPriority
  if (useFlashbots) {
    method = 'flashbots'
    // Flashbots: base bid is paid via the bundle; tip can be near-zero.
    const lowPriority = ethers.parseUnits('1', 'gwei')
    finalPriority = lowPriority < targetPriority ? lowPriority : targetPriority
    // Sanity floor: maxFee ≥ 110% × baseFee + finalPriority
    const minMaxFee = (baseFeePerGas * 110n) / 100n + finalPriority
    if (maxFeePerGas < minMaxFee) maxFeePerGas = minMaxFee
  }

  return { gasLimit, maxPriorityFeePerGas: finalPriority, maxFeePerGas, baseFeePerGas, method }
}

module.exports = { computeFeesForSwap }
