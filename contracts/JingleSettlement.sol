// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// Minimal ERC-20 surface we need (USDC on mainnet, TestUSD on testnet).
interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/**
 * JingleSettlement - merchant payouts and the dispute reserve, on Monad.
 *
 * One payment = one settle() call from the Jingle treasury (the operator):
 *   net  -> merchant wallet            (the studio is paid now, in a dollar token)
 *   fee  -> this contract's reserve    (Jingle's take, held on-chain as the dispute reserve)
 *
 * A Reg E dispute or a post-settlement ACH return = absorbDispute(): the reserve refills the treasury
 * for the amount Jingle fronted. The merchant is never debited; that is the chargeback guarantee, enforced here.
 *
 * Everything is keyed by the off-chain payment id (keccak256 of the PaymentIntent id) so the ledger in the
 * engine and the events on-chain reconcile one to one.
 */
contract JingleSettlement {
    struct Settlement {
        address merchant;
        uint256 net;
        uint256 fee;
        uint64 settledAt;
        bool disputed;
    }

    IERC20 public immutable usd;
    address public operator;
    uint256 public reserve;
    uint256 public totalSettled;
    uint256 public totalDisputed;
    mapping(bytes32 => Settlement) public settlements;

    event Settled(bytes32 indexed paymentId, address indexed merchant, uint256 net, uint256 fee, uint256 reserveAfter);
    event DisputeAbsorbed(bytes32 indexed paymentId, address indexed merchant, uint256 amount, uint256 reserveAfter);
    event ReserveFunded(address indexed from, uint256 amount, uint256 reserveAfter);
    event OperatorChanged(address indexed previous, address indexed next);

    error NotOperator();
    error AlreadySettled(bytes32 paymentId);
    error UnknownPayment(bytes32 paymentId);
    error AlreadyDisputed(bytes32 paymentId);
    error ReserveTooLow(uint256 reserve, uint256 needed);
    error ZeroAddress();
    error TransferFailed();

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    constructor(IERC20 usd_, address operator_) {
        if (address(usd_) == address(0) || operator_ == address(0)) revert ZeroAddress();
        usd = usd_;
        operator = operator_;
    }

    /// Pay the merchant now. Fee stays here as reserve. Idempotent per paymentId (a retry cannot double-pay).
    function settle(bytes32 paymentId, address merchant, uint256 net, uint256 fee) external onlyOperator {
        if (merchant == address(0)) revert ZeroAddress();
        if (settlements[paymentId].settledAt != 0) revert AlreadySettled(paymentId);

        settlements[paymentId] = Settlement({merchant: merchant, net: net, fee: fee, settledAt: uint64(block.timestamp), disputed: false});
        reserve += fee;
        totalSettled += net;

        if (!usd.transferFrom(msg.sender, merchant, net)) revert TransferFailed();
        if (fee > 0 && !usd.transferFrom(msg.sender, address(this), fee)) revert TransferFailed();

        emit Settled(paymentId, merchant, net, fee, reserve);
    }

    /// Top up the reserve from the treasury (the float Jingle holds against disputes).
    function fundReserve(uint256 amount) external onlyOperator {
        reserve += amount;
        if (!usd.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        emit ReserveFunded(msg.sender, amount, reserve);
    }

    /// A dispute landed after the merchant was paid. The reserve makes the treasury whole; the merchant keeps the funds.
    function absorbDispute(bytes32 paymentId, uint256 amount) external onlyOperator {
        Settlement storage s = settlements[paymentId];
        if (s.settledAt == 0) revert UnknownPayment(paymentId);
        if (s.disputed) revert AlreadyDisputed(paymentId);
        if (reserve < amount) revert ReserveTooLow(reserve, amount);

        s.disputed = true;
        reserve -= amount;
        totalDisputed += amount;

        if (!usd.transfer(operator, amount)) revert TransferFailed();

        emit DisputeAbsorbed(paymentId, s.merchant, amount, reserve);
    }

    function setOperator(address next) external onlyOperator {
        if (next == address(0)) revert ZeroAddress();
        emit OperatorChanged(operator, next);
        operator = next;
    }
}
