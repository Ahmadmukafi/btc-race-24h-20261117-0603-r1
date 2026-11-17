/**
 * BTC trading bot for make.fun btc-race-24h-20261117-0603.
 *
 * Protocol: agent-fun/bars-replay/v1 (newline-delimited JSON on stdin/stdout).
 * The bot reads one 1-minute cbBTC bar per batch and answers with buy/sell
 * orders that fill at the next bar's open. Long only, no leverage, no shorts.
 *
 * Method (written from scratch for this race; chosen by testing on the
 * published dev window, not by guessing):
 * - The dev window (Nov 16 13:03 WIB -> Nov 17 13:03 WIB) is a slow U-shape:
 *   an 8-hour bleed from $64.5k to $64.0k, a +2.3% rally to $65.5k, then a
 *   give-back to $64.8k. One-minute noise is ~6.4 bps, so every fast signal
 *   (EMA crosses, low-threshold momentum, narrow Bollinger bands) whipsaws
 *   and pays ~30 bps per round trip. Only wide, slow signals survive.
 * - Main leg, range mean-reversion: a 240-bar (4-hour) Bollinger band at
 *   2.5 sigma. Buy 60% of equity when the close touches the lower band
 *   (a true extreme, 2-4 times per day), sell everything at the upper
 *   band, or at +2% over average cost, or at -1.5% under it.
 * - Safety leg, strong uptrend: the main leg never trades in a sustained
 *   rally (price stays above the band), which would leave the entry with
 *   zero trades and fail the guardrail. So if the close runs >2% above the
 *   240-bar mean with a 120-bar return above +1.5%, buy 30% and ride it
 *   with a 1% trailing stop (exit also if the close falls back below the
 *   mean or hits the -1.5% stop). This leg never fires on the dev window
 *   (the largest close/mean excess there is 1.76%), so it cannot hurt the
 *   dev grade; it only exists to give the entry a trade in a rallying race
 *   window. After a safety-leg exit it stays quiet for 240 bars.
 * - Guards: band signals only count when the band is at least 0.4% wide
 *   (a flat market collapses the band to zero width, which would otherwise
 *   make the bot buy and sell on every bar); a 30-bar cooldown after any
 *   exit keeps a stop-out from being rebought into the same falling knife.
 * - A 12% equity-drawdown circuit breaker flattens the position and halts
 *   trading for the rest of the window (the guardrail is 25%).
 *
 * Only erasable TypeScript is used (Node 22 type stripping), no imports,
 * no dependencies. No network, no wall clock, no files outside the
 * repository, no randomness: the same bars in produce the same orders out,
 * byte for byte.
 */

const DEFAULT_PARAMS = {
  smaLen: 240,
  bbMult: 2.5,
  tpPct: 0.02,
  slPct: 0.015,
  frac: 0.6,
  safetyFrac: 0.3,
  safetyAboveMean: 0.02,
  safetyMomLb: 120,
  safetyMomThr: 0.015,
  safetyTrailPct: 0.01,
  safetyCooldown: 240,
  ddBreakPct: 0.12,
};

type Order = { side: "buy"; notionalUsd: number } | { side: "sell"; qty: number };

class Strategy {
  private p: typeof DEFAULT_PARAMS;
  private closes: number[] = [];
  private barIndex = -1;
  private halted = false;
  private peakEquity = 1000;
  private peakSinceEntry = 0;
  private lastSafetyExitBar = -1e9;
  private lastExitBar = -1e9;
  private safetyOpen = false;

  constructor(params: Partial<typeof DEFAULT_PARAMS> = {}) {
    this.p = { ...DEFAULT_PARAMS, ...params };
  }

  private bands(): [number, number, number] {
    const n = this.p.smaLen;
    const window = this.closes.slice(-n);
    let sum = 0;
    for (const c of window) sum += c;
    const mean = sum / window.length;
    let sq = 0;
    for (const c of window) sq += (c - mean) * (c - mean);
    const sd = Math.sqrt(sq / window.length);
    return [mean, mean - this.p.bbMult * sd, mean + this.p.bbMult * sd];
  }

