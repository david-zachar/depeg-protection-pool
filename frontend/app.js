const ORACLE_ABI = [
  "constructor(int256 initialPrice)",
  "function setPrice(int256 newPrice) external",
  "function latestRoundData() external view returns (uint80,int256,uint256,uint256,uint80)",
  "event PriceUpdated(int256 newPrice, uint256 timestamp)"
];
const LST_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function balanceOf(address account) external view returns (uint256)",
  "function mint(address to, uint256 amount) external"
];
const POOL_ABI = [
  "constructor(address,address,uint256,uint256,uint256,uint256)",
  "function deposit() external payable",
  "function withdraw() external",
  "function openPolicy(uint256 coverageAmountETH) external payable",
  "function triggerDepeg() external",
  "function settlePolicy(uint256 policyId) external",
  "function expirePolicy(uint256 policyId) external",
  "function cancelPolicy(uint256 policyId) external",
  "function recoverPool() external",
  "function activePolicesCount() external view returns (uint256)",
  "function getPoolConfig() external view returns (uint256,uint256,uint256,uint256)",
  "function getPoolState() external view returns (uint8,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256)",
  "function getPolicy(uint256 policyId) external view returns (address,uint256,uint256,uint256,uint8)",
  "function getSellerInfo(address seller) external view returns (uint256,bool)",
  "function sellerCount() external view returns (uint256)",
  "function sellerList(uint256 index) external view returns (address)",
  "function policyCount() external view returns (uint256)",
  "function quotePremium(uint256 coverageAmountETH) external view returns (uint256)",
  "receive() external payable",
  "event PoolReset(uint256 timestamp)"
];


//  -----CONTRACT ADDRESSES-------------
// Paste the deployed contract addresses here:
const POOL_ADDRESS   = "0xf3931dc99fA90f6C097067DE99a41206534391E4";
const ORACLE_ADDRESS = "0x3C74b619aa4a210801abD2F77Ceef0C819346649";
const LST_ADDRESS    = "0x40Ee1c4599d1109C24582D8beb039846D9ec00Ef";

let provider, signer, walletAddress;
let poolContract, oracleContract, lstContract;
let poolAddr   = POOL_ADDRESS;
let oracleAddr = ORACLE_ADDRESS;
let lstAddr    = LST_ADDRESS;
let currentPoolState = "OPEN";
const SEPOLIA_CHAIN_ID = "0xaa36a7";

// ask the wallet to connect, switch to Sepolia, then load the contracts
async function connectWallet() {
  if (!window.ethereum) { log("Wallet not detected.", "err"); return; }
  try {
    await window.ethereum.request({ method: "eth_requestAccounts" });
    const chainId = await window.ethereum.request({ method: "eth_chainId" });
    if (chainId !== SEPOLIA_CHAIN_ID)
      await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: SEPOLIA_CHAIN_ID }] });
    provider = new ethers.BrowserProvider(window.ethereum);
    signer   = await provider.getSigner();
    walletAddress = await signer.getAddress();
    const btn = document.getElementById("connect-btn");
    btn.textContent = short(walletAddress); btn.classList.add("connected");
    document.getElementById("wallet-addr-display").textContent = walletAddress;
    log(`Wallet connected ${walletAddress}`, "ok");
    await loadContracts();
  } catch(e) { log(e.message, "err"); }
}

// wire up ethers contract objects for the pool, oracle, and LST, then show the UI
async function loadContracts() {
  if (!signer) { log("Connect wallet first.", "err"); return; }
  if (!ethers.isAddress(POOL_ADDRESS) || !ethers.isAddress(ORACLE_ADDRESS) || !ethers.isAddress(LST_ADDRESS)) {
    log("Contract address invalid.", "err");
    return;
  }
  try {
    poolContract   = new ethers.Contract(POOL_ADDRESS,   POOL_ABI,   signer);
    oracleContract = new ethers.Contract(ORACLE_ADDRESS, ORACLE_ABI, signer);
    lstContract    = new ethers.Contract(LST_ADDRESS,    LST_ABI,    signer);
    log(`Pool loaded: ${POOL_ADDRESS}`, "ok");
    log(`Oracle loaded: ${ORACLE_ADDRESS}`, "ok");
    log(`LST loaded: ${LST_ADDRESS}`, "ok");
    document.querySelector(".bottom-tools").style.display = "grid";
    document.querySelector(".testing-tools-wrap").style.display = "block";
    showPoolPanel();
    updateAddrBar();
    refreshAll();
  } catch(e) { log(e.message, "err"); }
}

