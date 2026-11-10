// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// GRIFFIN on Robinhood Chain: a Safe module that lets an AI agent spend from a Safe only inside the owner's charter.
//
// The owner stays the Safe's owner and keeps every power a Safe owner has. The agent is not a Safe owner: it can only
// call execute() here. Each move must
//   - come from the agent the Safe named,
//   - carry a fresh EIP-712 signature from the Safe's Griffin key (Griffin simulates the move before it signs),
//   - fit the charter the Safe itself wrote: ETH per move and per day, recipients, token limits, contracts it may call.
// The charter is enforced here, on chain, so even a leaked Griffin key can't move more than the charter allows.
//
// The Safe writes its charter with its own transaction (msg.sender == safe), so only the owner can change it.
// Dismissing Griffin: setGriffin(address(0)) leaves the on-chain charter alone in charge; disableModule on the Safe
// stops the agent entirely. Both are ordinary owner transactions with no vote from anyone else.

interface ISafe {
    function execTransactionFromModuleReturnData(address to, uint256 value, bytes calldata data, uint8 operation)
        external
        returns (bool success, bytes memory returnData);
    function enableModule(address module) external;
}

contract GriffinModule {
    string public constant NAME = "GRIFFIN";
    string public constant VERSION = "1";
    bytes32 public constant MOVE_TYPEHASH =
        keccak256("Move(address safe,address to,uint256 value,bytes32 dataHash,uint256 nonce,uint256 deadline)");
    address public constant ETH = address(0);

    bytes4 private constant TRANSFER = 0xa9059cbb; // transfer(address,uint256)
    bytes4 private constant APPROVE = 0x095ea7b3; // approve(address,uint256)

    address public immutable SELF;
    bytes32 private immutable DOMAIN_SEPARATOR_;

    struct Charter {
        address agent;
        address griffin; // address(0): no co-signature, the on-chain charter alone
        uint128 ethPerMove;
        uint128 ethPerDay;
        uint64 version; // bumped by every setCharter, so old lists stop counting
    }

    struct Limit {
        uint128 perMove;
        uint128 perDay;
    }

    mapping(address => Charter) public charters;
    mapping(address => uint256) public nonces;
    // keyed by keccak256(safe, version, address)
    mapping(bytes32 => bool) private recipient_;
    mapping(bytes32 => bool) private target_;
    mapping(bytes32 => Limit) private limit_;
    // keyed by keccak256(safe, asset, day); asset ETH = address(0)
    mapping(bytes32 => uint256) private spent_;

    // the whole charter is in the event, so anyone can read what a Safe allows without trusting Griffin's server
    event CharterSet(
        address indexed safe,
        uint64 version,
        address agent,
        address griffin,
        uint128 ethPerMove,
        uint128 ethPerDay,
        address[] recipients,
        address[] tokens,
        Limit[] limits,
        address[] targets
    );
    event AgentSet(address indexed safe, address agent);
    event GriffinSet(address indexed safe, address griffin);
    event Moved(address indexed safe, uint256 indexed nonce, address to, uint256 value, bytes4 selector);

    error NotSafe();
    error NotAgent();
    error Expired();
    error BadSignature();
    error SelfCall();
    error NotRecipient(address to);
    error NotAllowed(address to, bytes4 selector);
    error OverMove(address asset, uint256 amount, uint256 limit);
    error OverDay(address asset, uint256 total, uint256 limit);
    error MoveFailed(bytes returnData);
    error OnlyDelegateCall();
    error BadLists();

    constructor() {
        SELF = address(this);
        DOMAIN_SEPARATOR_ = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(NAME)),
                keccak256(bytes(VERSION)),
                block.chainid,
                address(this)
            )
        );
    }

    // ---- set up, called by the Safe -------------------------------------------------------------------------

    /// @notice Write a new charter for msg.sender (the Safe). Earlier recipients, targets and token limits stop counting.
    /// @param tokens and limits go in pairs. targets are contracts the agent may call with data, and spenders it may approve.
    function setCharter(
        address agent,
        address griffin,
        uint128 ethPerMove,
        uint128 ethPerDay,
        address[] calldata recipients,
        address[] calldata tokens,
        Limit[] calldata limits,
        address[] calldata targets
    ) public {
        address safe = msg.sender;
        if (tokens.length != limits.length) revert BadLists();
        Charter storage c = charters[safe];
        uint64 v = c.version + 1;
        charters[safe] = Charter(agent, griffin, ethPerMove, ethPerDay, v);
        for (uint256 i; i < recipients.length; i++) recipient_[_key(safe, v, recipients[i])] = true;
        for (uint256 i; i < targets.length; i++) target_[_key(safe, v, targets[i])] = true;
        for (uint256 i; i < tokens.length; i++) limit_[_key(safe, v, tokens[i])] = limits[i];
        emit CharterSet(safe, v, agent, griffin, ethPerMove, ethPerDay, recipients, tokens, limits, targets);
    }

    /// @notice Swap the agent key, keeping the charter.
    function setAgent(address agent) external {
        charters[msg.sender].agent = agent;
        emit AgentSet(msg.sender, agent);
    }

    /// @notice Change or remove (address(0)) the co-signer, keeping the charter.
    function setGriffin(address griffin) external {
        charters[msg.sender].griffin = griffin;
        emit GriffinSet(msg.sender, griffin);
    }

    /// @notice For Safe.setup(to = this module, data = setupSafe(...)): runs as a delegatecall inside the new Safe,
    /// enables this module and writes the first charter in the same transaction that creates the Safe.
    function setupSafe(
        address agent,
        address griffin,
        uint128 ethPerMove,
        uint128 ethPerDay,
        address[] calldata recipients,
        address[] calldata tokens,
        Limit[] calldata limits,
        address[] calldata targets
    ) external {
        if (address(this) == SELF) revert OnlyDelegateCall();
        ISafe(address(this)).enableModule(SELF);
        GriffinModule(SELF).setCharter(agent, griffin, ethPerMove, ethPerDay, recipients, tokens, limits, targets);
    }

    // ---- the agent's move ---------------------------------------------------------------------------------------

    /// @notice The agent moves funds out of `safe`. Reverts unless the move fits the charter and Griffin signed it.
    function execute(address safe, address to, uint256 value, bytes calldata data, uint256 deadline, bytes calldata signature)
        external
        returns (bytes memory)
    {
        Charter memory c = charters[safe];
        if (c.agent == address(0) || msg.sender != c.agent) revert NotAgent();
        if (block.timestamp > deadline) revert Expired();
        uint256 nonce = nonces[safe]++;
        if (c.griffin != address(0)) {
            bytes32 digest = moveDigest(safe, to, value, data, nonce, deadline);
            if (_recover(digest, signature) != c.griffin) revert BadSignature();
        }
        bytes4 selector = _check(safe, c, to, value, data);
        (bool ok, bytes memory ret) = ISafe(safe).execTransactionFromModuleReturnData(to, value, data, 0);
        if (!ok) revert MoveFailed(ret);
        emit Moved(safe, nonce, to, value, selector);
        return ret;
    }

    function _check(address safe, Charter memory c, address to, uint256 value, bytes calldata data)
        internal
        returns (bytes4 selector)
    {
        // a call to the Safe or to this module would run as the Safe itself: add owners, rewrite the charter
        if (to == safe || to == SELF) revert SelfCall();
        if (value > 0) _spend(safe, ETH, value, c.ethPerMove, c.ethPerDay);
        if (data.length == 0) {
            if (!recipient_[_key(safe, c.version, to)] && !target_[_key(safe, c.version, to)]) revert NotRecipient(to);
            return bytes4(0);
        }
        selector = data.length >= 4 ? bytes4(data[:4]) : bytes4(0);
        Limit memory l = limit_[_key(safe, c.version, to)];
        if (l.perMove != 0 || l.perDay != 0) {
            // `to` is a listed token: only plain transfers to recipients and approvals of listed contracts
            if (data.length < 68) revert NotAllowed(to, selector);
            (address who, uint256 amount) = abi.decode(data[4:68], (address, uint256));
            if (selector == TRANSFER) {
                if (!recipient_[_key(safe, c.version, who)]) revert NotRecipient(who);
            } else if (selector == APPROVE) {
                if (!target_[_key(safe, c.version, who)]) revert NotAllowed(who, selector);
            } else {
                revert NotAllowed(to, selector);
            }
            _spend(safe, to, amount, l.perMove, l.perDay);
            return selector;
        }
        if (!target_[_key(safe, c.version, to)]) revert NotAllowed(to, selector);
    }

    function _spend(address safe, address asset, uint256 amount, uint256 perMove, uint256 perDay) internal {
        if (amount > perMove) revert OverMove(asset, amount, perMove);
        bytes32 k = keccak256(abi.encode(safe, asset, block.timestamp / 1 days));
        uint256 total = spent_[k] + amount;
        if (total > perDay) revert OverDay(asset, total, perDay);
        spent_[k] = total;
    }

    // ---- views --------------------------------------------------------------------------------------------------

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return DOMAIN_SEPARATOR_;
    }

    function moveDigest(address safe, address to, uint256 value, bytes calldata data, uint256 nonce, uint256 deadline)
        public
        view
        returns (bytes32)
    {
        bytes32 h = keccak256(abi.encode(MOVE_TYPEHASH, safe, to, value, keccak256(data), nonce, deadline));
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR_, h));
    }

    function isRecipient(address safe, address who) external view returns (bool) {
        return recipient_[_key(safe, charters[safe].version, who)];
    }

    function isTarget(address safe, address who) external view returns (bool) {
        return target_[_key(safe, charters[safe].version, who)];
    }

    function limitOf(address safe, address token) external view returns (Limit memory) {
        return limit_[_key(safe, charters[safe].version, token)];
    }

    /// @notice Spent today (UTC day) of `asset` (address(0) for ETH).
    function spentToday(address safe, address asset) external view returns (uint256) {
        return spent_[keccak256(abi.encode(safe, asset, block.timestamp / 1 days))];
    }

    // ---- internals ----------------------------------------------------------------------------------------------

    function _key(address safe, uint64 version, address who) private pure returns (bytes32) {
        return keccak256(abi.encode(safe, version, who));
    }

    function _recover(bytes32 digest, bytes calldata sig) private pure returns (address) {
        if (sig.length != 65) return address(0);
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        // reject malleable signatures (upper half s)
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) return address(0);
        if (v < 27) v += 27;
        return ecrecover(digest, v, r, s);
    }
}
