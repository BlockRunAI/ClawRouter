import { useEffect, useMemo, useState } from "react";

import type {
  AgentId,
  AgentStatus,
  DashboardData,
  ModelInfo,
  PaymentChain,
} from "../electron/core/types";
import { BUNDLED_MODEL_METADATA } from "../electron/core/model-catalog";
import { api } from "./api";
import { AGENT_ICON_DATA } from "./agent-icons";
import BLOCKRUN_ICON from "./blockrun-icon.svg";
import OPENCLAW_ICON from "./openclaw-x-avatar.jpg";

type Page = "overview" | "models" | "usage" | "wallet" | "settings";
type Theme = "dark" | "light";
type IconName =
  "home" | "models" | "usage" | "settings" | "refresh" | "sun" | "moon" | "external" | "wallet";
type CatalogModel = ModelInfo & { aliases: string[] };

const CLAWROUTER_REPO = "https://github.com/BlockRunAI/ClawRouter";
const AGENT_REPOS: Record<AgentId, string> = {
  openclaw: "https://github.com/openclaw/openclaw",
  codex: "https://github.com/openai/codex",
  hermes: "https://github.com/NousResearch/hermes-agent",
  dsh: "https://github.com/deepseek-ai/deepseek-harness",
  pi: "https://github.com/earendil-works/pi",
};

export function App() {
  const [page, setPage] = useState<Page>("overview");
  const [agents, setAgents] = useState<AgentStatus[]>([]);
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [busy, setBusy] = useState<AgentId | null>(null);
  const [chainBusy, setChainBusy] = useState<PaymentChain | null>(null);
  const [walletBusy, setWalletBusy] = useState<PaymentChain | null>(null);
  const [fundingOpen, setFundingOpen] = useState(false);
  const [fundingAmount, setFundingAmount] = useState(50);
  const [fundingBusy, setFundingBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = window.localStorage.getItem("clawrouter-theme");
    if (saved === "light" || saved === "dark") return saved;
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  });

  async function refresh() {
    await Promise.allSettled([
      api.statuses().then(setAgents),
      api.dashboard().then(setDashboard, (error: unknown) =>
        setDashboard({
          proxy: {
            reachable: false,
            error: error instanceof Error ? error.message : String(error),
          },
          stats: null,
          models: [],
        }),
      ),
    ]);
  }

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    window.localStorage.setItem("clawrouter-theme", theme);
  }, [theme]);

  async function toggleAgent(agent: AgentStatus) {
    setBusy(agent.id);
    setNotice(null);
    const result = agent.configured
      ? await api.uninstall(agent.id)
      : await api.install(agent.id, {
          setDefault: true,
          model: agent.id === "dsh" || agent.id === "pi" ? "auto" : "blockrun/auto",
        });
    setNotice({ kind: result.ok ? "ok" : "error", text: result.message });
    await refresh();
    setBusy(null);
  }

  async function switchChain(chain: PaymentChain) {
    if (chainBusy || dashboard?.proxy.configuredChain === chain) return;
    setChainBusy(chain);
    setNotice(null);
    const result = await api.switchPaymentChain(chain);
    setNotice({ kind: result.ok ? "ok" : "error", text: result.message });
    await refresh();
    setChainBusy(null);
  }

  async function startOnramp() {
    setFundingBusy(true);
    setNotice(null);
    const result = await api.createOnramp(fundingAmount);
    if (!result.ok || !result.url) {
      setNotice({ kind: "error", text: result.message });
      setFundingBusy(false);
      return;
    }
    try {
      await api.openExternal(result.url);
      setNotice({
        kind: "ok",
        text: "Coinbase opened. Your Base balance will refresh automatically after the purchase settles.",
      });
      setFundingOpen(false);
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setFundingBusy(false);
    }
  }

  async function createWallet(chain: PaymentChain) {
    setWalletBusy(chain);
    setNotice(null);
    const result = await api.createWallet(chain);
    setNotice({ kind: result.ok ? "ok" : "error", text: result.message });
    await refresh();
    setWalletBusy(null);
  }

  async function adoptLegacyWallet(chain: PaymentChain, address: string) {
    const confirmed = window.confirm(
      `Use ${shortAddress(address)} as your current ${chain === "base" ? "Base" : "Solana"} wallet? Your current Core wallet will be backed up and ClawRouter will need a restart.`,
    );
    if (!confirmed) return;
    setWalletBusy(chain);
    setNotice(null);
    const result = await api.adoptLegacyWallet(chain);
    setNotice({ kind: result.ok ? "ok" : "error", text: result.message });
    await refresh();
    setWalletBusy(null);
  }

  const configured = agents.filter((agent) => agent.configured).length;
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <BrandGlyph />
          </div>
          <div>
            <strong>ClawRouter</strong>
            <span>Agent routing</span>
          </div>
        </div>
        <nav>
          <NavButton active={page === "overview"} onClick={() => setPage("overview")} icon="home">
            Overview
          </NavButton>
          <NavButton active={page === "models"} onClick={() => setPage("models")} icon="models">
            Models
          </NavButton>
          <NavButton active={page === "usage"} onClick={() => setPage("usage")} icon="usage">
            Usage
          </NavButton>
          <NavButton active={page === "wallet"} onClick={() => setPage("wallet")} icon="wallet">
            Wallet
          </NavButton>
          <NavButton
            active={page === "settings"}
            onClick={() => setPage("settings")}
            icon="settings"
          >
            Settings
          </NavButton>
        </nav>
        <WalletSummary
          proxy={dashboard?.proxy}
          loading={dashboard === null}
          busy={chainBusy}
          onSwitch={switchChain}
          onOpen={() => setPage("wallet")}
          onFund={() => setFundingOpen(true)}
        />
        <button className="sidebar-github" onClick={() => void api.openExternal(CLAWROUTER_REPO)}>
          <GitHubIcon />
          <span>View source</span>
          <Icon name="external" />
        </button>
        <div className="sidebar-foot">
          <div className={`status-dot ${dashboard?.proxy.reachable ? "online" : ""}`} />
          <div>
            <strong>{dashboard?.proxy.reachable ? "Router online" : "Router offline"}</strong>
            <span>127.0.0.1:8402</span>
          </div>
        </div>
      </aside>

      <main>
        <header className="topbar">
          <div>
            <span className="eyebrow">LOCAL ROUTING</span>
            <h1>{titleFor(page)}</h1>
          </div>
          <div className="topbar-actions">
            <button
              className="icon-button"
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
              title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
            >
              <Icon name={theme === "dark" ? "sun" : "moon"} />
            </button>
            <button
              className="github-button"
              onClick={() => void api.openExternal(CLAWROUTER_REPO)}
            >
              <GitHubIcon />
              <span>GitHub</span>
            </button>
            <button
              className="icon-button"
              onClick={() => void refresh()}
              aria-label="Refresh"
              title="Refresh status"
            >
              <Icon name="refresh" />
            </button>
          </div>
        </header>

        {notice && (
          <div className={`notice ${notice.kind}`} aria-live="polite">
            {notice.text}
            <button onClick={() => setNotice(null)} aria-label="Dismiss notification">
              ×
            </button>
          </div>
        )}
        {page === "overview" && (
          <Overview
            agents={agents}
            dashboard={dashboard}
            configured={configured}
            busy={busy}
            toggle={toggleAgent}
          />
        )}
        {page === "models" && <Models models={dashboard?.models ?? []} />}
        {page === "usage" && <Usage dashboard={dashboard} />}
        {page === "wallet" && (
          <WalletCenter
            dashboard={dashboard}
            chainBusy={chainBusy}
            walletBusy={walletBusy}
            onSwitch={switchChain}
            onCreate={createWallet}
            onAdopt={adoptLegacyWallet}
            onFund={() => setFundingOpen(true)}
          />
        )}
        {page === "settings" && <Settings />}
      </main>
      {fundingOpen && (
        <FundingDialog
          amount={fundingAmount}
          busy={fundingBusy}
          wallet={dashboard?.proxy.configuredWallet ?? dashboard?.proxy.wallet}
          onAmount={setFundingAmount}
          onClose={() => !fundingBusy && setFundingOpen(false)}
          onContinue={() => void startOnramp()}
        />
      )}
    </div>
  );
}

