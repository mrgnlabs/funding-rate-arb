require("dotenv").config();

import { getMarketByBaseSymbolAndKind } from "@blockworks-foundation/mango-client";
import {
  getClientFromEnv,
  MarginfiAccount,
  processTransaction,
} from "@mrgnlabs/marginfi-client";
import { PerpOrderType, Side } from "@mrgnlabs/marginfi-client/dist/utp/mango";
import { OrderType } from "@mrgnlabs/marginfi-client/dist/utp/zo/types";
import {
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import Decimal from "decimal.js";

const DUST_THRESHOLD = 0.1;

// POSITION_SIZE_USD defines the max position size that the bot will take,
// per UTP per loop.
const POSITION_SIZE_USD = 10;

// INTERVAL defines the interval the bot observes and takes action at.
const INTERVAL = 30 * 1000;

async function main() {
  // Construct the marginfi client from .env file.
  const mfiClient = await getClientFromEnv();
  // Get marginfi account from .env config.
  const mfiAccount = await mfiClient.getMarginfiAccount(
    new PublicKey(process.env.MARGINFI_ACCOUNT!)
  );

  // Set up Zo.
  await checkZoOpenOrderAccounts(mfiAccount);

  let loop = async () => {
    try {
      // Main action
      trade(mfiAccount);
    } catch (e) {
      console.log("An error occurred:");
      console.error(e);
    }

    setTimeout(loop, INTERVAL);
  };

  loop();
}

// ================================
// Helper functions 👇
// ================================

// Creates a Zo open orders account so that we're prepared to use Zo.
async function checkZoOpenOrderAccounts(mfiAccount: MarginfiAccount) {
  const zoMargin = await mfiAccount.zo.getZoMargin();

  const oo = await zoMargin.getOpenOrdersInfoBySymbol("SOL-PERP");
  if (!oo) {
    await mfiAccount.zo.createPerpOpenOrders("SOL-PERP");
  }
}

async function trade(mfiAccount: MarginfiAccount) {
  const connection = mfiAccount.client.program.provider.connection;
  const provider = mfiAccount.client.program.provider;

  // Get Mango market information.
  const mangoMarketConfig = await getMarketByBaseSymbolAndKind(
    mfiAccount.mango.config.groupConfig,
    "SOL",
    "perp"
  );

  const mangoGroup = await mfiAccount.mango.getMangoGroup();
  const mangoMarket = await mangoGroup.loadPerpMarket(
    connection,
    mangoMarketConfig.marketIndex,
    mangoMarketConfig.baseDecimals,
    mangoMarketConfig.quoteDecimals
  );

  // Get Zo market information.
  const zoState = await mfiAccount.zo.getZoState();
  const zoMargin = await mfiAccount.zo.getZoMargin(zoState);
  const zoMarket = await zoState.getMarketBySymbol("SOL-PERP");

  const mangoFundingRate = new Decimal(
    mangoMarket.getCurrentFundingRate(
      mangoGroup,
      await mangoGroup.loadCache(connection),
      mangoMarketConfig.marketIndex,
      await mangoMarket.loadBids(connection),
      await mangoMarket.loadAsks(connection)
    )
  );

  const zoFundingInfo = await zoState.getFundingInfo("SOL-PERP");

  if (!zoFundingInfo.data) {
    console.log("Can't get Zo funding info");
    return;
  }

  const zoFundingRate = zoFundingInfo.data!.hourly;

  const mangoAbsFundingRate = mangoFundingRate.abs();
  const mangoPositive = mangoFundingRate.isPositive();
  const zoAbsFundingRate = zoFundingInfo.data!.hourly.abs();
  const zoPositive = zoFundingInfo.data!.hourly.isPositive();

  const mangoDominant = mangoAbsFundingRate.gt(zoAbsFundingRate);
  const delta = mangoFundingRate.sub(zoFundingRate).abs();

  console.log(
    "Mango: %s%, Zo: %s%, Mango dominant: %s, delta: %s% ($%s/h)",
    mangoFundingRate.mul(new Decimal(100)).toPrecision(4),
    zoFundingRate.mul(new Decimal(100)).toPrecision(4),
    mangoDominant,
    delta.mul(new Decimal(100)).toPrecision(4),
    delta.mul(new Decimal(POSITION_SIZE_USD)).toDecimalPlaces(6)
  );

  let mangoDirection: Side;
  let zoDirection: boolean;

  if (mangoDominant) {
    mangoDirection = mangoPositive ? Side.Ask : Side.Bid;
    zoDirection = mangoPositive;
  } else {
    zoDirection = !zoPositive;
    mangoDirection = zoPositive ? Side.Bid : Side.Ask;
  }

  let mangoPrice;
  let zoPrice;

  const mangoAskPrice = (await mangoMarket.loadAsks(connection)).getL2(1)[0][0];
  const mangoBidPrice = (await mangoMarket.loadBids(connection)).getL2(1)[0][0];
  const zoAskPrice = (await zoMarket.loadAsks(connection)).getL2(1)[0][0];
  const zoBidPrice = (await zoMarket.loadBids(connection)).getL2(1)[0][0];

  if (mangoDirection == Side.Ask) {
    mangoPrice = mangoBidPrice;
    zoPrice = zoAskPrice;
  } else {
    mangoPrice = mangoAskPrice;
    zoPrice = zoBidPrice;
  }

  const mangoPositionSize = new Decimal(POSITION_SIZE_USD).div(mangoPrice);
  const zoPositionSize = new Decimal(POSITION_SIZE_USD).div(zoPrice);

  console.log(
    "%s position structure:\n\tMango: %s @ %s\n\tZo: %s @ %s",
    "SOL-PERP",
    (mangoDirection == Side.Bid
      ? mangoPositionSize
      : mangoPositionSize.neg()
    ).toDecimalPlaces(4),
    mangoPrice,
    (zoDirection ? zoPositionSize : zoPositionSize.neg()).toDecimalPlaces(4),
    zoPrice
  );

  await zoMargin.loadPositions();

  const mangoAccount = await mfiAccount.mango.getMangoAccount(mangoGroup);
  const currentMangoPosition =
    mangoAccount.perpAccounts[mangoMarketConfig.marketIndex].getBasePositionUi(
      mangoMarket
    );
  const currentZoPositionInfo = zoMargin.position("SOL-PERP");
  const currentZoPosition = currentZoPositionInfo.isLong
    ? currentZoPositionInfo.coins.decimal
    : currentZoPositionInfo.coins.decimal.neg();

  console.log(
    "Current positions on %s: Mango: %s, Zo: %s",
    "SOL-PERP",
    currentMangoPosition,
    currentZoPosition
  );

  const mangoDelta = (
    mangoDirection === Side.Bid ? mangoPositionSize : mangoPositionSize.neg()
  ).sub(currentMangoPosition);
  const zoDelta = (zoDirection ? zoPositionSize : zoPositionSize.neg()).sub(
    currentZoPosition
  );

  console.log(
    "Delta Mango: %s, Zo: %s",
    mangoDelta.toDecimalPlaces(4),
    zoDelta.toDecimalPlaces(4)
  );

  const ixs: TransactionInstruction[] = [];

  if (mangoDelta.gt(new Decimal(DUST_THRESHOLD))) {
    console.log(
      "Opening %s %s ($%s) %s on Mango @ %s",
      mangoDirection == Side.Bid ? "LONG" : "SHORT",
      mangoDelta.toDecimalPlaces(4),
      mangoDelta.mul(mangoPrice).toDecimalPlaces(4),
      "SOL-PERP",
      mangoPrice
    );

    const ixw = await mfiAccount.mango.makePlacePerpOrderIx(
      mangoMarket,
      mangoDirection,
      mangoPrice,
      mangoDelta.toNumber(),
      { orderType: PerpOrderType.Market }
    );

    ixs.push(...ixw.instructions);
  }

  if (zoDelta.abs().gt(new Decimal(DUST_THRESHOLD))) {
    console.log(
      "Opening %s %s ($%s) %s on Zo @ %s",
      zoDirection ? "LONG" : "SHORT",
      zoDelta.toDecimalPlaces(4),
      zoDelta.mul(zoPrice).toDecimalPlaces(4),
      "SOL-PERP",
      zoPrice
    );

    const ixw = await mfiAccount.zo.makePlacePerpOrderIx({
      symbol: "SOL-PERP",
      isLong: zoDirection,
      price: zoPrice,
      size: zoDelta.abs().toNumber(),
      orderType: OrderType.FillOrKill,
    });

    ixs.push(...ixw.instructions);
  }

  if (ixs.length > 0) {
    const tx = new Transaction().add(...ixs);
    const sig = await processTransaction(provider, tx, []);
    console.log("Sig %s", sig);
  }
}

main();
