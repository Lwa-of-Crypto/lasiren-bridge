# Lasirèn Bridge

Master crypto trading agent for **Crypto Lwa** / **Brigitte's Swap**.

Lasirèn (Lwa of the deep waters) is the trading agent. Two helpers:
- **GEDE2** — mempool priority-fee sampler (EIP-1559 baseline).
- **GEDE3** — chart-pattern recognizer over 50 patterns × multi-timeframe.

This bridge is **not** a Cloudflare Pages Function. Trading is long-running
and stateful (open positions, nonces, P&L, websocket subscriptions) — it
runs as a separate Node.js service on a VPS / Render / Fly.io / your own box,
and Crypto Lwa's frontend talks to it via authenticated REST.

## Quick start (paper-mode)

```bash
cd lasiren-bridge
npm install
cp .env.example .env       # fill in RPC_URL + LOCAL_PRIVATE_KEY
npm start                  # PAPER_MODE=true by default — no broadcasts
```

The bridge listens on `:3000` and exposes:

| Method | Path | Purpose |
| ------ | ---- | ------- |
| GET | `/status` | Health + signer pubkey |
| POST | `/analyze` | QuoterV2 quote + chain context |
| POST | `/signal` | Simulate → fee-build → send → receipt |
| GET | `/audit` | Last 100 signed entries |

## Switching to live trading

Three things must be true before flipping `PAPER_MODE=false`:

1. **Key management** — replace `LOCAL_PRIVATE_KEY` with KMS / HSM / threshold
   signing. Never deploy a plaintext private key beyond a paper-mode demo.
2. **Risk limits** — set per-trade USD cap, daily loss cap, kill-switch hooks.
3. **HMAC auth** — set `HMAC_SECRET` so only signed Claude/strategy calls
   can hit `/signal` and `/analyze`. The bridge rejects unsigned writes.

## Strategy (codified)

Volatility-adjusted trend-following on a top-30 liquid-token basket:

- Universe: top 30 by 30-day volume; exclude low-liquidity tokens.
- Signal: 3-month cross-sectional momentum × 20/60 EMA trend filter.
- Entry: long top decile that passes trend filter.
- Sizing: vol-parity (`weight ∝ 1 / 30d_realized_vol`), capped 5% NAV.
- Rebalance: weekly signal, daily risk check, monthly equal-weight reset.
- Stops: 8–12% volatility-adjusted ATR per position; 15% portfolio drawdown
  triggers de-risking.
- Costs: 0.1% slippage + 0.1% fee modelled in backtests.

## Files

```
lasiren-bridge/
├── package.json
├── README.md
├── src/
│   ├── bridge.js          # Express server (the API surface)
│   ├── gede2.js           # eth_feeHistory percentile sampler
│   ├── gede3.js           # chart-pattern detection engine
│   └── fees.js            # EIP-1559 fee builder
└── patterns/
    └── gede3_patterns.json  # 50-pattern catalog
```

## CLI helpers

```bash
node src/gede2.js --probe       # probe current mempool priority fees
node src/gede3.js --selftest    # run pattern detection on synthetic data
```

## Production checklist (high → low priority)

1. **KMS / HSM signer** (no plaintext keys)
2. **HMAC + mTLS auth** on every endpoint
3. **Hardhat/Tenderly fork tests** for every new strategy before merge
4. **TWAP / Chainlink oracle sanity checks** on every quote
5. **Per-trade + daily caps + kill-switch + multisig** for value > threshold
6. **Flashbots/private relay** for orders ≥ N USD (set env `USE_FLASHBOOTS_DEFAULT=true`)
7. **Redis-backed durable job queue** to replace in-mem AsyncLock for multi-instance
8. **Minimal ERC-20 allowances** with auto-revoke on idle
9. **Prometheus metrics + PagerDuty alerts** on tx failure / slippage / gas spikes
10. **WORM audit storage** (signed receipts)

## Ethical / legal

- Lasirèn is software. Outputs are not financial advice.
- Crypto Lwa never custodies user funds. Lasirèn manages **its own wallet**
  per the user's deployment.
- Comply with KYC/AML, sanctions screening, and tax recordkeeping in your
  jurisdiction.
