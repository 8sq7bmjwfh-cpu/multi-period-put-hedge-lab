function toNum(id) {
  return Number(document.getElementById(id).value);
}

function ensureFinite(value, name) {
  if (!Number.isFinite(value)) {
    throw new Error(`${name} 不是有效数字`);
  }
}

function parseFloatList(text) {
  return text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s));
}

function parseIntList(text) {
  const arr = text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s));
  arr.forEach((v) => {
    if (!Number.isInteger(v) || v <= 0) {
      throw new Error("阶梯期限必须是正整数列表，如 21,42,63");
    }
  });
  return [...new Set(arr)].sort((a, b) => a - b);
}

const TRADING_DAYS_PER_YEAR = 252;
const SHOCK_PRESETS = {
  mild: {
    startRatio: 0.38,
    durationRatio: 0.06,
    totalDrop: 0.10,
    recoveryDurationRatio: 0.16,
    recoveryRatio: 0.80,
  },
  moderate: {
    startRatio: 0.33,
    durationRatio: 0.08,
    totalDrop: 0.18,
    recoveryDurationRatio: 0.25,
    recoveryRatio: 0.50,
  },
  extreme: {
    startRatio: 0.28,
    durationRatio: 0.12,
    totalDrop: 0.30,
    recoveryDurationRatio: 0.30,
    recoveryRatio: 0.25,
  },
};
const SHOCK_FIELD_IDS = [
  "shockStartDay",
  "shockDurationDays",
  "shockTotalDrop",
  "shockRecoveryDays",
  "shockRecoveryRatio",
];
let IS_APPLYING_SHOCK_PRESET = false;

