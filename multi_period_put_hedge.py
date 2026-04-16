from __future__ import annotations

import argparse
import csv
import math
import random
from dataclasses import dataclass
from pathlib import Path
from statistics import mean

METHODS = ("fixed_roll", "constant_maturity", "ladder", "drawdown_trigger")


@dataclass
class MarketParams:
    risk_free_rate: float = 0.015
    dividend_yield: float = 0.0
    option_volatility: float = 0.20
    strike_step: float = 100.0
    contract_multiplier: float = 100.0


@dataclass
class HedgeParams:
    portfolio_value: float = 10_000_000
    portfolio_beta: float = 1.0
    hedge_ratio: float = 1.0
    base_moneyness: float = 0.95
    trigger_drawdown: float = 0.08
    trigger_moneyness: float = 1.00
    fee_per_contract: float = 0.0
    slippage_per_contract: float = 0.0


@dataclass
class SimulationParams:
    tenor_months: int = 3
    roll_before_expiry_months: int = 1
    ladder_months: tuple[int, ...] = (1, 2, 3)
    bs_premium_rate: float = 0.0


@dataclass
class OptionLot:
    lot_id: int
    strike: float
    expiry_step: int
    contracts: int
    moneyness: float
    weight: float


def norm_cdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def bs_put_points(
    spot: float,
    strike: float,
    risk_free_rate: float,
    dividend_yield: float,
    volatility: float,
    maturity_years: float,
) -> float:
    if maturity_years <= 0:
        return max(strike - spot, 0.0)
    if volatility <= 0:
        discounted_strike = strike * math.exp(-risk_free_rate * maturity_years)
        discounted_spot = spot * math.exp(-dividend_yield * maturity_years)
        return max(discounted_strike - discounted_spot, 0.0)
    sqrt_t = math.sqrt(maturity_years)
    d1 = (
        math.log(spot / strike)
        + (risk_free_rate - dividend_yield + 0.5 * volatility * volatility) * maturity_years
    ) / (volatility * sqrt_t)
    d2 = d1 - volatility * sqrt_t
    return (
        strike * math.exp(-risk_free_rate * maturity_years) * norm_cdf(-d2)
        - spot * math.exp(-dividend_yield * maturity_years) * norm_cdf(-d1)
    )


def round_to_step(value: float, step: float) -> float:
    if step <= 0:
        raise ValueError("strike_step must be > 0")
    return max(step, round(value / step) * step)


def parse_float_list(text: str) -> list[float]:
    out: list[float] = []
    for item in text.split(","):
        item = item.strip()
        if not item:
            continue
        out.append(float(item))
    return out


def parse_int_list(text: str) -> list[int]:
    out: list[int] = []
    for item in text.split(","):
        item = item.strip()
        if not item:
            continue
        value = int(item)
        if value <= 0:
            raise ValueError("ladder months must be > 0")
        out.append(value)
    if not out:
        raise ValueError("ladder months cannot be empty")
    return sorted(set(out))


def generate_gbm_path(
    spot0: float,
    steps: int,
    annual_drift: float,
    annual_volatility: float,
    seed: int,
) -> list[float]:
    if steps < 1:
        raise ValueError("steps must be >= 1")
    if annual_volatility <= 0:
        raise ValueError("annual_volatility must be > 0")
    rng = random.Random(seed)
    dt = 1.0 / 12.0
    prices = [spot0]
    for _ in range(steps):
        z = rng.gauss(0.0, 1.0)
        growth = math.exp(
            (annual_drift - 0.5 * annual_volatility * annual_volatility) * dt
            + annual_volatility * math.sqrt(dt) * z
        )
        prices.append(prices[-1] * growth)
    return prices


def build_path_from_returns(spot0: float, returns: list[float]) -> list[float]:
    if not returns:
        raise ValueError("manual returns cannot be empty")
    prices = [spot0]
    for r in returns:
        prices.append(prices[-1] * (1.0 + r))
    return prices


def option_mtm_points(lot: OptionLot, spot: float, step: int, market: MarketParams) -> float:
    remaining_steps = lot.expiry_step - step
    if remaining_steps <= 0:
        return max(lot.strike - spot, 0.0)
    return bs_put_points(
        spot=spot,
        strike=lot.strike,
        risk_free_rate=market.risk_free_rate,
        dividend_yield=market.dividend_yield,
        volatility=market.option_volatility,
        maturity_years=remaining_steps / 12.0,
    )