function Overview({
  agents,
  dashboard,
  configured,
  busy,
  toggle,
}: {
  agents: AgentStatus[];
  dashboard: DashboardData | null;
  configured: number;
  busy: AgentId | null;
  toggle(agent: AgentStatus): void;
}) {
  const stats = normalizeStats(dashboard?.stats);
  return (
    <>
      <section className="hero" aria-label="Routing status">
        <div className="hero-copy">
          <div className="live-pill">
            <span />
            {dashboard?.proxy.reachable ? "Router online" : "Starting router…"}
          </div>
          <h2>
            {dashboard?.proxy.reachable ? "Every agent, one route." : "Getting ClawRouter ready."}
          </h2>
          <p>Models, payment, and local agent connections stay in one place.</p>
        </div>
        <RoutingMap />
        <div className="hero-metrics">
          <Metric label="Connected agents" value={`${configured}/${agents.length || 5}`} />
          <Metric label="7-day requests" value={compact(stats.requests)} />
          <Metric
            label="Wallet balance"
            value={
              dashboard?.proxy.balance == null ? "—" : `$${dashboard.proxy.balance.toFixed(2)}`
            }
          />
        </div>
      </section>

      <div className="section-title">
        <div>
          <h3>Agents</h3>
          <p>Connect a tool, restore its backup, or remove only ClawRouter settings.</p>
        </div>
        <span>{configured} connected</span>
      </div>
      <section className="agent-grid">
        {agents.map((agent) => (
          <article className={`agent-card ${agent.configured ? "connected" : ""}`} key={agent.id}>
            <div className="agent-summary">
              <AgentLogo id={agent.id} />
              <div>
                <div className="agent-name">
                  <h4>{agent.name}</h4>
                  <div className={`health ${agent.health}`}>
                    <i />
                    {healthLabel(agent)}
                  </div>
                </div>
                <p>{agent.description}</p>
                {agent.details[0] && <small className="agent-guidance">{agent.details[0]}</small>}
              </div>
            </div>
            <div className="agent-meta">
              <span>{agentApiLabel(agent.id)}</span>
              <span className={agent.activation === "immediate" ? "instant" : "restart"}>
                {activationLabel(agent)}
              </span>
            </div>
            <div className="agent-actions">
              <button
                className="agent-repo"
                onClick={() => void api.openExternal(AGENT_REPOS[agent.id])}
                aria-label={`Open ${agent.name} GitHub repository`}
                title={`${agent.name} on GitHub`}
              >
                <GitHubIcon />
              </button>
              <button
                className={agent.configured ? "secondary" : "primary"}
                disabled={
                  busy === agent.id || (agent.configured && agent.removalMode === "unavailable")
                }
                onClick={() => toggle(agent)}
              >
                {busy === agent.id ? (
                  <>
                    <b className="spinner" />
                    Working…
                  </>
                ) : agent.configured ? (
                  removalLabel(agent)
                ) : (
                  "Connect"
                )}
              </button>
            </div>
          </article>
        ))}
      </section>
    </>
  );
}