function mulberry32(seed) {
  let t = seed >>> 0;
  return function rand() {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function normalFromUniform(rand) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function generateGbmPath(spot0, steps, annualDrift, annualVolatility, seed, pathCount = 100) {
  if (steps < 1) throw new Error("模拟期数必须 >= 1");
  if (annualVolatility <= 0) throw new Error("路径年化波动率必须 > 0");
  if (!Number.isInteger(pathCount) || pathCount < 1) {
    throw new Error("GBM均值样本路径数必须是正整数");
  }
  const dt = 1 / TRADING_DAYS_PER_YEAR;
  const sums = Array.from({ length: steps + 1 }, () => 0);
  for (let p = 0; p < pathCount; p += 1) {
    const rand = mulberry32(Math.floor(seed + p * 100003));
    let spot = spot0;
    sums[0] += spot;
    for (let i = 1; i <= steps; i += 1) {
      const z = normalFromUniform(rand);
      const growth = Math.exp(
        (annualDrift - 0.5 * annualVolatility * annualVolatility) * dt
        + annualVolatility * Math.sqrt(dt) * z
      );
      spot *= growth;
      sums[i] += spot;
    }
  }
  return sums.map((v) => v / pathCount);
}

function buildPathFromReturns(spot0, returns) {
  if (!returns.length) throw new Error("手动收益率序列不能为空");
  const prices = [spot0];
  returns.forEach((r) => {
    prices.push(prices[prices.length - 1] * (1 + r));
  });
  return prices;
}

function applyDrawdownShock(
  pricePath,
  shockStartDay,
  shockDurationDays,
  shockTotalDrop,
  shockRecoveryDays = 0,
  shockRecoveryRatio = 0
) {
  const n = pricePath.length - 1;
  if (n < 1) throw new Error("价格路径至少要包含 1 个模拟日");
  if (!Number.isInteger(shockStartDay) || shockStartDay < 1 || shockStartDay > n) {
    throw new Error("冲击开始日必须在 [1, 模拟天数] 范围内");
  }
  if (!Number.isInteger(shockDurationDays) || shockDurationDays < 1) {
    throw new Error("冲击持续天数必须是正整数");
  }
  const shockEndDay = shockStartDay + shockDurationDays - 1;
  if (shockEndDay > n) {
    throw new Error("冲击窗口超出模拟天数，请缩短持续天数或提前冲击开始日");
  }
  if (!(shockTotalDrop > 0 && shockTotalDrop < 1)) {
    throw new Error("冲击总跌幅必须在 (0,1) 内");
  }
  if (!Number.isInteger(shockRecoveryDays) || shockRecoveryDays < 0) {
    throw new Error("冲击后修复天数必须是非负整数");
  }
  if (!(shockRecoveryRatio >= 0 && shockRecoveryRatio <= 1)) {
    throw new Error("修复比例必须在 [0,1] 内");
  }

  const shocked = [...pricePath];
  const floorFactor = 1 - shockTotalDrop;
  const perDayDropFactor = Math.pow(floorFactor, 1 / shockDurationDays);

  for (let day = shockStartDay; day <= n; day += 1) {
    let factor = floorFactor;
    if (day <= shockEndDay) {
      const k = day - shockStartDay + 1;
      factor = Math.pow(perDayDropFactor, k);
    }
    shocked[day] = pricePath[day] * factor;
  }

  let shockRecoveryEndDay = shockEndDay;
  if (shockRecoveryDays > 0 && shockRecoveryRatio > 0) {
    const recoveryStartDay = shockEndDay + 1;
    shockRecoveryEndDay = Math.min(n, shockEndDay + shockRecoveryDays);
    const recoveredFactor = floorFactor + shockTotalDrop * shockRecoveryRatio;
    for (let day = recoveryStartDay; day <= shockRecoveryEndDay; day += 1) {
      const frac = (day - recoveryStartDay + 1) / shockRecoveryDays;
      const factor = floorFactor + (recoveredFactor - floorFactor) * frac;
      shocked[day] = pricePath[day] * factor;
    }
    for (let day = shockRecoveryEndDay + 1; day <= n; day += 1) {
      shocked[day] = pricePath[day] * recoveredFactor;
    }
  }

  return {
    shockedPath: shocked,
    shockInfo: {
      shockStartDay,
      shockEndDay,
      shockDurationDays,
      shockTotalDrop,
      shockRecoveryDays,
      shockRecoveryRatio,
      shockRecoveryEndDay,
    },
  };
}

function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1 / (1 + p * ax);
  const y = 1 - (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t) * Math.exp(-ax * ax);
  return sign * y;
}

function normCdf(x) {
  return 0.5 * (1 + erf(x / Math.sqrt(2)));
}

function bsPutPoints(spot, strike, r, q, vol, t) {
  if (t <= 0) return Math.max(strike - spot, 0);
  if (vol <= 0) {
    const discountedStrike = strike * Math.exp(-r * t);
    const discountedSpot = spot * Math.exp(-q * t);
    return Math.max(discountedStrike - discountedSpot, 0);
  }
  const sqrtT = Math.sqrt(t);
  const d1 = (Math.log(spot / strike) + (r - q + 0.5 * vol * vol) * t) / (vol * sqrtT);
  const d2 = d1 - vol * sqrtT;
  return strike * Math.exp(-r * t) * normCdf(-d2) - spot * Math.exp(-q * t) * normCdf(-d1);
}

function roundToStep(value, step) {
  if (step <= 0) throw new Error("执行价档位步长必须 > 0");
  return Math.max(step, Math.round(value / step) * step);
}

function optionMtmPoints(lot, spot, step, cfg) {
  const remain = lot.expiryStep - step;
  if (remain <= 0) return Math.max(lot.strike - spot, 0);
  return bsPutPoints(
    spot,
    lot.strike,
    cfg.riskFreeRate,
    cfg.dividendYield,
    cfg.optionVolatility,
    remain / TRADING_DAYS_PER_YEAR
  );
}

function calcMaxDrawdown(curve) {
  let peak = curve[0];
  let mdd = 0;
  curve.forEach((v) => {
    peak = Math.max(peak, v);
    mdd = Math.max(mdd, peak - v);
  });
  return mdd;
}

function calcCvarLoss(curve, alpha = 0.95) {
  const losses = curve.filter((x) => x < 0).map((x) => -x).sort((a, b) => a - b);
  if (!losses.length) return 0;
  const tailCount = Math.max(1, Math.ceil(losses.length * (1 - alpha)));
  const tail = losses.slice(losses.length - tailCount);
  return tail.reduce((acc, x) => acc + x, 0) / tail.length;
}

const METHOD_LABELS = {
  fixed_roll: "固定续保",
  constant_maturity: "常期限滚动",
  ladder: "阶梯到期",
  drawdown_trigger: "触发式续保",
};

const ACTION_LABELS = {
  OPEN: "开仓",
  CLOSE: "平仓",
  EXPIRE: "到期结算",
};

const REASON_LABELS = {
  init_ladder: "初始化阶梯组合",
  init_single: "初始化单笔建仓",
  roll_after_expiry: "到期后续保",
  reopen_missing: "无持仓重建",
  early_roll_constant_maturity: "常期限提前展期",
  open_after_early_roll: "提前展期后开仓",
  ladder_replace: "阶梯到期补仓",
  drawdown_regime_roll: "回撤触发换仓",
  early_roll_before_expiry: "到期前提前展期",
  open_after_trigger: "触发后开仓",
  expiry_settlement: "到期结算",
};

function methodLabel(method) {
  return METHOD_LABELS[method] || method;
}

function actionLabel(action) {
  return ACTION_LABELS[action] || action;
}

function reasonLabel(reason) {
  return REASON_LABELS[reason] || reason;
}

function avg(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

function computePeriodMetrics(states) {
  if (!states.length) {
    return { avgImprovement: 0, downsideReductionRatio: 0 };
  }
  const unhedged = states.map((row) => row.unhedgedPnl);
  const hedged = states.map((row) => row.hedgedPnl);
  const improvements = states.map((row) => row.improvement);
  const worstUnhedged = Math.min(...unhedged);
  const worstHedged = Math.min(...hedged);
  let reduction = 0;
  if (worstUnhedged < 0) {
    reduction = 1 - Math.abs(worstHedged) / Math.abs(worstUnhedged);
  }
  return { avgImprovement: avg(improvements), downsideReductionRatio: reduction };
}

function fillShockPeriodDefaults(summary) {
  summary.preAvgImprovement = 0;
  summary.shockAvgImprovement = 0;
  summary.postAvgImprovement = 0;
  summary.preDownsideReductionRatio = 0;
  summary.shockDownsideReductionRatio = 0;
  summary.postDownsideReductionRatio = 0;
}

function enrichSummaryWithShockPeriods(summary, states, shockStartDay, shockEndDay) {
  const preStates = states.filter((row) => row.step < shockStartDay);
  const shockStates = states.filter((row) => row.step >= shockStartDay && row.step <= shockEndDay);
  const postStates = states.filter((row) => row.step > shockEndDay);

  const pre = computePeriodMetrics(preStates);
  const inShock = computePeriodMetrics(shockStates);
  const post = computePeriodMetrics(postStates);

  summary.preAvgImprovement = pre.avgImprovement;
  summary.shockAvgImprovement = inShock.avgImprovement;
  summary.postAvgImprovement = post.avgImprovement;
  summary.preDownsideReductionRatio = pre.downsideReductionRatio;
  summary.shockDownsideReductionRatio = inShock.downsideReductionRatio;
  summary.postDownsideReductionRatio = post.downsideReductionRatio;
}

function simulateMethod(method, pricePath, cfg) {
  const exposure = cfg.portfolioValue * cfg.portfolioBeta;
  const spot0 = pricePath[0];
  let peakSpot = spot0;
  let cashAccount = 0;
  const openLots = [];
  const states = [];
  const trades = [];
  let lotCounter = 1;

  const ladderWeight = 1 / cfg.ladderDays.length;

  function contractsForWeight(strike, weight) {
    const targetExposure = exposure * cfg.hedgeRatio * weight;
    return Math.max(1, Math.ceil(targetExposure / (strike * cfg.contractMultiplier)));
  }

  function pushTrade(step, spot, action, reason, lot, premiumPoints, cashflow, exercised) {
    trades.push({
      step,
      spot,
      action,
      reason,
      lotId: lot.lotId,
      strike: lot.strike,
      moneyness: lot.moneyness,
      contracts: lot.contracts,
      expiryStep: lot.expiryStep,
      premiumPoints,
      cashflow,
      exercised,
    });
  }

  function openLot(step, spot, tenorDays, moneyness, weight, reason) {
    const strike = roundToStep(spot * moneyness, cfg.strikeStep);
    const contracts = contractsForWeight(strike, weight);
    const premiumPoints =
      bsPutPoints(
        spot,
        strike,
        cfg.riskFreeRate,
        cfg.dividendYield,
        cfg.optionVolatility,
        tenorDays / TRADING_DAYS_PER_YEAR
      ) * (1 + cfg.bsPremiumRate);

    const outflow = contracts * (
      premiumPoints * cfg.contractMultiplier + cfg.feePerContract + cfg.slippagePerContract
    );

    const lot = {
      lotId: lotCounter,
      strike,
      expiryStep: step + tenorDays,
      contracts,
      moneyness,
      weight,
    };
    lotCounter += 1;
    openLots.push(lot);
    cashAccount -= outflow;
    pushTrade(step, spot, "OPEN", reason, lot, premiumPoints, -outflow, false);
  }

  function closeLot(step, spot, lot, reason) {
    const valuePoints = optionMtmPoints(lot, spot, step, cfg);
    const inflow = lot.contracts * (
      valuePoints * cfg.contractMultiplier - cfg.feePerContract - cfg.slippagePerContract
    );
    cashAccount += inflow;
    pushTrade(step, spot, "CLOSE", reason, lot, valuePoints, inflow, false);
  }

  function settleExpired(step, spot) {
    const expired = openLots.filter((lot) => lot.expiryStep <= step);
    expired.forEach((lot) => {
      const payoffPoints = Math.max(lot.strike - spot, 0);
      const inflow = lot.contracts * payoffPoints * cfg.contractMultiplier;
      cashAccount += inflow;
      pushTrade(step, spot, "EXPIRE", "expiry_settlement", lot, payoffPoints, inflow, payoffPoints > 0);
      const idx = openLots.findIndex((x) => x.lotId === lot.lotId);
      if (idx >= 0) openLots.splice(idx, 1);
    });
    return expired.length;
  }

  function recordState(step, spot) {
    const unhedgedPnl = exposure * (spot / spot0 - 1);
    let optionMtm = 0;
    openLots.forEach((lot) => {
      optionMtm += optionMtmPoints(lot, spot, step, cfg) * cfg.contractMultiplier * lot.contracts;
    });
    const hedgedPnl = unhedgedPnl + cashAccount + optionMtm;
    states.push({
      step,
      spot,
      drawdownFromPeak: spot / peakSpot - 1,
      unhedgedPnl,
      optionMtm,
      cashAccount,
      hedgedPnl,
      improvement: hedgedPnl - unhedgedPnl,
      openLotCount: openLots.length,
    });
  }

  if (method === "ladder") {
    cfg.ladderDays.forEach((tenor) => {
      openLot(0, spot0, tenor, cfg.baseMoneyness, ladderWeight, "init_ladder");
    });
  } else {
    openLot(0, spot0, cfg.tenorDays, cfg.baseMoneyness, 1, "init_single");
  }

  recordState(0, spot0);

  for (let step = 1; step < pricePath.length; step += 1) {
    const spot = pricePath[step];
    peakSpot = Math.max(peakSpot, spot);
    const expiredCount = settleExpired(step, spot);

    if (method === "fixed_roll") {
      if (!openLots.length) {
        openLot(step, spot, cfg.tenorDays, cfg.baseMoneyness, 1, "roll_after_expiry");
      }
    } else if (method === "constant_maturity") {
      if (!openLots.length) {
        openLot(step, spot, cfg.tenorDays, cfg.baseMoneyness, 1, "reopen_missing");
      } else {
        const current = openLots[0];
        const remaining = current.expiryStep - step;
        if (remaining <= cfg.rollBeforeExpiryDays) {
          closeLot(step, spot, current, "early_roll_constant_maturity");
          openLots.splice(0, 1);
          openLot(step, spot, cfg.tenorDays, cfg.baseMoneyness, 1, "open_after_early_roll");
        }
      }
    } else if (method === "ladder") {
      for (let i = 0; i < expiredCount; i += 1) {
        openLot(
          step,
          spot,
          cfg.ladderDays[cfg.ladderDays.length - 1],
          cfg.baseMoneyness,
          ladderWeight,
          "ladder_replace"
        );
      }
    } else if (method === "drawdown_trigger") {
      const drawdown = spot / peakSpot - 1;
      const targetMoneyness = drawdown <= -cfg.triggerDrawdown ? cfg.triggerMoneyness : cfg.baseMoneyness;
      if (!openLots.length) {
        openLot(step, spot, cfg.tenorDays, targetMoneyness, 1, "reopen_missing");
      } else {
        const current = openLots[0];
        const remaining = current.expiryStep - step;
        const triggerChanged = Math.abs(current.moneyness - targetMoneyness) > 1e-12;
        const nearExpiry = remaining <= cfg.rollBeforeExpiryDays;
        if (triggerChanged || nearExpiry) {
          closeLot(step, spot, current, triggerChanged ? "drawdown_regime_roll" : "early_roll_before_expiry");
          openLots.splice(0, 1);
          openLot(step, spot, cfg.tenorDays, targetMoneyness, 1, "open_after_trigger");
        }
      }
    }

    recordState(step, spot);
  }

  const hedgedCurve = states.map((r) => r.hedgedPnl);
  const unhedgedCurve = states.map((r) => r.unhedgedPnl);
  const improvementCurve = states.map((r) => r.improvement);

  const worstUnhedged = Math.min(...unhedgedCurve);
  const worstHedged = Math.min(...hedgedCurve);
  let downsideReduction = 0;
  if (worstUnhedged < 0) {
    downsideReduction = 1 - Math.abs(worstHedged) / Math.abs(worstUnhedged);
  }

  const upDragSamples = [];
  for (let i = 0; i < unhedgedCurve.length; i += 1) {
    if (unhedgedCurve[i] > 0) {
      upDragSamples.push(unhedgedCurve[i] - hedgedCurve[i]);
    }
  }

  const totalOpenCost = trades
    .filter((t) => t.action === "OPEN")
    .reduce((acc, t) => acc + (-t.cashflow), 0);

  const summary = {
    method,
    finalSpot: pricePath[pricePath.length - 1],
    finalUnhedgedPnl: unhedgedCurve[unhedgedCurve.length - 1],
    finalHedgedPnl: hedgedCurve[hedgedCurve.length - 1],
    finalImprovement: improvementCurve[improvementCurve.length - 1],
    maxDrawdownHedged: calcMaxDrawdown(hedgedCurve),
    maxLossHedged: Math.abs(worstHedged),
    cvar95LossHedged: calcCvarLoss(hedgedCurve, 0.95),
    downsideReductionRatio: downsideReduction,
    avgImprovement: avg(improvementCurve),
    avgUpsideDrag: avg(upDragSamples),
    totalOpenCost,
    tradeCount: trades.length,
  };
  fillShockPeriodDefaults(summary);

  return { states, trades, summary };
}

function fmtMoney(v) {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }).format(v);
}

