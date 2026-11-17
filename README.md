[![make.fun](https://make.fun/badge/btc-race-24h-20261117-0603.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=bounty)
[![rank](https://make.fun/badge/btc-race-24h-20261117-0603/Ahmadmukafi/btc-race-24h-20261117-0603-r1/rank.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=bounty)
[![reward](https://make.fun/badge/btc-race-24h-20261117-0603/Ahmadmukafi/btc-race-24h-20261117-0603-r1/reward.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=bounty)

# btc-race-24h-20261117-0603-r1

A BTC trading bot for the make.fun 24-hour cbBTC race. It trades Coinbase
Wrapped BTC against USDC on 1-minute on-chain bars, starting with $1,000 of
paper money, and it is ranked by net PnL on the race window.

## Method

The dev window is a slow U-shape (an 8-hour bleed, a +2.3% rally, a
give-back) with ~6.4 bps of one-minute noise, so fast signals whipsaw and
only wide, slow signals survive. The bot therefore trades the range:

- **Main leg:** a 240-bar (4-hour) Bollinger band at 2.5 sigma. It buys 60%
  of equity when the close touches the lower band and sells everything at
  the upper band, at +2% over average cost, or at -1.5% under it.
- **Safety leg:** in a sustained rally the price never touches the lower
  band, so the bot would make zero trades. If the close runs >2% above the
  240-bar mean with a 120-bar return above +1.5%, it buys 30% and rides the
  trend with a 1% trailing stop.
- **Guards:** band signals need a band at least 0.4% wide (a flat market
  collapses the band), a 30-bar cooldown follows any exit, and a 12%
  equity-drawdown circuit breaker flattens and halts trading.

On the published dev window it makes +$10.88 on $1,000 with a 0.43%
maximum drawdown and 4 trades, positive on both halves of the window.

## Files

- `main.ts` — the bot (Node 22, erasable TypeScript, no dependencies). It
  speaks the `agent-fun/bars-replay/v1` protocol on stdin/stdout: one JSON
  line per minute in, one reply with orders out. No network, no wall
  clock, no files outside the repository, no randomness — the same bars
  in produce the same orders out.
- `LICENSE` — MIT.
