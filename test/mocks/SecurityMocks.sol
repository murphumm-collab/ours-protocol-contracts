// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {MockToken} from "./Mocks.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {OursRevenueTypes as T, IOursSwapAdapter} from "../../src/interfaces/IOursRevenue.sol";

/// @dev Local test double: invokes a callback during a token transfer, or skips burn.
contract SecurityToken is MockToken {
    address public callback;
    bool public fakeBurn;
    bool private entered;
    function configure(address target, bool fake) external {callback=target;fakeBurn=fake;}
    function burn(uint256 amount) public override {if(!fakeBurn)super.burn(amount);}
    function _update(address from,address to,uint256 amount) internal override {
        super._update(from,to,amount);
        if(callback!=address(0)&&!entered&&from!=address(0)){
            entered=true;(bool ok,)=callback.call(abi.encodeWithSignature("onTokenTransfer()"));require(ok);entered=false;
        }
    }
}
contract SecurityRecipient {
    address public target; bytes public payload; bool public nestedSucceeded; uint256 public attempts;
    function configure(address t,bytes calldata d) external {target=t;payload=d;}
    function run() external { (bool ok,)=target.call(payload);require(ok); }
    function onTokenTransfer() external {++attempts;(nestedSucceeded,)=target.call(payload);}
}
/// @dev Deliberately bad whitelisted adapter to exercise the pool's own checks.
contract SecurityAdapter is IOursSwapAdapter {
    bool public nestedSucceeded; uint256 public attempts;
    function execute(address,address input,address output,uint256 amount,uint256 minOut,bytes calldata route)
        external payable returns(T.ExecutionResult memory) {
        (uint8 mode,address receiver,address target,bytes memory nested)=abi.decode(route,(uint8,address,address,bytes));
        IERC20(input).transferFrom(msg.sender,receiver,mode==1?amount+1:amount);
        if(mode==2){++attempts;(nestedSucceeded,)=target.call(nested);}
        if(mode!=0)MockToken(output).mint(msg.sender,minOut);
        return T.ExecutionResult(amount,minOut); // Mode 0 claims output it never delivered.
    }
    function drain(address token,address from,address to,uint256 amount) external {IERC20(token).transferFrom(from,to,amount);}
}
