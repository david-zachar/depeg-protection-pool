# LST depeg protection mechanism - Bachelor Thesis Project

An on-chain protection pool mechanism for protecting against Liquid Staking Token (LST) depeg events. Built on Ethereum network.

---
### Contract Addresses:
Pool: `0xf3931dc99fA90f6C097067DE99a41206534391E4`

Oracle: `0x3C74b619aa4a210801abD2F77Ceef0C819346649`

LST Token: `0x40Ee1c4599d1109C24582D8beb039846D9ec00Ef`

## Files

```
contracts/
  TestLST.sol          - Minimal ERC-20 simulating a liquid staking token
  TestOracle.sol       - Simulation oracle (anyone can change price)
  ProtectionPool.sol   - Main Protection Pool contract

frontend/              - Frontend files
  index.html
  app.js
  style.css

```

---

### How to deploy and run

The contracts created in this thesis are already deployed on the Ethereum Sepolia testnet and their addresses are hardcoded in the frontend files. Only thing required to use this app is to serve the frontend locally, for example with: `npx serve frontend/` and a wallet with SepoliaETH for transaction fees.

#### How to deploy fresh contract instance

- Compile all three contracts.
- Deploy `TestLST.sol` first, deployer address will receive testing tokens automatically.
- Deploy `TestOracle.sol`, it requires the initial price constructor argument.  
  For a 100% peg put 1000000000000000000 (= 1.0 × 10^18)
- Deploy `ProtectionPool.sol` with these arguments:
  - `_lstToken` TestLST contract address from step 2
  - `_priceFeed` TestOracle contract address from step 3
  - `_depegThresholdBps` depeg threshold in basis points. e.g. 9500 (95%)
  - `_premiumRateBps` premium rate in basis points. e.g. 500 (5%)
  - `_policyDurationDays` time after policy purchases expire in days
  - `_gracePeriodHours` time between depeg event and allowing settlement in hours (put 0 for instant settlement)
  - Copy and paste all contracts addresses in the JavaScript file constants at the top of the file
  - Open frontend web application with `npx serve frontend/`
  - Connect a wallet to interact with the dApp

#### Example flow

1. Seller: Deposit collateral to the pool.
2. Buyer: Purchase a protection policy, pay premium to the contract.
3. Anyone: Simulate depeg with the testing tool on the website and trigger depeg.
4. Buyer: Approve LST for spending, settle the policy, receive ETH in exchange for LST.
5. Seller: Withdraw, receive depegged LST and fees that were paid by buyers.