// seller sends ETH to the pool to provide coverage capacity
async function deposit() {
  if (!poolContract) { log("Contract not loaded", "err"); return; }
  try {
    const v = ethers.parseEther(document.getElementById("deposit-amount").value);
    log("Depositing into pool…", "info");
    await waitTx(await poolContract.deposit({ value: v }), "Deposit successful");
  } catch(e) { log(e.message, "err"); }
}

// seller pulls their share of ETH and LST out of the pool
async function withdraw() {
  if (!poolContract) { log("Contract not loaded", "err"); return; }
  try {
    log("Withdrawing from pool…", "info");
    await waitTx(await poolContract.withdraw(), "Withdrawal successful");
  } catch(e) { log(e.message, "err"); }
}

// buyer opens a new policy and pays the premium upfront
async function openPolicy() {
  if (!poolContract) { log("Contract not loaded.", "err"); return; }
  try {
    const coverage = ethers.parseEther(document.getElementById("policy-coverage").value);
    const premium  = await poolContract.quotePremium(coverage);
    log(`Opening policy: ${ethers.formatEther(coverage)} ETH coverage, ${ethers.formatEther(premium)} ETH premium`, "info");
    await waitTx(await poolContract.openPolicy(coverage, { value: premium }), "Policy opened");
  } catch(e) { log(e.message, "err"); }
}

// buyer gives the pool permission to pull their LST when they settle
async function approveLST() {
  if (!lstContract || !poolAddr) { log("Contract not loaded", "err"); return; }
  try {
    log("Approving LST for pool contract…", "info");
    await waitTx(await lstContract.approve(poolAddr, ethers.parseEther("1000")), "LST is approved for spending");
  } catch(e) { log(e.message, "err"); }
}

// faucet — mint test LST to any address
async function mintLST() {
  if (!lstContract) { log("Contract not loaded", "err"); return; }
  const recipient = document.getElementById("faucet-recipient").value.trim();
  const amountStr = document.getElementById("faucet-amount").value;
  if (!ethers.isAddress(recipient)) { log("Invalid recipient address.", "err"); return; }
  if (!amountStr || parseFloat(amountStr) <= 0) { log("Enter a positive amount.", "err"); return; }
  try {
    const amount = ethers.parseEther(amountStr);
    log(`Minting ${amountStr} tstETH to ${short(recipient)}…`, "info");
    await waitTx(await lstContract.mint(recipient, amount), `Minted ${amountStr} tstETH to ${short(recipient)}.`);
  } catch(e) { log(e.message, "err"); }
}

// buyer swaps their LST for ETH on a triggered, post-wait-period policy
async function settlePolicy(policyId) {
  if (!poolContract) { log("Contract not loaded", "err"); return; }
  try {
    log(`Settling policy ${policyId}…`, "warn");
    await waitTx(await poolContract.settlePolicy(policyId), `Policy #${policyId} settled. ETH sent to your wallet.`);
  } catch(e) { log(e.message, "err"); }
}

// permissionless — anyone marks a past-expiry policy as expired to free capacity
async function expirePolicy(policyId) {
  if (!poolContract) { log("Contract not loaded", "err"); return; }
  try {
    log(`Expiring policy #${policyId}…`, "info");
    await waitTx(await poolContract.expirePolicy(policyId), `Policy #${policyId} expired.`);
  } catch(e) { log(e.message, "err"); }
}

// buyer cancels their own policy, forfeits the premium, keeps their LST
async function cancelPolicy(policyId) {
  if (!poolContract) { log("Contract not loaded", "err"); return; }
  try {
    log(`Cancelling policy #${policyId}…`, "info");
    await waitTx(await poolContract.cancelPolicy(policyId), `Policy #${policyId} cancelled.`);
  } catch(e) { log(e.message, "err"); }
}

// permissionless — flip the pool to TRIGGERED when oracle price is below threshold
async function triggerDepeg() {
  if (!poolContract) { log("Contract not loaded", "err"); return; }
  try {
    log("Triggering depeg…", "warn");
    await waitTx(await poolContract.triggerDepeg(), "Depeg TRIGGERED Wait period started.");
  } catch(e) { log(e.message, "err"); }
}

