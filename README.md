# Multi-Period Put Hedge Lab

这个仓库用于研究“多期滚动 Put 对冲”的效果，重点回答：

- Put 到期后如何继续对冲？
- 不同续保方法的风险收益差异是什么？
- 如何把滚动策略落地为可回测、可可视化的流程？

---

## 已实现的 4 种方法

1. `fixed_roll`（固定换月）
- 持有到期后再开下一期。
- 优点：规则简单，交易频率低。
- 缺点：临近到期保护会衰减。

2. `constant_maturity`（常期限滚动）
- 到期前 `N` 个月提前平仓并重建同期限 Put。
- 优点：保持相对稳定的剩余期限暴露。
- 缺点：换仓更频繁，成本更高。

3. `ladder`（阶梯到期）
- 同时持有多个到期桶（如 1/2/3 月），到期后补最远端。
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

输出指标包括：

- 最终对冲 PnL 与最终改进
- 最大损失
- 对冲后 PnL 曲线的 CVaR95
- 下跌损失降幅
- 总开仓成本
- 交易次数

---

## 本地运行（后端）

```bash
python multi_period_put_hedge.py \
  --spot-index 8560.84 \
  --path-mode gbm \
  --horizon-months 24 \
  --path-drift 0.05 \
  --path-volatility 0.22 \
  --portfolio-value 10000000 \
  --portfolio-beta 1.0 \
  --hedge-ratio 1.0 \
  --tenor-months 3 \
  --roll-before-expiry-months 1 \
  --base-moneyness 0.95 \
  --trigger-drawdown 0.08 \
  --trigger-moneyness 1.00 \
  --ladder-months 1,2,3 \
  --methods fixed_roll,constant_maturity,ladder,drawdown_trigger
```

输出到 `outputs/`：

- `price_path.csv`
- `method_summary.csv`
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
