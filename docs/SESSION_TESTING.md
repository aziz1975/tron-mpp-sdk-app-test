# Permit2 session testing on Nile

The session commands use the updated local SDK and require
`CREDENTIAL_TYPE=permit2`. Existing charge commands
continue to use `/premium` on port 3000; sessions use `/session` on port 3001.

## Configure the existing .env

Build the local SDK before starting the app:

```sh
cd ../tron-mpp-sdk
npm run build
cd ../tron-mpp-sdk-app-test
```

Keep the existing `TRON_FULL_HOST`, `TRON_TOKEN_ADDRESS`, `TRON_PERMIT2_ADDRESS`,
`TRON_RECIPIENT_ADDRESS`, `TRON_PAYER_PRIVATE_KEY`, `TRON_RELAYER_PRIVATE_KEY`, and
`MPP_SECRET_KEY`. Add the session settings from `.env.example` without replacing
the existing file or secrets:

```dotenv
TRON_SESSION_ESCROW_ADDRESS=<deployed TronPaymentChannel address on Nile>
TRON_PAYEE_PRIVATE_KEY=<private key for TRON_RECIPIENT_ADDRESS>
SESSION_PORT=3001
SESSION_STATE_DIR=.data/session
SESSION_UNIT_AMOUNT_ATOMIC=100000
SESSION_DEPOSIT_ATOMIC=1000000
SESSION_TOP_UP_ATOMIC=1000000
SESSION_MAX_DEPOSIT_ATOMIC=2000000
SESSION_MAX_CUMULATIVE_ATOMIC=2000000
SESSION_STREAM_UNITS=4
```

Deploy `TronPaymentChannel` from `../tron-mpp-sdk-contract` separately, using
TRON-compiled bytecode, an allowlist containing the configured token, the same
Permit2 address, and a close grace period of at least 900 seconds. This app does
not deploy contracts automatically. `session:inspect` and server startup verify
`PERMIT2()`, the token allowlist, grace period, and both signing domains against
the local Nile configuration.

The payee key is needed on the **server** for settlement and close authorizations.
It can be omitted if `TRON_RELAYER_PRIVATE_KEY` already belongs to
`TRON_RECIPIENT_ADDRESS`. Otherwise, keep a separate merchant key in
`TRON_PAYEE_PRIVATE_KEY`: the merchant signs off-chain and the relayer submits
`settleWithAuthorization` / `closeWithAuthorization`. The server does not need
the payer key. Ordinary client commands need only the payer key; operator
`settle` and `reconcile` also need `MPP_SECRET_KEY`.

For sessions, the **Permit2 spender is the escrow contract**, not the relayer.
`TRON_PERMIT2_SPENDER_ADDRESS` remains a charge-only setting. Token allowance is
still granted to Permit2. The payer needs tokens for the deposit and Nile
TRX/resources for approval or forced withdrawal. The relayer needs resources
for sponsored funding, settlement, and cooperative close.

All amounts are integer token atomic units. With a six-decimal token, the defaults
quote 0.1 token per message, initially escrow 1 token, permit an additional 1 token,
and cap the channel's total funding and cumulative voucher at 2 tokens.

## Run the lifecycle

First run the local checks, which do not load `.env` or contact Nile:

```sh
npm run check
npm test
```

Start the session server in terminal 1:

```sh
npm run session:server
```

In terminal 2, run each command separately and inspect its output:

```sh
npm run session:inspect
npm run session:challenge
npm run session:approve
npm run session:open
npm run session:voucher
npm run session:pay
npm run session:stream
npm run session:merge
npm run session:stream
npm run session:settle
npm run session:voucher -- 1200000
npm run session:pay
npm run session:close
npm run session:inspect
```

| Command | Expected behavior |
| --- | --- |
| `session:inspect` | Read-only deployment checks, token balance/allowance, on-chain channel, last receipt, and pending-operation summary |
| `session:challenge` | Check the HTTP 402 challenge against local token, payee, escrow, Permit2, price, and network policy without signing |
| `session:approve` | Set token allowance to Permit2 to exactly `SESSION_MAX_DEPOSIT_ATOMIC`; skip if already equal |
| `session:open` | Sign a Permit2 open witness, a zero-value initial voucher, and request proof; server deposits funds without charging service |
| `session:voucher` | Send an unbilled `HEAD` voucher update; by default increase the cumulative voucher by four units |
| `session:pay` | Deliver one JSON message and persist a one-unit debit |
| `session:stream` | Deliver up to `SESSION_STREAM_UNITS` SSE messages, debit each before delivery, and emit a final `payment-receipt` |
| `session:topup` | Add `SESSION_TOP_UP_ATOMIC` to escrow; no voucher or service-credit increase |
| `session:merge` | Merge a Permit2 top-up and a higher voucher in one unbilled `HEAD` request |
| `session:settle` | Operator action: settle the highest accepted voucher and report its transaction hash |
| `session:close` | Settle at least the delivered amount and any amount already settled, finalize, and refund the remainder |
| `session:revoke` | Explicitly clear any remaining allowance to Permit2 |

