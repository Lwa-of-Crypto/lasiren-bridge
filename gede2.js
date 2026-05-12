# Lasirèn bridge — environment template. Copy to .env before npm start.

# Paper-mode safety: when true, /signal NEVER broadcasts a tx.
PAPER_MODE=true

# RPC (use your own Alchemy/Infura key in production)
RPC_URL=https://cloudflare-eth.com

# Uniswap V3 (mainnet defaults)
QUOTER_ADDRESS=0x61fFE014bA17989E743c5F6cB21bF9697530B21e
ROUTER_ADDRESS=0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45

# Signer — set ONE of these
KMS_SIGNER=false
LOCAL_PRIVATE_KEY=             # 0x… ONLY for paper mode demos

# Auth — required in production
HMAC_SECRET=                   # share with Claude / strategy caller

# Risk caps
MAX_SLIPPAGE_BPS=50
MAX_TRADE_USD=50000
MAX_PRIORITY_GWEI=100

# Behavior
USE_FLASHBOOTS_DEFAULT=false

# Server
PORT=3000
