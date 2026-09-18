// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {OursTokenDeployer} from "../../src/launch/OursTokenDeployer.sol";
contract LaunchFactoryHarness {
    function launch(OursTokenDeployer d,address creator,bytes32 hash,bytes32 nonce,bytes calldata args,bool fail)
        external returns(address token) {
        token=d.deploy(creator,hash,nonce,args);
        require(!fail,"registration failed");
    }
}
contract ConstructorTokenHarness {
    address public immutable creator;
    uint256 public immutable supply;
    constructor(address c,uint256 s) { require(s > 0); creator=c; supply=s; }
}
contract EmptyRuntimeHarness { constructor() { assembly { return(0,0) } } }
