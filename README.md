# Marginfi Mangox01 Funding Rate Arb Bot

## Setup

```
cp .env.example .env
```

Set the `WALLET=` the path of your solana wallet.


Setup node dependencies and create your marginfi account, fund it, and activate the trading protocols.
```
yarn
yarn setup
```

Set the `MARGINFI_ACCOUNT=<address>` to the just created address.

Start the bot
```
yarn start
```
