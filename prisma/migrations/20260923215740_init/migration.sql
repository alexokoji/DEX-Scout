-- CreateEnum
CREATE TYPE "Environment" AS ENUM ('MANUAL', 'PAPER', 'LIVE');

-- CreateEnum
CREATE TYPE "DataSource" AS ENUM ('MOCK', 'LIVE');

-- CreateEnum
CREATE TYPE "TokenStage" AS ENUM ('DISCOVERED', 'SCANNED', 'SAFETY_CHECK', 'ANALYZED', 'QUALIFIED', 'SIGNAL_GENERATED', 'FILTERED');

-- CreateEnum
CREATE TYPE "RiskLevel" AS ENUM ('LOWER', 'MODERATE', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "SignalType" AS ENUM ('BUY', 'WATCH', 'HOLD', 'EXIT');

-- CreateEnum
CREATE TYPE "SignalStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'CONSUMED');

-- CreateEnum
CREATE TYPE "BotStatus" AS ENUM ('ACTIVE', 'PAUSED', 'DISABLED');

-- CreateEnum
CREATE TYPE "PositionStatus" AS ENUM ('OPEN', 'TARGET_1', 'TARGET_2', 'TARGET_3', 'PROFITABLE', 'EMERGENCY', 'CLOSED');

-- CreateEnum
CREATE TYPE "PositionHealth" AS ENUM ('HOLD', 'MONITOR', 'WARNING', 'EMERGENCY');

-- CreateEnum
CREATE TYPE "TradeSide" AS ENUM ('BUY', 'SELL');

-- CreateEnum
CREATE TYPE "TradeKind" AS ENUM ('MANUAL_ENTRY', 'AUTO_ENTRY', 'TARGET_EXIT', 'MANUAL_EXIT', 'EMERGENCY_EXIT');

-- CreateEnum
CREATE TYPE "TradeStatus" AS ENUM ('PREPARED', 'PENDING', 'CONFIRMED', 'FAILED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "TargetsMode" AS ENUM ('SINGLE', 'MULTI');

-- CreateEnum
CREATE TYPE "EventLevel" AS ENUM ('DEBUG', 'INFO', 'WARN', 'ERROR');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "passwordHash" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'USER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Wallet" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "chain" TEXT NOT NULL DEFAULT 'solana',
    "address" TEXT NOT NULL,
    "label" TEXT,
    "verifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Wallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TradingAccount" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "environment" "Environment" NOT NULL,
    "realizedPnlUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TradingAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TradingSettings" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "environment" "Environment" NOT NULL DEFAULT 'PAPER',
    "autoTradingEnabled" BOOLEAN NOT NULL DEFAULT false,
    "capitalUsd" DOUBLE PRECISION NOT NULL DEFAULT 100,
    "maxPositionUsd" DOUBLE PRECISION NOT NULL DEFAULT 10,
    "minPositionUsd" DOUBLE PRECISION NOT NULL DEFAULT 5,
    "maxOpenPositions" INTEGER NOT NULL DEFAULT 10,
    "maxDeployedUsd" DOUBLE PRECISION NOT NULL DEFAULT 100,
    "minOpportunityScore" DOUBLE PRECISION NOT NULL DEFAULT 70,
    "minLiquidityUsd" DOUBLE PRECISION NOT NULL DEFAULT 100000,
    "minVolume24hUsd" DOUBLE PRECISION NOT NULL DEFAULT 50000,
    "maxPriceImpactPct" DOUBLE PRECISION NOT NULL DEFAULT 2,
    "maxSlippageBps" INTEGER NOT NULL DEFAULT 300,
    "maxAllowedRisk" "RiskLevel" NOT NULL DEFAULT 'MODERATE',
    "targetsMode" "TargetsMode" NOT NULL DEFAULT 'MULTI',
    "maxPositionAgeHours" INTEGER,
    "emergencyEnabled" BOOLEAN NOT NULL DEFAULT true,
    "emergencyAutoExit" BOOLEAN NOT NULL DEFAULT false,
    "emergencyLiquidityDropPct" DOUBLE PRECISION NOT NULL DEFAULT 70,
    "filters" JSONB NOT NULL DEFAULT '{}',
    "weights" JSONB NOT NULL DEFAULT '{}',
    "activeStrategyId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TradingSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProfitTarget" (
    "id" TEXT NOT NULL,
    "settingsId" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "gainPct" DOUBLE PRECISION NOT NULL,
    "sellPct" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "ProfitTarget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Strategy" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "config" JSONB NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Strategy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Token" (
    "id" TEXT NOT NULL,
    "chain" TEXT NOT NULL DEFAULT 'solana',
    "address" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "decimals" INTEGER NOT NULL,
    "dex" TEXT NOT NULL,
    "poolAddress" TEXT,
    "logoUrl" TEXT,
    "dataSource" "DataSource" NOT NULL,
    "stage" "TokenStage" NOT NULL DEFAULT 'DISCOVERED',
    "poolCreatedAt" TIMESTAMP(3),
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastScannedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "priceUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "marketCapUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "fdvUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "liquidityUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "volume24hUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "volume1hUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "change5m" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "change1h" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "change24h" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "buySellRatio" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "holders" INTEGER NOT NULL DEFAULT 0,
    "holderGrowth1h" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "txCount1h" INTEGER NOT NULL DEFAULT 0,
    "pairCount" INTEGER NOT NULL DEFAULT 1,
    "opportunityScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "riskLevel" "RiskLevel" NOT NULL DEFAULT 'MODERATE',
    "passedFilters" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TokenMetric" (
    "id" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "priceUsd" DOUBLE PRECISION NOT NULL,
    "marketCapUsd" DOUBLE PRECISION NOT NULL,
    "fdvUsd" DOUBLE PRECISION NOT NULL,
    "liquidityUsd" DOUBLE PRECISION NOT NULL,
    "volume5m" DOUBLE PRECISION NOT NULL,
    "volume15m" DOUBLE PRECISION NOT NULL,
    "volume30m" DOUBLE PRECISION NOT NULL,
    "volume1h" DOUBLE PRECISION NOT NULL,
    "volume24h" DOUBLE PRECISION NOT NULL,
    "buys5m" INTEGER NOT NULL,
    "sells5m" INTEGER NOT NULL,
    "buys1h" INTEGER NOT NULL,
    "sells1h" INTEGER NOT NULL,
    "holders" INTEGER NOT NULL,
    "pairCount" INTEGER NOT NULL,

    CONSTRAINT "TokenMetric_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceSnapshot" (
    "id" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "priceUsd" DOUBLE PRECISION NOT NULL,
    "liquidityUsd" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "PriceSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VolumeSnapshot" (
    "id" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "volume5m" DOUBLE PRECISION NOT NULL,
    "volume1h" DOUBLE PRECISION NOT NULL,
    "volume24h" DOUBLE PRECISION NOT NULL,
    "buys5m" INTEGER NOT NULL,
    "sells5m" INTEGER NOT NULL,

    CONSTRAINT "VolumeSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LiquidityPool" (
    "id" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "chain" TEXT NOT NULL DEFAULT 'solana',
    "address" TEXT NOT NULL,
    "dex" TEXT NOT NULL,
    "quoteSymbol" TEXT NOT NULL DEFAULT 'SOL',
    "liquidityUsd" DOUBLE PRECISION NOT NULL,
    "createdAtChain" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LiquidityPool_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TokenSafety" (
    "id" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "riskScore" DOUBLE PRECISION NOT NULL,
    "riskLevel" "RiskLevel" NOT NULL,
    "passed" BOOLEAN NOT NULL,
    "warnings" JSONB NOT NULL,
    "criticalIssues" JSONB NOT NULL,
    "details" JSONB NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TokenSafety_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TokenAnalysis" (
    "id" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "opportunityScore" DOUBLE PRECISION NOT NULL,
    "components" JSONB NOT NULL,
    "market" JSONB NOT NULL,
    "onchain" JSONB NOT NULL,
    "snapshot" JSONB NOT NULL,
    "raw" JSONB NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TokenAnalysis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Signal" (
    "id" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "type" "SignalType" NOT NULL,
    "status" "SignalStatus" NOT NULL DEFAULT 'ACTIVE',
    "dataSource" "DataSource" NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "opportunityScore" DOUBLE PRECISION NOT NULL,
    "riskLevel" "RiskLevel" NOT NULL,
    "priceUsd" DOUBLE PRECISION NOT NULL,
    "entryMin" DOUBLE PRECISION NOT NULL,
    "entryMax" DOUBLE PRECISION NOT NULL,
    "target1" DOUBLE PRECISION NOT NULL,
    "target2" DOUBLE PRECISION NOT NULL,
    "target3" DOUBLE PRECISION NOT NULL,
    "reasons" JSONB NOT NULL,
    "warnings" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Signal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SignalAnalysis" (
    "id" TEXT NOT NULL,
    "signalId" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "ai" JSONB,
    "aiProvider" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SignalAnalysis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Bot" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "BotStatus" NOT NULL DEFAULT 'PAUSED',
    "environment" "Environment" NOT NULL DEFAULT 'PAPER',
    "lastRunAt" TIMESTAMP(3),
    "emergencyStoppedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Bot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BotRun" (
    "id" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "signalsEvaluated" INTEGER NOT NULL DEFAULT 0,
    "tradesExecuted" INTEGER NOT NULL DEFAULT 0,
    "tradesSkipped" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "summary" JSONB,

    CONSTRAINT "BotRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Position" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "environment" "Environment" NOT NULL,
    "status" "PositionStatus" NOT NULL DEFAULT 'OPEN',
    "health" "PositionHealth" NOT NULL DEFAULT 'HOLD',
    "healthNotes" JSONB,
    "origin" TEXT NOT NULL DEFAULT 'MANUAL',
    "sourceSignalId" TEXT,
    "entryPriceUsd" DOUBLE PRECISION NOT NULL,
    "currentPriceUsd" DOUBLE PRECISION NOT NULL,
    "initialAmount" DOUBLE PRECISION NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "investedUsd" DOUBLE PRECISION NOT NULL,
    "costBasisUsd" DOUBLE PRECISION NOT NULL,
    "realizedPnlUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "targetsHit" INTEGER NOT NULL DEFAULT 0,
    "targetsSnapshot" JSONB NOT NULL,
    "emergencyEnabled" BOOLEAN NOT NULL DEFAULT true,
    "emergencyAutoExit" BOOLEAN NOT NULL DEFAULT false,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),
    "lastAnalysisAt" TIMESTAMP(3),

    CONSTRAINT "Position_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PositionEvent" (
    "id" TEXT NOT NULL,
    "positionId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "data" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PositionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Trade" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "positionId" TEXT,
    "side" "TradeSide" NOT NULL,
    "kind" "TradeKind" NOT NULL,
    "environment" "Environment" NOT NULL,
    "dataSource" "DataSource" NOT NULL,
    "status" "TradeStatus" NOT NULL DEFAULT 'PREPARED',
    "inputUsd" DOUBLE PRECISION NOT NULL,
    "tokenAmount" DOUBLE PRECISION NOT NULL,
    "priceUsd" DOUBLE PRECISION NOT NULL,
    "priceImpactPct" DOUBLE PRECISION NOT NULL,
    "slippageBps" INTEGER NOT NULL,
    "feesUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "networkFeeUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "realizedPnlUsd" DOUBLE PRECISION,
    "quote" JSONB NOT NULL,
    "failureReason" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "executedAt" TIMESTAMP(3),

    CONSTRAINT "Trade_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Transaction" (
    "id" TEXT NOT NULL,
    "tradeId" TEXT NOT NULL,
    "chain" TEXT NOT NULL DEFAULT 'solana',
    "signature" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "unsignedTx" TEXT,
    "error" TEXT,
    "slot" BIGINT,
    "submittedAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Transaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemEvent" (
    "id" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "type" TEXT NOT NULL,
    "level" "EventLevel" NOT NULL DEFAULT 'INFO',
    "source" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "userId" TEXT,
    "data" JSONB,

    CONSTRAINT "SystemEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkerState" (
    "name" TEXT NOT NULL,
    "lastRunAt" TIMESTAMP(3),
    "lastError" TEXT,
    "runs" INTEGER NOT NULL DEFAULT 0,
    "stats" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkerState_pkey" PRIMARY KEY ("name")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_createdAt_idx" ON "User"("createdAt");

-- CreateIndex
CREATE INDEX "Wallet_userId_idx" ON "Wallet"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Wallet_chain_address_key" ON "Wallet"("chain", "address");

-- CreateIndex
CREATE INDEX "TradingAccount_userId_idx" ON "TradingAccount"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "TradingAccount_userId_environment_key" ON "TradingAccount"("userId", "environment");

-- CreateIndex
CREATE UNIQUE INDEX "TradingSettings_userId_key" ON "TradingSettings"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ProfitTarget_settingsId_level_key" ON "ProfitTarget"("settingsId", "level");

-- CreateIndex
CREATE INDEX "Strategy_userId_idx" ON "Strategy"("userId");

-- CreateIndex
CREATE INDEX "Token_address_idx" ON "Token"("address");

-- CreateIndex
CREATE INDEX "Token_marketCapUsd_idx" ON "Token"("marketCapUsd");

-- CreateIndex
CREATE INDEX "Token_updatedAt_idx" ON "Token"("updatedAt");

-- CreateIndex
CREATE INDEX "Token_opportunityScore_idx" ON "Token"("opportunityScore");

-- CreateIndex
CREATE INDEX "Token_passedFilters_marketCapUsd_idx" ON "Token"("passedFilters", "marketCapUsd");

-- CreateIndex
CREATE UNIQUE INDEX "Token_chain_address_key" ON "Token"("chain", "address");

-- CreateIndex
CREATE INDEX "TokenMetric_tokenId_ts_idx" ON "TokenMetric"("tokenId", "ts");

-- CreateIndex
CREATE INDEX "PriceSnapshot_tokenId_ts_idx" ON "PriceSnapshot"("tokenId", "ts");

-- CreateIndex
CREATE INDEX "VolumeSnapshot_tokenId_ts_idx" ON "VolumeSnapshot"("tokenId", "ts");

-- CreateIndex
CREATE INDEX "LiquidityPool_tokenId_idx" ON "LiquidityPool"("tokenId");

-- CreateIndex
CREATE UNIQUE INDEX "LiquidityPool_chain_address_key" ON "LiquidityPool"("chain", "address");

-- CreateIndex
CREATE UNIQUE INDEX "TokenSafety_tokenId_key" ON "TokenSafety"("tokenId");

-- CreateIndex
CREATE INDEX "TokenSafety_riskLevel_idx" ON "TokenSafety"("riskLevel");

-- CreateIndex
CREATE UNIQUE INDEX "TokenAnalysis_tokenId_key" ON "TokenAnalysis"("tokenId");

-- CreateIndex
CREATE INDEX "TokenAnalysis_opportunityScore_idx" ON "TokenAnalysis"("opportunityScore");

-- CreateIndex
CREATE INDEX "Signal_createdAt_idx" ON "Signal"("createdAt");

-- CreateIndex
CREATE INDEX "Signal_score_idx" ON "Signal"("score");

-- CreateIndex
CREATE INDEX "Signal_status_expiresAt_idx" ON "Signal"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "Signal_tokenId_status_idx" ON "Signal"("tokenId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "SignalAnalysis_signalId_key" ON "SignalAnalysis"("signalId");

-- CreateIndex
CREATE UNIQUE INDEX "Bot_userId_key" ON "Bot"("userId");

-- CreateIndex
CREATE INDEX "BotRun_botId_startedAt_idx" ON "BotRun"("botId", "startedAt");

-- CreateIndex
CREATE INDEX "Position_userId_status_idx" ON "Position"("userId", "status");

-- CreateIndex
CREATE INDEX "Position_status_idx" ON "Position"("status");

-- CreateIndex
CREATE INDEX "Position_tokenId_idx" ON "Position"("tokenId");

-- CreateIndex
CREATE INDEX "Position_openedAt_idx" ON "Position"("openedAt");

-- CreateIndex
CREATE INDEX "PositionEvent_positionId_createdAt_idx" ON "PositionEvent"("positionId", "createdAt");

-- CreateIndex
CREATE INDEX "Trade_userId_createdAt_idx" ON "Trade"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Trade_status_idx" ON "Trade"("status");

-- CreateIndex
CREATE INDEX "Trade_tokenId_idx" ON "Trade"("tokenId");

-- CreateIndex
CREATE UNIQUE INDEX "Transaction_tradeId_key" ON "Transaction"("tradeId");

-- CreateIndex
CREATE UNIQUE INDEX "Transaction_signature_key" ON "Transaction"("signature");

-- CreateIndex
CREATE INDEX "SystemEvent_ts_idx" ON "SystemEvent"("ts");

-- CreateIndex
CREATE INDEX "SystemEvent_type_ts_idx" ON "SystemEvent"("type", "ts");

-- CreateIndex
CREATE INDEX "SystemEvent_userId_ts_idx" ON "SystemEvent"("userId", "ts");

-- AddForeignKey
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradingAccount" ADD CONSTRAINT "TradingAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradingSettings" ADD CONSTRAINT "TradingSettings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProfitTarget" ADD CONSTRAINT "ProfitTarget_settingsId_fkey" FOREIGN KEY ("settingsId") REFERENCES "TradingSettings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Strategy" ADD CONSTRAINT "Strategy_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TokenMetric" ADD CONSTRAINT "TokenMetric_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "Token"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceSnapshot" ADD CONSTRAINT "PriceSnapshot_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "Token"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VolumeSnapshot" ADD CONSTRAINT "VolumeSnapshot_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "Token"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LiquidityPool" ADD CONSTRAINT "LiquidityPool_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "Token"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TokenSafety" ADD CONSTRAINT "TokenSafety_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "Token"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TokenAnalysis" ADD CONSTRAINT "TokenAnalysis_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "Token"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Signal" ADD CONSTRAINT "Signal_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "Token"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SignalAnalysis" ADD CONSTRAINT "SignalAnalysis_signalId_fkey" FOREIGN KEY ("signalId") REFERENCES "Signal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bot" ADD CONSTRAINT "Bot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotRun" ADD CONSTRAINT "BotRun_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Position" ADD CONSTRAINT "Position_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Position" ADD CONSTRAINT "Position_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "TradingAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Position" ADD CONSTRAINT "Position_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "Token"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Position" ADD CONSTRAINT "Position_sourceSignalId_fkey" FOREIGN KEY ("sourceSignalId") REFERENCES "Signal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PositionEvent" ADD CONSTRAINT "PositionEvent_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "Position"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Trade" ADD CONSTRAINT "Trade_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Trade" ADD CONSTRAINT "Trade_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "TradingAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Trade" ADD CONSTRAINT "Trade_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "Token"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Trade" ADD CONSTRAINT "Trade_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "Position"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_tradeId_fkey" FOREIGN KEY ("tradeId") REFERENCES "Trade"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SystemEvent" ADD CONSTRAINT "SystemEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
