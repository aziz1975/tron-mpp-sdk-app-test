# TRON MPP SDK TRC-20 charge and session test app

This app exercises `tron.charge(...)` and Permit2-backed `tron.session(...)`
from the local `tron-mpp-sdk` on Nile. For the session setup and lifecycle commands,
see [Session testing](docs/SESSION_TESTING.md). Charge commands below keep their
existing configuration and behavior; session commands use a separate server on port 3001.
Payments are configured for Nile testnet USDT at
`TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf` (six decimals), as listed in the
[TRON wallet-cli documentation](https://github.com/tronprotocol/wallet-cli/blob/develop/ts/docs/commands/token/add.md).
Native TRX payments are unsupported. The default `transaction` credential signs an
unbroadcast TRC-20 `transfer`; the server validates and broadcasts it. The optional
`permit2` credential signs an off-chain witness permit, which the server's relayer
submits to the configured Permit2 contract. Both paths confirm the matching token
Transfer event and return protected content with a receipt. Both use only the
`charge` intent. The separate session flow uses an escrow, cumulative vouchers,
metered streams, top-ups, settlement, and refunds.
TRX is used only for network resources when required.

## Setup

Build the SDK in `../tron-mpp-sdk`, then install this app's dependencies:

```sh
npm install
cp .env.example .env
openssl rand -base64 32
```

Configure `.env` with the generated `MPP_SECRET_KEY`, a Nile payer key, the
merchant's recipient address. The template sets `TRON_TOKEN_ADDRESS` to Nile
USDT. Addresses may be Base58Check, `41`-prefixed hex or
20-byte `0x` hex. The payer needs that token and enough Nile TRX/resources for
execution. The server does not need the payer's key. Permit2 mode needs a server
relayer key; transaction mode does not.
The USDT migration updates only public network/token/amount settings in an
existing `.env`, preserves keys and secrets, and removes `PAYMENT_AMOUNT_TRX`.
The old native-payment setting is rejected.

`PAYMENT_AMOUNT_ATOMIC` and `MAX_PAYMENT_AMOUNT_ATOMIC` are positive integer
strings in token atomic units. Both default to `1000000`, meaning one token for
a six-decimal token such as USDT. Decimal amounts such as `1.25` are rejected;
use `1250000` for 1.25 units of a six-decimal token. The client checks the exact
token contract, recipient, Nile chain ID, and atomic spending cap before signing.

Use a dedicated test wallet. Keep `.env` local and excluded from Git. The node
configured by `TRON_FULL_HOST` must serve Nile; the SDK's chain ID is trusted
configuration rather than automatic node-network discovery.

## Run

```sh
# Terminal 1
npm run server
# Terminal 2
npm run client
```

The flow is HTTP 402 -> charge credential -> server broadcast -> confirmed
receipt -> HTTP 200 with `Payment-Receipt`. The app advertises exactly the
credential selected by `CHARGE_CREDENTIAL_TYPE` (`transaction` by default).
EIP-3009 and escrow contracts are not used.

With the server still running, `npm run replay` performs one token payment and
submits its credential twice. The replay must return 402 without another
broadcast or access to the handler. Both `client` and `replay` can submit a real
Nile token transfer. They are separate payment runs.

## Manual Permit2 charge test

The SUN deployment reference lists Nile Permit2 at
`TYQuuhGbEMxF7nZxUHV3uHJxAVVAegNU9h`:
https://docs.sun.io/protocols/sunswap-v4/reference/contract/

1. Edit the existing `.env`; do not overwrite configured secrets. Add:

   ```dotenv
   CHARGE_CREDENTIAL_TYPE=permit2
   TRON_PERMIT2_ADDRESS=TYQuuhGbEMxF7nZxUHV3uHJxAVVAegNU9h
   TRON_PERMIT2_SPENDER_ADDRESS=<relayer wallet address>
   TRON_RELAYER_PRIVATE_KEY=<relayer wallet private key>
   ```

   Keep `TRON_FULL_HOST=https://nile.trongrid.io`, the Nile USDT token,
   `TRON_PAYER_PRIVATE_KEY`, `TRON_RECIPIENT_ADDRESS`, and `MPP_SECRET_KEY`.
   Set both `PAYMENT_AMOUNT_ATOMIC` and `MAX_PAYMENT_AMOUNT_ATOMIC` to `1000000`
   for one USDT. The spender is the relayer account that calls Permit2; the
   merchant recipient can be a different account. No router address is needed.

2. Derive the relayer address from its key, without printing the key:

   ```sh
   node --env-file=.env --input-type=module -e "import { TronWeb } from 'tronweb'; console.log(TronWeb.address.fromPrivateKey(process.env.TRON_RELAYER_PRIVATE_KEY.replace(/^0x/, '')))"
   ```

   Put that address in `TRON_PERMIT2_SPENDER_ADDRESS`. The server rejects a
   mismatch. Fund the payer with at least one Nile USDT plus TRX/resources for
   approval. Fund the relayer with Nile TRX/resources for submitting the charge.

3. Run `npm run check` and `npm test`. These checks spend no funds.

4. Run `npm run permit2:inspect`. It reads balances, the USDT allowance to
   Permit2, `nonceBitmap`, and `DOMAIN_SEPARATOR`. Expect `domainMatchesSdk: true`,
   USDT with six decimals, and `balanceCoversClientCap: true`. An initial zero
   allowance is expected. This command does not sign or broadcast.

5. Run `npm run permit2:approve`. This sends a payer transaction to the USDT
   contract, setting its allowance to the Permit2 contract to exactly
   `MAX_PAYMENT_AMOUNT_ATOMIC`. With the settings above that is one USDT.
   Wait for `Confirmed allowance: 1000000 atomic units`, then rerun
   `npm run permit2:inspect`; `allowanceCoversClientCap` should be true.
   Approval itself transfers no tokens. A different nonzero existing allowance
   must first be cleared with `npm run permit2:revoke`.

6. Stop any older server using the configured port. Start `npm run server` in
   terminal 1. Expect `Charge credential: permit2` and the correct Permit2 and
   relayer addresses. This harness keeps its payment journal in memory, so keep
   this server running while a submission is pending.

7. In terminal 2, run `npm run challenge`. It requires HTTP 402, method `tron`,
   intent `charge`, the configured token/recipient/Nile chain, and exactly
   `credentialTypes: ["permit2"]`. It also checks the Permit2 and spender
   addresses. It prints the challenge without signing or paying. SDK challenge
   addresses are normalized to `0x` format; they represent the same TRON accounts.

8. Run `npm run client` once. The payer signs a short-lived witness permit
   off-chain; the server relayer simulates and submits
   `permitWitnessTransferFrom`, then confirms the USDT Transfer event. Expect
   `Charge credential: permit2`, HTTP 200, a `Payment-Receipt`, and a confirmed
   transaction hash. This is one live charge and transfers one USDT.

9. Run `npm run permit2:inspect` again. Compare with step 4: payer balance falls
   by `1000000` atomic units and recipient balance rises by `1000000` when they
   are different wallets. The exact one-USDT approval is normally consumed.
   Open the printed charge hash at
   `https://nile.tronscan.org/#/transaction/<hash-without-0x>`; expect the relayer
   as transaction sender, Permit2 as the called contract, and a USDT Transfer
   from payer to merchant.

10. Optional replay test: approve another one USDT, then run `npm run replay`.
    This makes a separate charge, submits the same credential twice, and expects
    `First submission: 200` followed by `Replay submission: 402`. Only its first
    submission should transfer tokens. Use `npm run permit2:revoke` to clear any
    remaining token allowance after testing.

If a charge returns 503 or its submission result is uncertain, keep the server
running and investigate the original transaction before starting another charge.
`npm run client` creates a fresh payment credential on each invocation.

The earlier live transaction-credential test does not validate Permit2 settlement.
Permit2 setup inspection is read-only; a successful `npm run client` in Permit2
mode is the live end-to-end settlement check.

## Automated checks

```sh
npm run check
npm test
curl http://127.0.0.1:3000/health
```

Tests do not load `.env`, contact Nile, or spend funds. They use deterministic
public test keys, real signed TRON transaction envelopes, simulated chain
receipts, and ephemeral localhost HTTP servers. Coverage includes the paid
fetch flow, sequential/concurrent replay, token/recipient/amount checks, native
value rejection, malformed envelopes, policy limits, and uncertain-submission
recovery without a duplicate broadcast.

Replay journals use an in-memory atomic store in this local single-process
harness. A deployed application needs a shared persistent atomic store across
restarts and instances. Retry the same credential after a 503 uncertainty;
do not create another payment while the first transaction is unresolved. The
SDK also exposes `chargeMethod.reconcile(challengeId)` for operator recovery.

The SDK dependency is `file:../tron-mpp-sdk`; rebuild its exported `dist` files
after SDK changes. Existing reports in `docs/` describe the previous native-TRX
harness and are historical evidence, not validation of this token-only flow.
Live Nile validation must use the configured token and current SDK build.
