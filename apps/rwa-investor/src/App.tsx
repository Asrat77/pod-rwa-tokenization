import {
  ArrowUpRight,
  BadgeCheck,
  Check,
  ChevronRight,
  CircleDollarSign,
  Clock3,
  ExternalLink,
  FileCheck2,
  Landmark,
  Leaf,
  LockKeyhole,
  LogOut,
  RefreshCw,
  ShieldCheck,
  WalletCards,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { calculateProRataPayout } from "@pod/rwa-client";
import { AuthGate, useAuth } from "./auth";
import {
  bindWallet,
  createWalletChallenge,
  isFixtureMode,
  loadDealDetail,
  loadWorkspace,
} from "./api";
import type {
  DealDetail,
  DealWorkspace,
  RwaDeal,
  RwaMilestone,
  RwaTreasuryMovement,
} from "./types";
import {
  connectWallet,
  signBindingMessage,
  type InjectedSolanaProvider,
} from "./wallet";

const emptyWorkspace: DealWorkspace = { deals: [], eligibility: null };
const emptyDetail: DealDetail = {
  milestones: [],
  movements: [],
  position: null,
  settlement: null,
};

function usdc(baseUnits: string): string {
  const value = BigInt(baseUnits || "0");
  const whole = value / 1_000_000n;
  const fraction = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${whole.toLocaleString("en-US")}${fraction ? `.${fraction}` : ""}`;
}

function usdMinor(baseUnits: string): string {
  return (Number(baseUnits || "0") / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  });
}

function parseUsdc(value: string): string {
  if (!/^(0|[1-9]\d*)(\.\d{0,6})?$/.test(value)) throw new Error("Use no more than 6 decimals");
  const [whole, fraction = ""] = value.split(".");
  const amount = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0") || "0");
  if (amount <= 0n) throw new Error("Enter an amount greater than zero");
  return amount.toString(10);
}

function short(value?: string | null, head = 6): string {
  if (!value) return "Not anchored";
  return value.length > head * 2 + 1 ? `${value.slice(0, head)}…${value.slice(-head)}` : value;
}

function date(value?: string | null): string {
  if (!value) return "Pending";
  return new Intl.DateTimeFormat("en", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(new Date(value));
}

function InvestorApp() {
  const { user, getIdToken, signOut } = useAuth();
  const [workspace, setWorkspace] = useState<DealWorkspace>(emptyWorkspace);
  const [selectedId, setSelectedId] = useState("");
  const [detail, setDetail] = useState<DealDetail>(emptyDetail);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [provider, setProvider] = useState<InjectedSolanaProvider | null>(null);
  const [wallet, setWallet] = useState("");
  const [amount, setAmount] = useState("15");
  const [reviewOpen, setReviewOpen] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [lastSignature, setLastSignature] = useState("");

  const reloadWorkspace = async () => {
    setLoading(true);
    try {
      const next = await loadWorkspace(getIdToken);
      setWorkspace(next);
      setSelectedId((current) => current || next.deals[0]?.id || "");
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load RWA workspace");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void reloadWorkspace();
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setDetail(emptyDetail);
      return;
    }
    let current = true;
    setDetailLoading(true);
    loadDealDetail(selectedId, getIdToken)
      .then((next) => {
        if (current) setDetail(next);
      })
      .catch((reason) => {
        if (current) setError(reason instanceof Error ? reason.message : "Could not load deal");
      })
      .finally(() => {
        if (current) setDetailLoading(false);
      });
    return () => {
      current = false;
    };
  }, [selectedId]);

  const deal = workspace.deals.find((candidate) => candidate.id === selectedId)
    || workspace.deals[0];
  const fundedPercent = deal
    ? Math.min(100, Number((BigInt(deal.fundedBaseUnits) * 10_000n) / BigInt(deal.hardCapBaseUnits)) / 100)
    : 0;
  const projected = useMemo(() => {
    try {
      const amountBaseUnits = parseUsdc(amount);
      return usdc(
        calculateProRataPayout(
          amountBaseUnits,
          "33000000",
          "30000000",
        ),
      );
    } catch {
      return "—";
    }
  }, [amount]);

  const connectAndBind = async () => {
    setError("");
    setNotice("");
    if (isFixtureMode) {
      setNotice("Fixture mode is read-only. Configure AppSync/Cognito to bind a Solana wallet.");
      return;
    }
    try {
      const connected = await connectWallet();
      setProvider(connected.provider);
      setWallet(connected.wallet);
      if (isFixtureMode) {
        setNotice("Wallet connected. Binding is disabled while the app is using local fixtures.");
        return;
      }
      const challenge = await createWalletChallenge(connected.wallet, getIdToken);
      const signature = await signBindingMessage(connected.provider, challenge.message);
      const bindingStatus = await bindWallet(
        { nonce: challenge.nonce, wallet: connected.wallet, signature },
        getIdToken,
      );
      setNotice(
        bindingStatus === "ACTIVE"
          ? "Wallet verified and bound to your active investor credential."
          : "Wallet verified. Compliance activation is still required before subscription.",
      );
      await reloadWorkspace();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Wallet connection failed");
    }
  };

  const subscribe = async () => {
    if (!deal || !workspace.eligibility || !provider) return;
    setSubmitting(true);
    setError("");
    try {
      const { submitSubscription } = await import("./solana");
      const signature = await submitSubscription({
        deal,
        eligibility: workspace.eligibility,
        amountBaseUnits: parseUsdc(amount),
        provider,
      });
      setLastSignature(signature);
      setNotice("Subscription finalized on Solana. The indexer may take a few seconds to update.");
      setReviewOpen(false);
      setAcknowledged(false);
      const [nextWorkspace, nextDetail] = await Promise.all([
        loadWorkspace(getIdToken),
        loadDealDetail(deal.id, getIdToken),
      ]);
      setWorkspace(nextWorkspace);
      setDetail(nextDetail);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Subscription failed");
    } finally {
      setSubmitting(false);
    }
  };

  const eligible = workspace.eligibility?.status === "ACTIVE";
  const walletMatches = Boolean(wallet && wallet === workspace.eligibility?.wallet);
  const chainReady = Boolean(deal?.chain?.programId && deal?.dealIdHash && deal?.receiptMint);
  const v1RailReady = !deal?.mseRailKind || deal.mseRailKind === "SQUADS_FIAT_FORWARD";
  const canReview = deal?.state === "SUBSCRIPTION_OPEN"
    && eligible
    && walletMatches
    && chainReady
    && v1RailReady;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-glyph"><Leaf size={17} /></span>
          <span>TURMI</span>
          <small>RWA REGISTRY</small>
        </div>
        <div className="topbar-actions">
          <span className="network"><i /> SOLANA DEVNET</span>
          <button className="wallet-button" onClick={connectAndBind} disabled={isFixtureMode}>
            <WalletCards size={16} />
            {isFixtureMode ? "Fixture mode" : wallet ? short(wallet, 4) : "Connect wallet"}
          </button>
          <div className="user-chip">
            <span>{user.name.slice(0, 1).toUpperCase()}</span>
            <div><strong>{user.name}</strong><small>{user.email}</small></div>
          </div>
          <button className="icon-button" onClick={signOut} aria-label="Sign out">
            <LogOut size={16} />
          </button>
        </div>
      </header>

      <div className="workspace">
        <aside className="deal-rail">
          <div className="rail-heading">
            <span>AVAILABLE SERIES</span>
            <strong>{workspace.deals.length.toString().padStart(2, "0")}</strong>
          </div>
          <div className="deal-list">
            {workspace.deals.map((candidate, index) => (
              <button
                key={candidate.id}
                className={`deal-tab ${candidate.id === deal?.id ? "active" : ""}`}
                onClick={() => setSelectedId(candidate.id)}
              >
                <span className="deal-index">{String(index + 1).padStart(2, "0")}</span>
                <span>
                  <strong>{candidate.displayName}</strong>
                  <small>{candidate.id}</small>
                </span>
                <ChevronRight size={16} />
              </button>
            ))}
          </div>
          <div className="rail-note">
            <ShieldCheck size={19} />
            <p><strong>Issuer-sponsored record</strong>The participation token records a claim. It is not title to farm, land, or crop.</p>
          </div>
        </aside>

        <main>
          {loading || !deal ? (
            <div className="loading-panel"><RefreshCw className="spin" /><span>Reading finalized records</span></div>
          ) : (
            <>
              {isFixtureMode ? (
                <div className="fixture-banner">
                  <span>FIXTURE VIEW</span>
                  Connect AppSync and a deployed deal to enable signed subscriptions.
                </div>
              ) : null}
              {!v1RailReady ? (
                <div className="notice error"><X size={16} />This deal uses a reserved non-V1 treasury rail. Subscription is disabled.</div>
              ) : null}
              {error ? <div className="notice error"><X size={16} />{error}</div> : null}
              {notice ? <div className="notice success"><Check size={16} />{notice}</div> : null}
              {lastSignature ? (
                <a
                  className="signature-link"
                  href={`https://explorer.solana.com/tx/${lastSignature}?cluster=devnet`}
                  target="_blank"
                  rel="noreferrer"
                >
                  View finalized subscription <ExternalLink size={14} />
                </a>
              ) : null}

              <section className="deal-hero">
                <div>
                  <span className="eyebrow">{deal.id} · SENIOR SERIES</span>
                  <h1>{deal.displayName}</h1>
                  <p>
                    A fixed-term financing claim issued by the US C-Corporation,
                    settled in Circle USDC, with field releases governed by immutable oracle revisions.
                  </p>
                </div>
                <div className={`state-stamp state-${deal.state.toLowerCase()}`}>
                  <span>DEAL STATE</span>
                  <strong>{deal.state.replaceAll("_", " ")}</strong>
                  <small>Account v{deal.chain?.accountVersion || 1}</small>
                </div>
              </section>

              <section className="funding-strip">
                <div className="funding-copy">
                  <span>CAPITAL FORMATION</span>
                  <strong>{usdc(deal.fundedBaseUnits)} <small>/ {usdc(deal.hardCapBaseUnits)} USDC</small></strong>
                </div>
                <div className="funding-meter" aria-label={`${fundedPercent}% funded`}>
                  <span style={{ width: `${fundedPercent}%` }} />
                </div>
                <div className="funding-percent">{fundedPercent.toFixed(0)}%</div>
                <div className="funding-stat">
                  <span>MINIMUM</span><strong>{usdc(deal.minimumRaiseBaseUnits)} USDC</strong>
                </div>
                <div className="funding-stat">
                  <span>COUPON</span><strong>{(deal.couponBps / 100).toFixed(0)}% FLAT</strong>
                </div>
                <div className="funding-stat">
                  <span>CLOSES</span><strong>{date(deal.subscriptionCloseAt)}</strong>
                </div>
              </section>

              <div className="content-grid">
                <div className="primary-column">
                  <Lifecycle
                    milestones={detail.milestones}
                    movements={detail.movements}
                    loading={detailLoading}
                  />
                  <section className="panel record-panel">
                    <PanelHeading number="02" label="LEGAL & CHAIN RECORD" title="What this series represents" />
                    <div className="record-grid">
                      <Record icon={<Landmark />} label="Issuer" value="US C-Corporation" note={`Commitment ${short(deal.issuerEntityHash)}`} />
                      <Record
                        icon={<ArrowUpRight />}
                        label="Fiat beneficiary"
                        value="International MSE (USD via SWIFT)"
                        note={`Entity ${short(deal.beneficiaryEntityHash)}`}
                      />
                      <Record icon={<CircleDollarSign />} label="Settlement asset" value="Circle USDC" note={`6 decimals · ${short(deal.settlementMint)}`} />
                      <Record icon={<FileCheck2 />} label="Legal documents" value="Locked at opening" note={`Bundle ${short(deal.documentBundleHash)}`} />
                    </div>
                    <div className="flow-line">
                      <span>INVESTOR</span><i /> <span>DEAL VAULT</span><i /> <span>US ISSUER (SQUADS)</span><i /> <span>USD / SWIFT</span><i /> <span>MSE</span>
                    </div>
                  </section>
                </div>

                <aside className="subscription-card">
                  <span className="eyebrow">YOUR ALLOCATION</span>
                  <h2>Subscribe to series</h2>
                  <p>USDC moves into this deal’s isolated vault. Receipt units mint atomically at 1:1.</p>

                  <label className="amount-field">
                    <span>AMOUNT</span>
                    <div><input value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="decimal" /><strong>USDC</strong></div>
                  </label>
                  <div className="quick-amounts">
                    {["5", "10", "15"].map((value) => (
                      <button key={value} onClick={() => setAmount(value)}>{value}</button>
                    ))}
                    <span>CAP 15</span>
                  </div>

                  <dl className="subscription-math">
                    <div><dt>Receipt units</dt><dd>{amount || "0"}</dd></div>
                    <div><dt>Coupon target</dt><dd>+10%</dd></div>
                    <div className="total"><dt>Illustrative full repayment</dt><dd>{projected} USDC</dd></div>
                  </dl>

                  <div className="eligibility-row">
                    <span className={eligible ? "verified" : ""}>
                      {eligible ? <BadgeCheck size={17} /> : <Clock3 size={17} />}
                      {eligible ? "Eligibility active" : "Eligibility pending"}
                    </span>
                    <small>{workspace.eligibility ? short(workspace.eligibility.wallet, 4) : "No wallet bound"}</small>
                  </div>

                  {isFixtureMode ? (
                    <button className="primary-action" onClick={connectAndBind}>
                      <WalletCards size={17} /> Wallet binding unavailable in fixture mode
                    </button>
                  ) : !wallet ? (
                    <button className="primary-action" onClick={connectAndBind}>
                      <WalletCards size={17} /> Connect and verify wallet
                    </button>
                  ) : (
                    <button
                      className="primary-action"
                      disabled={!canReview}
                      onClick={() => {
                        setAcknowledged(false);
                        setReviewOpen(true);
                      }}
                    >
                      Review subscription <ArrowUpRight size={17} />
                    </button>
                  )}
                  {!chainReady ? <small className="action-note">On-chain fixture addresses have not been indexed yet.</small> : null}
                  <div className="custody-note">
                    <LockKeyhole size={16} />
                    <span>Funds release only after oracle, risk, delay, and fixed-recipient checks.</span>
                  </div>
                </aside>
              </div>
            </>
          )}
        </main>
      </div>

      {reviewOpen && deal && workspace.eligibility && v1RailReady ? (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setReviewOpen(false)}>
          <section className="review-modal" role="dialog" aria-modal="true" aria-labelledby="review-title" onMouseDown={(event) => event.stopPropagation()}>
            <button className="modal-close" onClick={() => setReviewOpen(false)} aria-label="Close"><X /></button>
            <span className="eyebrow">WALLET-SIGNED TRANSACTION</span>
            <h2 id="review-title">Review {amount} USDC subscription</h2>
            <p>Your wallet will approve one checked USDC transfer and the protocol will mint the same number of receipt base units in the same transaction.</p>
            <dl>
              <div><dt>Deal</dt><dd>{deal.id}</dd></div>
              <div><dt>Destination</dt><dd>Isolated subscription vault</dd></div>
              <div><dt>Receipt policy</dt><dd>Transfers blocked · governed burn</dd></div>
              <div><dt>Terms commitment</dt><dd>{short(deal.termsHash, 8)}</dd></div>
            </dl>
            <label className="review-ack">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(event) => setAcknowledged(event.target.checked)}
              />
              <span>I understand this receipt is a financing claim, not ownership of the underlying farm, land, or crop.</span>
            </label>
            <button className="primary-action" disabled={submitting || !acknowledged} onClick={subscribe}>
              {submitting ? "Confirming on Solana…" : `Confirm ${amount} USDC`}
              <ArrowUpRight size={17} />
            </button>
          </section>
        </div>
      ) : null}
    </div>
  );
}

