{
  "name": "lasiren-bridge",
  "version": "1.0.0",
  "private": true,
  "description": "Lasirèn — master crypto trading agent for Brigitte's Swap. Bridges Claude/strategy decisions to Uniswap V3 with GEDE2 fee sampling and GEDE3 pattern recognition.",
  "type": "commonjs",
  "main": "src/bridge.js",
  "scripts": {
    "start": "node src/bridge.js",
    "test": "node --test src/*.test.js",
    "patterns": "node src/gede3.js --selftest",
    "fees": "node src/gede2.js --probe"
  },
  "engines": { "node": ">=20" },
  "dependencies": {
    "ethers": "^6.13.0",
    "express": "^4.21.0",
    "pino": "^9.4.0",
    "pino-http": "^10.3.0",
    "async-lock": "^1.4.1",
    "dotenv": "^16.4.5",
    "axios": "^1.7.7",
    "ws": "^8.18.0",
    "ccxt": "^4.4.0"
  },
  "devDependencies": {
    "nodemon": "^3.1.7"
  }
}
