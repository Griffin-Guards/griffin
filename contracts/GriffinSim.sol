// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// Griffin's simulator. Never deployed: the worker places this code at a spare address in an eth_call state override
// and marks that address as an enabled module of the Safe, then runs the agent's move through the Safe and reads
// what left and arrived. Nothing here is ever sent on chain.

interface ISafeSim {
    function execTransactionFromModuleReturnData(address to, uint256 value, bytes calldata data, uint8 operation)
        external
        returns (bool success, bytes memory returnData);
}

interface IERC20Balance {
    function balanceOf(address who) external view returns (uint256);
}

contract GriffinSim {
    function simulate(address safe, address to, uint256 value, bytes calldata data, address[] calldata tokens)
        external
        returns (bool ok, bytes memory ret, int256 ethDelta, int256[] memory tokenDeltas)
    {
        uint256 e0 = safe.balance;
        uint256[] memory b0 = new uint256[](tokens.length);
        for (uint256 i; i < tokens.length; i++) b0[i] = _bal(tokens[i], safe);
        (ok, ret) = ISafeSim(safe).execTransactionFromModuleReturnData(to, value, data, 0);
        ethDelta = int256(safe.balance) - int256(e0);
        tokenDeltas = new int256[](tokens.length);
        for (uint256 i; i < tokens.length; i++) tokenDeltas[i] = int256(_bal(tokens[i], safe)) - int256(b0[i]);
    }

    function _bal(address token, address who) private view returns (uint256 b) {
        (bool ok, bytes memory r) = token.staticcall(abi.encodeCall(IERC20Balance.balanceOf, (who)));
        if (ok && r.length >= 32) b = abi.decode(r, (uint256));
    }
}