// read the price input and push it to the oracle
async function setOraclePrice() {
  const price = parseFloat(document.getElementById("oracle-price-input").value);
  if (isNaN(price) || price < 0) { log("Enter a valid price.", "err"); return; }
  await sendOraclePrice(price);
}
// send the new price to the oracle; if it's back at peg, also try to reset the pool
async function sendOraclePrice(price) {
  if (!oracleContract) { log("Contract not loaded", "err"); return; }
  try {
    log(`Setting oracle ${price.toFixed(4)}`, "info");
    await waitTx(await oracleContract.setPrice(ethers.parseEther(price.toString())), `Oracle price set to ${price.toFixed(4)}`);
  } catch(e) { log(e.message, "err"); return; }

  // when price is back at peg and the pool is TRIGGERED with no active policies, recover it
  if (price >= 1.0 && poolContract) {
    try {
      const state = await poolContract.getPoolState();
      const stateN = Number(state[0]);
      if (POOL_STATES[stateN] === "TRIGGERED") {
        const active = Number(await poolContract.activePolicesCount());
        if (active === 0) {
          log("Recovering pool to OPEN…", "info");
          await waitTx(await poolContract.recoverPool(), "Pool recovered to OPEN.");
        }
      }
    } catch(e) { console.error("recoverPool skipped:", e); }
  }
}

const POOL_STATES   = ["OPEN", "TRIGGERED"];
const POLICY_STATES = ["ACTIVE", "SETTLED", "EXPIRED"];

// pull the latest pool data on chain and repaint the whole UI
async function refreshAll() {
  if (!poolContract) return;

  try {
    const config = await poolContract.getPoolConfig();
    const state  = await poolContract.getPoolState();

    // unpack config
    const [
      premRate,
      depThr,
      expiry,
      waitPeriod
    ] = config;

    // unpack state
    const [
      stateN,
      totalDep,
      totalCov,
      freeCap,
      totalPrem,
      trigTs,
      curPrice,
      polCount,
      selCount,
      bal
    ] = state;

    const stateStr  = POOL_STATES[Number(stateN)] || "UNKNOWN";
    const priceEth  = parseFloat(ethers.formatEther(curPrice));
    const depEth    = parseFloat(ethers.formatEther(totalDep));
    const covEth    = parseFloat(ethers.formatEther(totalCov));
    const freeEth   = parseFloat(ethers.formatEther(freeCap));
    const premEth   = parseFloat(ethers.formatEther(totalPrem));

    const threshold = Number(depThr) / 10000;
    const pricePct  = (priceEth * 100).toFixed(2);
    const thrPct    = (threshold * 100).toFixed(0);

    const prevState = document.getElementById("state-badge").textContent;
    const badge = document.getElementById("state-badge");
    badge.textContent = stateStr;
    badge.className = `state-badge state-${stateStr}`;
    currentPoolState = stateStr;
    if (prevState === "TRIGGERED" && stateStr === "OPEN") {
      log("Pool OPEN, all policies settled. New policies can be opened.", "ok");
    }

    const pe = document.getElementById("stat-price");
    pe.textContent = `${pricePct}%`;
    pe.className = "stat-value " +
      (priceEth >= threshold + 0.02 ? "price-ok"
      : priceEth >= threshold ? "price-warn"
      : "price-bad");

    document.getElementById("stat-threshold").textContent = `${thrPct}%`;
    document.getElementById("stat-deposited").textContent = `${depEth.toFixed(4)} ETH`;
    document.getElementById("stat-free").textContent      = `${freeEth.toFixed(4)} ETH`;
    document.getElementById("stat-covered").textContent   = `${covEth.toFixed(4)} ETH`;
    document.getElementById("stat-premiums").textContent  = `${premEth.toFixed(4)} ETH`;

    const util = depEth > 0 ? (covEth / depEth * 100).toFixed(1) : 0;
    document.getElementById("util-label").textContent = `${util}%`;

    updateQuote();
    await refreshSellers(Number(selCount));
    await refreshPolicies(Number(polCount));

  } catch (e) {
    log("Refresh error: " + e.message, "err");
    console.error(e);
  }
}

// render the depositors table, with a Withdraw button on your own row
async function refreshSellers(count) {
  const wrap = document.getElementById("sellers-wrap");
  if (count === 0) { wrap.innerHTML = '<div class="empty-note">No deposits yet</div>'; return; }
  let html = `<table class="data-table"><tr><th>Address</th><th>Deposited (ETH)</th><th></th></tr>`;
  for (let i = 0; i < count; i++) {
    try {
      const addr = await poolContract.sellerList(i);
      const [depWei] = await poolContract.getSellerInfo(addr);
      const isYou = addr.toLowerCase() === walletAddress?.toLowerCase();
      const hasDeposit = depWei > 0n;
      html += `<tr>
        <td>${short(addr)}${isYou ? '<span class="you-badge">YOU</span>' : ''}</td>
        <td>${parseFloat(ethers.formatEther(depWei)).toFixed(4)}</td>
        <td>${isYou && hasDeposit ? `<button class="btn btn-primary btn-sm" onclick="withdraw()">Withdraw</button>` : ''}</td>
      </tr>`;
    } catch {}
  }
  wrap.innerHTML = html + "</table>";
}

