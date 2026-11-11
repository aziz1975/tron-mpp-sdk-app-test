# App integration test report — October 30, 2026

The updated SDK passes this application's automated integration suite and its
live Nile TRX payment and replay flows after the app migration described below.
This report distinguishes simulated node behavior from actual on-chain evidence.

## Tested environment

- App: `/home/aziz/localrepos/blockchain-projects/tron-mpp-sdk-app-test`.
- SDK: local `file:../tron-mpp-sdk` symlink, resolved to
  `/home/aziz/localrepos/blockchain-projects/tron-mpp-sdk`.
- SDK HEAD: `0cacb8567bea60fb2b6fd8587611476ceb5bee50`
  (`Upgraded to the latest versions of the packages`); SDK working tree clean at inspection.
- SDK package version: `0.1.0`. The version alone does not identify these changes.
- Runtime: Node `v22.22.1`; TypeScript `5.9.3`; tsx `4.23.5`.
- Installed app dependencies: MPP `0.15.0`, TronWeb `6.5.1`, viem `2.57.13`.
- Live node: `https://nile.trongrid.io`; local app port: `3001`.
- Price: `0.000001 TRX` (one sun); minimum confirmations: one.
- Recipient: `TQGfKPHs3AwiBT44ibkCU64u1G4ttojUXU`.
- Existing local `.env` supplied the test configuration. No private keys, signing
  secrets, or API keys are included in this report or evidence.
- App Git metadata is unavailable in this workspace (`git status` reports that
  it is not a repository), so there is no app commit identifier or Git diff.

Tests import the SDK's public package exports, which resolve to its existing
`dist` artifacts, not directly to SDK TypeScript. No SDK files were edited or
rebuilt. SHA-256 identifiers of the tested artifacts:

| Export | SHA-256 |
| --- | --- |
| root | `f8ac33979cc47078e8873f5525a66778da8a9899a4326cafff9204112c1f12eb` |
| client | `de1c84879ab0b82467ba83d8a5cf0c0a050214e4bc661d16f96de12e6e20007a` |
| server | `7409baf909b8ffb372396c9783f95ce603602a41d71d42a37e14ea394c9209cd` |
| tronweb | `a02ddd9a81ac46bacd738dc43ab34b0aacc508158084cfc6a72912445d1908f7` |

## Initial findings and app changes

| Finding | Resolution |
| --- | --- |
| App's `npm run check` failed: signer and verifier adapters now require a second options argument. | Pass `{ network: 'nile' }` to both adapters. |
| App installed MPP `0.8.15`, TronWeb `6.4.0`, viem `2.55.10`, below SDK peer requirements. MPP/Zod type identities conflicted in replay parsing. | Update dependencies and lockfile to compatible versions. Type check now passes without suppressions. |
| SDK credentials now require a payer proof signature bound to challenge/payment. | Use the current TronWeb signer, which broadcasts and creates the signed proof. Exercise valid, invalid, missing and tampered proofs through HTTP. |
| App treated only 402 as an early return from the payment listener. | Return on every non-200 payment result, including verification infrastructure failures. |
| Amount validation concatenated decimal digits incorrectly before checking positivity; server port had no upper bound. | Correct atomic-unit construction and reject ports above 65535. Regression cases cover invalid amounts/ports. |
| Confirmation polling could treat a null block number as block zero and did not reject explicit failed receipts. | Require a non-null finite block number; reject explicit failed receipts; bound each polling delay by remaining timeout. |
| Dependency update initially reported three high-severity vulnerable package entries (Axios, follow-redirects and affected TronWeb). | Apply the SDK's app-level Axios `^1.20.0` and follow-redirects `^1.16.2` overrides. Final audit reports zero vulnerabilities. |
| Server startup was coupled to route construction. | Extract `createAppServer` to `src/app.ts`, with injectable TronWeb adapter; preserve CLI startup/shutdown in `src/server.ts`. Tests use the actual app routes and middleware. |

The SDK's network option is a binding to the configured adapter, not remote chain
identification. Configure a real Nile node for this app.

## Automated coverage

`npm test`: **39 passed, zero failed, zero skipped**, about 9.5 seconds.
Node counts the parent integration test as well as its subtests; there are 38
leaf scenarios. These tests use real HTTP, MPP serialization, TronWeb message
signing, SDK payer proof verification and replay storage. Blockchain broadcasts,
transaction lookups and block heights are simulated locally.

