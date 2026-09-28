-- Multi-chain support: existing users' scanner filters were saved with chains = ["solana"] only.
-- Widen them to every supported chain (users can narrow them again under Settings -> Trading).
UPDATE "TradingSettings"
SET "filters" = jsonb_set("filters", '{chains}', '["solana","ethereum","base","bsc","arbitrum","polygon"]'::jsonb)
WHERE ("filters" -> 'chains') IS NULL OR ("filters" -> 'chains') = '["solana"]'::jsonb;

-- Wallet rows are now keyed by address family ("solana" | "evm"); existing rows are Solana wallets already.
