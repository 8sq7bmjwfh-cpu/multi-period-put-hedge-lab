# Multi-Period Put Hedge Lab

这个仓库用于研究“多期滚动 Put 对冲”的效果，重点回答：

- Put 到期后如何继续对冲？
- 不同续保方法的风险收益差异是什么？
- 如何把滚动策略落地为可回测、可可视化的流程？

---

## 已实现的 4 种方法

1. `fixed_roll`（固定续保）
- 持有到期后再开下一期。
- 优点：规则简单，交易频率低。
- 缺点：临近到期保护会衰减。

2. `constant_maturity`（常期限滚动）
- 到期前 `N` 天提前平仓并重建同期限 Put。
- 优点：保持相对稳定的剩余期限暴露。
- 缺点：换仓更频繁，成本更高。

3. `ladder`（阶梯到期）
- 同时持有多个到期桶（如 21/42/63 天），到期后补最远端。
- 优点：平滑单一到期点风险。
- 缺点：管理复杂度更高。

4. `drawdown_trigger`（触发式续保）
- 当标的相对峰值回撤超过阈值，自动切换到更高保护强度（更高 moneyness）。
- 优点：在下行风险放大阶段主动加保。
- 缺点：对阈值参数敏感。

---

## 目录结构

- `multi_period_put_hedge.py`：多期滚动对冲后端仿真（Python）。
- `web/index.html`：前端参数面板。
- `web/app.js`：前端计算与可视化逻辑。
- `web/styles.css`：页面样式。
- `.github/workflows/deploy-pages.yml`：GitHub Pages 自动部署。

---

## 核心实现逻辑

每期循环分四步：

1. 更新标的价格（路径生成或手工输入收益率）。
2. 处理到期期权（行权结算）。
3. 按策略规则决定是否展期/换仓。
4. 记录状态（未对冲 PnL、对冲 PnL、现金账户、期权盯市、交易明细）。

价格路径约定：

- `gbm` 模式下，使用 **100 条几何布朗运动路径的逐期均值** 作为仿真价格路径（可通过参数调整样本数）。
- `gbm_shock` 模式下，先生成 GBM 均值路径，再叠加“回撤冲击”：
  - 冲击开始日 `shock_start_day`
  - 冲击持续天数 `shock_duration_days`
  - 冲击总跌幅 `shock_total_drop`
  - 冲击后修复天数与修复比例（可选）
- `manual` 模式下，按用户输入的每日收益率序列构造价格路径。

输出指标包括：

- 最终对冲 PnL 与最终改进
- 最大损失
- 对冲后 PnL 曲线的 CVaR95
- 下跌损失降幅
- 总开仓成本
- 交易次数
- 若使用 `gbm_shock`，额外输出回撤前/回撤中/回撤后分段指标：
  - 每段平均改进
  - 每段下行损失降幅

---

## 本地运行（后端）

```bash
python multi_period_put_hedge.py \
  --spot-index 8560.84 \
  --path-mode gbm_shock \
  --gbm-path-count 100 \
  --horizon-days 252 \
  --path-drift 0.05 \
  --path-volatility 0.22 \
  --shock-start-day 84 \
  --shock-duration-days 21 \
  --shock-total-drop 0.18 \
  --shock-recovery-days 63 \
  --shock-recovery-ratio 0.5 \
  --portfolio-value 10000000 \
  --portfolio-beta 1.0 \
  --hedge-ratio 1.0 \
  --tenor-days 63 \
  --roll-before-expiry-days 21 \
  --base-moneyness 0.95 \
  --trigger-drawdown 0.08 \
  --trigger-moneyness 1.00 \
  --ladder-days 21,42,63 \
  --methods fixed_roll,constant_maturity,ladder,drawdown_trigger
```

输出到 `outputs/`：

- `price_path.csv`
- `method_summary.csv`
- `shock_info.csv`（仅 `gbm_shock` 模式）
- `outputs/<method>/state_curve.csv`
- `outputs/<method>/trades.csv`

---

## 本地运行（前端）

直接打开：

- `web/index.html`

即可在页面中切换路径、调整策略参数并查看方法对比。

---

## GitHub Pages 部署

仓库已内置工作流：

- `.github/workflows/deploy-pages.yml`

推送 `web/**`、工作流或 `README.md` 变更时自动部署。

网站访问地址：

- https://8sq7bmjwfh-cpu.github.io/multi-period-put-hedge-lab/

部署触发时间（UTC）：2026-04-17
