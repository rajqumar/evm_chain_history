#!/usr/bin/env node
/**
 * ETH history exporter (Alchemy SDK + p-map), scalable for very large histories.
 * - Categories: external, internal, erc20, erc721, erc1155
 * - Gas fee: effectiveGasPrice * gasUsed (receipt)
 * - Streams CSV per page; bounded memory; rolling de-dupe
 *
 * Usage:
 *   ALCHEMY_KEY=your_key node export-eth-history.js --address 0x... [--out history.csv]
 */

const fs = require("fs");
const path = require("path");
const { setTimeout: sleep } = require("timers/promises");
const pMap = require("p-map");
require("dotenv").config();
const { Alchemy, Network } = require("alchemy-sdk");

const ALCHEMY_KEY = process.env.ALCHEMY_KEY;
if (!ALCHEMY_KEY) {
    console.error("Missing env ALCHEMY_KEY");
    process.exit(1);
}
const alchemy = new Alchemy({ apiKey: ALCHEMY_KEY, network: Network.ETH_MAINNET });

/* ---------------- CLI (only address/out) ---------------- */
function parseArgs() {
    const argv = process.argv.slice(2);
    const get = (flag, def) => {
        const i = argv.indexOf(flag);
        return i >= 0 ? argv[i + 1] : def;
    };
    const address = (get("--address") || "").trim().toLowerCase();
    if (!address) {
        console.error("Error: --address <0x...> is required");
        process.exit(1);
    }
    return { address };
}

/* ---------------- CSV helpers ---------------- */
function writeCsvHeader(filePath) {
    const header = [
        "Transaction Hash",
        "Date & Time",
        "From Address",
        "To Address",
        "Transaction Type",
        "Asset Contract Address",
        "Asset Symbol / Name",
        "Token ID",
        "Value / Amount",
        "Gas Fee (ETH)",
    ].join(",") + "\n";
    fs.writeFileSync(filePath, header, "utf8");
}
function csvEscape(v) {
    if (v === null || v === undefined) return "";
    const s = String(v);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
}
function appendCsvRow(stream, row) {
    const ordered = [
        "hash", "datetime", "from", "to", "type",
        "contract", "symbolOrName", "tokenId", "amount", "gasFeeEth",
    ];
    stream.write(ordered.map((k) => csvEscape(row[k])).join(",") + "\n");
}

/* ---------------- Utils ---------------- */
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
const MAX_RETRIES = 6;

// internal defaults (not user-facing)
const DEFAULT_FROM_BLOCK = "0x0";
const DEFAULT_TO_BLOCK = "latest";
const DEFAULT_MAX_PER_PAGE = 1000;      // (Alchemy max 1000)
const DEFAULT_CONCURRENCY = 1000;        // receipt fetch concurrency

const isHex = (s) => /^0x[0-9a-fA-F]+$/.test(s);
const toHexBlock = (v) => (v === "latest" ? "latest" : isHex(v) ? v.toLowerCase() : "0x" + BigInt(v).toString(16));

const hexToBigIntStr = (hex) => {
    if (!hex) return undefined;
    try { return BigInt(hex).toString(); } catch { return undefined; }
};
const weiToEth = (weiStr) => {
    if (!weiStr) return "0";
    try {
        const wei = BigInt(weiStr);
        const whole = wei / 10n ** 18n;
        const frac = wei % 10n ** 18n;
        let fracStr = frac.toString().padStart(18, "0").replace(/0+$/, "");
        return fracStr ? `${whole}.${fracStr}` : whole.toString();
    } catch { return "0"; }
};

// rolling de-dupe (bounded)
function makeRollingSet(maxSize = 500_000) {
    const set = new Set();
    const queue = [];
    return {
        has: (k) => set.has(k),
        add: (k) => {
            if (set.has(k)) return;
            set.add(k); queue.push(k);
            if (queue.length > maxSize) {
                const old = queue.shift();
                if (old !== undefined) set.delete(old);
            }
        }
    };
}
const transferKey = (t) => {
    if (t.uniqueId) return t.uniqueId;
    const parts = [
        t.hash,
        t.category,
        t.logIndex ?? "",
        t.tokenId ?? "",
        (t.from || "").toLowerCase(),
        (t.to || "").toLowerCase(),
    ];
    return parts.join("|");
};

// retry wrapper
async function withRetry(fn, label = "op") {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try { return await fn(); }
        catch (e) {
            if (attempt === MAX_RETRIES) throw e;
            const backoff = Math.min(1000 * 2 ** (attempt - 1), 10_000);
            await sleep(backoff + Math.floor(Math.random() * 250));
        }
    }
}

/* ---------------- Alchemy wrappers ---------------- */
async function getTransfersPaged(q) {
    // q includes: fromAddress|toAddress, pageKey, etc.
    return withRetry(() => alchemy.core.getAssetTransfers(q), "getAssetTransfers");
}
async function getReceipt(hash) {
    return withRetry(() => alchemy.core.getTransactionReceipt(hash), "getTransactionReceipt");
}

