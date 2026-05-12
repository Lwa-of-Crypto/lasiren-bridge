// bridge.js — Lasirèn's HTTPS bridge to Uniswap V3.
//
// Endpoints:
//   GET  /status                     →  health + signer pubkey
//   POST /analyze   {tokenIn, tokenOut, fee, amountIn}
//                                    →  quoter estimate + chain context
//   POST /signal    {tokenIn, tokenOut, fee, amountIn, maxSlippageBps,
//                    urgency, useFlashbots, id}
//                                    →  simulate → fee-build → send → receipt
//   GET  /audit                      →  last 100 audit entries
//
// Safety layers:
//   • Idempotent signal IDs (in-mem 24-hour map)
//   • async-lock per signer to serialize nonces
//   • PAPER_MODE never broadcasts a tx
//   • MAX_TRADE_USD via TWAP oracle (placeholder — wire Chainlink in prod)
//   • computeFeesForSwap + GEDE2 sampling on every signal
//   • All inbound requests pass through `requireAuth()`. In production,
//     terminate mTLS at a reverse proxy and validate JWT/HMAC here.

'use strict'

require('dotenv').config()
const express = require('express')
const pino = require('pino')()
const pinoHttp = require('pino-http')
const AsyncLock = require('async-lock')
const { ethers } = require('ethers')
const crypto = require('crypto')

const { gede2Sample } = require('./gede2')
const { computeFeesForSwap } = require('./fees')

// ═════ ENV ════════════════════════════════════════════════════════
const {
  RPC_URL = 'https://cloudflare-eth.com',
  QUOTER_ADDRESS = '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',  // mainnet QuoterV2
  ROUTER_ADDRESS = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',  // SwapRouter02 mainnet
  PORT = 3000,
  PAPER_MODE = 'true',
  MAX_SLIPPAGE_BPS = '50',
  MAX_TRADE_USD = '50000',
  KMS_SIGNER = 'false',
  LOCAL_PRIVATE_KEY,
  HMAC_SECRET,                            // shared with Claude/strategy
  MAX_PRIORITY_GWEI = '100',
  USE_FLASHBOOTS_DEFAULT = 'false',
} = process.env

// ═════ Provider + signer ══════════════════════════════════════════
const provider = new ethers.JsonRpcProvider(RPC_URL)
let signer
if (KMS_SIGNER === 'true') {
  // TODO: wire your KMS / HSM signer here.
  throw new Error('KMS signer not wired — implement remoteSign() before going live')
}
if (!LOCAL_PRIVATE_KEY) throw new Error('LOCAL_PRIVATE_KEY env var required for non-KMS mode')
signer = new ethers.Wallet(LOCAL_PRIVATE_KEY, provider)

// ═════ ABIs (minimal) ═════════════════════════════════════════════
const QuoterV2_ABI = [
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)',
]
const SwapRouter02_ABI = [
  'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)',
]
const quoter = new ethers.Contract(QUOTER_ADDRESS, QuoterV2_ABI, provider)
const routerIface = new ethers.Interface(SwapRouter02_ABI)

// ═════ State ══════════════════════════════════════════════════════
const lock = new AsyncLock({ timeout: 30_000 })
const audit = []
function logAudit(entry) {
  audit.push({ ts: Date.now(), ...entry })
  if (audit.length > 1000) audit.splice(0, audit.length - 1000)
}

// Idempotency cache (signal.id → first-result), 24-hour TTL.
const idempotency = new Map()
function rememberSignal(id, result) {
  idempotency.set(id, { result, ts: Date.now() })
}
function recallSignal(id) {
  const v = idempotency.get(id)
  if (!v) return null
  if (Date.now() - v.ts > 24 * 3600_000) { idempotency.delete(id); return null }
  return v.result
}

// ═════ Auth ═══════════════════════════════════════════════════════
function requireAuth(req, res, next) {
  if (!HMAC_SECRET) return next() // dev mode — skip
  const sig = req.headers['x-lasiren-sig']
  const ts = req.headers['x-lasiren-ts']
  if (!sig || !ts) return res.status(401).json({ error: 'missing signature headers' })
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 30) {
    return res.status(401).json({ error: 'stale signature' })
  }
  const body = JSON.stringify(req.body || {})
  const expected = crypto.createHmac('sha256', HMAC_SECRET)
    .update(`${ts}.${req.method}.${req.path}.${body}`)
    .digest('hex')
  if (!crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))) {
    return res.status(401).json({ error: 'bad signature' })
  }
  next()
}

// ═════ Express ════════════════════════════════════════════════════
const app = express()
app.use(express.json({ limit: '256kb' }))
app.use(pinoHttp({ logger: pino }))

app.get('/status', (_req, res) => {
  res.json({
    ok: true,
    name: 'lasiren-bridge',
    paperMode: PAPER_MODE === 'true',
    address: signer.address,
    chainId: provider._network?.chainId?.toString?.() || null,
  })
})

// /analyze — read-only quote
app.post('/analyze', requireAuth, async (req, res) => {
  try {
    const { tokenIn, tokenOut, fee = 3000, amountIn } = req.body || {}
    if (!tokenIn || !tokenOut || !amountIn) {
      return res.status(400).json({ error: 'missing tokenIn / tokenOut / amountIn' })
    }
    const result = await quoter.quoteExactInputSingle.staticCall({
      tokenIn, tokenOut, amountIn: BigInt(amountIn), fee, sqrtPriceLimitX96: 0n,
    })
    const block = await provider.getBlock('latest')
    res.json({
      tokenIn, tokenOut, fee,
      amountIn: amountIn.toString(),
      amountOut: result[0].toString(),
      gasEstimateQuote: result[3].toString(),
      blockNumber: block.number,
      blockTimestamp: block.timestamp,
    })
  } catch (err) {
    pino.error(err)
    res.status(500).json({ error: err.message })
  }
})