function Lifecycle({
  milestones,
  movements,
  loading,
}: {
  milestones: RwaMilestone[];
  movements: RwaTreasuryMovement[];
  loading: boolean;
}) {
  const movementByMilestone = useMemo(
    () => new Map(movements.map((movement) => [movement.milestoneIndex, movement])),
    [movements],
  );
  return (
    <section className="panel lifecycle-panel">
      <PanelHeading number="01" label="CAPITAL CONTROL" title="Release & bank-funding trail" />
      {loading ? <div className="inline-loading"><RefreshCw className="spin" /> Reconciling chain and bank evidence</div> : (
        <div className="milestones">
          {milestones.map((milestone, index) => {
            const movement = movementByMilestone.get(milestone.index);
            const complete = milestone.status === "RELEASED";
            return (
              <div className={`milestone ${complete ? "complete" : ""}`} key={milestone.index}>
                <div className="milestone-rail"><span>{complete ? <Check size={14} /> : index + 1}</span><i /></div>
                <div className="milestone-copy">
                  <span>{milestone.gateKind.replace("_PASS", "")}</span>
                  <strong>{milestone.allocationBps / 100}% · {usdc(milestone.amountBaseUnits)} USDC</strong>
                  <small>{milestone.gateRevision ? `Oracle revision ${milestone.gateRevision}` : milestone.index === 0 ? "Capital-close condition" : "Exact oracle revision pending"}</small>
                </div>
                <div className="bank-proof">
                  <span className={`proof-state proof-${movement?.status?.toLowerCase() || "pending"}`}>
                    {movement?.status?.replaceAll("_", " ") || "NOT RELEASED"}
                  </span>
                  <small>{movement ? `${usdMinor(movement.netUsdMinor)} net USD · ${date(movement.updatedAt)}` : "No treasury movement"}</small>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function PanelHeading({ number, label, title }: { number: string; label: string; title: string }) {
  return (
    <div className="panel-heading">
      <span>{number}</span>
      <div><small>{label}</small><h2>{title}</h2></div>
    </div>
  );
}

function Record({ icon, label, value, note }: { icon: React.ReactNode; label: string; value: string; note: string }) {
  return (
    <div className="record">
      <span>{icon}</span>
      <div><small>{label}</small><strong>{value}</strong><p>{note}</p></div>
    </div>
  );
}

export function App() {
  return <AuthGate><InvestorApp /></AuthGate>;
}
