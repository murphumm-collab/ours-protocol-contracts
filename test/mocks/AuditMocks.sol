// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IV4Manager} from "../../src/adapters/OursV4Adapter.sol";
import {MockToken} from "./Mocks.sol";

interface IAuditUnlockCallback {
    function unlockCallback(bytes calldata data) external returns (bytes memory);
}

/// @dev Models the real V4 synced-currency hazard: a hook can leave an ERC20
/// currency synced during swap, so a later native settle must first sync(0).
contract PoisonedSyncV4Manager is IV4Manager {
    bool private unlocked;
    address private synced;

    receive() external payable {}

    function unlock(bytes calldata data) external returns (bytes memory result) {
        require(!unlocked, "locked");
        unlocked = true;
        result = IAuditUnlockCallback(msg.sender).unlockCallback(data);
        unlocked = false;
    }

    function swap(PoolKey calldata, SwapParams calldata params, bytes calldata)
        external returns (int256 packed)
    {
        require(unlocked && params.amountSpecified < 0, "bad swap");
        // Simulates beforeSwap/afterSwap calling PoolManager.sync(ERC20).
        synced = address(0xBEEF);
        int128 spent = int128(int256(uint256(-params.amountSpecified)));
        int128 output = spent * 2;
        int128 amount0 = params.zeroForOne ? -spent : output;
        int128 amount1 = params.zeroForOne ? output : -spent;
        packed = (int256(amount0) << 128) | int256(uint256(uint128(amount1)));
    }

    function sync(address currency) external { synced = currency; }

    function settle() external payable returns (uint256 amount) {
        // Mirrors V4's NonzeroNativeValue branch when an ERC20 remains synced.
        require(synced == address(0) || msg.value == 0, "NonzeroNativeValue");
        amount = msg.value;
        synced = address(0);
    }

    function take(address currency, address to, uint256 amount) external {
        require(unlocked, "locked");
        MockToken(currency).mint(to, amount);
    }
}