def calc_max_drawdown(curve: list[float]) -> float:
    peak = curve[0]
    mdd = 0.0
    for value in curve:
        peak = max(peak, value)
        mdd = max(mdd, peak - value)
    return mdd


def calc_cvar_loss(curve: list[float], alpha: float = 0.95) -> float:
    losses = sorted([-x for x in curve if x < 0])
    if not losses:
        return 0.0
    tail_count = max(1, math.ceil(len(losses) * (1 - alpha)))
    tail_losses = losses[-tail_count:]
    return mean(tail_losses)


def simulate_method(
    method: str,
    price_path: list[float],
    market: MarketParams,
    hedge: HedgeParams,
    sim: SimulationParams,
) -> tuple[list[dict], list[dict], dict]:
    if method not in METHODS:
        raise ValueError(f"unsupported method: {method}")

    exposure = hedge.portfolio_value * hedge.portfolio_beta
    spot0 = price_path[0]
    peak_spot = spot0
    cash_account = 0.0
    open_lots: list[OptionLot] = []
    state_rows: list[dict] = []
    trade_rows: list[dict] = []
    lot_counter = 1

    ladder_months = tuple(sorted(set(sim.ladder_months)))
    ladder_weight = 1.0 / len(ladder_months)

    def contracts_for_weight(strike: float, weight: float) -> int:
        target_exposure = exposure * hedge.hedge_ratio * weight
        raw = target_exposure / (strike * market.contract_multiplier)
        return max(1, math.ceil(raw))

    def log_trade(
        step: int,
        spot: float,
        action: str,
        reason: str,
        lot: OptionLot,
        premium_points: float,
        cashflow: float,
        exercised: bool,
    ) -> None:
        trade_rows.append(
            {
                "step": step,
                "spot": round(spot, 6),
                "action": action,
                "reason": reason,
                "lot_id": lot.lot_id,
                "strike": round(lot.strike, 6),
                "moneyness": round(lot.moneyness, 6),
                "contracts": lot.contracts,
                "expiry_step": lot.expiry_step,
                "premium_points": round(premium_points, 6),
                "cashflow": round(cashflow, 6),
                "exercised": exercised,
            }
        )

    def open_lot(
        step: int,
        spot: float,
        tenor_months: int,
        moneyness: float,
        weight: float,
        reason: str,
    ) -> None:
        nonlocal cash_account, lot_counter
        strike = round_to_step(spot * moneyness, market.strike_step)
        contracts = contracts_for_weight(strike, weight)
        maturity_years = tenor_months / 12.0
        premium_points = bs_put_points(
            spot=spot,
            strike=strike,
            risk_free_rate=market.risk_free_rate,
            dividend_yield=market.dividend_yield,
            volatility=market.option_volatility,
            maturity_years=maturity_years,
        ) * (1.0 + sim.bs_premium_rate)
        outflow = contracts * (
            premium_points * market.contract_multiplier
            + hedge.fee_per_contract
            + hedge.slippage_per_contract
        )
        lot = OptionLot(
            lot_id=lot_counter,
            strike=strike,
            expiry_step=step + tenor_months,
            contracts=contracts,
            moneyness=moneyness,
            weight=weight,
        )
        lot_counter += 1
        open_lots.append(lot)
        cash_account -= outflow
        log_trade(step, spot, "OPEN", reason, lot, premium_points, -outflow, exercised=False)

    def close_lot(step: int, spot: float, lot: OptionLot, reason: str) -> None:
        nonlocal cash_account
        value_points = option_mtm_points(lot, spot, step, market)
        inflow = lot.contracts * (
            value_points * market.contract_multiplier
            - hedge.fee_per_contract
            - hedge.slippage_per_contract
        )
        cash_account += inflow
        log_trade(step, spot, "CLOSE", reason, lot, value_points, inflow, exercised=False)

    def settle_expired(step: int, spot: float) -> int:
        nonlocal cash_account
        expired = [lot for lot in open_lots if lot.expiry_step <= step]
        for lot in expired:
            payoff_points = max(lot.strike - spot, 0.0)
            inflow = lot.contracts * payoff_points * market.contract_multiplier
            cash_account += inflow
            log_trade(
                step,
                spot,
                "EXPIRE",
                "expiry_settlement",
                lot,
                payoff_points,
                inflow,
                exercised=payoff_points > 0,
            )
            open_lots.remove(lot)
        return len(expired)

    def record_state(step: int, spot: float) -> None:
        unhedged_pnl = exposure * (spot / spot0 - 1.0)
        option_mtm = 0.0
        for lot in open_lots:
            option_mtm += (
                option_mtm_points(lot, spot, step, market)
                * market.contract_multiplier
                * lot.contracts
            )
        hedged_pnl = unhedged_pnl + cash_account + option_mtm
        drawdown_from_peak = spot / peak_spot - 1.0
        state_rows.append(
            {
                "step": step,
                "spot": round(spot, 6),
                "drawdown_from_peak": round(drawdown_from_peak, 8),
                "unhedged_pnl": round(unhedged_pnl, 6),
                "option_mtm": round(option_mtm, 6),
                "cash_account": round(cash_account, 6),
                "hedged_pnl": round(hedged_pnl, 6),
                "improvement": round(hedged_pnl - unhedged_pnl, 6),
                "open_lot_count": len(open_lots),
            }
        )

    if method == "ladder":
        for tenor in ladder_months:
            open_lot(0, spot0, tenor, hedge.base_moneyness, ladder_weight, "init_ladder")
    else:
        open_lot(0, spot0, sim.tenor_months, hedge.base_moneyness, 1.0, "init_single")

    record_state(0, spot0)

    for step in range(1, len(price_path)):
        spot = price_path[step]
        peak_spot = max(peak_spot, spot)
        expired_count = settle_expired(step, spot)

        if method == "fixed_roll":
            if not open_lots:
                open_lot(step, spot, sim.tenor_months, hedge.base_moneyness, 1.0, "roll_after_expiry")

        elif method == "constant_maturity":
            if not open_lots:
                open_lot(step, spot, sim.tenor_months, hedge.base_moneyness, 1.0, "reopen_missing")
            else:
                current = open_lots[0]
                remaining = current.expiry_step - step
                if remaining <= sim.roll_before_expiry_months:
                    close_lot(step, spot, current, "early_roll_constant_maturity")
                    open_lots.remove(current)
                    open_lot(step, spot, sim.tenor_months, hedge.base_moneyness, 1.0, "open_after_early_roll")

        elif method == "ladder":
            for _ in range(expired_count):
                open_lot(
                    step,
                    spot,
                    max(ladder_months),
                    hedge.base_moneyness,
                    ladder_weight,
                    "ladder_replace",
                )

        elif method == "drawdown_trigger":
            drawdown = spot / peak_spot - 1.0
            target_moneyness = (
                hedge.trigger_moneyness
                if drawdown <= -hedge.trigger_drawdown
                else hedge.base_moneyness
            )
            if not open_lots:
                open_lot(step, spot, sim.tenor_months, target_moneyness, 1.0, "reopen_missing")
            else:
                current = open_lots[0]
                remaining = current.expiry_step - step
                trigger_changed = abs(current.moneyness - target_moneyness) > 1e-12
                near_expiry = remaining <= sim.roll_before_expiry_months
                if near_expiry or trigger_changed:
                    reason = "drawdown_regime_roll" if trigger_changed else "early_roll_before_expiry"
                    close_lot(step, spot, current, reason)
                    open_lots.remove(current)
                    open_lot(step, spot, sim.tenor_months, target_moneyness, 1.0, "open_after_trigger")

        record_state(step, spot)

    hedged_curve = [row["hedged_pnl"] for row in state_rows]
    unhedged_curve = [row["unhedged_pnl"] for row in state_rows]
    improvement_curve = [h - u for h, u in zip(hedged_curve, unhedged_curve)]

    worst_unhedged = min(unhedged_curve)
    worst_hedged = min(hedged_curve)
    downside_reduction = 0.0
    if worst_unhedged < 0:
        downside_reduction = 1.0 - abs(worst_hedged) / abs(worst_unhedged)

    up_drag_samples = []
    for u, h in zip(unhedged_curve, hedged_curve):
        if u > 0:
            up_drag_samples.append(u - h)

    total_open_cost = sum(
        -row["cashflow"] for row in trade_rows if row["action"] == "OPEN"
    )

    summary = {
        "method": method,
        "final_spot": round(price_path[-1], 6),
        "final_unhedged_pnl": round(unhedged_curve[-1], 6),
        "final_hedged_pnl": round(hedged_curve[-1], 6),
        "final_improvement": round(improvement_curve[-1], 6),
        "max_drawdown_hedged": round(calc_max_drawdown(hedged_curve), 6),
        "max_loss_hedged": round(abs(worst_hedged), 6),
        "cvar95_loss_hedged": round(calc_cvar_loss(hedged_curve), 6),
        "downside_reduction_ratio": round(downside_reduction, 8),
        "avg_improvement": round(mean(improvement_curve), 6),
        "avg_upside_drag": round(mean(up_drag_samples), 6) if up_drag_samples else 0.0,
        "total_open_cost": round(total_open_cost, 6),
        "trade_count": len(trade_rows),
    }

    return state_rows, trade_rows, summary


