# Ethereum Wallet History Exporter

Export a full **Ethereum wallet transaction history** (ETH transfers, internal transfers, ERC-20, ERC-721, ERC-1155) to a structured CSV file.  
Built with **[Alchemy SDK](https://docs.alchemy.com/docs/alchemy-sdk)**, supports **millions of transactions** efficiently by streaming results and batching RPC calls.

---

## ✨ Features

- ✅ **All transfer types**:
  - External (ETH transfers)
  - Internal (contract-triggered ETH moves)
  - ERC-20 token transfers
  - ERC-721 NFT transfers
  - ERC-1155 multi-token transfers
  - Contract interactions (zero-value external calls)
- ✅ **Gas fee calculation** using `effectiveGasPrice × gasUsed` from receipts (EIP-1559 aware)
- ✅ **Streaming CSV output** – memory efficient, handles millions of txs
- ✅ **Retries & backoff** – resilient against RPC throttling
- ✅ **Duplicate-safe** – rolling de-dupe set
- ✅ Defaults tuned for scale (no need to pass `fromBlock`, `toBlock`, etc.)

---

## 📦 Installation

Clone your repo and install dependencies:

```bash
git clone https://github.com/<your-repo>/eth-history-exporter.git
cd eth-history-exporter
npm install
Setup

Get a free Alchemy API Key:
👉 https://dashboard.alchemy.com/

Create a .env file in the project root:

ALCHEMY_KEY=your_alchemy_api_key_here

🚀 Usage
Run script
node export-eth-history.js --address 0xYourWalletAddress --out history.csv

Arguments

--address <0x...> (required) → Ethereum wallet address

--out <filename.csv> (optional) → Output CSV file (default: out.csv)

Example
node export-eth-history.js \
  --address 0xa39b189482f984388a34460636fea9eb181ad1a6 \
  --out my_wallet_history.csv

📊 CSV Output

Each row in the CSV has these fields:

Column	Description
Transaction Hash	Unique identifier
Date & Time	Block timestamp (ISO)
From Address	Sender
To Address	Recipient
Transaction Type	ETH transfer, ERC-20, ERC-721, ERC-1155, contract interaction
Asset Contract Address	Token/NFT contract
Asset Symbol / Name	Token symbol or NFT collection
Token ID	NFT ID (for ERC-721 / ERC-1155)
Value / Amount	Amount of ETH/tokens transferred
Gas Fee (ETH)	Transaction fee paid
Sample Output (CSV)
Transaction Hash,Date & Time,From Address,To Address,Transaction Type,Asset Contract Address,Asset Symbol / Name,Token ID,Value / Amount,Gas Fee (ETH)
0xabc123...,2025-01-10T12:34:56Z,0x111...,0x222...,ETH transfer,,ETH,,0.5,0.00042
0xdef456...,2025-01-11T09:15:21Z,0x333...,0x444...,ERC-20,0xa0b8...,USDC,,1000,0.0011
0xghi789...,2025-01-12T17:08:45Z,0x555...,0x666...,ERC-721,0xb47e...,CRYPTOPUNK,1234,1,0.0029

⚡ Performance Notes

Processes 1,000 transfers per page (Alchemy maximum).

Fetches receipts in parallel with safe concurrency (20 by default).

Uses a rolling de-dupe buffer to avoid duplicate entries across sent/received queries.

Stream-writes to CSV → does not load all transfers into memory.

⚠️ For wallets with millions of transfers, export may take a long time.
💡 Tip: run inside a screen/tmux session or Docker container for long-running jobs.

🛠️ Development
Run with hot reload (optional)
npm install -g nodemon
nodemon export-eth-history.js --address 0x...

Code style

Written in CommonJS (require) for compatibility

Internal defaults (tweak in code if needed):

DEFAULT_FROM_BLOCK = 0x0

DEFAULT_TO_BLOCK = latest

DEFAULT_MAX_PER_PAGE = 1000

DEFAULT_CONCURRENCY = 20