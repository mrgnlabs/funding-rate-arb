# Marginfi Mango x 01 Funding Rate Arb Bot

## Prerequisites

Fund your wallet with:

- 0.2 SOL (for margin account + mango + 01 rent)
- 10 USDC

## Setup

```sh
cp .env.example.mainnet .env
```

Set the `WALLET=` the path of your solana wallet.

Setup node dependencies

```sh
yarn
```

You can follow either the **Setup Script** or the **Cli Setup**

### Setup Script

Create your marginfi account, fund it, and activate the trading protocols

```sh
yarn setup
```

It is recommended you use a private RPC node, as public ones like to fail/serve stale data.

**If at any step the setup script fails, you can continue manually with the CLI from the step that failed**

### Cli Setup

Download the CLI

```sh
yarn global add @mrgnlabs/marginfi-cli
```

Create your marginfi account

```sh
mfi account create -k <wallet_path>
```

Fund your marginfi account

```sh
mfi account deposit <account_address> 10 -k <wallet_path>
```

Activate and fund Mango

```sh
mfi account mango activate <account_address> -k <wallet_path>
mfi account mango deposit  <account_address> -k <wallet_path>
```

Activate and fund 01

```sh
mfi account zo activate <account_address> -k <wallet_path>
mfi account zo deposit <account_address> -k <wallet_path>
```

---

Set the `MARGINFI_ACCOUNT=<address>` to the just created address.

Start the bot

```sh
yarn start
```

## Troubleshooting

If anything goes wrong you can set `export DEBUG=*` and repeat the failing step
and send us the log via Telegram ❤️.

## DISCLAIMER

**Not financial advice**.

This bot is written for educational purposes only.