With the defaults, the first voucher authorizes `400000`. After one JSON message,
only three more messages are paid. The fourth stream message is stopped; expect
`payment-need-voucher` with `requiredCumulative: "500000"`, followed by the final
receipt showing `spent: "400000"`. `session:merge` raises the deposit to `2000000`
and the voucher to `800000`, without changing `spent`. The next stream consumes
the next four messages. Settlement leaves unused prepaid service credit usable.
Closing refunds what has not been settled.

Optional arguments are absolute atomic values: `session:voucher -- 600000` sets
the cumulative authorization to `600000`; `session:topup -- 500000` adds `500000`;
`session:merge -- 1200000` uses the configured top-up and sets the new cumulative
voucher to `1200000`. Funding and vouchers are checked against their separate caps
before signing. Open is refused while an earlier saved channel remains active.

Approval sends a transaction but transfers no tokens. Open/top-up/merge fund escrow;
settlement and close pay the merchant. If a different nonzero allowance exists,
run `session:revoke` before `session:approve`. Check that no charge is pending
before changing their shared Permit2 allowance.

## Replay, persistence, and recovery

`session:replay` resubmits the last successful credential. A paid GET or control
open is rejected with 409 because its signed request nonce was consumed. A HEAD
voucher update is idempotent and may return 200 without billing. Top-ups reuse
the confirmed funding record without another deposit. No replay command creates
a new permit.

The local single-process server saves the SDK's atomic journal to
`.data/session/server.json`; the client saves the exact credential **before**
submission to `client.json`. Files use mode 0600 and are excluded from Git.
Each side takes its own process lock. Restarting the same server/client retains
the accounting, replay markers, and pending funding. Use a separate
`SESSION_STATE_DIR` when changing wallets, token, escrow, or server port.

After a network failure or HTTP 503, run:

```sh
npm run session:inspect
npm run session:retry
```

Retry reuses the saved credential or confirms a saved payer-transaction hash;
it does not create a second deposit. Other payment commands are blocked while
an operation is unresolved. Expired management credentials can be rebound to a
fresh matching challenge while retaining the exact original funding signature.
An expired paid GET requires investigation because delivery may already have
occurred; the app does not automatically authorize a second billable request.

Operator reconciliation is explicit:

```sh
npm run session:reconcile
```

For a saved funding credential, this calls the SDK's `reconcileFunding`; otherwise
it reconciles known settlement/close transactions once they reach `MIN_CONFIRMATIONS`.
HTTP 200 means the state was inspected; check `state.operation` and `state.closed`
to see whether an operation has actually resolved. Reconciliation does not
broadcast or deliver service. For an uncertain paid GET, successful reconciliation
acknowledges the saved service attempt and clears it after returning the current
accounting; it does not recover or redeliver the response. A subsequent paid command
is a new billable request. A successful funding reconciliation can still need
`session:retry` to initialize accounting or accept the voucher. Confirmed close
or settlement failures release the SDK's operation reservation. Hashless unknown
submissions require checking the submitting account's transactions; do not delete
the journals to force another payment. The built-in adapter cannot reconcile a
hashless operation or external forced withdrawal from a confirmed channel snapshot.
That requires a custom adapter implementing `confirmedChannel` at the configured
confirmation depth. New successful signed requests are new
billable requests; handler responses are not cached for business retries.

The file store is for this local single-process harness. A production deployment
needs a shared transactional store and application-specific delivery recovery.

## Forced close

On a separate active session, the payer can recover the unsettled remainder even
if the merchant server is unavailable:

```sh
npm run session:request-close
npm run session:inspect
# Wait for the escrow's reported grace period (at least 900 seconds).
npm run session:withdraw
# Inspect server accounting (the built-in adapter cannot confirm external withdrawal):
npm run session:reconcile
```

The built-in adapter leaves the server tombstone open after an external withdrawal;
automatic tombstone synchronization requires a custom `confirmedChannel` adapter.
The payer pays resources for these transactions. Withdraw is simulated first, so
an unelapsed grace period is rejected before broadcast. During the wait, a
standalone `session:topup` is permitted and preserves the close deadline;
vouchers, merged funding, and new service remain unavailable. Refunds always go
to the original payer. After finalization, `session:open` generates a fresh salt
and channel ID.

## Automated coverage

Session tests use deterministic public test keys, real SDK signatures and ABI
encoding, simulated receipts, and ephemeral localhost servers. They cover the
Permit2 lifecycle, merchant-authorized relays, HEAD billing, streaming exhaustion
and final receipts, restart recovery, replay, spending limits, forced-close
top-ups, grace-period preflight, and journal locking/corruption. They do not prove
that a particular deployed Nile escrow or token works; the manual flow above is
the live integration check.
