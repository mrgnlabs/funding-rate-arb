require("dotenv").config();

import {
  getClientFromEnv,
  MarginfiAccount,
  uiToNative,
} from "@mrgnlabs/marginfi-client";
import { POSITION_SIZE_USD } from "./bot";

/**
 * Sample setup for a brand new account
 */

(async function () {
  console.log("Setting up funding rate arb bot for SOL");

  // Get marginfi account from .env config.
  const mfiClient = await getClientFromEnv();
  const mfiAccount = await tryOrCry(mfiClient.createMarginfiAccount(), "Creating marginfi account");

  console.log("Account address %s", mfiAccount.publicKey);
  
  await tryOrCry(mfiAccount.deposit(uiToNative(POSITION_SIZE_USD)), "Depositing into marginfi account");

  // Setup UTPs.
  await setupZo(mfiAccount);
  await setupMango(mfiAccount);

  console.log("Done. Add MARGINFI_ACCOUNT=%s to .env", mfiAccount.publicKey);
})()

async function setupZo(mfiAccount: MarginfiAccount) {
  console.log("Setting up 01");
  const zo = mfiAccount.zo

  await tryOrCry(zo.activate(), "Activating 01 Protocol");
  await tryOrCry(zo.deposit(uiToNative(POSITION_SIZE_USD / 2, 6)), "Depositing into 01 Protocol");
}

async function setupMango(mfiAccount: MarginfiAccount) {
  console.log("Setting up Mango");
  const mango = mfiAccount.mango

  await tryOrCry(mango.activate(), "Activating Mango Protocol");
  await tryOrCry(mango.deposit(uiToNative(POSITION_SIZE_USD / 2, 6)), "Depositing into Mango Protocol");
}


async function tryOrCry<G>(promise: Promise<G>, actionText: string): Promise<G> {
  console.log("%s", actionText.toUpperCase());
  try {
    return await promise
  } catch (e) {
    console.log("%s FAILED", actionText.toUpperCase());
    throw e
  }
}