// render the policies table and the right action button per row (Settle/Cancel/Expire)
async function refreshPolicies(count) {
  const wrap = document.getElementById("policies-wrap");
  if (count === 0) { wrap.innerHTML = '<div class="empty-note">No policies yet</div>'; return; }
  const nowSec = Math.floor(Date.now() / 1000);
  let html = `<table class="data-table"><tr><th>#</th><th>Buyer</th><th>Coverage</th><th>Expires</th><th>State</th><th></th></tr>`;
  for (let i = 0; i < count; i++) {
    try {
      const [buyer, coverageWei, premWei, expiryBN, stN] = await poolContract.getPolicy(i);
      const stStr = POLICY_STATES[Number(stN)] || "UNKNOWN";
      const isYou = buyer.toLowerCase() === walletAddress?.toLowerCase();
      const expirySec = Number(expiryBN);
      const expired   = nowSec >= expirySec;
      const canSettle = stStr === "ACTIVE" && isYou && currentPoolState === "TRIGGERED" && !expired;
      const canCancel = stStr === "ACTIVE" && isYou;
      const canExpire = stStr === "ACTIVE" && !isYou && expired;
      let actionBtns = '';
      if (canSettle) {
        actionBtns = `<button class="btn btn-primary btn-sm" onclick="approveLST()">Approve</button>
                      <button class="btn btn-red btn-sm" style="margin-left:6px;" onclick="settlePolicy(${i})">Settle</button>
                      <button class="btn btn-red btn-sm" style="margin-left:6px;" onclick="cancelPolicy(${i})">Cancel</button>`;
      } else if (canCancel) {
        actionBtns = `<button class="btn btn-red btn-sm" onclick="cancelPolicy(${i})">Cancel</button>`;
      } else if (canExpire) {
        actionBtns = `<button class="btn btn-yellow btn-sm" onclick="expirePolicy(${i})">Expire</button>`;
      }
      const expiryStr = expirySec
        ? new Date(expirySec * 1000).toLocaleString([], { year: '2-digit', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
        : '—';
      html += `<tr>
        <td>${i}</td>
        <td>${short(buyer)}${isYou ? '<span class="you-badge">YOU</span>' : ''}</td>
        <td>${parseFloat(ethers.formatEther(coverageWei)).toFixed(4)}</td>
        <td>${expiryStr}</td>
        <td class="policy-${stStr}">${stStr}</td>
        <td style="white-space:nowrap;">${actionBtns}</td>
      </tr>`;
    } catch (e) { console.error("getPolicy failed for id", i, e); }
  }
  wrap.innerHTML = html + "</table>";
}

// live-update the premium quote as the buyer types a coverage amount
async function updateQuote() {
  if (!poolContract) return;
  try {
    const n = ethers.parseEther(document.getElementById("policy-coverage").value || "0");
    const p = await poolContract.quotePremium(n);
    document.getElementById("premium-quote").textContent = `${parseFloat(ethers.formatEther(p)).toFixed(6)} ETH`;
  } catch {}
}

// log a tx hash, wait for it to mine, then log success and refresh the UI
async function waitTx(tx, msg) {
  log(`Tx: <a class="tx-link" href="https://sepolia.etherscan.io/tx/${tx.hash}" target="_blank">${short(tx.hash)}</a>`, "info");
  await tx.wait(); log(msg, "ok"); refreshAll();
}

// reveal the main pool panel and address bar after contracts load
function showPoolPanel() {
  document.getElementById("pool-panel").style.display = "block";
  document.getElementById("addr-bar").style.display   = "block";
}

// fill the address bar with the pool, oracle, and LST contract addresses
function updateAddrBar() {
  if (poolAddr)   document.getElementById("pool-addr-display").textContent   = poolAddr;
  if (oracleAddr) document.getElementById("oracle-addr-display").textContent = oracleAddr;
  if (lstAddr)    document.getElementById("lst-addr-display").textContent    = lstAddr;
  document.getElementById("addr-bar").style.display = "block";
}

// shorten a long address for display
function short(addr) { return addr ? addr.slice(0,6)+"…"+addr.slice(-4) : "—"; }

// add timestamped line to the transaction log panel
function log(msg, type = "info") {
  const el = document.getElementById("log-entries");
  const now = new Date().toLocaleTimeString("en-GB", { hour12: false });
  const div = document.createElement("div");
  div.className = `log-entry ${type}`;
  div.innerHTML = `<span class="ts">${now}</span><span class="msg">${msg}</span>`;
  el.appendChild(div); el.scrollTop = el.scrollHeight;
}

setInterval(() => { if (poolContract) refreshAll(); }, 20000);