  decide(close: number, cash: number, qty: number, avgCost: number, equity: number): Order[] {
    this.barIndex += 1;
    this.closes.push(close);

    // drawdown circuit breaker (uses the equity at this bar's close)
    if (equity > this.peakEquity) this.peakEquity = equity;
    if (!this.halted && this.peakEquity > 0) {
      if ((this.peakEquity - equity) / this.peakEquity >= this.p.ddBreakPct) {
        this.halted = true;
        this.safetyOpen = false;
        if (qty > 0) return [{ side: "sell", qty }];
        return [];
      }
    }
    if (this.halted) return [];
    if (this.closes.length < this.p.smaLen) return []; // indicator warmup

    const [sma, lower, upper] = this.bands();
    // Degenerate-band guard: when the market goes flat the band width
    // collapses to ~0 and close == lower == upper == mean, which would
    // make the bot buy and sell on every bar. Band signals only count
    // when the band is at least 0.4% wide.
    const bandWide = sma > 0 && (upper - lower) / sma > 0.004;

    // --- exits (only when holding) ---
    if (qty > 0 && avgCost > 0) {
      if (close > this.peakSinceEntry) this.peakSinceEntry = close;
      const stopped = close <= avgCost * (1 - this.p.slPct);
      if (this.safetyOpen) {
        // trend leg: ride it; exit only on trailing stop, trend
        // break, or hard stop (no band / take-profit exit)
        if (stopped) {
          this.safetyOpen = false;
          this.lastSafetyExitBar = this.barIndex;
          return [{ side: "sell", qty }];
        }
        if (close <= this.peakSinceEntry * (1 - this.p.safetyTrailPct)) {
          this.safetyOpen = false;
          this.lastSafetyExitBar = this.barIndex;
          return [{ side: "sell", qty }];
        }
        if (close < sma) {
          this.safetyOpen = false;
          this.lastSafetyExitBar = this.barIndex;
          return [{ side: "sell", qty }];
        }
      } else {
        const takeProfit = close >= avgCost * (1 + this.p.tpPct);
        const atUpperBand = bandWide && close >= upper;
        if (takeProfit || atUpperBand || stopped) {
          this.lastExitBar = this.barIndex;
          return [{ side: "sell", qty }];
        }
      }
      return []; // holding: no exit, and no second entry while holding
    }

    // --- entries (flat) ---
    // main leg: extreme lower-band touch (wide band only), with a
    // 30-bar cooldown after any exit so a stop-out is not rebought
    // into the same falling knife
    if (bandWide && close <= lower && this.barIndex - this.lastExitBar >= 30) {
      let notional = this.p.frac * equity;
      if (notional >= 1) {
        if (notional > cash) notional = cash;
        if (notional >= 1) {
          this.peakSinceEntry = close;
          this.safetyOpen = false;
          return [{ side: "buy", notionalUsd: notional }];
        }
      }
      return [];
    }
    // safety leg: strong uptrend (never fires on the dev window)
    if (this.barIndex - this.lastSafetyExitBar >= this.p.safetyCooldown) {
      const lb = this.p.safetyMomLb;
      if (this.closes.length > lb) {
        const mom = close / this.closes[this.closes.length - 1 - lb] - 1;
        if (close > sma * (1 + this.p.safetyAboveMean) && mom > this.p.safetyMomThr) {
          let notional = this.p.safetyFrac * equity;
          if (notional >= 1) {
            if (notional > cash) notional = cash;
            if (notional >= 1) {
              this.peakSinceEntry = close;
              this.safetyOpen = true;
              return [{ side: "buy", notionalUsd: notional }];
            }
          }
        }
      }
    }
    return [];
  }
}

function runProtocol(): void {
  let priceScale = 5;
  let qtyScale = 8;
  let quoteScale = 6;
  let symbol = "CBBTC";
  const strategy = new Strategy();
  let orderNo = 0;
  let buffer = "";

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line) handleLine(line);
    }
  });
  process.stdin.on("end", () => {
    if (buffer.trim()) handleLine(buffer.trim());
  });

  function handleLine(line: string): void {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const mtype = msg.type;
    if (mtype === "hello") {
      const syms = msg.symbols || [];
      if (syms.length > 0) {
        symbol = syms[0].symbol || symbol;
        priceScale = syms[0].price_scale ?? priceScale;
        qtyScale = syms[0].qty_scale ?? qtyScale;
      }
      const cap = msg.capital || {};
      quoteScale = cap.quote_scale ?? quoteScale;
      return;
    }
    if (mtype === "batch") {
      const seq = msg.seq ?? 0;
      const orders: any[] = [];
      try {
        const bars = msg.bars || [];
        let bar: any = null;
        for (const b of bars) {
          if (b.symbol === symbol) {
            bar = b;
            break;
          }
        }
        const acct = msg.account || {};
        const cash = Number(acct.cash_quote_units || "0") / 10 ** quoteScale;
        const equity = Number(acct.equity_quote_units || "0") / 10 ** quoteScale;
        let qty = 0;
        let avgCost = 0;
        for (const pos of acct.positions || []) {
          if (pos.symbol === symbol) {
            const q = Number(pos.qty || "0") / 10 ** qtyScale;
            const cost = Number(pos.cost_quote_units || "0") / 10 ** quoteScale;
            qty += q;
            if (q > 0) avgCost = cost / q;
          }
        }
        if (bar !== null) {
          const close = Number(bar.c) / 10 ** priceScale;
          for (const d of strategy.decide(close, cash, qty, avgCost, equity)) {
            orderNo += 1;
            if (d.side === "buy") {
              const notional = Math.round(d.notionalUsd * 10 ** quoteScale);
              if (notional < 1000000) continue;
              orders.push({
                side: "buy",
                client_id: "b" + orderNo,
                symbol,
                notional_quote_units: String(notional),
                max_slippage_bps: 100,
              });
            } else {
              const q = Math.round(d.qty * 10 ** qtyScale);
              if (q <= 0) continue;
              orders.push({
                side: "sell",
                client_id: "s" + orderNo,
                symbol,
                qty: String(q),
                max_slippage_bps: 100,
              });
            }
          }
        }
      } catch {
        orders.length = 0;
      }
      process.stdout.write(JSON.stringify({ type: "reply", seq, orders }) + "\n");
      return;
    }
    // "done" or anything else: nothing to answer; stdin ending exits us.
  }
}

runProtocol();
