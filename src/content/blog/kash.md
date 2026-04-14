---
title: "Kash — A Trading Bot in Rust and React"
summary: "Building an automated trading system with Rust, GraphQL, and a React frontend."
date: 2025-12-10
tags: [project, rust, react, graphql, finance, trading]
type: tech
draft: false
---

Kash is an architecture exercise — a trading system backend in Rust with a React frontend, built to explore domain-driven design and clean service boundaries. Whether the backtesting actually produces correct results is uncertain; this is not something I run against real money.

Repo: [github.com/kaiwalya/kash](https://github.com/kaiwalya/kash)

### Stack

```
Backend:   Rust, Axum, async-graphql, SeaORM, PostgreSQL
Frontend:  React, TypeScript, lightweight-charts
Broker:    Alpaca (paper and live), equities and crypto
```

### Architecture first, features later

The first few commits were not trading code. They were foundations: Worlds, Connections, ServiceProviders. [Domain-Driven Design](https://en.wikipedia.org/wiki/Domain-driven_design) was properly laid out before anything moved money.

Early commits had names like "DRY principles" and "Hide domain models behind traits." That tells you the intent. Four domains emerged:

- **workspace** — workspaces that group connections and portfolios
- **connection** — broker adapters and session state
- **trading** — orders, positions, trades
- **strategy** — strategy lifecycle, parameter management, signal generation

Each domain exposes a `ServiceProvider` — the single entry point into that domain's functionality, keeping internal details hidden. The [GraphQL](https://graphql.org/) layer composes them. Resolvers have no business logic, just call into providers. This felt like overhead in week one. By week two it was paying dividends.

---

### The DDD file layout

Every domain in the codebase follows the same layout:

```
domains/
└── trading/
    ├── mod.rs           # visibility rules + factory function
    ├── entities.rs      # database schema (public — migrations need it)
    ├── models.rs        # domain models (private)
    ├── repo.rs          # data access (private)
    ├── service.rs       # public interface: traits and types ONLY
    └── service_impl.rs  # concrete implementation (private)
```

The most important rule is written in the domains README like a law: **`service.rs` must contain only types and traits, with no imports from sibling modules.** It cannot import `models.rs`. It cannot import `repo.rs`. It cannot import `service_impl.rs`.

```rust
// service.rs — only external crate imports allowed
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use uuid::Uuid;

pub trait TradingAdapter: Send + Sync {
    async fn get_account(&self) -> Result<AccountInfo, TradingError>;
    async fn get_positions(&self) -> Result<Vec<Position>, TradingError>;
    async fn get_orders(&self, status: Option<OrderStatus>) -> Result<Vec<Order>, TradingError>;
    async fn get_trades(&self) -> Result<Vec<Trade>, TradingError>;
    fn connection(&self) -> &dyn ConnectionModel;
}
```

This makes `service.rs` a dependency firewall. Any code outside the domain imports only from `service.rs`. The implementation details — how data is fetched, how entities map to domain models, which ORM is in use — are invisible to the outside world.

The factory function is the one seam. It lives in `mod.rs` because that is the only place that can see both the public interface (`service.rs`) and the private implementation (`service_impl.rs`):

```rust
// mod.rs — the only place private and public meet
pub mod entities;
mod models;
mod repo;
pub mod service;
mod service_impl;

pub fn create_trading_service(
    db: Arc<DatabaseConnection>,
    workspace_service: Arc<dyn WorkspaceServiceTrait>,
    connection_service: Arc<dyn ConnectionServiceTrait>,
) -> Arc<dyn TradingServiceTrait> {
    Arc::new(service_impl::TradingService::new(db, workspace_service, connection_service))
}
```

External code calls `create_trading_service` and gets back `Arc<dyn TradingServiceTrait>`. It never touches `TradingService` directly. From the outside, the concrete type does not exist.

This matters because it removes an entire category of coupling. If you change how `TradingService` stores state internally, nothing outside the domain recompiles. If you want to swap the database layer, you change `repo.rs` and `service_impl.rs` and nothing else notices.

The models layer enforces the same principle. The concrete `Portfolio` struct in `models.rs` is private. External code never holds a `Portfolio`. It holds `Box<dyn PortfolioModel>` and calls methods on the trait:

```rust
// service.rs — the trait is public, the struct is not
pub trait PortfolioModel: Send + Sync + Debug {
    fn id(&self) -> Uuid;
    fn workspace_id(&self) -> Uuid;
    fn mode(&self) -> PortfolioMode;
    fn name(&self) -> &str;
    fn position_size_pct(&self) -> f64;
}

// Note: `cash` is NOT included here — it comes from the adapter via get_account()
```

That comment in the source is load-bearing. More on it later.

---

### ServiceProvider as composition root

With four domains, something needs to build them and wire them together. That is the `ServiceProvider`.

```rust
pub trait ServiceProviderTrait: Send + Sync {
    fn workspace_service(&self) -> Arc<dyn WorkspaceServiceTrait>;
    fn connection_service(&self) -> Arc<dyn ConnectionServiceTrait>;
    fn trading_service(&self) -> Arc<dyn TradingServiceTrait>;
}

pub struct ServiceProvider {
    workspace_service: Arc<dyn WorkspaceServiceTrait>,
    connection_service: Arc<dyn ConnectionServiceTrait>,
    trading_service: Arc<dyn TradingServiceTrait>,
}

impl ServiceProvider {
    pub fn new(db: Arc<DatabaseConnection>, adapters: Arc<AdapterRegistry>) -> Self {
        // Create services in dependency order:
        // connection_service -> workspace_service -> trading_service
        let connection_service = create_connection_service(db.clone(), adapters.clone());
        let workspace_service = create_workspace_service(db.clone(), connection_service.clone());
        Self {
            workspace_service: workspace_service.clone(),
            connection_service: connection_service.clone(),
            trading_service: create_trading_service(db, workspace_service, connection_service),
        }
    }
}
```

The comment matters: services are created in dependency order. `trading_service` depends on `workspace_service` and `connection_service`, so those are created first. The `ServiceProvider` is the only place this ordering lives. Everything downstream just calls `.trading_service()` and gets a fully initialized object.

Because `ServiceProviderTrait` is a trait, you can implement it with mock services for tests. You do not need a DI framework, no annotations, no XML config. Just a trait and `Arc<dyn>`. In tests, you write a `MockServiceProvider` that returns mock implementations. In production, you use `ServiceProvider` with real ones. The code being tested never knows which it got.

This pattern — dependency injection without a framework — is a deliberate choice. The type system enforces the contract. If you forget to pass a dependency, it does not compile.

---

### The adapter pattern

Mid-project realization: backtesting and live trading need completely different data sources, but the strategy engine should not care which one it is talking to. I had originally built the strategy runner against the Alpaca client directly. When I wanted to add backtesting, I was looking at a rewrite — or a growing pile of `if backtest { ... } else { ... }` branches.

The solution was the `TradingAdapter` trait shown above. Two implementations: `BacktestTradingAdapter` reads from PostgreSQL; `AlpacaTradingAdapter` hits the live API. The routing happens in `resolve_trading_adapter`:

```rust
async fn resolve_trading_adapter(
    &self,
    portfolio_id: Uuid,
) -> Result<Box<dyn TradingAdapter>, TradingError> {
    let portfolio = self.get_portfolio_by_id(portfolio_id).await?
        .ok_or_else(|| TradingError::new(format!("Portfolio not found: {}", portfolio_id)))?;

    match portfolio.mode() {
        PortfolioMode::Backtest => {
            Ok(Box::new(BacktestTradingAdapter::new(
                portfolio_id,
                self.repo.clone_box(),
            )))
        }
        PortfolioMode::Paper | PortfolioMode::Live => {
            // ... find the right connection, then:
            Ok(Box::new(AlpacaTradingAdapter::new(conn)?))
        }
    }
}
```

One call, one branch. Everything above this call in the stack is adapter-agnostic.

`BacktestConnection` is a companion type that implements `ConnectionModel` with all capabilities returning `false`:

```rust
impl ConnectionModel for BacktestConnection {
    fn rfqdn(&self) -> &str { "internal.backtest" }

    // All capabilities false — this is a virtual connection for interface compliance
    fn cap_data_stream_live(&self) -> bool { false }
    fn cap_data_stream_historic(&self) -> bool { false }
    fn cap_trading_live(&self) -> bool { false }
    fn cap_trading_paper(&self) -> bool { false }
}
```

This is the [Null Object pattern](https://en.wikipedia.org/wiki/Null_object_pattern). Any code that checks capabilities before doing something broker-specific will get `false` from a backtest connection and do nothing. The code does not need to special-case backtest mode — it reads the capability and responds accordingly.

Retrofitting all this required touching every callsite that had reached into the Alpaca client directly, which was about a day of work. It also forced a cleaner split: the backtest adapter needed to simulate order fills, which surfaced a bunch of assumptions the strategy code had been making about immediate execution. Those assumptions are fine for live trading; they are wrong for backtesting and were hiding real edge cases.

---

### GraphQL resolvers and lazy loading

The `Portfolio` GraphQL type does not preload its cash or positions. It resolves them lazily when the client asks for them:

```rust
pub struct Portfolio {
    pub id: String,
    pub mode: PortfolioMode,
    pub name: String,
    pub position_size_pct: f64,
}

#[async_graphql::Object]
impl Portfolio {
    /// Current cash balance — fetched from broker for Paper/Live, from DB for Backtest
    async fn cash(&self, ctx: &Context<'_>) -> async_graphql::Result<f64> {
        let trading_service = ctx.data::<Arc<dyn TradingServiceTrait>>()?;
        let portfolio_id = uuid::Uuid::parse_str(&self.id)?;

        let adapter = trading_service
            .resolve_trading_adapter(portfolio_id)
            .await
            .map_err(|e| async_graphql::Error::new(e.message))?;

        let account = adapter.get_account().await
            .map_err(|e| async_graphql::Error::new(e.message))?;

        Ok(account.cash)
    }
}
```

The resolver pulls the trading service from the GraphQL context, resolves the adapter, and calls `get_account()`. Whether that hits Alpaca's API or a PostgreSQL query is not the resolver's concern. The `From` implementations elsewhere do the domain-to-GraphQL type translation:

```rust
impl From<trading::AccountInfo> for TradingAccount {
    fn from(info: trading::AccountInfo) -> Self {
        Self {
            cash: info.cash,
            buying_power: info.buying_power,
        }
    }
}
```

No business logic in the translation. Just field mapping. That is the discipline — resolvers call domain services, domain services do the work, `From` impls handle conversion. Each layer has one job.

---

### YAGNI in practice: the cash migration

The commit that dropped cash tracking from portfolios is named `m20251208_000001_remove_portfolio_cash.rs`. The migration drops two columns:

```rust
async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
    // Remove initial_cash column from portfolios table
    manager.alter_table(
        Table::alter()
            .table(Portfolios::Table)
            .drop_column(Portfolios::InitialCash)
            .to_owned(),
    ).await?;

    // Remove cash column from portfolios table
    manager.alter_table(
        Table::alter()
            .table(Portfolios::Table)
            .drop_column(Portfolios::Cash)
            .to_owned(),
    ).await
}
```

The reasoning: real positions and orders come from the broker API, which is the source of truth. Duplicating that in the database adds complexity without enabling anything useful at this stage. The comment in `service.rs` now reads: `cash is NOT included here — it comes from the adapter via get_account()`.

This is worth pausing on. Most projects accumulate fields. Columns accrete. Rarely do you see a migration whose entire purpose is deletion. The pressure to keep speculative code is real — "we might need this later" — but actively deleting it keeps the data model honest. The `PortfolioModel` trait contract reflects reality: cash is a broker concept, not a portfolio concept.

[YAGNI](https://en.wikipedia.org/wiki/You_aren%27t_gonna_need_it) applied to a database schema, which is harder to delete from than source code.

---

### The strategy engine

This is the interesting part.

The core problem with strategy UIs: every strategy has different parameters. A moving average crossover needs two period lengths. A mean-reversion strategy needs something else entirely. The naive solution is a bespoke form per strategy. That scales to exactly zero.

Instead, each strategy describes its parameters as [JSON Schema](https://json-schema.org/). The backend returns the schema; the frontend renders a form from it. No hardcoded UI per strategy, no frontend changes to add a new one.

The Rust side uses `schemars` to derive the schema from the params struct:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct SmaCrossoverParams {
    /// Number of periods for fast moving average (2-200)
    #[schemars(range(min = 2, max = 200))]
    pub short_period: usize,

    /// Number of periods for slow moving average (2-500)
    #[schemars(range(min = 2, max = 500))]
    pub long_period: usize,
}
```

The `#[derive(JsonSchema)]` macro generates the schema at compile time. The `Strategy` trait exposes it:

```rust
pub trait Strategy: Send + Sync {
    fn id(&self) -> &str;
    fn name(&self) -> &str;
    fn description(&self) -> &str;
    fn default_timeframe(&self) -> Timeframe;
    fn params_schema(&self) -> Value;  // returns the JSON Schema
    fn with_params(&self, params: &Value) -> Result<Box<dyn Strategy>, StrategyError>;
    fn generate_signals(&self, bars: &[Bar]) -> Vec<Signal>;
    fn indicators(&self, bars: &[Bar]) -> Vec<Indicator>;
}
```

`SmaCrossover` implements `params_schema()` with one line:

```rust
fn params_schema(&self) -> Value {
    serde_json::to_value(schema_for!(SmaCrossoverParams)).unwrap()
}
```

The registry stores factory functions, not instances:

```rust
type StrategyFactory = Box<dyn Fn() -> Box<dyn Strategy> + Send + Sync>;

pub struct StrategyRegistry {
    strategies: HashMap<String, StrategyFactory>,
}

impl StrategyRegistry {
    pub fn register<F>(&mut self, factory: F)
    where
        F: Fn() -> Box<dyn Strategy> + Send + Sync + 'static,
    {
        let strategy = factory();
        let id = strategy.id().to_string();
        self.strategies.insert(id, Box::new(factory));
    }

    pub fn create_with_params(
        &self,
        id: &str,
        params: &Value,
    ) -> Result<Box<dyn Strategy>, StrategyError> {
        let strategy = self.get(id)
            .ok_or_else(|| StrategyError::InvalidParams(format!("Unknown strategy: {}", id)))?;
        strategy.with_params(params)
    }
}
```

The factory pattern means the registry never holds a configured instance. Each call to `create_with_params` creates a fresh instance with the requested parameters. Adding a new strategy is: implement the `Strategy` trait, call `registry.register(|| Box::new(MyStrategy::new()))`, done. No changes to the registry, no changes to the frontend, no changes to the GraphQL schema.

[SMA Crossover](https://en.wikipedia.org/wiki/Moving_average#Simple_moving_average) was the first strategy — buy when the fast moving average crosses above the slow one (golden cross), sell when it crosses below (death cross). The signal generation:

```rust
fn generate_signals(&self, bars: &[Bar]) -> Vec<Signal> {
    let short_sma = calculate_sma(bars, self.params.short_period);
    let long_sma = calculate_sma(bars, self.params.long_period);
    let mut signals = Vec::new();
    let start_idx = self.params.long_period;

    for i in start_idx..bars.len() {
        let prev_short = short_sma[i - 1];
        let prev_long = long_sma[i - 1];
        let curr_short = short_sma[i];
        let curr_long = long_sma[i];

        if prev_short.is_nan() || prev_long.is_nan() || curr_short.is_nan() || curr_long.is_nan() {
            continue;
        }

        // Golden cross: short crosses above long -> Buy
        if prev_short <= prev_long && curr_short > curr_long {
            signals.push(Signal {
                timestamp_ms: bars[i].timestamp.timestamp_millis() as f64,
                signal_type: SignalType::Buy,
                price: bars[i].close,
            });
        }

        // Death cross: short crosses below long -> Sell
        if prev_short >= prev_long && curr_short < curr_long {
            signals.push(Signal {
                timestamp_ms: bars[i].timestamp.timestamp_millis() as f64,
                signal_type: SignalType::Sell,
                price: bars[i].close,
            });
        }
    }

    signals
}
```

Chart signal markers show entry and exit points directly on the candlestick chart. These are rendered with [lightweight-charts](https://tradingview.github.io/lightweight-charts/), an open-source charting library from TradingView.

Then the portfolio infrastructure: tables for positions, orders, trades. The plumbing that makes results visible.

---

### Market data, charts, and timezone headaches

Once the data layer had shape, the first real feature arrived: security search, price charts, crypto support alongside equities. [Alpaca](https://alpaca.markets/) exposes equities and crypto under the same API interface, which made that straightforward.

The chart was less straightforward. Financial timestamps look simple until you try to render them correctly. Market hours are in Eastern time. Pre/post market sessions exist. Crypto never closes, so there is no "market hours" concept at all — just a continuous stream. My first pass treated everything as UTC and displayed it as-is. The chart showed candles at 4am for a 9:30am open. I had to convert each bar's timestamp to the exchange's local time before handing it to the charting library, then suppress the timezone label so it didn't show a misleading offset.

Once the timezone rendering was right, zoom state started misbehaving. Every time new data arrived, the chart reset to the full range — so if you had zoomed into a specific session, you'd lose that view on the next data update. The fix was capturing the current visible range before any update and restoring it after. Sounds simple; in practice it meant threading that state through the React component lifecycle without triggering additional re-renders. I also bumped the data limit from 1000 to 10000 bars while I was in there — 1000 bars on a 1-minute chart is about sixteen hours of data, which is not useful for anything.

---

### Testing: traits as the seam

Test coverage went from 64% to 69% over the last couple of days. Not chasing a number — just filling in the gaps that were obvious once the main flows were solid.

The testing approach is consistent with the architecture: mock at the trait boundary, not the function boundary. Because `TradingServiceTrait`, `ConnectionServiceTrait`, and `ServiceProviderTrait` are all traits, a test can inject mock implementations without touching the production code path at all. No mocking framework, no macro magic. Just a struct that implements the trait with hardcoded return values.

The pure strategy logic is the easiest to test — `generate_signals` and `calculate_sma` are functions that take slices and return values. They have no I/O, no state, no threading. You call them with synthetic bars and assert on the output:

```rust
#[test]
fn test_sma_calculation() {
    let bars: Vec<Bar> = (0..10)
        .map(|i| make_bar(i * 86400000, (i + 1) as f64 * 10.0))
        .collect();

    let sma = calculate_sma(&bars, 3);

    assert!(sma[0].is_nan());
    assert!(sma[1].is_nan());
    // SMA at index 2 = (10 + 20 + 30) / 3 = 20
    assert!((sma[2] - 20.0).abs() < 0.001);
}
```

`BacktestConnection` gets its own test for the capability contract:

```rust
#[test]
fn test_backtest_connection_capabilities() {
    let conn = BacktestConnection::new(Uuid::new_v4());

    assert!(!conn.cap_data_stream_live());
    assert!(!conn.cap_data_stream_historic());
    assert!(!conn.cap_trading_live());
    assert!(!conn.cap_trading_paper());
}
```

Testing the Null Object in isolation confirms the contract without needing a broker.

---

### Options panel, MFI strategy

Added basic options support: expiry filtering, strike selection. Data retrieval from Alpaca. No options-specific strategy logic yet — just making the data available. Paper trading stays available throughout; live trading requires opting in explicitly.

Second strategy: [MFI](https://en.wikipedia.org/wiki/Money_flow_index) (Money Flow Index). Unlike a pure price indicator, MFI incorporates volume to measure buying and selling pressure. Different character than a moving average — it can signal overbought/oversold conditions even when price is flat. Adding it required implementing the `Strategy` trait and registering it. The registry, the GraphQL layer, and the frontend form renderer were untouched.

That is the payoff of the schema-driven approach. New strategies plug in without touching infrastructure. New brokers implement `TradingAdapter`. Backtesting runs the same code as live. The architecture constraints from week one are paying the dividend in week two.
