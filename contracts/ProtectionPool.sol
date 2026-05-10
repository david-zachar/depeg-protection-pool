// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// shared protection pool against LST/LRT depeg events.
// sellers deposit ETH to provide liquidity, buyers pay a premium upfront for a policy.
// if LST depegs and someone calls triggerDepeg, buyers can swap their LST for ETH 1:1
// each policy has its own expiry, after that anyone can mark it expired and free up the capacity
// buyers can also cancel their policy at any time
// sellers can withdraw only when no active policies remain

interface IERC20 {
    function transferFrom(
        address from,
        address to,
        uint256 amount
    ) external returns (bool);

    function transfer(address to, uint256 amount) external returns (bool);

    function balanceOf(address account) external view returns (uint256);

    function allowance(
        address owner,
        address spender
    ) external view returns (uint256);
}

interface IPriceFeed {
    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        );
}

contract ProtectionPool {
    enum PoolState {
        OPEN,
        TRIGGERED
    }
    enum PolicyState {
        ACTIVE,
        SETTLED,
        EXPIRED
    }

    struct Policy {
        address buyer;
        uint256 coverageAmountETH; // ETH the buyer gets if they settle
        uint256 premiumPaid; // what the buyer paid upfront
        uint256 expiry; // policy can be expired after this timestamp
        PolicyState state;
    }

    struct SellerInfo {
        uint256 depositedETH;
        uint256 joinedAt;
        bool exists;
    }

    // pool config. set in the constructor
    address public admin;
    address public lstToken;
    IPriceFeed public priceFeed;

    uint256 public premiumRateBps; // premium = coverage amount * rate / 10000
    uint256 public depegThresholdBps; // e.g. 9500 means depeg = price below 95% of peg
    uint256 public policyDuration; // how long a policy lasts before it can be expired
    uint256 public waitPeriod; // wait time after a depeg before settlement opens

    // pool state
    PoolState public poolState;
    uint256 public totalDeposited;
    uint256 public totalCovered;
    uint256 public totalPremiums;
    uint256 public triggerTimestamp;

    uint256 public policyCount;

    mapping(address => SellerInfo) public sellers;
    address[] public sellerList;

    mapping(uint256 => Policy) public policies;
    uint256[] public policyIds;

    event SellerDeposited(address indexed seller, uint256 amount);
    event SellerWithdrew(address indexed seller, uint256 amount);
    event PolicyOpened(
        uint256 indexed policyId,
        address indexed buyer,
        uint256 coverageAmount,
        uint256 premium,
        uint256 expiry
    );
    event DepegTriggered(uint256 price, uint256 threshold, uint256 timestamp);
    event PolicySettled(
        uint256 indexed policyId,
        address indexed buyer,
        uint256 ethPaid,
        uint256 lstReceived
    );
    event PolicyExpired(uint256 indexed policyId, address indexed caller);
    event PoolReset(uint256 timestamp);

    modifier onlyAdmin() {
        require(msg.sender == admin, "Only admin");
        _;
    }

    modifier poolIsOpen() {
        require(poolState == PoolState.OPEN, "Pool is not open");
        _;
    }

    constructor(
        address _lstToken,
        address _priceFeed,
        uint256 _premiumRateBps,
        uint256 _depegThresholdBps,
        uint256 _policyDurationDays,
        uint256 _waitPeriodHours
    ) {
        require(
            _depegThresholdBps < 10000 && _depegThresholdBps > 0,
            "Invalid threshold"
        );
        require(
            _premiumRateBps > 0 && _premiumRateBps < 10000,
            "Invalid premium rate"
        );
        require(_policyDurationDays > 0, "Invalid policy duration");

        admin = msg.sender;
        lstToken = _lstToken;
        priceFeed = IPriceFeed(_priceFeed);
        premiumRateBps = _premiumRateBps;
        depegThresholdBps = _depegThresholdBps;
        policyDuration = _policyDurationDays * 1 days;
        waitPeriod = _waitPeriodHours * 1 hours;
        poolState = PoolState.OPEN;
    }

    // seller adds ETH to the pool, multiple deposits from the same address stack up
    function deposit() external payable poolIsOpen {
        require(msg.value > 0, "Must deposit > 0");
        require(!_isDepegged(), "Cannot deposit while LST is depegged");

        if (!sellers[msg.sender].exists) {
            sellers[msg.sender] = SellerInfo({
                depositedETH: msg.value,
                joinedAt: block.timestamp,
                exists: true
            });
            sellerList.push(msg.sender);
        } else {
            sellers[msg.sender].depositedETH += msg.value;
        }

        totalDeposited += msg.value;

        emit SellerDeposited(msg.sender, msg.value);
    }

    // seller pulls out their share of ETH and any LST the pool collected from settlements
    // only allowed when NO policies are active
    function withdraw() external {
        SellerInfo storage info = sellers[msg.sender];
        require(info.exists && info.depositedETH > 0, "No deposit found");
        require(activePolicesCount() == 0, "Active policies still exist");

        uint256 sellerDeposit = info.depositedETH;

        uint256 ethShare = (address(this).balance * sellerDeposit) /
            totalDeposited;

        uint256 lstBalance = IERC20(lstToken).balanceOf(address(this));
        uint256 lstShare = (lstBalance * sellerDeposit) / totalDeposited;

        totalDeposited -= sellerDeposit;
        info.depositedETH = 0;

        (bool sent, ) = msg.sender.call{value: ethShare}("");
        require(sent, "ETH withdraw failed");

        if (lstShare > 0) {
            bool lstSent = IERC20(lstToken).transfer(msg.sender, lstShare);
            require(lstSent, "LST withdraw failed");
        }

        emit SellerWithdrew(msg.sender, ethShare);
    }

    // buyer opens a new policy. they pay the premium upfront
    function openPolicy(uint256 coverageAmountETH) external payable poolIsOpen {
        require(coverageAmountETH > 0, "Coverage amount must be > 0");
        require(msg.sender != address(0), "Invalid buyer");
        require(!_isDepegged(), "Cannot open policy while LST is depegged");

        uint256 freeCapacityAmt = totalDeposited - totalCovered;
        require(
            coverageAmountETH <= freeCapacityAmt,
            "Insufficient pool capacity"
        );

        uint256 requiredPremium = (coverageAmountETH * premiumRateBps) / 10000;
        require(msg.value == requiredPremium, "Incorrect premium amount");

        uint256 policyId = policyCount++;
        uint256 expiry = block.timestamp + policyDuration;
        policies[policyId] = Policy({
            buyer: msg.sender,
            coverageAmountETH: coverageAmountETH,
            premiumPaid: requiredPremium,
            expiry: expiry,
            state: PolicyState.ACTIVE
        });
        policyIds.push(policyId);

        totalCovered += coverageAmountETH;
        totalPremiums += requiredPremium;

        emit PolicyOpened(
            policyId,
            msg.sender,
            coverageAmountETH,
            requiredPremium,
            expiry
        );
    }

    // anyone can make the pool state TRIGGERED if the oracle is below the threshold
    function triggerDepeg() external {
        require(poolState == PoolState.OPEN, "Pool already triggered");

        uint256 currentPrice = getPrice();
        uint256 threshold = (1e18 * depegThresholdBps) / 10000;

        require(currentPrice < threshold, "Price above threshold");

        poolState = PoolState.TRIGGERED;
        triggerTimestamp = block.timestamp;

        emit DepegTriggered(currentPrice, threshold, block.timestamp);
    }

    // buyer swaps their LST for ETH at 1:1. needs to allow LST spending
    function settlePolicy(uint256 policyId) external {
        require(poolState == PoolState.TRIGGERED, "Pool not triggered");
        require(
            block.timestamp >= triggerTimestamp + waitPeriod,
            "Wait period has not passed"
        );

        Policy storage policy = policies[policyId];
        require(policy.buyer == msg.sender, "Not your policy");
        require(policy.state == PolicyState.ACTIVE, "Policy not active");

        uint256 lstAmount = policy.coverageAmountETH;

        bool received = IERC20(lstToken).transferFrom(
            msg.sender,
            address(this),
            lstAmount
        );
        require(received, "LST transfer failed, did you approve()?");

        policy.state = PolicyState.SETTLED;
        totalCovered -= policy.coverageAmountETH;

        (bool sent, ) = msg.sender.call{value: policy.coverageAmountETH}("");
        require(sent, "ETH transfer to buyer failed");

        emit PolicySettled(
            policyId,
            msg.sender,
            policy.coverageAmountETH,
            lstAmount
        );

        // if every policy is done and price is back at peg, change the pool back to OPEN
        if (activePolicesCount() == 0 && getPrice() >= 1e18) {
            _resetPool();
        }
    }

    // anyone can call this once the policy is past its expiry timestamp
    // buyer keeps their LST, premium stays in the pool, capacity goes back to sellers
    function expirePolicy(uint256 policyId) external {
        Policy storage policy = policies[policyId];
        require(policy.state == PolicyState.ACTIVE, "Policy not active");
        require(block.timestamp >= policy.expiry, "Policy not yet expirable");

        policy.state = PolicyState.EXPIRED;
        totalCovered -= policy.coverageAmountETH;

        emit PolicyExpired(policyId, msg.sender);
    }

    // buyer can cancel their own policy any time, they lose the premium but keep the LST
    function cancelPolicy(uint256 policyId) external {
        Policy storage policy = policies[policyId];
        require(policy.buyer == msg.sender, "Not your policy");
        require(policy.state == PolicyState.ACTIVE, "Policy not active");

        policy.state = PolicyState.EXPIRED;
        totalCovered -= policy.coverageAmountETH;

        emit PolicyExpired(policyId, msg.sender);
    }

    // anyone can reset the pool back to OPEN once the depeg is over and no policies are active
    function recoverPool() external {
        require(poolState == PoolState.TRIGGERED, "Pool not triggered");
        require(activePolicesCount() == 0, "Active policies still exist");
        require(getPrice() >= 1e18, "Price has not recovered to peg");
        _resetPool();
    }

    function _resetPool() internal {
        poolState = PoolState.OPEN;
        triggerTimestamp = 0;
        emit PoolReset(block.timestamp);
    }

    function _isDepegged() internal view returns (bool) {
        (, int256 answer, , , ) = priceFeed.latestRoundData();
        if (answer <= 0) return false;
        uint256 threshold = (1e18 * depegThresholdBps) / 10000;
        return uint256(answer) < threshold;
    }

    // current oracle price
    function getPrice() public view returns (uint256) {
        (, int256 answer, , , ) = priceFeed.latestRoundData();
        require(answer > 0, "Invalid oracle price");
        return uint256(answer);
    }

    function isDepegged() external view returns (bool) {
        uint256 price = getPrice();
        uint256 threshold = (1e18 * depegThresholdBps) / 10000;
        return price < threshold;
    }

    function freeCapacity() external view returns (uint256) {
        return totalDeposited - totalCovered;
    }

    function quotePremium(
        uint256 coverageAmountETH
    ) external view returns (uint256) {
        return (coverageAmountETH * premiumRateBps) / 10000;
    }

    function activePolicesCount() public view returns (uint256 count) {
        for (uint256 i = 0; i < policyIds.length; i++) {
            if (policies[policyIds[i]].state == PolicyState.ACTIVE) {
                count++;
            }
        }
    }

    function sellerCount() external view returns (uint256) {
        return sellerList.length;
    }

    function getPoolConfig()
        external
        view
        returns (
            uint256 _premiumRateBps,
            uint256 _depegThresholdBps,
            uint256 _policyDuration,
            uint256 _waitPeriod
        )
    {
        return (premiumRateBps, depegThresholdBps, policyDuration, waitPeriod);
    }

    function getPoolState()
        external
        view
        returns (
            uint8 _poolState,
            uint256 _totalDeposited,
            uint256 _totalCovered,
            uint256 _freeCapacity,
            uint256 _totalPremiums,
            uint256 _triggerTimestamp,
            uint256 _currentPrice,
            uint256 _policyCount,
            uint256 _sellerCount,
            uint256 _contractBalance
        )
    {
        return (
            uint8(poolState),
            totalDeposited,
            totalCovered,
            totalDeposited - totalCovered,
            totalPremiums,
            triggerTimestamp,
            getPrice(),
            policyCount,
            sellerList.length,
            address(this).balance
        );
    }

    function getPolicy(
        uint256 policyId
    )
        external
        view
        returns (
            address _buyer,
            uint256 _coverageAmountETH,
            uint256 _premiumPaid,
            uint256 _expiry,
            uint8 _state
        )
    {
        Policy storage p = policies[policyId];
        return (
            p.buyer,
            p.coverageAmountETH,
            p.premiumPaid,
            p.expiry,
            uint8(p.state)
        );
    }

    function getSellerInfo(
        address seller
    ) external view returns (uint256 _depositedETH, bool _exists) {
        return (sellers[seller].depositedETH, sellers[seller].exists);
    }

    receive() external payable {}
}