/* ---------------- Normalization ---------------- */
function inferType(t) {
    if (t.category === "erc20") return "ERC-20";
    if (t.category === "erc721") return "ERC-721";
    if (t.category === "erc1155") return "ERC-1155";
    if (t.category === "external") {
        const val = Number(t.value || "0");
        if (val === 0 || (t.to && t.to.toLowerCase() === ZERO_ADDR)) return "contract interaction";
        return "ETH transfer";
    }
    return "ETH transfer"; // internal
}

function expandRowsFromTransfer(t) {
    const base = {
        hash: t.hash,
        datetime: (t.metadata && t.metadata.blockTimestamp) || "",
        from: t.from || "",
        to: t.to || "",
        contract: (t.rawContract && t.rawContract.address) || "",
        symbolOrName: t.asset || "",
        gasFeeEth: "",
    };
    const type = inferType(t);

    if (t.category === "erc1155" && Array.isArray(t.erc1155Metadata) && t.erc1155Metadata.length > 0) {
        return t.erc1155Metadata.map((m) => ({
            ...base, type, tokenId: m.tokenId, amount: m.value,
        }));
    }
    const tokenId = t.tokenId || "";
    const amount = t.category === "erc721" ? "1" : (t.value || "0");
    return [{ ...base, type, tokenId, amount }];
}

/* ---------------- Page pipeline (uses p-map) ---------------- */
async function processDirection({ address, dir, fromBlock, toBlock, stream, dedupe }) {
    const base = {
        fromBlock,
        toBlock,
        category: ["external", "internal", "erc20", "erc721", "erc1155"],
        withMetadata: true,
        excludeZeroValue: false,
        maxCount: "0x" + DEFAULT_MAX_PER_PAGE.toString(16),
    };

    let pageKey;
    do {
        const query = { ...base, pageKey };
        if (dir === "sent") query.fromAddress = address;
        else if (dir === "received") query.toAddress = address;

        const res = await getTransfersPaged(query); // { transfers: [], pageKey? }
        const transfers = res.transfers || [];
        if (transfers.length === 0 && !res.pageKey) break;

        // Expand + de-dupe
        const rows = [];
        const hashes = new Set();
        for (const t of transfers) {
            const key = transferKey(t);
            if (dedupe.has(key)) continue;
            dedupe.add(key);
            rows.push(...expandRowsFromTransfer(t));
            hashes.add(t.hash);
        }

        // Fetch receipts concurrently (p-map), compute fee map
        const uniqueHashes = Array.from(hashes);
        const feeByHash = new Map();

        await pMap(
            uniqueHashes,
            async (h) => {
                const rcpt = await getReceipt(h);
                const egp = hexToBigIntStr(rcpt && rcpt.effectiveGasPrice);
                const gu = hexToBigIntStr(rcpt && rcpt.gasUsed);
                if (egp && gu) {
                    try {
                        const feeWei = (BigInt(egp) * BigInt(gu)).toString();
                        feeByHash.set(h, weiToEth(feeWei));
                    } catch { feeByHash.set(h, "0"); }
                } else {
                    feeByHash.set(h, "0");
                }
            },
            { concurrency: DEFAULT_CONCURRENCY }
        );

        // Write this page
        for (const r of rows) {
            appendCsvRow(stream, {
                hash: r.hash,
                datetime: r.datetime,
                from: r.from,
                to: r.to,
                type: r.type,
                contract: r.contract,
                symbolOrName: r.symbolOrName,
                tokenId: r.tokenId,
                amount: r.amount,
                gasFeeEth: feeByHash.get(r.hash) || "0",
            });
        }

        pageKey = res.pageKey;
        await sleep(120); // small pacing to be polite
    } while (pageKey);
}

/* ---------------- Main ---------------- */
async function main() {
    const { address } = parseArgs();
    const fileName = `${address}_transaction_history.csv`;
    const outPath = path.resolve(process.cwd(), fileName);
    writeCsvHeader(outPath);
    const stream = fs.createWriteStream(outPath, { flags: "a" });

    const fromBlock = toHexBlock(DEFAULT_FROM_BLOCK);
    const toBlock = DEFAULT_TO_BLOCK;

    const dedupe = makeRollingSet(250_000);

    console.log("→ Processing sent transfers...");
    await processDirection({ address, dir: "sent", fromBlock, toBlock, stream, dedupe });

    console.log("→ Processing received transfers...");
    await processDirection({ address, dir: "received", fromBlock, toBlock, stream, dedupe });

    stream.end();
    console.log(`✅ Done. CSV saved to: ${outPath}`);
}

main().catch((e) => {
    console.error("Fatal error:", e);
    process.exit(1);
});
