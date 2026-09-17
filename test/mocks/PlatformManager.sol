// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {IPlatformV4Manager} from "../../src/platform/OursPlatformTreasury.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
interface IPlatformCallback {function unlockCallback(bytes calldata data) external returns(bytes memory);}
/// @dev Local settlement model. Not a replacement for actual V4 pool math or hook execution.
contract PlatformManager is IPlatformV4Manager {
    address private locker;address private synced;uint256 private syncedBalance;
    address private asset0;address private asset1;uint256 public fillBps=10000;bool public omitOutput;
    int128 public fee0;int128 public fee1;
    function setFees(int128 a,int128 b) external {fee0=a;fee1=b;}
    mapping(address=>int256) public delta;
    mapping(bytes32=>bool) public initialized;
    mapping(bytes32=>uint256) public positions;
    receive()external payable{}
    function setFill(uint256 bps) external {require(bps<=10000);fillBps=bps;}
    function setOmitOutput(bool value) external {omitOutput=value;}
    modifier onlyLocker(){require(locker==msg.sender&&locker!=address(0));_;}
    function initialize(PoolKey calldata key,uint160 price) external returns(int24){bytes32 id=keccak256(abi.encode(key));require(!initialized[id]&&price>0);initialized[id]=true;return 0;}
    function unlock(bytes calldata data) external returns(bytes memory result){
        require(locker==address(0));locker=msg.sender;result=IPlatformCallback(msg.sender).unlockCallback(data);
        require(delta[asset0]==0&&delta[asset1]==0,"unsettled");locker=address(0);
    }
    function _touch(PoolKey calldata key) private {require(initialized[keccak256(abi.encode(key))]);asset0=key.currency0;asset1=key.currency1;}
    function _pack(int128 a,int128 b) private pure returns(int256){return(int256(a)<<128)|int256(uint256(uint128(b)));}
    function swap(PoolKey calldata key,SwapParams calldata params,bytes calldata) external onlyLocker returns(int256){
        _touch(key);require(params.amountSpecified<0);int128 spent=int128(int256(uint256(-params.amountSpecified)*fillBps/10000));
        int128 a=params.zeroForOne?-spent:spent*2;int128 b=params.zeroForOne?spent*2:-spent;delta[asset0]=a;delta[asset1]=b;return _pack(a,b);
    }
    function positionKey(address account,PoolKey calldata key,ModifyLiquidityParams calldata p) public pure returns(bytes32){return keccak256(abi.encode(account,key,p.tickLower,p.tickUpper,p.salt));}
    function modifyLiquidity(PoolKey calldata key,ModifyLiquidityParams calldata p,bytes calldata) external onlyLocker returns(int256,int256){
        _touch(key);bytes32 id=positionKey(msg.sender,key,p);
        if(p.liquidityDelta>0)positions[id]+=uint256(p.liquidityDelta);else positions[id]-=uint256(-p.liquidityDelta);
        if(p.liquidityDelta==0){int128 a=fee0;int128 b=fee1;fee0=0;fee1=0;delta[asset0]=a;delta[asset1]=b;return(_pack(a,b),_pack(a,b));}
        int128 d=-int128(p.liquidityDelta);delta[asset0]=d;delta[asset1]=d;return(_pack(d,d),0);
    }
    function sync(address currency) external onlyLocker {synced=currency;syncedBalance=currency==address(0)?0:IERC20(currency).balanceOf(address(this));}
    function settle() external payable onlyLocker returns(uint256 amount){
        if(synced==address(0))amount=msg.value;else{require(msg.value==0);amount=IERC20(synced).balanceOf(address(this))-syncedBalance;}
        delta[synced]+=int256(amount);synced=address(0);syncedBalance=0;
    }
    function take(address currency,address to,uint256 amount) external onlyLocker {
        require(delta[currency]>=int256(amount));delta[currency]-=int256(amount);if(omitOutput)return;
        if(currency==address(0)){(bool ok,)=to.call{value:amount}("");require(ok);}else require(IERC20(currency).transfer(to,amount));
    }
}
