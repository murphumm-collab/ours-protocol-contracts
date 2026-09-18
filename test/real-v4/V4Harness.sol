// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {SwapParams,ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BalanceDelta,BalanceDeltaLibrary} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {Currency,CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
interface ITestERC20 {function transferFrom(address,address,uint256) external returns(bool);}
/// @dev Test-only liquidity provider and external trader; actual AMM is official PoolManager.
contract V4Harness {
    using BalanceDeltaLibrary for BalanceDelta;using PoolIdLibrary for PoolKey;using StateLibrary for IPoolManager;
    IPoolManager public immutable manager;
    constructor(IPoolManager m){manager=m;}
    receive()external payable{}
    function seed(PoolKey calldata key,uint128 liquidity) external payable {
        manager.unlock(abi.encode(msg.sender,key,true,int256(uint256(liquidity)),uint160(0),false,bytes32(0)));_refund();
    }
    function trade(PoolKey calldata key,bool zeroForOne,uint256 amount,uint160 limit) external payable {
        manager.unlock(abi.encode(msg.sender,key,false,-int256(amount),limit,zeroForOne,bytes32(0)));_refund();
    }
    function remove(PoolKey calldata key,uint128 liquidity,bytes32 salt) external {
        manager.unlock(abi.encode(msg.sender,key,true,-int256(uint256(liquidity)),uint160(0),false,salt));
    }
    function _refund()private {if(address(this).balance>0){(bool ok,)=msg.sender.call{value:address(this).balance}("");require(ok);}}
    function unlockCallback(bytes calldata data)external returns(bytes memory){
        require(msg.sender==address(manager));(address payer,PoolKey memory key,bool seed_,int256 amount,uint160 limit,bool zeroForOne,bytes32 salt)=abi.decode(data,(address,PoolKey,bool,int256,uint160,bool,bytes32));
        BalanceDelta d;if(seed_)(d,)=manager.modifyLiquidity(key,ModifyLiquidityParams(-600,600,amount,salt),"");else d=manager.swap(key,SwapParams(zeroForOne,amount,limit),"");
        _settle(key.currency0,payer,d.amount0());_settle(key.currency1,payer,d.amount1());return "";
    }
    function _settle(Currency currency,address payer,int128 delta)private {
        address token=Currency.unwrap(currency);
        if(delta<0){uint256 amount=uint256(-int256(delta));manager.sync(currency);if(token==address(0))manager.settle{value:amount}();else{require(ITestERC20(token).transferFrom(payer,address(manager),amount));manager.settle();}}
        else if(delta>0)manager.take(currency,payer,uint128(delta));
    }
    function liquidityOf(PoolKey memory key,address who,int24 lower,int24 upper,bytes32 salt)external view returns(uint128){(uint128 liquidity,,)=manager.getPositionInfo(key.toId(),who,lower,upper,salt);return liquidity;}
}
/// @dev Hook deliberately leaves an ERC20 currency synced inside the SAME swap transaction.
contract SyncAfterSwapHook {
    function afterSwap(address,PoolKey calldata key,SwapParams calldata,BalanceDelta,bytes calldata)external returns(bytes4,int128){
        IPoolManager(msg.sender).sync(key.currency1);return(IHooks.afterSwap.selector,0);
    }
}