| Area | Scenarios and observed behavior |
| --- | --- |
| HTTP routing | Health returns expected JSON; unknown path, POST premium and POST health return 404. |
| Initial payment challenge | Premium returns 402 and WWW-Authenticate; challenge has amount `1`, TRX, expected recipient, Nile and one confirmation. |
| Automatic payment fetch | Real MPP client retry returns 200, protected JSON and parseable success receipt with TRON method/transaction reference. |
| Credential replay | Sequential and concurrent identical submissions produce one 200 and one 402. |
| Challenge replay | Two distinct payments answering one challenge concurrently produce one 200 and one 402. |
| Transaction replay | A used transaction re-signed against a fresh challenge is rejected; a new payment can still answer that challenge. |
| Payer proof and binding | Missing signature, invalid signature, changed transaction, changed amount, changed source and changed challenge return 402 before node lookup; original valid credential remains usable. |
| Authorization parsing | Malformed Payment/Bearer headers return 402. |
| Chain verification | Failed execution, pending info, wrong amount, wrong recipient, wrong payer and insufficient confirmations return 402. Same credential succeeds after recovery, proving failure did not consume it. |
| RPC outage | Simulated node exception returns 500; retry of the same credential succeeds after recovery. Expected SDK diagnostic appears in TAP output. |
| Spending limit | Amount above the app's 0.01 TRX cap is rejected before broadcast. |
| Adapter network | Mainnet-configured signer refuses a Nile challenge before broadcast. |
| Client policy | Wrong network, unsupported currency, spoofed native decimals, atomic cap, missing trusted token decimals, spoofed token decimals and a token mislabeled TRX are rejected before signer invocation. |
| Configuration | Zero, negative, exponential, malformed and excessive-precision amounts are rejected; zero, negative, fractional and out-of-range ports are rejected. |
| Confirmation helper | Mined result succeeds; failed receipt rejects; missing info, RPC error and null block time out. |
| Supplemental TRC-20 SDK flow | Six public-export scenarios: valid signed token payment succeeds; wrong contract, amount, recipient, failed receipt and missing Transfer log fail. Display amount 1.25 normalizes to 1250000; signer receives expected token/recipient/amount. |

TRC-20 tests exercise SDK public methods with Request objects and simulated node
responses; the app's `/premium` route itself accepts only native TRX.

Evidence: [TAP output](evidence/automated-tests.tap),
[type check](evidence/typecheck.txt), [npm audit](evidence/npm-audit.json).

## Live Nile results

Both live commands exited successfully against the same running app process.
Each broadcast one one-sun payment. No additional payment was sent for the replay.

| Flow | Transaction | Result |
| --- | --- | --- |
| `npm run client` | `c0daccc363801304bc5dba95fc5e289b59acfae8cd2658d8460b9efabb9e6062` | Broadcast, confirmed, HTTP 200, Payment-Receipt present, premium content unlocked. |
| `npm run replay` | `337dc226db57dfaeb5e9cf23259b58c643d0806ccdc439199dce7f81daf290f0` | Broadcast, confirmed, first submission 200; identical credential replay 402. |

The first receipt decoded to:

```json
{
  "method": "tron",
  "reference": "c0daccc363801304bc5dba95fc5e289b59acfae8cd2658d8460b9efabb9e6062",
  "status": "success",
  "timestamp": "2026-10-30T21:16:48.000Z"
}
```

Public node `wallet/gettransactioninfobyid` independently returned:

| Transaction | Block | Block time (UTC) | Receipt |
| --- | --- | --- | --- |
| `c0daccc3…e6062` | 72286274 | 2026-10-30 21:16:48 | `net_usage: 265` |
| `337dc226…90f0` | 72286300 | 2026-10-30 21:18:06 | `net_usage: 265` |

The replay response contained status 402, problem type
`https://paymentauth.org/problems/verification-failed`, and detail:
`Payment verification failed: TRON challenge has already been used.`
The accepted response included `paymentReceiptAttached: true`.
Total payment principal: two sun, excluding any network resource charges.

## Reproduce

From the app directory, with an up-to-date SDK build in its sibling checkout:

```sh
npm ci
npm run check
npm test
npm audit
```

For live checks, configure `.env` as described in the README. Start the server
in one terminal, then run the client and replay sequentially in another:

```sh
npm run server
```

```sh
npm run client
npm run replay
```

Do not restart the server between accepted submission and replay. Each live
command sends a new payment. Preserve only public transaction IDs/statuses and
receipts when saving evidence.

Restricted runs encountered DNS `EAI_AGAIN` and localhost `EPERM`. Registry and
HTTP tests were rerun with required environment permissions. A first local HTTP
run expected 402 for a simulated RPC exception; observation established 500 as
the infrastructure-error behavior, and the regression now asserts 500 followed
by successful retry. No final failures are hidden by skipped tests.

## Limits and remaining work

- Live coverage is Nile/native TRX. No mainnet payments, live TRC-20 transfers,
  deployed token contracts, browser wallets or hardware wallets were tested.
- Token and failure scenarios use simulated node responses. They do not establish
  compatibility with every node provider or real token implementation.
- Replay races were tested within one app process. Persistent Redis stores,
  multi-process coordination, crash recovery and load testing remain untested.
  App replay state resets on restart; this harness is not production replay storage.
- No SDK unit suite was run or SDK source modified. This is consumer integration
  evidence for the exact public build identified above, not an SDK code audit.
- Confirmation timeout bounds polling delays; an individual stalled RPC call
  can exceed that timeout because the helper does not abort in-flight requests.
  Transient polling errors retry until timeout; verifier RPC exceptions surface as 500.
- The final helper hardening and server refactor were covered by type checking
  and automated tests. Live commands ran with the updated adapter options and
  dependencies; the running server was started before the final non-200 guard edit.
- A deep `npm ls axios follow-redirects` additionally flags the sibling SDK's
  existing Axios 1.20.0 as `invalid` against TronWeb's pinned 1.18.0 requirement.
  The SDK itself overrides Axios to `^1.20.0`; traversal from this app's local
  symlink does not treat that nested override as a root override. The app's own
  Axios resolves to 1.21.0 with a valid root override. Public-export integration
  tests and root dependency listing pass; the sibling install was left unchanged.
- `npm audit` is a registry snapshot of this app's dependency tree, not a security
  assessment of application logic or a separate audit of the sibling SDK install.
