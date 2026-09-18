// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Factory-only CREATE2 deployment with an immutable address suffix.
/// @dev Token creation code is supplied once at deployment, never embedded in factory runtime.
/// The factory MUST authenticate creator, validate constructor args and atomically initialize/register.
contract OursTokenDeployer is ReentrancyGuard {
    error Unauthorized();
    error InvalidConfiguration();
    error InvalidLaunch();
    error WrongSuffix(address predicted);
    error DeploymentFailed();

    address public immutable factory;
    uint8 public immutable suffixDigits;
    uint160 public immutable suffix;
    uint160 public immutable suffixMask;
    bytes32 public immutable creationCodeHash;
    bytes private tokenCreationCode;

    event TokenDeployed(address indexed token, address indexed creator, bytes32 indexed launchHash,
        bytes32 salt, bytes32 initCodeHash);

    constructor(address factory_, bytes memory creationCode_, uint8 digits_, uint160 suffix_) {
        // Factory is deployed first, then binds this deployer exactly once before enabling launch.
        if (factory_.code.length == 0 || creationCode_.length == 0 || creationCode_.length > 45000
            || digits_ == 0 || digits_ > 8) revert InvalidConfiguration();
        uint160 mask = uint160((uint256(1) << (uint256(digits_) * 4)) - 1);
        if (suffix_ > mask) revert InvalidConfiguration();
        factory = factory_;
        suffixDigits = digits_;
        suffix = suffix_;
        suffixMask = mask;
        tokenCreationCode = creationCode_;
        creationCodeHash = keccak256(creationCode_);
    }

    function initCodeHash(bytes calldata constructorArgs) public view returns (bytes32) {
        return keccak256(_initCode(constructorArgs));
    }

    function effectiveSalt(address creator, bytes32 launchHash, bytes32 nonce) public view returns (bytes32) {
        if (creator == address(0) || launchHash == bytes32(0)) revert InvalidLaunch();
        return keccak256(abi.encode(block.chainid, factory, creator, launchHash, nonce));
    }

    function predict(address creator, bytes32 launchHash, bytes32 nonce, bytes calldata constructorArgs)
        external view returns (address predicted, bool matches) {
        predicted = _predict(effectiveSalt(creator, launchHash, nonce), initCodeHash(constructorArgs));
        matches = uint160(predicted) & suffixMask == suffix;
    }

    function deploy(address creator, bytes32 launchHash, bytes32 nonce, bytes calldata constructorArgs)
        external nonReentrant returns (address token) {
        if (msg.sender != factory) revert Unauthorized();
        bytes memory code = _initCode(constructorArgs);
        bytes32 codeHash = keccak256(code);
        bytes32 salt = effectiveSalt(creator, launchHash, nonce);
        address predicted = _predict(salt, codeHash);
        if (uint160(predicted) & suffixMask != suffix) revert WrongSuffix(predicted);
        assembly ("memory-safe") { token := create2(0, add(code, 32), mload(code), salt) }
        if (token == address(0) || token != predicted || token.code.length == 0) revert DeploymentFailed();
        emit TokenDeployed(token, creator, launchHash, salt, codeHash);
    }

    function _initCode(bytes calldata args) private view returns (bytes memory code) {
        // EIP-3860 initcode limit; supported constructor must be nonpayable.
        if (tokenCreationCode.length + args.length > 49152) revert InvalidLaunch();
        code = abi.encodePacked(tokenCreationCode, args);
    }

    function _predict(bytes32 salt, bytes32 codeHash) private view returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, codeHash)))));
    }
}
