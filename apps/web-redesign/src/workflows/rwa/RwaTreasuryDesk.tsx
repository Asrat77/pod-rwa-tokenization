import {
  ArrowRight,
  BadgeCheck,
  Banknote,
  CircleAlert,
  CircleDollarSign,
  ExternalLink,
  FileCheck2,
  Landmark,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import { FormEvent, ReactNode, useEffect, useMemo, useState } from 'react';
import { graphqlRequest } from '../../api';
import { useAuth } from '../../auth';
import { usePermissions } from '../../permissions';
import './rwaTreasury.css';

type Notify = (message: string) => void;
type RailKind = 'SQUADS_FIAT_FORWARD' | 'DIRECT_USDC';
type Deal = {
  id: string;
  displayName: string;
  state: string;
  beneficiaryEntityHash: string;
  bankRouteHash: string;
  mseRailKind?: RailKind | null;
  hardCapBaseUnits: string;
  fundedBaseUnits: string;
  releasedBaseUnits: string;
  repaidBaseUnits: string;
  settlementMint: string;
};
type Milestone = {
  dealId: string;
  index: number;
  gateKind: string;
  allocationBps: number;
  amountBaseUnits: string;
  status: string;
  gateRevision?: number | null;
};
type Movement = {
  id: string;
  dealId: string;
  milestoneIndex: number;
  status: string;
  railKind?: RailKind | null;
  releasedUsdcBaseUnits: string;
  grossUsdMinor: string;
  netUsdMinor: string;
  conversionRateE8: string;
  providerFeesUsdMinor: string;
  bankFeesUsdMinor: string;
  beneficiaryEntityHash: string;
  bankRouteHash: string;
  conversionProviderRefHash?: string | null;
  swiftUetrHash?: string | null;
  bankConfirmationHash?: string | null;
  treasuryApprovedBy?: string | null;
  riskApprovedBy?: string | null;
  updatedAt: string;
};

const DEALS = `query RwaOperationsDeals {
  rwaDeals {
    id displayName state beneficiaryEntityHash bankRouteHash mseRailKind settlementMint
    hardCapBaseUnits fundedBaseUnits releasedBaseUnits repaidBaseUnits
  }
}`;
const DETAIL = `query RwaOperationsDetail($dealId: ID!) {
  rwaMilestones(dealId: $dealId) {
    dealId index gateKind allocationBps amountBaseUnits status gateRevision
  }
  rwaTreasuryMovements(dealId: $dealId) {
    id dealId milestoneIndex status railKind releasedUsdcBaseUnits grossUsdMinor netUsdMinor
    conversionRateE8 providerFeesUsdMinor bankFeesUsdMinor beneficiaryEntityHash
    bankRouteHash conversionProviderRefHash swiftUetrHash bankConfirmationHash
    treasuryApprovedBy riskApprovedBy updatedAt
  }
}`;

const amount = (baseUnits: string) => {
  const raw = BigInt(baseUnits || '0');
  const fraction = (raw % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${raw / 1_000_000n}${fraction ? `.${fraction}` : ''}`;
};
const money = (minor: string) => (Number(minor || '0') / 100).toLocaleString('en-US', {
  style: 'currency',
  currency: 'USD',
});
const short = (value?: string | null) => value
  ? `${value.slice(0, 7)}…${value.slice(-7)}`
  : '—';
const statusLabel = (value: string) => value.replaceAll('_', ' ');

async function mutate<T>(
  query: string,
  input: Record<string, unknown>,
  getIdToken: () => Promise<string>,
): Promise<T> {
  return graphqlRequest<T>(query, { input }, await getIdToken());
}

export function RwaTreasuryDesk({ notify }: { notify: Notify }) {
  const { getIdToken } = useAuth();
  const {
    role,
    isTreasury,
    isRisk,
    isAdmin,
    isSuperAdmin,
    isOperations,
  } = usePermissions();
  const [deals, setDeals] = useState<Deal[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [milestones, setMilestones] = useState<Milestone[]>([]);
  const [movements, setMovements] = useState<Movement[]>([]);
  const [selectedMilestone, setSelectedMilestone] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const deal = deals.find((item) => item.id === selectedId);
  const movementByMilestone = useMemo(
    () => new Map(movements.map((item) => [item.milestoneIndex, item])),
    [movements],
  );
  const milestone = milestones.find((item) => item.index === selectedMilestone);
  const movement = movementByMilestone.get(selectedMilestone);

  const loadDeals = async () => {
    const result = await graphqlRequest<{ rwaDeals: Deal[] }>(DEALS, {}, await getIdToken());
    setDeals(result.rwaDeals);
    setSelectedId((current) => current || result.rwaDeals[0]?.id || '');
  };
  const loadDetail = async (dealId = selectedId) => {
    if (!dealId) return;
    const result = await graphqlRequest<{
      rwaMilestones: Milestone[];
      rwaTreasuryMovements: Movement[];
    }>(DETAIL, { dealId }, await getIdToken());
    setMilestones(result.rwaMilestones);
    setMovements(result.rwaTreasuryMovements);
  };
  const refresh = async () => {
    setLoading(true);
    setError('');
    try {
      await loadDeals();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to load RWA operations');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void refresh(); }, []);
  useEffect(() => {
    setSelectedMilestone(0);
    void loadDetail(selectedId).catch((reason) => {
      setError(reason instanceof Error ? reason.message : 'Unable to load treasury movements');
    });
  }, [selectedId]);

  const run = async (operation: () => Promise<unknown>, success: string) => {
    setBusy(true);
    setError('');
    try {
      await operation();
      notify(success);
      await Promise.all([loadDeals(), loadDetail()]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'RWA operation failed');
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return <div className="page"><div className="rwa-loading"><LoaderCircle className="rwa-spin" />Reconciling finalized RWA records…</div></div>;
  }

  return (
    <div className="page rwa-ops">
      <header className="rwa-ops__header">
        <div>
          <span className="rwa-kicker">MSE TREASURY CONTROL PLANE</span>
          <h1>RWA treasury rail</h1>
          <p>Release, conversion, SWIFT, bank confirmation, and repayment evidence—the Squads fiat-forward rail runs the full chain; a direct-USDC MSE settles on release.</p>
        </div>
        <div className="rwa-role"><ShieldCheck /><span>ACTIVE ROLE</span><strong>{role.replaceAll('_', ' ')}</strong></div>
      </header>

      {error ? <div className="rwa-error"><CircleAlert />{error}</div> : null}

      <section className="rwa-deal-strip">
        {deals.map((item) => (
          <button key={item.id} className={item.id === selectedId ? 'active' : ''} onClick={() => setSelectedId(item.id)}>
            <span>{item.id}</span><strong>{item.displayName}</strong><small>{statusLabel(item.state)}</small>
          </button>
        ))}
        <button className="rwa-refresh" onClick={() => void refresh()} aria-label="Refresh"><RefreshCw /></button>
      </section>

      {deal ? (
        <>
          <section className="rwa-ledger-summary">
            <Summary icon={<CircleDollarSign />} label="Funded" value={`${amount(deal.fundedBaseUnits)} USDC`} />
            <Summary icon={<ArrowRight />} label="Released to US treasury" value={`${amount(deal.releasedBaseUnits)} USDC`} />
            <Summary icon={<Landmark />} label="Repaid on-chain" value={`${amount(deal.repaidBaseUnits)} USDC`} />
            <Summary icon={<FileCheck2 />} label="Approved bank route" value={short(deal.bankRouteHash)} mono />
          </section>

          <div className="rwa-ops__grid">
            <section className="surface rwa-tranches">
              <div className="rwa-section-title"><div><span>01</span><h2>Tranche evidence chain</h2></div><small>PREVIOUS WIRE MUST BE RECONCILED</small></div>
              <div className="rwa-tranche-list">
                {milestones.map((item) => {
                  const linked = movementByMilestone.get(item.index);
                  return (
                    <button
                      key={item.index}
                      className={item.index === selectedMilestone ? 'active' : ''}
                      onClick={() => setSelectedMilestone(item.index)}
                    >
                      <span className="rwa-tranche-index">{item.index + 1}</span>
                      <div><small>{item.gateKind.replace('_PASS', '')}</small><strong>{item.allocationBps / 100}% · {amount(item.amountBaseUnits)} USDC</strong><p>{item.gateRevision ? `Exact oracle revision ${item.gateRevision}` : 'Capital-close gate'}</p></div>
                      <span className={`rwa-status rwa-status--${(linked?.status || 'pending').toLowerCase()}`}>{statusLabel(linked?.status || 'PENDING')}</span>
                    </button>
                  );
                })}
              </div>
            </section>

            <section className="surface rwa-action-panel">
              <div className="rwa-section-title"><div><span>02</span><h2>Controlled action</h2></div><small>{milestone ? `TRANCHE ${milestone.index + 1}` : 'SELECT A TRANCHE'}</small></div>
              {milestone ? (
                <MovementAction
                  deal={deal}
                  milestone={milestone}
                  movement={movement}
                  role={{
                    isTreasury,
                    isRisk,
                    isAdmin,
                    isSuperAdmin,
                    isOperations,
                  }}
                  busy={busy}
                  run={run}
                  getIdToken={getIdToken}
                />
              ) : <p>No release milestone is indexed for this deal.</p>}
            </section>
          </div>

          <section className="surface rwa-repayment">
            <div className="rwa-section-title"><div><span>03</span><h2>Reverse fiat repayment</h2></div><small>FIAT → USD/USDC → SQUADS → REPAYMENT VAULT</small></div>
            <RepaymentForm
              deal={deal}
              allowed={isTreasury || isOperations || isAdmin}
              busy={busy}
              run={run}
              getIdToken={getIdToken}
            />
          </section>
        </>
      ) : <section className="surface empty-state"><h2>No indexed RWA deals</h2><p>Deploy and index a finalized deal before initiating treasury workflow.</p></section>}
    </div>
  );
}

function Summary({ icon, label, value, mono }: { icon: ReactNode; label: string; value: string; mono?: boolean }) {
  return <div className="rwa-summary"><span>{icon}</span><div><small>{label}</small><strong className={mono ? 'mono' : ''}>{value}</strong></div></div>;
}

function MovementAction({
  deal,
  milestone,
  movement,
  role,
  busy,
  run,
  getIdToken,
}: {
  deal: Deal;
  milestone: Milestone;
  movement?: Movement;
  role: {
    isTreasury: boolean;
    isRisk: boolean;
    isAdmin: boolean;
    isSuperAdmin: boolean;
    isOperations: boolean;
  };
  busy: boolean;
  run: (operation: () => Promise<unknown>, success: string) => Promise<void>;
  getIdToken: () => Promise<string>;
}) {
  const isDirect = deal.mseRailKind === 'DIRECT_USDC';

  if (!movement) {
    return (
      <ActionForm
        title="Create disbursement proposal"
        copy={isDirect
          ? 'The MSE beneficiary is copied from the deal. A direct-USDC MSE has no bank route—USDC lands in its wallet on release.'
          : 'The immutable beneficiary and bank-route commitments are copied from the deal—not typed by operations.'}
        submitLabel="Create proposal"
        allowed={role.isOperations || role.isAdmin || role.isTreasury}
        busy={busy}
        fields={[]}
        onSubmit={() => run(
          () => mutate(
            `mutation Propose($input: CreateFiatDisbursementInput!) {
              createFiatDisbursement(input: $input) { id status }
            }`,
            {
              dealId: deal.id,
              milestoneIndex: milestone.index,
              beneficiaryEntityHash: deal.beneficiaryEntityHash,
              ...(isDirect ? {} : { bankRouteHash: deal.bankRouteHash }),
            },
            getIdToken,
          ),
          'Disbursement proposal created',
        )}
      >
        <Commitment label={isDirect ? 'MSE beneficiary' : 'Fiat beneficiary'} value={deal.beneficiaryEntityHash} />
        {isDirect ? null : <Commitment label="Approved bank route" value={deal.bankRouteHash} />}
      </ActionForm>
    );
  }

  if (movement.status === 'PROPOSED') {
    const availableRoles = [
      ...(role.isTreasury || role.isSuperAdmin ? ['TREASURY'] : []),
      ...(role.isRisk || role.isSuperAdmin ? ['RISK'] : []),
    ].filter((approvalRole) => (
      approvalRole === 'TREASURY'
        ? !movement.treasuryApprovedBy
        : !movement.riskApprovedBy
    ));
    return (
      <div className="rwa-approval">
        <p>Treasury and risk must approve independently. The same Cognito subject cannot approve both roles.</p>
        <div><Approval label="Treasury" actor={movement.treasuryApprovedBy} /><Approval label="Risk" actor={movement.riskApprovedBy} /></div>
        {availableRoles.length ? availableRoles.map((approvalRole) => (
          <button
            key={approvalRole}
            className="primary"
            disabled={busy}
            onClick={() => void run(
              () => mutate(
                `mutation Approve($input: ApproveFiatDisbursementInput!) {
                  approveFiatDisbursement(input: $input) { id status }
                }`,
                { movementId: movement.id, approvalRole },
                getIdToken,
              ),
              `${approvalRole.toLowerCase()} approval recorded`,
            )}
          >
            <ShieldCheck />Approve as {approvalRole.toLowerCase()}
          </button>
        )) : <button className="primary" disabled><ShieldCheck />Use a treasury or risk account</button>}
      </div>
    );
  }

  if (movement.status === 'APPROVED') {
    return (
      <ActionForm
        title={isDirect ? 'Anchor direct USDC release' : 'Anchor Squads release'}
        copy={isDirect
          ? 'Execute the approved release to the MSE wallet first, then record the finalized Solana signature.'
          : 'Execute the approved Squads proposal first, then record the finalized Solana signature.'}
        submitLabel="Record USDC release"
        allowed={role.isTreasury || role.isSuperAdmin}
        busy={busy}
        fields={[
          { name: 'releaseSignature', label: 'Finalized Solana signature', required: true },
        ]}
        hidden={{ releasedUsdcBaseUnits: milestone.amountBaseUnits }}
        onSubmit={(values) => run(
          () => mutate(
            `mutation Release($input: MarkUsdcReleasedInput!) {
              markUsdcReleased(input: $input) { id status }
            }`,
            { movementId: movement.id, ...values },
            getIdToken,
          ),
          'USDC treasury release anchored',
        )}
      >
        <Commitment label="Exact scheduled amount" value={`${amount(milestone.amountBaseUnits)} USDC`} />
      </ActionForm>
    );
  }

  if (movement.status === 'USDC_RELEASED' && isDirect) {
    return (
      <ActionForm
        title="Reconcile direct USDC transfer"
        copy="A direct-USDC MSE has no conversion or SWIFT leg; the finalized on-chain transfer to the MSE wallet is the reconciliation evidence."
        submitLabel="Reconcile movement"
        allowed={role.isRisk || role.isAdmin}
        busy={busy}
        fields={[{ name: 'reconciliationEvidenceHash', label: 'Reconciliation evidence hash', hash: true }]}
        onSubmit={(values) => run(
          () => mutate(
            `mutation Reconcile($input: ReconcileTreasuryMovementInput!) {
              reconcileTreasuryMovement(input: $input) { id status }
            }`,
            { movementId: movement.id, ...values },
            getIdToken,
          ),
          'Direct USDC movement reconciled',
        )}
      />
    );
  }

  if (movement.status === 'USDC_RELEASED') {
    return (
      <ActionForm
        title="Record USDC-to-USD conversion"
        copy="Gross USD must equal net USD plus provider and bank fees exactly."
        submitLabel="Record conversion"
        allowed={role.isTreasury || role.isSuperAdmin}
        busy={busy}
        fields={[
          { name: 'conversionProviderRefHash', label: 'Provider reference hash', hash: true },
          { name: 'grossUsdMinor', label: 'Gross USD minor units', amount: true },
          { name: 'netUsdMinor', label: 'Net USD minor units', amount: true },
          { name: 'providerFeesUsdMinor', label: 'Provider fees (minor units)', amount: true },
          { name: 'bankFeesUsdMinor', label: 'Bank fees (minor units)', amount: true },
          { name: 'conversionRateE8', label: 'Conversion rate × 10⁸', amount: true },
          { name: 'providerEvidenceHash', label: 'Provider evidence hash', hash: true },
        ]}
        onSubmit={(values) => run(
          () => mutate(
            `mutation Conversion($input: RecordConversionInput!) {
              recordConversion(input: $input) { id status }
            }`,
            { movementId: movement.id, ...values },
            getIdToken,
          ),
          'Conversion evidence recorded',
        )}
      />
    );
  }

  if (movement.status === 'CONVERTED' || movement.status === 'SWIFT_SENT') {
    return (
      <ActionForm
        title="Record SWIFT bank confirmation"
        copy="The full UETR is sent once for hashing and is never stored in DynamoDB or on-chain."
        submitLabel="Record bank confirmation"
        allowed={role.isOperations || role.isAdmin}
        busy={busy}
        fields={[
          { name: 'swiftUetr', label: 'SWIFT UETR', required: true, secret: true },
          { name: 'valueDate', label: 'Value date', type: 'date', required: true },
          { name: 'bankConfirmationHash', label: 'Bank confirmation hash', hash: true },
        ]}
        onSubmit={(values) => run(
          () => mutate(
            `mutation Swift($input: RecordSwiftConfirmationInput!) {
              recordSwiftConfirmation(input: $input) { id status }
            }`,
            { movementId: movement.id, ...values },
            getIdToken,
          ),
          'Bank confirmation recorded',
        )}
      />
    );
  }

  if (movement.status === 'BANK_CONFIRMED') {
    return (
      <ActionForm
        title="Independent reconciliation"
        copy="A reviewer independent from treasury and risk approvers checks amount, beneficiary, route, fees, and UETR."
        submitLabel="Reconcile movement"
        allowed={role.isRisk || role.isAdmin}
        busy={busy}
        fields={[{ name: 'reconciliationEvidenceHash', label: 'Reconciliation evidence hash', hash: true }]}
        onSubmit={(values) => run(
          () => mutate(
            `mutation Reconcile($input: ReconcileTreasuryMovementInput!) {
              reconcileTreasuryMovement(input: $input) { id status }
            }`,
            { movementId: movement.id, ...values },
            getIdToken,
          ),
          'Treasury movement reconciled',
        )}
      />
    );
  }

  return (
    <div className="rwa-complete">
      <BadgeCheck />
      <h3>{statusLabel(movement.status)}</h3>
      <p>{money(movement.netUsdMinor)} net USD · {money(movement.providerFeesUsdMinor)} provider fees · {money(movement.bankFeesUsdMinor)} bank fees</p>
      {movement.status === 'RECONCILED' ? <span>The next tranche may now be proposed.</span> : null}
    </div>
  );
}

type Field = {
  name: string;
  label: string;
  required?: boolean;
  hash?: boolean;
  amount?: boolean;
  secret?: boolean;
  type?: string;
};

function ActionForm({
  title,
  copy,
  submitLabel,
  fields,
  hidden,
  allowed = true,
  busy,
  onSubmit,
  children,
}: {
  title: string;
  copy: string;
  submitLabel: string;
  fields: Field[];
  hidden?: Record<string, string>;
  allowed?: boolean;
  busy: boolean;
  onSubmit: (values: Record<string, string>) => Promise<void>;
  children?: ReactNode;
}) {
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    if (!allowed) return;
    const values: Record<string, string> = { ...(hidden ?? {}) };
    for (const field of fields) values[field.name] = String(data.get(field.name) || '').trim();
    void onSubmit(values);
  };
  return (
    <form className="rwa-action-form" onSubmit={submit}>
      <h3>{title}</h3><p>{copy}</p>{children}
      <div className="rwa-form-grid">
        {fields.map((field) => (
          <label key={field.name}>
            {field.label}
            <input
              name={field.name}
              type={field.type || (field.secret ? 'password' : 'text')}
              required={field.required ?? true}
              pattern={field.hash ? '[0-9a-fA-F]{64}' : field.amount ? '(0|[1-9][0-9]*)' : undefined}
              autoComplete="off"
            />
          </label>
        ))}
      </div>
      <button className="primary" disabled={busy || !allowed}>
        {busy ? <LoaderCircle className="rwa-spin" /> : <Banknote />}
        {allowed ? submitLabel : 'Sign in with the required role'}
      </button>
    </form>
  );
}

function Commitment({ label, value }: { label: string; value: string }) {
  return <div className="rwa-commitment"><small>{label}</small><code>{value}</code></div>;
}

function Approval({ label, actor }: { label: string; actor?: string | null }) {
  return <span className={actor ? 'done' : ''}>{actor ? <BadgeCheck /> : <CircleAlert />}<small>{label}</small><strong>{actor ? short(actor) : 'Pending'}</strong></span>;
}

function RepaymentForm({
  deal,
  allowed,
  busy,
  run,
  getIdToken,
}: {
  deal: Deal;
  allowed: boolean;
  busy: boolean;
  run: (operation: () => Promise<unknown>, success: string) => Promise<void>;
  getIdToken: () => Promise<string>;
}) {
  return (
    <ActionForm
      title="Record incoming fiat and conversion"
      copy="After this evidence record, the US issuer Squads wallet must separately execute deposit_repayment into the deal vault."
      submitLabel="Record fiat repayment"
      allowed={allowed}
      busy={busy}
      fields={[
        { name: 'payerType', label: 'Authorized payer type' },
        { name: 'fiatBankEvidenceHash', label: 'Incoming bank evidence hash', hash: true },
        { name: 'grossUsdMinor', label: 'Gross USD minor units', amount: true },
        { name: 'netUsdcBaseUnits', label: 'Net USDC base units', amount: true },
        { name: 'conversionProviderRefHash', label: 'Conversion provider hash', hash: true },
      ]}
      hidden={{ dealId: deal.id }}
      onSubmit={(values) => run(
        () => mutate(
          `mutation Repayment($input: RecordFiatRepaymentInput!) {
            recordFiatRepayment(input: $input) { id status }
          }`,
          values,
          getIdToken,
        ),
        'Fiat repayment evidence recorded',
      )}
    >
      <a className="rwa-squads-link" href="https://app.squads.so/" target="_blank" rel="noreferrer">Open issuer Squads treasury <ExternalLink /></a>
    </ActionForm>
  );
}