def save_csv(path: Path, rows: list[dict], fieldnames: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def run_multi_method_analysis(
    methods: list[str],
    price_path: list[float],
    market: MarketParams,
    hedge: HedgeParams,
    sim: SimulationParams,
) -> dict[str, dict]:
    results: dict[str, dict] = {}
    for method in methods:
        state_rows, trade_rows, summary = simulate_method(method, price_path, market, hedge, sim)
        results[method] = {
            "states": state_rows,
            "trades": trade_rows,
            "summary": summary,
        }
    return results


def validate_inputs(
    spot_index: float,
    methods: list[str],
    market: MarketParams,
    hedge: HedgeParams,
    sim: SimulationParams,
) -> None:
    if spot_index <= 0:
        raise ValueError("spot_index must be > 0")
    if market.option_volatility <= 0:
        raise ValueError("option_volatility must be > 0")
    if market.contract_multiplier <= 0:
        raise ValueError("contract_multiplier must be > 0")
    if hedge.portfolio_value <= 0:
        raise ValueError("portfolio_value must be > 0")
    if hedge.portfolio_beta <= 0:
        raise ValueError("portfolio_beta must be > 0")
    if hedge.hedge_ratio <= 0:
        raise ValueError("hedge_ratio must be > 0")
    if hedge.base_moneyness <= 0:
        raise ValueError("base_moneyness must be > 0")
    if hedge.trigger_moneyness <= 0:
        raise ValueError("trigger_moneyness must be > 0")
    if hedge.trigger_drawdown <= 0:
        raise ValueError("trigger_drawdown must be > 0")
    if sim.tenor_months <= 0:
        raise ValueError("tenor_months must be > 0")
    if sim.roll_before_expiry_months < 0:
        raise ValueError("roll_before_expiry_months must be >= 0")
    if sim.bs_premium_rate <= -1:
        raise ValueError("bs_premium_rate must be > -1")
    if not methods:
        raise ValueError("methods cannot be empty")
    for method in methods:
        if method not in METHODS:
            raise ValueError(f"unsupported method: {method}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Multi-period put hedge simulator with rolling strategies."
    )
    parser.add_argument("--spot-index", type=float, default=8560.84)
    parser.add_argument("--path-mode", choices=["gbm", "manual"], default="gbm")
    parser.add_argument("--manual-returns", type=str, default="")
    parser.add_argument("--horizon-months", type=int, default=24)
    parser.add_argument("--path-drift", type=float, default=0.05)
    parser.add_argument("--path-volatility", type=float, default=0.22)
    parser.add_argument("--seed", type=int, default=42)

    parser.add_argument("--portfolio-value", type=float, default=10_000_000)
    parser.add_argument("--portfolio-beta", type=float, default=1.0)
    parser.add_argument("--hedge-ratio", type=float, default=1.0)

    parser.add_argument("--risk-free-rate", type=float, default=0.015)
    parser.add_argument("--dividend-yield", type=float, default=0.0)
    parser.add_argument("--option-volatility", type=float, default=0.20)
    parser.add_argument("--strike-step", type=float, default=100)
    parser.add_argument("--contract-multiplier", type=float, default=100)
    parser.add_argument("--bs-premium-rate", type=float, default=0.0)

    parser.add_argument("--tenor-months", type=int, default=3)
    parser.add_argument("--roll-before-expiry-months", type=int, default=1)
    parser.add_argument("--base-moneyness", type=float, default=0.95)
    parser.add_argument("--trigger-drawdown", type=float, default=0.08)
    parser.add_argument("--trigger-moneyness", type=float, default=1.00)
    parser.add_argument("--ladder-months", type=str, default="1,2,3")

    parser.add_argument("--fee-per-contract", type=float, default=0.0)
    parser.add_argument("--slippage-per-contract", type=float, default=0.0)

    parser.add_argument(
        "--methods",
        type=str,
        default=",".join(METHODS),
        help="comma separated: fixed_roll,constant_maturity,ladder,drawdown_trigger",
    )
    parser.add_argument("--out-dir", type=Path, default=Path("outputs"))
    return parser


def main() -> None:
    args = build_parser().parse_args()

    methods = [m.strip() for m in args.methods.split(",") if m.strip()]
    ladder_months = tuple(parse_int_list(args.ladder_months))

    market = MarketParams(
        risk_free_rate=args.risk_free_rate,
        dividend_yield=args.dividend_yield,
        option_volatility=args.option_volatility,
        strike_step=args.strike_step,
        contract_multiplier=args.contract_multiplier,
    )
    hedge = HedgeParams(
        portfolio_value=args.portfolio_value,
        portfolio_beta=args.portfolio_beta,
        hedge_ratio=args.hedge_ratio,
        base_moneyness=args.base_moneyness,
        trigger_drawdown=args.trigger_drawdown,
        trigger_moneyness=args.trigger_moneyness,
        fee_per_contract=args.fee_per_contract,
        slippage_per_contract=args.slippage_per_contract,
    )
    sim = SimulationParams(
        tenor_months=args.tenor_months,
        roll_before_expiry_months=args.roll_before_expiry_months,
        ladder_months=ladder_months,
        bs_premium_rate=args.bs_premium_rate,
    )

    validate_inputs(args.spot_index, methods, market, hedge, sim)

    if args.path_mode == "manual":
        returns = parse_float_list(args.manual_returns)
        price_path = build_path_from_returns(args.spot_index, returns)
    else:
        price_path = generate_gbm_path(
            spot0=args.spot_index,
            steps=args.horizon_months,
            annual_drift=args.path_drift,
            annual_volatility=args.path_volatility,
            seed=args.seed,
        )

    results = run_multi_method_analysis(methods, price_path, market, hedge, sim)

    args.out_dir.mkdir(parents=True, exist_ok=True)

    price_rows = []
    for i, spot in enumerate(price_path):
        ret = 0.0 if i == 0 else spot / price_path[i - 1] - 1.0
        price_rows.append({"step": i, "spot": round(spot, 6), "step_return": round(ret, 8)})
    save_csv(args.out_dir / "price_path.csv", price_rows, ["step", "spot", "step_return"])

    summary_rows = []
    for method in methods:
        method_dir = args.out_dir / method
        method_dir.mkdir(parents=True, exist_ok=True)

        states = results[method]["states"]
        trades = results[method]["trades"]
        summary = results[method]["summary"]
        summary_rows.append(summary)

        save_csv(
            method_dir / "state_curve.csv",
            states,
            [
                "step",
                "spot",
                "drawdown_from_peak",
                "unhedged_pnl",
                "option_mtm",
                "cash_account",
                "hedged_pnl",
                "improvement",
                "open_lot_count",
            ],
        )
        save_csv(
            method_dir / "trades.csv",
            trades,
            [
                "step",
                "spot",
                "action",
                "reason",
                "lot_id",
                "strike",
                "moneyness",
                "contracts",
                "expiry_step",
                "premium_points",
                "cashflow",
                "exercised",
            ],
        )

    save_csv(
        args.out_dir / "method_summary.csv",
        summary_rows,
        [
            "method",
            "final_spot",
            "final_unhedged_pnl",
            "final_hedged_pnl",
            "final_improvement",
            "max_drawdown_hedged",
            "max_loss_hedged",
            "cvar95_loss_hedged",
            "downside_reduction_ratio",
            "avg_improvement",
            "avg_upside_drag",
            "total_open_cost",
            "trade_count",
        ],
    )

    print("=" * 96)
    print("多期 Put 对冲滚动分析已完成")
    print("=" * 96)
    print(f"路径模式: {args.path_mode}")
    print(f"情景步数: {len(price_path) - 1}")
    print(f"方法列表: {', '.join(methods)}")
    print(f"输出目录: {args.out_dir.resolve()}")
    print("-" * 96)
    for row in summary_rows:
        print(
            f"{row['method']:<20} "
            f"最终对冲PnL={row['final_hedged_pnl']:>14,.0f}  "
            f"最终改进={row['final_improvement']:>12,.0f}  "
            f"最大损失={row['max_loss_hedged']:>12,.0f}  "
            f"CVaR95={row['cvar95_loss_hedged']:>12,.0f}"
        )


if __name__ == "__main__":
    main()
