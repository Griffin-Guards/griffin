// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// Plain ERC-20 for the fork tests.
contract MockToken {
    string public name = "Mock";
    string public symbol = "MOCK";
    uint8 public decimals = 18;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function transfer(address to, uint256 amount) external returns (bool) { return _move(msg.sender, to, amount); }
    function approve(address spender, uint256 amount) external returns (bool) { allowance[msg.sender][spender] = amount; return true; }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        return _move(from, to, amount);
    }
    function _move(address from, address to, uint256 amount) private returns (bool) {
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

// Stands in for a DEX: pulls tokens it was approved for, pays ETH back.
contract MockRouter {
    function sell(address token, uint256 amount, uint256 ethOut) external {
        MockToken(token).transferFrom(msg.sender, address(this), amount);
        payable(msg.sender).transfer(ethOut);
    }
    receive() external payable {}
}