function fmtPct(v, digits = 2) {
  return `${(v * 100).toFixed(digits)}%`;
}

let LAST_RESULT = null;

function clamp(v, minV, maxV) {
  return Math.min(maxV, Math.max(minV, v));
}

function buildShockParamsFromPreset(presetKey, horizonDays) {
  const preset = SHOCK_PRESETS[presetKey];
  if (!preset) return null;

  const durationDays = clamp(Math.round(horizonDays * preset.durationRatio), 3, horizonDays);
  const startMax = Math.max(1, horizonDays - durationDays + 1);
  const startDay = clamp(Math.round(horizonDays * preset.startRatio), 1, startMax);
  const endDay = startDay + durationDays - 1;
  const recoveryCap = Math.max(0, horizonDays - endDay);
  const recoveryDays = recoveryCap > 0
    ? clamp(Math.round(horizonDays * preset.recoveryDurationRatio), 1, recoveryCap)
    : 0;

  return {
    shockStartDay: startDay,
    shockDurationDays: durationDays,
    shockTotalDrop: preset.totalDrop,
    shockRecoveryDays: recoveryDays,
    shockRecoveryRatio: preset.recoveryRatio,
  };
}

function applyShockPreset(presetKey) {
  const horizonRaw = toNum("horizonDays");
  const horizonDays = Number.isFinite(horizonRaw) && horizonRaw >= 1
    ? Math.floor(horizonRaw)
    : 252;
  const params = buildShockParamsFromPreset(presetKey, horizonDays);
  if (!params) return;
  IS_APPLYING_SHOCK_PRESET = true;
  document.getElementById("shockStartDay").value = String(params.shockStartDay);
  document.getElementById("shockDurationDays").value = String(params.shockDurationDays);
  document.getElementById("shockTotalDrop").value = params.shockTotalDrop.toFixed(3);
  document.getElementById("shockRecoveryDays").value = String(params.shockRecoveryDays);
  document.getElementById("shockRecoveryRatio").value = params.shockRecoveryRatio.toFixed(3);
  IS_APPLYING_SHOCK_PRESET = false;
}