// /signal — simulate → fee-build → send → receipt
app.post('/signal', requireAuth, async (req, res) => {
  const intent = req.body || {}
  if (!intent.tokenIn || !intent.tokenOut || !intent.amountIn) {
    return res.status(400).json({ error: 'invalid intent' })
  }
  // Idempotency: same id within 24h returns cached result
  if (intent.id) {
    const cached = recallSignal(intent.id)
    if (cached) return res.json({ replayed: true, ...cached })
  }
  // Trade-size guard (replace with USD oracle in prod)
  if (BigInt(intent.amountIn) > ethers.parseUnits('1000000', 18)) {
    return res.status(400).json({ error: 'amountIn exceeds hard cap' })
  }

  const logEntry = { intent, status: 'received' }
  logAudit(logEntry)

  await lock.acquire('tx', async () => {
    try {
      // 1. Re-quote at execution time
      const quote = await quoter.quoteExactInputSingle.staticCall({
        tokenIn: intent.tokenIn, tokenOut: intent.tokenOut,
        amountIn: BigInt(intent.amountIn),
        fee: intent.fee || 3000, sqrtPriceLimitX96: 0n,
      })
      const amountOut = quote[0]
      const slipBps = BigInt(intent.maxSlippageBps || MAX_SLIPPAGE_BPS)
      const minAmountOut = (amountOut * (10000n - slipBps)) / 10000n

      // 2. Build calldata
      const params = {
        tokenIn: intent.tokenIn,
        tokenOut: intent.tokenOut,
        fee: intent.fee || 3000,
        recipient: signer.address,
        amountIn: BigInt(intent.amountIn),
        amountOutMinimum: minAmountOut,
        sqrtPriceLimitX96: 0n,
      }
      const calldata = routerIface.encodeFunctionData('exactInputSingle', [params])

      // 3. Estimate gas + GEDE2 sample
      const txCallShape = { to: ROUTER_ADDRESS, data: calldata, from: signer.address, value: 0n }
      const gasEstimate = await provider.estimateGas(txCallShape)
      const gede = await gede2Sample(provider, { blocks: 12, percentileTarget: 50 })

      // 4. Build EIP-1559 fee params
      const feeObj = await computeFeesForSwap(provider, gasEstimate, {
        urgency: intent.urgency ?? 0.6,
        useFlashbots: intent.useFlashbots ?? (USE_FLASHBOOTS_DEFAULT === 'true'),
        marketPriorityOverride: gede.smoothed,
        priorityFeeCapGwei: Number(MAX_PRIORITY_GWEI),
      })

      // 5. Simulate via eth_call (will revert on bad path)
      await provider.call({ to: ROUTER_ADDRESS, data: calldata, from: signer.address })

      // 6. PAPER MODE — no broadcast
      if (PAPER_MODE === 'true') {
        const out = {
          ok: true, mode: 'paper',
          simulation: {
            quoteAmountOut: amountOut.toString(),
            minAmountOut: minAmountOut.toString(),
            gasEstimate: gasEstimate.toString(),
            feeObj: {
              gasLimit: feeObj.gasLimit.toString(),
              maxFeePerGasGwei: ethers.formatUnits(feeObj.maxFeePerGas, 'gwei'),
              maxPriorityFeePerGasGwei: ethers.formatUnits(feeObj.maxPriorityFeePerGas, 'gwei'),
              baseFeePerGasGwei: ethers.formatUnits(feeObj.baseFeePerGas, 'gwei'),
              method: feeObj.method,
            },
            gede: {
              source: gede.source,
              smoothedPriorityGwei: ethers.formatUnits(gede.smoothed, 'gwei'),
            },
          },
        }
        logEntry.status = 'simulated'
        logEntry.simulation = out.simulation
        if (intent.id) rememberSignal(intent.id, out)
        return res.json(out)
      }

      // 7. LIVE — sign + broadcast
      const txReq = {
        to: ROUTER_ADDRESS,
        data: calldata,
        value: 0n,
        gasLimit: feeObj.gasLimit,
        maxFeePerGas: feeObj.maxFeePerGas,
        maxPriorityFeePerGas: feeObj.maxPriorityFeePerGas,
        nonce: await provider.getTransactionCount(signer.address, 'latest'),
        type: 2,
      }
      const sent = await signer.sendTransaction(txReq)
      logEntry.status = 'submitted'
      logEntry.txHash = sent.hash
      const receipt = await sent.wait(1)
      logEntry.status = receipt?.status === 1 ? 'confirmed' : 'reverted'
      const out = {
        ok: receipt?.status === 1,
        mode: 'live',
        txHash: sent.hash,
        blockNumber: receipt?.blockNumber,
        gasUsed: receipt?.gasUsed?.toString(),
      }
      if (intent.id) rememberSignal(intent.id, out)
      res.json(out)
    } catch (err) {
      pino.error(err)
      logEntry.status = 'error'
      logEntry.reason = err.message
      res.status(500).json({ error: err.message })
    }
  })
})

app.get('/audit', requireAuth, (_req, res) => res.json(audit.slice(-100)))

const PORT_NUM = Number(PORT) || 3000
app.listen(PORT_NUM, () => pino.info(`Lasirèn bridge listening on :${PORT_NUM}`))

module.exports = { app }