function Models({ models }: { models: ModelInfo[] }) {
  const catalog = useMemo(() => collapseModelAliases(models.map(enrichModel)), [models]);
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState("all");
  const [capability, setCapability] = useState("all");
  const [sort, setSort] = useState("catalog");
  const providers = useMemo(
    () => ["all", ...[...new Set(catalog.map(modelProvider))].sort()],
    [catalog],
  );
  const filtered = useMemo(
    () =>
      catalog
        .filter((model) => {
          const normalizedQuery = query.trim().toLowerCase();
          const matchesCapability =
            capability === "all" ||
            (capability === "reasoning" && model.reasoning) ||
            (capability === "vision" && model.vision) ||
            (capability === "agentic" && model.agentic) ||
            (capability === "tools" && model.toolCalling);
          return (
            (provider === "all" || modelProvider(model) === provider) &&
            matchesCapability &&
            (`${model.id} ${model.name ?? ""}`.toLowerCase().includes(normalizedQuery) ||
              model.aliases.some((alias) => alias.toLowerCase() === normalizedQuery))
          );
        })
        .sort((a, b) => {
          if (sort === "name") return (a.name ?? a.id).localeCompare(b.name ?? b.id);
          if (sort === "context") return (b.contextWindow ?? -1) - (a.contextWindow ?? -1);
          if (sort === "input") return sortablePrice(a, "input") - sortablePrice(b, "input");
          if (sort === "output") return sortablePrice(a, "output") - sortablePrice(b, "output");
          return 0;
        }),
    [catalog, query, provider, capability, sort],
  );
  const freeModels = catalog.filter(
    (model) =>
      model.inputPrice === 0 &&
      model.outputPrice === 0 &&
      !["auto", "eco", "premium"].includes(model.id),
  ).length;
  const pricedModels = catalog.filter(
    (model) => model.inputPrice != null && model.outputPrice != null,
  ).length;
  const groupedAliases = catalog.reduce((total, model) => total + model.aliases.length, 0);
  const maxContext = Math.max(0, ...catalog.map((model) => model.contextWindow ?? 0));
  return (
    <>
      <section className="models-intro" aria-label="Model catalog summary">
        <div>
          <span className="catalog-live">
            <i />
            Live catalog
          </span>
          <h2>{catalog.length} available models</h2>
          <p>{groupedAliases} compatibility aliases are grouped with their models.</p>
        </div>
        <div className="catalog-stats">
          <div>
            <strong>{catalog.length}</strong>
            <span>Models</span>
          </div>
          <div>
            <strong>{freeModels}</strong>
            <span>Free</span>
          </div>
          <div>
            <strong>{formatTokenCount(maxContext)}</strong>
            <span>Max context</span>
          </div>
        </div>
      </section>
      <section className="panel models-panel">
        <div className="filters">
          <label className="model-search">
            <span aria-hidden="true">⌕</span>
            <input
              name="model-search"
              aria-label="Search models"
              autoComplete="off"
              spellCheck={false}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search models…"
            />
          </label>
          <select
            aria-label="Filter by provider"
            value={provider}
            onChange={(event) => setProvider(event.target.value)}
          >
            {providers.map((item) => (
              <option key={item} value={item}>
                {item === "all" ? "All providers" : providerLabel(item)}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter by capability"
            value={capability}
            onChange={(event) => setCapability(event.target.value)}
          >
            <option value="all">All capabilities</option>
            <option value="reasoning">Reasoning</option>
            <option value="vision">Vision</option>
            <option value="agentic">Agentic</option>
            <option value="tools">Tool calling</option>
          </select>
          <select
            aria-label="Sort models"
            value={sort}
            onChange={(event) => setSort(event.target.value)}
          >
            <option value="catalog">Catalog order</option>
            <option value="name">Name</option>
            <option value="context">Largest context</option>
            <option value="input">Lowest input price</option>
            <option value="output">Lowest output price</option>
          </select>
        </div>
        <div className="model-result-meta">
          <span>
            {filtered.length} of {catalog.length} models · {pricedModels} with published pricing
          </span>
          <span>
            <b>USD per 1M tokens</b> · Aliases do not create duplicate rows
          </span>
        </div>
        <div className="model-table">
          <div className="model-row model-header">
            <span>Model</span>
            <span>Context</span>
            <span>Input / 1M</span>
            <span>Output / 1M</span>
            <span>Capabilities</span>
          </div>
          {filtered.map((model) => (
            <div className="model-row" key={model.id}>
              <span className="model-identity">
                <ProviderMark provider={modelProvider(model)} />
                <span>
                  <strong>{model.name ?? prettyModel(model.id)}</strong>
                  <small
                    title={
                      model.aliases.length ? `Aliases: ${model.aliases.join(", ")}` : undefined
                    }
                  >
                    {model.id}
                    {model.aliases.length ? ` · ${model.aliases.length} aliases` : ""}
                  </small>
                  <em>{providerLabel(modelProvider(model))}</em>
                </span>
              </span>
              <span className="context-cell">
                <strong>{formatTokenCount(model.contextWindow)}</strong>
                <small>
                  {model.maxOutput
                    ? `${formatTokenCount(model.maxOutput)} max output`
                    : "context window"}
                </small>
              </span>
              <PriceCell model={model} kind="input" />
              <PriceCell model={model} kind="output" />
              <span className="chips">
                {model.reasoning && <i>Reasoning</i>}
                {model.vision && <i>Vision</i>}
                {model.agentic && <i>Agentic</i>}
                {model.toolCalling && <i>Tools</i>}
                {!model.reasoning && !model.vision && !model.agentic && !model.toolCalling && (
                  <i>Chat</i>
                )}
              </span>
            </div>
          ))}
          {filtered.length === 0 && (
            <div className="model-empty">
              <strong>No matching models</strong>
              <span>Try clearing one of the filters.</span>
            </div>
          )}
        </div>
      </section>
    </>
  );
}

function Usage({ dashboard }: { dashboard: DashboardData | null }) {
  const stats = normalizeStats(dashboard?.stats);
  const values = [42, 68, 53, 82, 64, 91, 74];
  return (
    <>
      <section className="stat-grid">
        <MetricCard label="Requests" value={compact(stats.requests)} delta="last 7 days" />
        <MetricCard
          label="Estimated spend"
          value={`$${stats.cost.toFixed(2)}`}
          delta="wallet settled"
        />
        <MetricCard label="Tokens routed" value={compact(stats.tokens)} delta="across all agents" />
      </section>
      <section className="panel usage-chart">
        <div>
          <h3>Routing activity</h3>
          <p>Requests handled by the local proxy</p>
        </div>
        <div className="bars">
          {values.map((value, index) => (
            <div key={index} style={{ height: `${value}%` }}>
              <span>{["M", "T", "W", "T", "F", "S", "S"][index]}</span>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}

function WalletCenter({
  dashboard,
  chainBusy,
  walletBusy,
  onSwitch,
  onCreate,
  onAdopt,
  onFund,
}: {
  dashboard: DashboardData | null;
  chainBusy: PaymentChain | null;
  walletBusy: PaymentChain | null;
  onSwitch(chain: PaymentChain): void;
  onCreate(chain: PaymentChain): void;
  onAdopt(chain: PaymentChain, address: string): void;
  onFund(): void;
}) {
  const proxy = dashboard?.proxy;
  const selected = proxy?.configuredChain ?? "base";
  return (
    <section className="wallet-center">
      <div className="wallet-center-intro">
        <div>
          <span className="eyebrow">BLOCKRUN CORE</span>
          <h2>Your payment wallet</h2>
          <p>One current wallet per network, shared by every connected agent.</p>
        </div>
        <button className="coinbase-fund-button" onClick={onFund}>
          <span>＋</span>
          <b>Buy USDC</b>
          <small>on Base</small>
        </button>
      </div>

      <div className="payment-rail" aria-label="ClawRouter payment path">
        <span>
          <Icon name="wallet" />
          <b>Core wallet</b>
        </span>
        <i>→</i>
        <span>
          <b>{selected === "base" ? "Base" : "Solana"}</b>
          <small>default network</small>
        </span>
        <i>→</i>
        <span>
          <b>All agents</b>
          <small>shared payment</small>
        </span>
      </div>

      <div className="wallet-network-grid">
        {(["base", "solana"] as PaymentChain[]).map((chain) => {
          const address =
            chain === "base"
              ? (proxy?.configuredWallet ?? proxy?.wallet)
              : (proxy?.configuredSolana ?? proxy?.solana);
          const activeAddress = chain === "base" ? proxy?.activeWallet : proxy?.activeSolana;
          const restart = proxy?.walletRestartChains?.includes(chain) ?? false;
          const issue = proxy?.walletIssues?.[chain];
          return (
            <article
              className={`wallet-network-card ${selected === chain ? "selected" : ""}`}
              key={chain}
            >
              <header>
                <span className="wallet-network-name">
                  <i className={chain === "base" ? "base-coin" : "solana-coin"}>
                    {chain === "base" ? "B" : "S"}
                  </i>
                  <span>
                    <b>{chain === "base" ? "Base" : "Solana"}</b>
                    <small>USDC</small>
                  </span>
                </span>
                {selected === chain && <em>Default network</em>}
              </header>
              <strong>
                {formatWalletBalance(proxy?.balances?.[chain], false, dashboard === null)}
              </strong>
              <code>{address ? shortAddress(address) : "No Core wallet"}</code>
              {issue && <p className="wallet-card-warning">{issue}</p>}
              {restart && activeAddress && (
                <p className="wallet-card-warning">
                  Running router still uses {shortAddress(activeAddress)}.
                </p>
              )}
              <footer>
                {address ? (
                  <button
                    className={selected === chain ? "secondary" : "primary"}
                    disabled={chainBusy !== null || selected === chain}
                    onClick={() => onSwitch(chain)}
                  >
                    {chainBusy === chain
                      ? "Switching…"
                      : selected === chain
                        ? "Current default"
                        : "Use this network"}
                  </button>
                ) : (
                  <button
                    className="primary"
                    disabled={walletBusy !== null || Boolean(issue)}
                    onClick={() => onCreate(chain)}
                  >
                    {walletBusy === chain
                      ? "Creating…"
                      : `Create ${chain === "base" ? "Base" : "Solana"} wallet`}
                  </button>
                )}
              </footer>
            </article>
          );
        })}
      </div>

      {(proxy?.legacyWallets?.base || proxy?.legacyWallets?.solana) && (
        <section className="legacy-wallet-panel">
          <div>
            <span className="eyebrow">MIGRATION</span>
            <h3>Older ClawRouter wallet found</h3>
            <p>
              It is not active. Choose it only if this is the funded wallet you want to keep using.
            </p>
          </div>
          <div className="legacy-wallet-list">
            {(["base", "solana"] as PaymentChain[]).map((chain) => {
              const legacy = proxy.legacyWallets?.[chain];
              if (!legacy) return null;
              return (
                <div key={chain}>
                  <span>
                    <b>{chain === "base" ? "Base" : "Solana"}</b>
                    <code>{shortAddress(legacy.address)}</code>
                  </span>
                  <strong>{formatWalletBalance(legacy.balance, false, dashboard === null)}</strong>
                  <button
                    disabled={walletBusy !== null}
                    onClick={() => onAdopt(chain, legacy.address)}
                  >
                    {walletBusy === chain ? "Switching…" : "Use legacy wallet"}
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <div className="wallet-notes">
        <div>
          <b>Network selection is not wallet selection</b>
          <p>
            Base / Solana chooses which network pays for requests. It does not switch between
            multiple wallets on the same network.
          </p>
        </div>
        <div>
          <b>Secrets stay local</b>
          <p>
            Private keys never enter the renderer or agent configuration. Wallet changes are applied
            after ClawRouter restarts.
          </p>
        </div>
      </div>
    </section>
  );
}

function Settings() {
  return (
    <section className="settings-grid">
      <div className="panel setting-card">
        <span className="setting-icon">↔</span>
        <div>
          <h3>Local endpoints</h3>
          <p>Chat: http://127.0.0.1:8402/v1</p>
          <p>Codex Responses: http://127.0.0.1:8403/v1</p>
        </div>
      </div>
      <div className="panel setting-card source-card">
        <span className="setting-icon">
          <GitHubIcon />
        </span>
        <div>
          <h3>Open source</h3>
          <p>Inspect releases, report issues, or contribute to ClawRouter.</p>
          <button onClick={() => void api.openExternal(CLAWROUTER_REPO)}>
            Open GitHub <Icon name="external" />
          </button>
        </div>
      </div>
      <div className="panel setting-card warning">
        <span className="setting-icon">!</span>
        <div>
          <h3>Secrets stay local</h3>
          <p>The wallet mnemonic is never shown in the UI or copied into launch configuration.</p>
        </div>
      </div>
    </section>
  );
}

function RoutingMap() {
  return (
    <div
      className="routing-map"
      aria-label="Agents route through ClawRouter to the shared model catalog"
    >
      <div className="route-source">
        <div className="logo-stack">
          {(["openclaw", "codex", "hermes", "dsh", "pi"] as AgentId[]).map((id) => (
            <AgentLogo id={id} key={id} compact />
          ))}
        </div>
        <span>5 agents</span>
      </div>
      <div className="route-line">
        <i />
        <b>→</b>
      </div>
      <div className="route-core">
        <BrandGlyph />
        <strong>ClawRouter</strong>
        <span>smart route</span>
      </div>
      <div className="route-line">
        <i />
        <b>→</b>
      </div>
      <div className="route-destination">
        <strong>55+</strong>
        <span>models</span>
      </div>
    </div>
  );
}

function WalletSummary({
  proxy,
  loading,
  busy,
  onSwitch,
  onOpen,
  onFund,
}: {
  proxy: DashboardData["proxy"] | undefined;
  loading: boolean;
  busy: PaymentChain | null;
  onSwitch(chain: PaymentChain): void;
  onOpen(): void;
  onFund(): void;
}) {
  const selected = proxy?.configuredChain ?? (proxy?.paymentChain === "solana" ? "solana" : "base");
  const address =
    selected === "solana"
      ? (proxy?.configuredSolana ?? proxy?.solana)
      : (proxy?.configuredWallet ?? proxy?.wallet);
  const balance =
    proxy?.balances?.[selected] ?? (proxy?.paymentChain === selected ? proxy?.balance : undefined);
  return (
    <div className="sidebar-wallet">
      <span className="wallet-heading">
        <i>
          <Icon name="wallet" />
        </i>
        <b>Wallet</b>
        <em>{proxy?.chainRestartRequired || proxy?.walletRestartRequired ? "Restart" : "Live"}</em>
      </span>
      <div className="chain-switch" aria-label="Payment chain">
        {(["base", "solana"] as PaymentChain[]).map((chain) => {
          const available = Boolean(
            chain === "base"
              ? (proxy?.configuredWallet ?? proxy?.wallet)
              : (proxy?.configuredSolana ?? proxy?.solana),
          );
          return (
            <button
              key={chain}
              className={selected === chain ? "active" : ""}
              aria-pressed={selected === chain}
              disabled={busy !== null || !available}
              title={available ? undefined : `Create a ${chain} wallet first`}
              onClick={() => onSwitch(chain)}
            >
              <span>{chain === "base" ? "Base" : "Solana"}</span>
              <small>{formatWalletBalance(proxy?.balances?.[chain], true)}</small>
            </button>
          );
        })}
      </div>
      <strong>{formatWalletBalance(balance, false, loading)}</strong>
      <button className="wallet-address" onClick={onOpen}>
        {address ? shortAddress(address) : loading ? "Wallet initializing…" : "Wallet unavailable"}
        <Icon name="external" />
      </button>
      <button className="wallet-fund-button" onClick={onFund}>
        <span>＋</span>
        {selected === "base" ? "Add funds" : "Buy USDC on Base"}
      </button>
      {proxy?.chainRestartRequired && (
        <small className="wallet-restart">
          Restart gateway to activate {selected === "solana" ? "Solana" : "Base"}
        </small>
      )}
      {proxy?.walletRestartChains?.includes(selected) && (
        <small className="wallet-restart">Restart gateway to activate the shared wallet</small>
      )}
    </div>
  );
}

function FundingDialog({
  amount,
  busy,
  wallet,
  onAmount,
  onClose,
  onContinue,
}: {
  amount: number;
  busy: boolean;
  wallet: string | undefined;
  onAmount(value: number): void;
  onClose(): void;
  onContinue(): void;
}) {
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);
  const valid = Number.isFinite(amount) && amount >= 1 && amount <= 2_500;
  return (
    <div className="funding-backdrop" onMouseDown={onClose} role="presentation">
      <section
        className="funding-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="funding-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <span className="coinbase-wordmark">Coinbase Onramp</span>
            <h2 id="funding-title">Add funds</h2>
            <p>Buy USDC for your shared Base wallet.</p>
          </div>
          <button className="funding-close" onClick={onClose} disabled={busy} aria-label="Close">
            ×
          </button>
        </header>
        <div className="funding-amount">
          <label htmlFor="funding-usd">You pay</label>
          <div className="amount-input">
            <span>$</span>
            <input
              id="funding-usd"
              type="number"
              min="1"
              max="2500"
              step="1"
              value={Number.isFinite(amount) ? amount : ""}
              onChange={(event) => onAmount(Number(event.target.value))}
              autoFocus
            />
            <b>USD</b>
          </div>
          <div className="amount-presets">
            {[25, 50, 100, 250].map((value) => (
              <button
                key={value}
                className={amount === value ? "active" : ""}
                onClick={() => onAmount(value)}
              >
                ${value}
              </button>
            ))}
          </div>
        </div>
        <div className="funding-route">
          <div>
            <span className="route-token">USDC</span>
            <p>
              <b>USDC on Base</b>
              <small>Delivered after Coinbase fees</small>
            </p>
          </div>
          <i>→</i>
          <div className="funding-destination">
            <span>To your wallet</span>
            <code>{wallet ? shortAddress(wallet) : "Wallet unavailable"}</code>
          </div>
        </div>
        <button
          className="funding-continue"
          disabled={busy || !valid || !wallet}
          onClick={onContinue}
        >
          {busy ? (
            <>
              <b className="spinner" />
              Creating secure session…
            </>
          ) : (
            <>
              Continue to Coinbase <Icon name="external" />
            </>
          )}
        </button>
        <p className="funding-legal">
          Coinbase shows the final quote, fees, and payment methods available in your region. The
          one-time checkout opens in your browser.
        </p>
      </section>
    </div>
  );
}

function PriceCell({ model, kind }: { model: ModelInfo; kind: "input" | "output" }) {
  const value = kind === "input" ? model.inputPrice : model.outputPrice;
  const formatted = formatModelPrice(model, value);
  return (
    <span className={`price-cell ${formatted === "Free" ? "free" : ""}`}>
      <strong>{formatted}</strong>
      <small>per 1M tokens</small>
    </span>
  );
}

function ProviderMark({ provider }: { provider: string }) {
  const normalized = provider.toLowerCase();
  if (normalized === "blockrun")
    return (
      <b className="provider-mark provider-blockrun">
        <BrandGlyph />
      </b>
    );
  const paths: Record<string, React.ReactNode> = {
    openai: (
      <path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.911 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.182a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.096 5.98 5.98 0 0 0 .511 4.911 6.051 6.051 0 0 0 6.514 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073Zm-9.022 12.608a4.476 4.476 0 0 1-2.877-1.041l.142-.08 4.778-2.758a.795.795 0 0 0 .393-.682v-6.737l2.02 1.169a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494Zm-9.661-4.125a4.471 4.471 0 0 1-.534-3.014l.142.085 4.783 2.758a.771.771 0 0 0 .78 0l5.843-3.368v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.499 4.499 0 0 1-6.141-1.646ZM2.341 7.896a4.485 4.485 0 0 1 2.365-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.354-2.02 1.169a.076.076 0 0 1-.071 0l-4.831-2.787a4.504 4.504 0 0 1-1.646-6.14Zm16.596 3.855-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.831 2.791a4.494 4.494 0 0 1-.677 8.104v-5.677a.79.79 0 0 0-.407-.667Zm2.011-3.023-.142-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.831-2.787a4.499 4.499 0 0 1 6.68 4.66ZM8.307 12.863l-2.02-1.164a.08.08 0 0 1-.038-.056V6.074a4.499 4.499 0 0 1 7.375-3.453l-.142.08-4.778 2.758a.795.795 0 0 0-.393.681Zm1.097-2.365 2.602-1.5 2.607 1.5v3l-2.597 1.499-2.607-1.5Z" />
    ),
    anthropic: (
      <path d="M17.304 3.541h-3.672l6.696 16.918H24Zm-10.608 0L0 20.459h3.744l1.37-3.553h7.005l1.369 3.553h3.744L10.536 3.541ZM6.325 13.764l2.291-5.945 2.292 5.945Z" />
    ),
    google: (
      <path d="M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81" />
    ),
    deepseek: (
      <path d="M23.748 4.651c-.254-.124-.364.113-.512.233-.423.437-.9.807-1.51.763-.83-.047-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.155-.708-.311-.955-.65-.172-.24-.219-.509-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.094.172.187.129.323-.082.28-.18.553-.266.833-.055.179-.137.218-.328.14a5.5 5.5 0 0 1-1.737-1.179c-.857-.828-1.631-1.743-2.597-2.46-.985-.734-1.99-1.211-3.154-1.5a9.6 9.6 0 0 0-2.883-.101c-1.885.21-3.39 1.1-4.497 2.622C.082 8.776-.231 10.854.152 13.02c.403 2.284 1.568 4.175 3.36 5.653 1.857 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.132-.284 4.994-1.86.47.234.962.328 1.78.398.629.058 1.235-.031 1.705-.129.735-.155.684-.836.418-.961-2.155-1.004-1.682-.595-2.112-.926 1.095-1.295 2.768-3.598 3.284-6.733.05-.346.115-.834.108-1.114-.004-.171.035-.238.23-.257a4.2 4.2 0 0 0 1.545-.475c1.397-.763 1.96-2.016 2.093-3.517.02-.23-.004-.467-.247-.588M11.58 18.168c-2.088-1.642-3.101-2.183-3.52-2.16-.39.024-.32.472-.234.763.09.288.207.487.371.74.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.168-1.361-.801-2.5-1.86-3.301-3.306-.775-1.393-1.225-2.888-1.299-4.482-.02-.385.094-.522.477-.592a4.7 4.7 0 0 1 1.53-.038c2.131.311 3.946 1.264 5.467 2.774.868.86 1.525 1.887 2.202 2.89.72 1.066 1.494 2.082 2.48 2.915.348.291.626.513.892.677-.802.09-2.14.109-3.055-.615Z" />
    ),
    xai: (
      <path d="M14.234 10.162 22.977 0h-2.072l-7.591 8.824L7.251 0H.258l9.168 13.343L.258 24H2.33l8.016-9.318L16.749 24h6.993Zm-2.837 3.299-.929-1.329L3.076 1.56h3.182l5.965 8.532.929 1.329 7.754 11.09h-3.182Z" />
    ),
    qwen: (
      <path d="M23.919 14.545 20.817 9.17l1.47-2.544a.56.56 0 0 0 0-.566l-1.633-2.83a.57.57 0 0 0-.49-.283h-6.207L12.487.402a.57.57 0 0 0-.49-.284H8.732a.56.56 0 0 0-.49.284L5.139 5.775h-2.94a.56.56 0 0 0-.49.284L.077 8.887a.56.56 0 0 0 0 .567L3.18 14.83l-1.47 2.545a.56.56 0 0 0 0 .566l1.634 2.83a.57.57 0 0 0 .49.283h6.205l1.47 2.545a.57.57 0 0 0 .49.284h3.266a.57.57 0 0 0 .49-.284l3.104-5.375h2.94a.57.57 0 0 0 .49-.283l1.634-2.828a.55.55 0 0 0-.004-.568M8.733.686l1.634 2.828-1.634 2.828H21.8L20.164 9.17H7.425L5.63 6.06Zm1.306 19.801-6.205-.002 1.634-2.83h3.265L2.201 6.344h3.267q3.182 5.517 6.367 11.032zm10.124-5.66L18.53 12l-6.532 11.315-1.634-2.83c2.129-3.673 4.25-7.351 6.373-11.028h3.592l3.102 5.374Z" />
    ),
    minimax: (
      <path d="M11.43 3.92a.86.86 0 1 0-1.718 0v14.236a1.999 1.999 0 0 1-3.997 0V9.022a.86.86 0 1 0-1.718 0v3.87a1.999 1.999 0 0 1-3.997 0V11.49a.57.57 0 0 1 1.139 0v1.404a.86.86 0 0 0 1.719 0V9.022a1.999 1.999 0 0 1 3.997 0v9.134a.86.86 0 0 0 1.719 0V3.92a1.998 1.998 0 1 1 3.996 0v11.788a.57.57 0 1 1-1.139 0zm10.572 3.105a2 2 0 0 0-1.999 1.997v7.63a.86.86 0 0 1-1.718 0V3.923a1.999 1.999 0 0 0-3.997 0v16.16a.86.86 0 0 1-1.719 0V18.08a.57.57 0 1 0-1.138 0v2a1.998 1.998 0 0 0 3.996 0V3.92a.86.86 0 0 1 1.719 0v12.73a1.999 1.999 0 0 0 3.996 0V9.023a.86.86 0 1 1 1.72 0v6.686a.57.57 0 0 0 1.138 0V9.022a2 2 0 0 0-1.998-1.997" />
    ),
    nvidia: (
      <path d="M8.948 8.798v-1.43a6.7 6.7 0 0 1 .424-.018c3.922-.124 6.493 3.374 6.493 3.374s-2.774 3.851-5.75 3.851c-.398 0-.787-.062-1.158-.185v-4.346c1.528.185 1.837.857 2.747 2.385l2.04-1.714s-1.492-1.952-4-1.952a6.016 6.016 0 0 0-.796.035m0-4.735v2.138l.424-.027c5.45-.185 9.01 4.47 9.01 4.47s-4.08 4.964-8.33 4.964c-.37 0-.733-.035-1.095-.097v1.325c.3.035.61.062.91.062 3.957 0 6.82-2.023 9.593-4.408.459.371 2.34 1.263 2.73 1.652-2.633 2.208-8.772 3.984-12.253 3.984-.335 0-.653-.018-.971-.053v1.864H24V4.063zm0 10.326v1.131c-3.657-.654-4.673-4.46-4.673-4.46s1.758-1.944 4.673-2.262v1.237H8.94c-1.528-.186-2.73 1.245-2.73 1.245s.68 2.412 2.739 3.11M2.456 10.9s2.164-3.197 6.5-3.533V6.201C4.153 6.59 0 10.653 0 10.653s2.35 6.802 8.948 7.42v-1.237c-4.84-.6-6.492-5.936-6.492-5.936Z" />
    ),
    meta: (
      <path d="M6.915 4.03c-1.968 0-3.683 1.28-4.871 3.113C.704 9.208 0 11.883 0 14.449c0 .706.07 1.369.21 1.973.14.604.354 1.15.636 1.621.696 1.159 1.818 1.927 3.593 1.927 1.497 0 2.633-.671 3.965-2.444.76-1.012 1.144-1.626 2.663-4.32l.942-1.664.183.3 2.152 3.595c.724 1.21 1.665 2.556 2.47 3.314 1.046.987 1.992 1.22 3.06 1.22 1.075 0 1.876-.355 2.455-.843C23.51 18.085 24 16.6 24 14.41c0-2.72-.681-5.357-2.084-7.45-1.282-1.912-2.957-2.93-4.716-2.93-1.047 0-2.088.467-3.053 1.308-.652.57-1.257 1.29-1.82 2.05-.69-.875-1.335-1.547-1.958-2.056-1.182-.966-2.315-1.303-3.454-1.303Zm10.16 2.053c1.147 0 2.188.758 2.992 1.999 1.132 1.748 1.647 4.195 1.647 6.4 0 1.548-.368 2.9-1.839 2.9-.58 0-1.027-.23-1.664-1.004-.496-.601-1.343-1.878-2.832-4.358l-.617-1.028a44.908 44.908 0 0 0-1.255-1.98c1.19-1.865 2.24-2.929 3.569-2.929ZM6.874 6.636c1.265 0 2.058.791 2.675 1.446.307.327.737.871 1.234 1.579l-1.02 1.566c-.757 1.163-1.882 3.017-2.837 4.338-1.191 1.649-1.81 1.817-2.486 1.817-1.31 0-1.847-1.151-1.847-2.84 0-2.221.63-4.535 1.66-6.088.76-1.15 1.61-1.818 2.621-1.818Z" />
    ),
    mistral: (
      <path d="M17.143 3.429v3.428h-3.429v3.429h-3.428V6.857H6.857V3.43H3.43v13.714H0v3.428h10.286v-3.428H6.857v-3.429h3.429v3.429h3.429v-3.429h3.428v3.429h-3.428v3.428H24v-3.428h-3.43V3.429Z" />
    ),
  };
  const path = paths[normalized];
  if (path)
    return (
      <b className={`provider-mark provider-${normalized}`}>
        <svg viewBox="0 0 24 24" aria-label={`${providerLabel(normalized)} logo`}>
          {path}
        </svg>
      </b>
    );
  if (normalized === "moonshot")
    return (
      <b className="provider-mark provider-moonshot">
        <svg viewBox="0 0 24 24" aria-label="Moonshot logo">
          <path d="M17.8 16.9A8.2 8.2 0 0 1 8.1 6.2 8.3 8.3 0 1 0 17.8 16.9Z" />
        </svg>
      </b>
    );
  if (normalized === "free")
    return (
      <b className="provider-mark provider-free">
        <span>F</span>
      </b>
    );
  return (
    <b className={`provider-mark provider-${normalized}`}>
      <span>{providerMonogram(normalized)}</span>
    </b>
  );
}

function NavButton({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick(): void;
  icon: IconName;
  children: React.ReactNode;
}) {
  return (
    <button className={active ? "active" : ""} onClick={onClick}>
      <span>
        <Icon name={icon} />
      </span>
      {children}
    </button>
  );
}
function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}
function MetricCard({ label, value, delta }: { label: string; value: string; delta: string }) {
  return (
    <div className="panel metric-card">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{delta}</small>
    </div>
  );
}
function AgentLogo({ id, compact = false }: { id: AgentId; compact?: boolean }) {
  const icon = id === "openclaw" ? OPENCLAW_ICON : AGENT_ICON_DATA[id];
  return (
    <div className={`agent-logo ${id} ${compact ? "compact" : ""}`}>
      <img
        src={icon}
        alt={`${agentLabel(id)} logo`}
        width={compact ? 26 : 36}
        height={compact ? 26 : 36}
      />
    </div>
  );
}
function agentLabel(id: AgentId) {
  return {
    openclaw: "OpenClaw",
    codex: "Codex",
    hermes: "Hermes",
    dsh: "DeepSeek Harness",
    pi: "Pi",
  }[id];
}
function BrandGlyph() {
  return <img src={BLOCKRUN_ICON} alt="" aria-hidden="true" width={24} height={24} />;
}
function GitHubIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12 .7a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2.23c-3.22.7-3.9-1.37-3.9-1.37-.52-1.34-1.28-1.69-1.28-1.69-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.71 1.26 3.37.96.1-.75.4-1.26.73-1.55-2.57-.29-5.27-1.28-5.27-5.68 0-1.26.45-2.28 1.18-3.09-.12-.29-.51-1.47.11-3.05 0 0 .97-.31 3.16 1.18A10.9 10.9 0 0 1 12 6.16c.98 0 1.95.13 2.87.39 2.2-1.49 3.16-1.18 3.16-1.18.63 1.58.23 2.76.12 3.05.73.81 1.18 1.83 1.18 3.09 0 4.41-2.71 5.38-5.29 5.67.42.36.79 1.07.79 2.16v3.21c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .7Z"
      />
    </svg>
  );
}
function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, React.ReactNode> = {
    home: (
      <>
        <path d="m3 11 9-7 9 7" />
        <path d="M5.5 10v9.5h13V10M9 19.5v-6h6v6" />
      </>
    ),
    models: (
      <>
        <path d="m12 3 8 4.5-8 4.5-8-4.5Z" />
        <path d="m4 12 8 4.5 8-4.5M4 16.5 12 21l8-4.5" />
      </>
    ),
    usage: (
      <>
        <path d="M4 19V9M10 19V5M16 19v-7M22 19V3" />
      </>
    ),
    settings: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.55V21h-4v-.08A1.7 1.7 0 0 0 8.96 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15 1.7 1.7 0 0 0 3.08 14H3v-4h.08A1.7 1.7 0 0 0 4.6 8.96a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 8.96 4.6 1.7 1.7 0 0 0 10 3.08V3h4v.08a1.7 1.7 0 0 0 1.03 1.53 1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06a1.7 1.7 0 0 0-.34 1.88A1.7 1.7 0 0 0 20.92 10H21v4h-.08A1.7 1.7 0 0 0 19.4 15Z" />
      </>
    ),
    refresh: (
      <>
        <path d="M20 7v5h-5" />
        <path d="M18.3 16a8 8 0 1 1 .4-8.5L20 12" />
      </>
    ),
    sun: (
      <>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.42-1.41M17.66 6.34l1.41-1.41" />
      </>
    ),
    moon: <path d="M20.5 15.4A8.5 8.5 0 0 1 8.6 3.5 8.5 8.5 0 1 0 20.5 15.4Z" />,
    external: (
      <>
        <path d="M14 5h5v5M19 5l-8 8" />
        <path d="M17 13v6H5V7h6" />
      </>
    ),
    wallet: (
      <>
        <path d="M4 6.5h14a2 2 0 0 1 2 2v9H4a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2h12" />
        <path d="M16 11h6v4h-6a2 2 0 0 1 0-4Z" />
      </>
    ),
  };
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[name]}
    </svg>
  );
}
function healthLabel(agent: AgentStatus) {
  if (agent.health === "ready")
    return agent.activation === "immediate" ? "Connected" : "Configured";
  if (!agent.installed) return agent.configured ? "Configured · CLI missing" : "Not detected";
  return agent.configured ? "Needs proxy" : "Available";
}
function activationLabel(agent: AgentStatus) {
  return agent.activation === "immediate"
    ? "Live update"
    : agent.activation === "restart-gateway"
      ? "Restart gateway after changes"
      : "Restart app after changes";
}
function agentApiLabel(id: AgentId) {
  if (id === "codex") return "Responses API";
  if (id === "dsh" || id === "pi") return "Hot reload";
  if (id === "openclaw") return "Native plugin";
  return "Chat Completions";
}
function titleFor(page: Page) {
  return {
    overview: "Overview",
    models: "Model catalog",
    usage: "Usage & routing",
    wallet: "Wallet",
    settings: "Settings",
  }[page];
}
function compact(value: number) {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(
    value,
  );
}
function modelProvider(model: ModelInfo) {
  const identity = `${model.id} ${model.name ?? ""}`.toLowerCase();
  if (["auto", "eco", "premium"].includes(model.id)) return "blockrun";
  if (/qwen|千问/.test(identity)) return "qwen";
  if (/deepseek/.test(identity)) return "deepseek";
  if (/kimi|moonshot/.test(identity)) return "moonshot";
  if (/claude|anthropic/.test(identity)) return "anthropic";
  if (/gemini|google/.test(identity)) return "google";
  if (/grok|xai/.test(identity)) return "xai";
  if (/minimax/.test(identity)) return "minimax";
  if (/glm|zai/.test(identity)) return "zai";
  if (/gpt|openai|\bo[134](?:-|\b)/.test(identity)) return "openai";
  if (/llama|maverick/.test(identity)) return "meta";
  if (/mistral|devstral/.test(identity)) return "mistral";
  if (/nemotron/.test(identity)) return "nvidia";
  if (/stepfun|step-/.test(identity)) return "stepfun";
  if (/seed-oss/.test(identity)) return "seed";
  return model.ownedBy === "free"
    ? "free"
    : (model.ownedBy ?? model.id.split("/")[0] ?? "blockrun");
}
function providerLabel(provider: string) {
  const labels: Record<string, string> = {
    zai: "Z.AI",
    xai: "xAI",
    qwen: "Qwen",
    nvidia: "NVIDIA",
    meta: "Meta",
    mistral: "Mistral AI",
    stepfun: "StepFun",
    seed: "Seed",
  };
  return (
    labels[provider] ??
    (provider === "free" ? "Free model" : provider.charAt(0).toUpperCase() + provider.slice(1))
  );
}
function providerMonogram(provider: string) {
  return provider === "anthropic"
    ? "A"
    : provider === "openai"
      ? "O"
      : provider === "google"
        ? "G"
        : provider === "deepseek"
          ? "D"
          : provider === "blockrun"
            ? "B"
            : provider.slice(0, 1).toUpperCase();
}
function formatTokenCount(value: number | undefined) {
  if (!value) return "—";
  if (value >= 1_000_000)
    return `${(value / 1_000_000).toLocaleString("en", { maximumFractionDigits: 2 })}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return value.toLocaleString("en");
}
function formatModelPrice(model: ModelInfo, value: number | undefined) {
  if (["auto", "eco", "premium"].includes(model.id)) return "Varies";
  if (value == null) return "—";
  if (value === 0) return "Free";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 3,
  }).format(value);
}
function formatWalletBalance(value: number | undefined, compact = false, loading = false) {
  if (value == null) return compact ? "—" : loading ? "Checking balance…" : "Balance unavailable";
  return compact ? `$${value.toFixed(2)}` : `$${value.toFixed(2)} USDC`;
}
function removalLabel(agent: AgentStatus) {
  return agent.removalMode === "restore"
    ? "Restore config"
    : agent.removalMode === "disconnect"
      ? "Disconnect"
      : "No backup";
}
function sortablePrice(model: ModelInfo, kind: "input" | "output") {
  if (["auto", "eco", "premium"].includes(model.id)) return Number.POSITIVE_INFINITY;
  return (kind === "input" ? model.inputPrice : model.outputPrice) ?? Number.POSITIVE_INFINITY;
}
function shortAddress(address: string) {
  return address.length > 15 ? `${address.slice(0, 7)}…${address.slice(-5)}` : address;
}
function prettyModel(id: string) {
  return id.split("/").at(-1)?.replaceAll("-", " ") ?? id;
}
function normalizeStats(stats: Record<string, unknown> | null | undefined) {
  const pick = (...keys: string[]) =>
    keys.map((key) => stats?.[key]).find((value) => typeof value === "number") as
      number | undefined;
  return {
    requests: pick("requests", "totalRequests", "total_requests") ?? 0,
    cost: pick("totalCost", "totalCostUSD", "total_cost") ?? 0,
    tokens: pick("tokens", "totalTokens", "inputTokens", "total_tokens") ?? 0,
  };
}

function collapseModelAliases(models: ModelInfo[]): CatalogModel[] {
  const aliasesByTarget = new Map<string, string[]>();
  const canonical: ModelInfo[] = [];

  for (const model of models) {
    const name = model.name ?? "";
    const arrow = name.indexOf(" → ");
    if (arrow === -1) {
      canonical.push(model);
      continue;
    }
    const targetName = name
      .slice(arrow + 3)
      .trim()
      .toLowerCase();
    const aliases = aliasesByTarget.get(targetName) ?? [];
    aliases.push(model.id);
    aliasesByTarget.set(targetName, aliases);
  }

  const seen = new Set<string>();
  return canonical.flatMap((model) => {
    if (seen.has(model.id)) return [];
    seen.add(model.id);
    const aliases = aliasesByTarget.get((model.name ?? "").trim().toLowerCase()) ?? [];
    return [{ ...model, aliases: [...new Set(aliases)].sort() }];
  });
}

function enrichModel(model: ModelInfo): ModelInfo {
  const bundled = BUNDLED_MODEL_METADATA[model.id];
  if (!bundled) return model;
  return {
    ...model,
    name: model.name ?? bundled.name,
    ownedBy: model.ownedBy ?? bundled.owned_by,
    contextWindow: model.contextWindow ?? bundled.context_window,
    maxOutput: model.maxOutput ?? bundled.max_output,
    inputPrice: model.inputPrice ?? bundled.input_price,
    outputPrice: model.outputPrice ?? bundled.output_price,
    reasoning: model.reasoning ?? bundled.reasoning,
    vision: model.vision ?? bundled.vision,
    agentic: model.agentic ?? bundled.agentic,
    toolCalling: model.toolCalling ?? bundled.tool_calling,
  };
}