function markShockPresetAsCustom() {
  if (IS_APPLYING_SHOCK_PRESET) return;
  const presetSel = document.getElementById("shockPreset");
  if (presetSel.value !== "custom") {
    presetSel.value = "custom";
  }
}

function readConfig() {
  const cfg = {
    spotIndex: toNum("spotIndex"),
    pathMode: document.getElementById("pathMode").value,
    horizonDays: toNum("horizonDays"),
    pathDrift: toNum("pathDrift"),
    pathVolatility: toNum("pathVolatility"),
    seed: toNum("seed"),
    gbmPathCount: toNum("gbmPathCount"),
    shockStartDay: toNum("shockStartDay"),
    shockDurationDays: toNum("shockDurationDays"),
    shockTotalDrop: toNum("shockTotalDrop"),
    shockRecoveryDays: toNum("shockRecoveryDays"),
    shockRecoveryRatio: toNum("shockRecoveryRatio"),
    manualReturns: parseFloatList(document.getElementById("manualReturns").value),

    portfolioValue: toNum("portfolioValue"),
    portfolioBeta: toNum("portfolioBeta"),
    hedgeRatio: toNum("hedgeRatio"),

    riskFreeRate: toNum("riskFreeRate"),
    dividendYield: toNum("dividendYield"),
    optionVolatility: toNum("optionVolatility"),
    bsPremiumRate: toNum("bsPremiumRate"),
    strikeStep: toNum("strikeStep"),
    contractMultiplier: toNum("contractMultiplier"),

    tenorDays: toNum("tenorDays"),
    rollBeforeExpiryDays: toNum("rollBeforeExpiryDays"),
    baseMoneyness: toNum("baseMoneyness"),
    triggerDrawdown: toNum("triggerDrawdown"),
    triggerMoneyness: toNum("triggerMoneyness"),
    ladderDays: parseIntList(document.getElementById("ladderDays").value),

    feePerContract: toNum("feePerContract"),
    slippagePerContract: toNum("slippagePerContract"),

    methods: [],
  };

  Object.entries(cfg).forEach(([k, v]) => {
    if (typeof v === "number") ensureFinite(v, k);
  });

  if (document.getElementById("mFixed").checked) cfg.methods.push("fixed_roll");
  if (document.getElementById("mConst").checked) cfg.methods.push("constant_maturity");
  if (document.getElementById("mLadder").checked) cfg.methods.push("ladder");
  if (document.getElementById("mTrigger").checked) cfg.methods.push("drawdown_trigger");

  if (!cfg.methods.length) throw new Error("至少选择一个分析方法");
  if (cfg.spotIndex <= 0) throw new Error("起始标的价格必须 > 0");
  if (cfg.optionVolatility <= 0 || cfg.pathVolatility <= 0) throw new Error("波动率必须 > 0");
  if (cfg.horizonDays < 1) throw new Error("模拟天数必须 >= 1");
  if (cfg.tenorDays <= 0) throw new Error("单期合约期限(天)必须 > 0");
  if (cfg.rollBeforeExpiryDays < 0) throw new Error("提前展期阈值(天)必须 >= 0");
  if (cfg.bsPremiumRate <= -1) throw new Error("BS溢价率必须 > -1");
  if (!Number.isInteger(cfg.gbmPathCount) || cfg.gbmPathCount < 1) {
    throw new Error("GBM均值样本路径数必须是正整数");
  }
  if (!Number.isInteger(cfg.shockStartDay)) throw new Error("冲击开始日必须是整数");
  if (!Number.isInteger(cfg.shockDurationDays)) throw new Error("冲击持续天数必须是整数");
  if (!Number.isInteger(cfg.shockRecoveryDays)) throw new Error("冲击后修复天数必须是整数");

  if (cfg.pathMode === "manual") {
    if (!cfg.manualReturns.length) throw new Error("手动路径模式下，收益率序列不能为空");
    cfg.manualReturns.forEach((r, i) => {
      if (!Number.isFinite(r)) throw new Error(`第 ${i + 1} 个手动收益率不是数字`);
      if (r <= -1) throw new Error(`第 ${i + 1} 个手动收益率不能 <= -100%`);
    });
  }

  if (cfg.pathMode === "gbm_shock") {
    if (cfg.shockStartDay < 1 || cfg.shockStartDay > cfg.horizonDays) {
      throw new Error("冲击开始日必须在 [1, 模拟天数] 内");
    }
    if (cfg.shockDurationDays < 1) throw new Error("冲击持续天数必须 >= 1");
    if (cfg.shockStartDay + cfg.shockDurationDays - 1 > cfg.horizonDays) {
      throw new Error("冲击窗口超出模拟天数");
    }
    if (!(cfg.shockTotalDrop > 0 && cfg.shockTotalDrop < 1)) {
      throw new Error("冲击总跌幅必须在 (0,1) 内");
    }
    if (cfg.shockRecoveryDays < 0) throw new Error("冲击后修复天数必须 >= 0");
    if (!(cfg.shockRecoveryRatio >= 0 && cfg.shockRecoveryRatio <= 1)) {
      throw new Error("修复比例必须在 [0,1] 内");
    }
  }

  return cfg;
}

