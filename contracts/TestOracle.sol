// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// pretends to be a Chainlink price feed for the LST / ETH ratio.
// price has 18 decimals: 1e18 means perfect peg (1 LST = 1 ETH), 0.95e18 is 5% depeg
// change this for a real oracle in production.

contract TestOracle {
    int256 private _price;
    uint8 public decimals = 18;
    string public description = "LST / ETH test Price Feed";
    uint256 public version = 1;

    uint80 private _roundId;
    uint256 private _updatedAt;

    event PriceUpdated(int256 newPrice, uint256 timestamp);

    constructor(int256 initialPrice) {
        _price = initialPrice;
        _updatedAt = block.timestamp;
        _roundId = 1;
    }

    // anyone can push a new price. used for simulating a depeg in the demo.
    function setPrice(int256 newPrice) external {
        require(newPrice > 0, "Price must be positive");
        _price = newPrice;
        _updatedAt = block.timestamp;
        _roundId++;
        emit PriceUpdated(newPrice, block.timestamp);
    }

    // matches the Chainlink AggregatorV3 shape so the pool can call it the same way.
    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        )
    {
        return (_roundId, _price, _updatedAt, _updatedAt, _roundId);
    }

    function latestAnswer() external view returns (int256) {
        return _price;
    }
}
