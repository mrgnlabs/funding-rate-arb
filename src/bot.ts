require("dotenv").config();

import { getMarketByBaseSymbolAndKind } from "@blockworks-foundation/mango-client";
import {
  MarginfiAccount,
  MarginfiClient,
  processTransaction,
  MangoOrderSide,
  MangoPerpOrderType,
  ZoPerpOrderType,
} from "@mrgnlabs/marginfi-client";
import {
  ComputeBudgetProgram,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import Decimal from "decimal.js";

const DUST_THRESHOLD = 0.1;

// POSITION_SIZE_USD defines the max position size that the bot will take,
// per UTP per loop.
export const POSITION_SIZE_USD = Number.parseInt(
  process.env.POSITION_SIZE || "10"
);

// INTERVAL defines the interval the bot observes and takes action at.
const INTERVAL = Number.parseInt(process.env.INTERVAL || "60000");

const DRY_RUN = process.env.DRY_RUN == "true";

const MANGO_MARKET = process.env.ASSET_KEY!;
export const ZO_MARKET = `${MANGO_MARKET}-PERP`;

export async function run() {
  // Construct the marginfi client from .env file.
  console.log(
    "Starting arb bot for %s with account %s\nInterval %ss, max position size: $%s",
    ZO_MARKET,
    process.env.MARGINFI_ACCOUNT,
    INTERVAL / 1000,
    POSITION_SIZE_USD
  );

  if (DRY_RUN) {
    console.log("DRY RUN Enabled");
  }
  const mfiClient = await MarginfiClient.fromEnv();
  // Get marginfi account from .env config.
  const mfiAccount = await mfiClient.getMarginfiAccount(
    new PublicKey(process.env.MARGINFI_ACCOUNT!)
  );

  const zoMargin = await mfiAccount.zo.getZoMargin();
  const oo = await zoMargin.getOpenOrdersInfoBySymbol(ZO_MARKET);
  if (!oo) {
    await mfiAccount.zo.createPerpOpenOrders(ZO_MARKET);
  }

  let loop = async () => {
    try {
      // Main action
      await trade(mfiAccount);
    } catch (e) {
      console.log("An error occurred:");
      console.error(e);
    }

    setTimeout(loop, INTERVAL);
  };

  loop();
}

async function trade(mfiAccount: MarginfiAccount) {
  console.log("----------------------------------------------------");
  console.log("%s", new Date().toISOString());
  const connection = mfiAccount.client.program.provider.connection;
  const provider = mfiAccount.client.program.provider;

  // Get Mango market information.
  const mangoMarketConfig = await getMarketByBaseSymbolAndKind(
    mfiAccount.mango.config.groupConfig,
    MANGO_MARKET,
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
  const zoMarket = await zoState.getMarketBySymbol(ZO_MARKET);

  const mangoFundingRate = new Decimal(
    mangoMarket.getCurrentFundingRate(
      mangoGroup,
      await mangoGroup.loadCache(connection),
      mangoMarketConfig.marketIndex,
      await mangoMarket.loadBids(connection),
      await mangoMarket.loadAsks(connection)
    )
  );

  const zoFundingInfo = await zoState.getFundingInfo(ZO_MARKET);

  if (!zoFundingInfo.data) {
    console.log("Can't get 01 funding info");
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
    "Mango: %s%, 01: %s%, Mango dominant: %s, delta: %s% ($%s/h - APR %s%)",
    mangoFundingRate.mul(new Decimal(100)).toPrecision(4),
    zoFundingRate.mul(new Decimal(100)).toPrecision(4),
    mangoDominant,
    delta.mul(new Decimal(100)).toPrecision(4),
    delta.mul(new Decimal(POSITION_SIZE_USD)).toDecimalPlaces(6),
    delta.mul(new Decimal(8760)).mul(new Decimal(100)).toPrecision(4)
  );

  let mangoDirection: MangoOrderSide;
  let zoDirection: boolean;

  if (mangoDominant) {
    mangoDirection = mangoPositive ? MangoOrderSide.Ask : MangoOrderSide.Bid;
    zoDirection = mangoPositive;
  } else {
    zoDirection = !zoPositive;
    mangoDirection = zoPositive ? MangoOrderSide.Bid : MangoOrderSide.Ask;
  }

  let mangoPrice;
  let zoPrice;

  const mangoAskPrice = (await mangoMarket.loadAsks(connection)).getL2(1)[0][0];
  const mangoBidPrice = (await mangoMarket.loadBids(connection)).getL2(1)[0][0];
  const zoAskPrice = (await zoMarket.loadAsks(connection)).getL2(1)[0][0];
  const zoBidPrice = (await zoMarket.loadBids(connection)).getL2(1)[0][0];

  console.log("Mango ask: %s, bid: %s", mangoAskPrice, mangoBidPrice);
  console.log("01 ask: %s, bid: %s", zoAskPrice, zoBidPrice);

  if (mangoDirection == MangoOrderSide.Ask) {
    mangoPrice = mangoBidPrice;
    zoPrice = zoAskPrice;
  } else {
    mangoPrice = mangoAskPrice;
    zoPrice = zoBidPrice;
  }

  const mangoPositionSize = new Decimal(POSITION_SIZE_USD).div(mangoPrice);
  const zoPositionSize = new Decimal(POSITION_SIZE_USD).div(zoPrice);

  console.log(
    "Position: Mango: %s @ %s 01: %s @ %s",
    (mangoDirection == MangoOrderSide.Bid
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
  const currentZoPositionInfo = zoMargin.position(ZO_MARKET);
  const currentZoPosition = currentZoPositionInfo.isLong
    ? currentZoPositionInfo.coins.decimal
    : currentZoPositionInfo.coins.decimal.neg();

  console.log(
    "Current positions on %s: Mango: %s, 01: %s",
    ZO_MARKET,
    currentMangoPosition,
    currentZoPosition
  );

  const mangoDelta = (
    mangoDirection === MangoOrderSide.Bid
      ? mangoPositionSize
      : mangoPositionSize.neg()
  ).sub(currentMangoPosition);
  const zoDelta = (zoDirection ? zoPositionSize : zoPositionSize.neg()).sub(
    currentZoPosition
  );

  console.log(
    "Delta Mango: %s, 01: %s",
    mangoDelta.toDecimalPlaces(4),
    zoDelta.toDecimalPlaces(4)
  );

  const ixs: TransactionInstruction[] = [];

  if (mangoDelta.abs().gt(new Decimal(DUST_THRESHOLD))) {
    const deltaLong = mangoDelta.isPositive();
    const deltaDirection = deltaLong ? MangoOrderSide.Bid : MangoOrderSide.Ask;
    const price = deltaLong ? mangoAskPrice : mangoBidPrice;

    console.log(
      "Opening %s %s ($%s) %s on Mango @ %s",
      deltaLong ? "LONG" : "SHORT",
      mangoDelta.toDecimalPlaces(4),
      mangoDelta.abs().mul(price).toDecimalPlaces(4),
      ZO_MARKET,
      price
    );

    const ixw = await mfiAccount.mango.makePlacePerpOrderIx(
      mangoMarket,
      deltaDirection,
      price,
      mangoDelta.abs().toNumber(),
      { orderType: MangoPerpOrderType.Market }
    );

    ixs.push(...ixw.instructions);
  }

  if (zoDelta.abs().gt(new Decimal(DUST_THRESHOLD))) {
    const deltaLong = zoDelta.isPositive();
    const price = deltaLong ? zoAskPrice : zoBidPrice;

    console.log(
      "Opening %s %s ($%s) %s on 01 @ %s",
      deltaLong ? "LONG" : "SHORT",
      zoDelta.toDecimalPlaces(4),
      zoDelta.abs().mul(price).toDecimalPlaces(4),
      ZO_MARKET,
      price
    );

    const ixw = await mfiAccount.zo.makePlacePerpOrderIx({
      symbol: ZO_MARKET,
      isLong: deltaLong,
      price: price,
      size: zoDelta.abs().toNumber(),
      orderType: ZoPerpOrderType.Limit,
    });

    ixs.push(...ixw.instructions);
  }

  if (ixs.length > 0 && !DRY_RUN) {
    const tx = new Transaction().add(
      ComputeBudgetProgram.requestUnits({ units: 1_000_000, additionalFee: 0 }),
      ...ixs
    );
    try {
      const sig = await processTransaction(provider, tx, []);
      console.log("Sig %s", sig);
    } catch (err: any) {
      console.log("Position adjustment failed");
    }
  }
}