function buildPricePath(cfg) {
  if (cfg.pathMode === "manual") {
    return { pricePath: buildPathFromReturns(cfg.spotIndex, cfg.manualReturns), shockInfo: null };
  }
  const basePath = generateGbmPath(
    cfg.spotIndex,
    cfg.horizonDays,
    cfg.pathDrift,
    cfg.pathVolatility,
    cfg.seed,
    cfg.gbmPathCount
  );
  if (cfg.pathMode === "gbm_shock") {
    const { shockedPath, shockInfo } = applyDrawdownShock(
      basePath,
      cfg.shockStartDay,
      cfg.shockDurationDays,
      cfg.shockTotalDrop,
      cfg.shockRecoveryDays,
      cfg.shockRecoveryRatio
    );
    return { pricePath: shockedPath, shockInfo };
  }
  return { pricePath: basePath, shockInfo: null };
}

function renderSummaryTable(summaryRows) {
  const body = document.querySelector("#summaryTable tbody");
  body.innerHTML = "";
  summaryRows.forEach((row) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${methodLabel(row.method)}</td>
      <td>${fmtMoney(row.finalHedgedPnl)}</td>
      <td>${fmtMoney(row.finalImprovement)}</td>
      <td>${fmtMoney(row.maxLossHedged)}</td>
      <td>${fmtMoney(row.cvar95LossHedged)}</td>
      <td>${fmtPct(row.downsideReductionRatio)}</td>
      <td>${fmtMoney(row.totalOpenCost)}</td>
      <td>${row.tradeCount}</td>
      <td>${fmtMoney(row.preAvgImprovement)}</td>
      <td>${fmtMoney(row.shockAvgImprovement)}</td>
      <td>${fmtMoney(row.postAvgImprovement)}</td>
      <td>${fmtPct(row.preDownsideReductionRatio)}</td>
      <td>${fmtPct(row.shockDownsideReductionRatio)}</td>
      <td>${fmtPct(row.postDownsideReductionRatio)}</td>
    `;
    body.appendChild(tr);
  });
}

function renderMethodSelector(methods) {
  const sel = document.getElementById("chartMethod");
  const old = sel.value;
  sel.innerHTML = "";
  methods.forEach((m) => {
    const op = document.createElement("option");
    op.value = m;
    op.textContent = methodLabel(m);
    sel.appendChild(op);
  });
  if (methods.includes(old)) sel.value = old;
}

function niceTicks(minV, maxV, n = 5) {
  if (minV === maxV) return [minV];
  const out = [];
  for (let i = 0; i <= n; i += 1) {
    out.push(minV + ((maxV - minV) * i) / n);
  }
  return out;
}

function linePath(points) {
  if (!points.length) return "";
  let d = `M ${points[0][0]} ${points[0][1]}`;
  for (let i = 1; i < points.length; i += 1) {
    d += ` L ${points[i][0]} ${points[i][1]}`;
  }
  return d;
}

function renderCurveChart(method) {
  if (!LAST_RESULT) return;
  const svg = document.getElementById("curveChart");
  const rows = LAST_RESULT.results[method].states;
  const spotPath = LAST_RESULT.pricePath;
  const shockInfo = LAST_RESULT.shockInfo;

  const width = 960;
  const height = 420;
  const margin = { top: 20, right: 70, bottom: 36, left: 70 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;

  const xVals = rows.map((r) => r.step);
  const unhedged = rows.map((r) => r.unhedgedPnl);
  const hedged = rows.map((r) => r.hedgedPnl);

  const yMin = Math.min(...unhedged, ...hedged);
  const yMax = Math.max(...unhedged, ...hedged);
  const yPad = Math.max(1, (yMax - yMin) * 0.12);
  const leftMin = yMin - yPad;
  const leftMax = yMax + yPad;

  const spotMin = Math.min(...spotPath);
  const spotMax = Math.max(...spotPath);

  const mapX = (x) => margin.left + (plotW * x) / (xVals[xVals.length - 1] || 1);
  const mapYL = (y) => margin.top + ((leftMax - y) / (leftMax - leftMin || 1)) * plotH;
  const mapYR = (s) => margin.top + ((spotMax - s) / (spotMax - spotMin || 1)) * plotH;

  const gridTicks = niceTicks(leftMin, leftMax, 5);
  const spotTicks = niceTicks(spotMin, spotMax, 5);

  const unhedgedPts = rows.map((r) => [mapX(r.step), mapYL(r.unhedgedPnl)]);
  const hedgedPts = rows.map((r) => [mapX(r.step), mapYL(r.hedgedPnl)]);
  const spotPts = spotPath.map((s, i) => [mapX(i), mapYR(s)]);

  let html = "";

  gridTicks.forEach((t) => {
    const y = mapYL(t);
    html += `<line x1="${margin.left}" y1="${y}" x2="${width - margin.right}" y2="${y}" stroke="#e9e2d4" stroke-width="1"/>`;
    html += `<text x="${margin.left - 8}" y="${y + 4}" text-anchor="end" font-size="11" fill="#6f6a5d">${fmtMoney(t)}</text>`;
  });

  spotTicks.forEach((s) => {
    const y = mapYR(s);
    html += `<text x="${width - margin.right + 8}" y="${y + 4}" text-anchor="start" font-size="11" fill="#5d55a8">${s.toFixed(0)}</text>`;
  });

  html += `<line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${height - margin.bottom}" stroke="#7e7562"/>`;
  html += `<line x1="${width - margin.right}" y1="${margin.top}" x2="${width - margin.right}" y2="${height - margin.bottom}" stroke="#7e7562"/>`;
  html += `<line x1="${margin.left}" y1="${height - margin.bottom}" x2="${width - margin.right}" y2="${height - margin.bottom}" stroke="#7e7562"/>`;

  if (shockInfo) {
    const x1 = mapX(shockInfo.shockStartDay);
    const x2 = mapX(shockInfo.shockEndDay);
    html += `<rect x="${x1}" y="${margin.top}" width="${Math.max(1, x2 - x1)}" height="${plotH}" fill="#ca7a1320" stroke="#ca7a13" stroke-width="1"/>`;
    html += `<text x="${x1 + 4}" y="${margin.top + 14}" font-size="11" fill="#8a530a">回撤冲击区间</text>`;
  }

  html += `<path d="${linePath(unhedgedPts)}" fill="none" stroke="#9b6a00" stroke-width="2.2"/>`;
  html += `<path d="${linePath(hedgedPts)}" fill="none" stroke="#1a7d62" stroke-width="2.4"/>`;
  html += `<path d="${linePath(spotPts)}" fill="none" stroke="#5d55a8" stroke-width="2" stroke-dasharray="6 4"/>`;

  const zeroY = mapYL(0);
  html += `<line x1="${margin.left}" y1="${zeroY}" x2="${width - margin.right}" y2="${zeroY}" stroke="#b8afa0" stroke-dasharray="4 4"/>`;

  html += `<text x="${margin.left}" y="14" font-size="12" fill="#1f1d18">未对冲损益</text>`;
  html += `<line x1="${margin.left + 64}" y1="10" x2="${margin.left + 96}" y2="10" stroke="#9b6a00" stroke-width="2.2"/>`;
  html += `<text x="${margin.left + 110}" y="14" font-size="12" fill="#1f1d18">对冲后损益</text>`;
  html += `<line x1="${margin.left + 176}" y1="10" x2="${margin.left + 208}" y2="10" stroke="#1a7d62" stroke-width="2.4"/>`;
  html += `<text x="${margin.left + 222}" y="14" font-size="12" fill="#1f1d18">标的价格</text>`;
  html += `<line x1="${margin.left + 276}" y1="10" x2="${margin.left + 308}" y2="10" stroke="#5d55a8" stroke-width="2" stroke-dasharray="6 4"/>`;

  svg.innerHTML = html;
}

function renderTradeTable(method) {
  if (!LAST_RESULT) return;
  const body = document.querySelector("#tradeTable tbody");
  body.innerHTML = "";
  const trades = LAST_RESULT.results[method].trades;
  const limit = Math.min(trades.length, 300);
  for (let i = 0; i < limit; i += 1) {
    const t = trades[i];
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${t.step}</td>
      <td>${actionLabel(t.action)}</td>
      <td>${reasonLabel(t.reason)}</td>
      <td>${t.spot.toFixed(2)}</td>
      <td>${t.strike.toFixed(2)}</td>
      <td>${t.contracts}</td>
      <td>${t.expiryStep}</td>
      <td>${t.premiumPoints.toFixed(4)}</td>
      <td>${fmtMoney(t.cashflow)}</td>
      <td>${t.exercised ? "是" : "否"}</td>
    `;
    body.appendChild(tr);
  }
}

function runAnalysis() {
  const errorEl = document.getElementById("errorMsg");
  errorEl.textContent = "";

  try {
    const cfg = readConfig();
    const { pricePath, shockInfo } = buildPricePath(cfg);
    const results = {};
    const summaryRows = [];

    cfg.methods.forEach((m) => {
      const ret = simulateMethod(m, pricePath, cfg);
      if (shockInfo) {
        enrichSummaryWithShockPeriods(
          ret.summary,
          ret.states,
          shockInfo.shockStartDay,
          shockInfo.shockEndDay
        );
      }
      results[m] = ret;
      summaryRows.push(ret.summary);
    });

    LAST_RESULT = { cfg, pricePath, shockInfo, results };
    renderSummaryTable(summaryRows);
    renderMethodSelector(cfg.methods);

    const selected = document.getElementById("chartMethod").value || cfg.methods[0];
    document.getElementById("chartMethod").value = selected;
    renderCurveChart(selected);
    renderTradeTable(selected);
  } catch (err) {
    errorEl.textContent = String(err.message || err);
  }
}

function togglePathMode() {
  const mode = document.getElementById("pathMode").value;
  const isManual = mode === "manual";
  const isShock = mode === "gbm_shock";
  document.getElementById("manualReturnsWrap").classList.toggle("hidden", !isManual);
  document.getElementById("horizonWrap").classList.toggle("hidden", isManual);
  document.getElementById("driftWrap").classList.toggle("hidden", isManual);
  document.getElementById("pathVolWrap").classList.toggle("hidden", isManual);
  document.getElementById("seedWrap").classList.toggle("hidden", isManual);
  document.getElementById("gbmCountWrap").classList.toggle("hidden", isManual);
  document.getElementById("shockPresetWrap").classList.toggle("hidden", !isShock);
  document.getElementById("shockStartWrap").classList.toggle("hidden", !isShock);
  document.getElementById("shockDurationWrap").classList.toggle("hidden", !isShock);
  document.getElementById("shockDropWrap").classList.toggle("hidden", !isShock);
  document.getElementById("shockRecoveryDaysWrap").classList.toggle("hidden", !isShock);
  document.getElementById("shockRecoveryRatioWrap").classList.toggle("hidden", !isShock);
  if (isShock) {
    const preset = document.getElementById("shockPreset").value;
    if (preset !== "custom") {
      applyShockPreset(preset);
    }
  }
}

document.getElementById("runBtn").addEventListener("click", runAnalysis);
document.getElementById("pathMode").addEventListener("change", togglePathMode);
document.getElementById("shockPreset").addEventListener("change", (e) => {
  const preset = e.target.value;
  if (preset !== "custom") {
    applyShockPreset(preset);
  }
});
document.getElementById("horizonDays").addEventListener("change", () => {
  if (document.getElementById("pathMode").value !== "gbm_shock") return;
  const preset = document.getElementById("shockPreset").value;
  if (preset !== "custom") {
    applyShockPreset(preset);
  }
});
SHOCK_FIELD_IDS.forEach((id) => {
  document.getElementById(id).addEventListener("input", markShockPresetAsCustom);
});
document.getElementById("chartMethod").addEventListener("change", (e) => {
  const method = e.target.value;
  renderCurveChart(method);
  renderTradeTable(method);
});

togglePathMode();
runAnalysis();
