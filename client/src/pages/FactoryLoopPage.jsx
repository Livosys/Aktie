import React, { useCallback, useEffect, useState } from 'react';
import { DashboardShell, ChartCard, EmptyState } from '../components/dashboard/DashboardKit.jsx';

// ── AI Fabrikens loop ────────────────────────────────────────────────────────
//
// Sidan svarar på två frågor, och ordningen är designen:
//
//   1. Vad gör AI:n just nu?   → statusraden och de sju stegen
//   2. Vad lärde den sig senast? → evidens, minne och bibliotek
//
// Ren läsvy. Sidan hämtar ETT svar med GET och ritar det. Den räknar inte om
// policy, härleder ingen loopstatus och duplicerar ingen hjärnlogik — backend
// är källan, och ett andra ställe som räknar samma sak blir förr eller senare
// oense med det första.
//
// Allt som saknas visas som "–", aldrig som noll. Skillnaden mellan "vi vet att
// det är noll" och "vi vet inte" är hela poängen med en statusvy.

const ENDPOINT = '/api/factory/loop';
const REFRESH_MS = 20000;
const FETCH_TIMEOUT_MS = 8000;

const STEP_TONE = Object.freeze({
  done: 'ok',
  running: 'info',
  skipped: 'muted',
  pending: 'muted',
  failed: 'bad',
});

const STEP_LABEL = Object.freeze({
  done: 'Klart',
  running: 'Pågår',
  skipped: 'Hoppades över',
  pending: 'Väntar',
  failed: 'Fel',
});

const STATE_LABEL = Object.freeze({
  running: 'Arbetar',
  idle: 'Vilar',
  blocked: 'Blockerad',
});

// AI:s beslut om vad som ska hända med strategin. Det är något ANNAT än
// evidensklassificeringen: policyn dömer bevisen, det här dömer nästa steg.
const DECISION_LABEL = Object.freeze({
  PROMOTE: 'Befordra',
  IMPROVE: 'Förbättra',
  INSUFFICIENT_EVIDENCE: 'Otillräcklig evidens',
  REJECT: 'Lägg ned',
  WAITING_FOR_MORE_DATA: 'Väntar på mer data',
});

const DECISION_TONE = Object.freeze({
  PROMOTE: 'ok',
  IMPROVE: 'info',
  INSUFFICIENT_EVIDENCE: 'muted',
  REJECT: 'bad',
  WAITING_FOR_MORE_DATA: 'muted',
});

const OUTCOME_LABEL = Object.freeze({
  HISTORICALLY_VALIDATED_CANDIDATE: 'Historiskt validerad kandidat',
  INSUFFICIENT_EVIDENCE: 'Otillräcklig evidens',
  REJECTED_BY_HISTORICAL_EVIDENCE: 'Förkastad av historisk evidens',
});

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('sv-SE') : '–';
}

/** Tal med decimaler — profit factor, edge retention. */
function dec(value, digits = 2) {
  return typeof value === 'number' && Number.isFinite(value)
    ? value.toLocaleString('sv-SE', { minimumFractionDigits: digits, maximumFractionDigits: digits })
    : '–';
}

/** Pengar i USD. Tecknet är hela poängen och skrivs alltid ut. */
function usd(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '–';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toLocaleString('sv-SE', { maximumFractionDigits: 2 })} USD`;
}

function when(value) {
  if (!value) return '–';
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return '–';
  return new Date(ms).toLocaleString('sv-SE', { dateStyle: 'short', timeStyle: 'short' });
}

function Row({ label, value, hint }) {
  return (
    <div className="loop-row">
      <span className="loop-row-label">{label}</span>
      <span className="loop-row-value">{value ?? '–'}</span>
      {hint ? <span className="loop-row-hint">{hint}</span> : null}
    </div>
  );
}

function LoopStep({ index, step }) {
  const tone = STEP_TONE[step.status] || 'muted';
  return (
    <li className={`loop-step loop-step-${tone}`}>
      <span className="loop-step-index">{index}</span>
      <div className="loop-step-body">
        <div className="loop-step-head">
          <strong>{step.label}</strong>
          <span className={`loop-step-status loop-step-status-${tone}`}>
            {STEP_LABEL[step.status] || step.status}
          </span>
        </div>
        {step.summary ? <p className="loop-step-summary">{step.summary}</p> : null}
        <div className="loop-step-meta">
          {step.strategyId ? <span title="Strategi">{step.strategyId}</span> : null}
          {step.dnaHash ? <span title="DNA">{step.dnaHash}</span> : null}
          {/* Vilket genom som FAKTISKT kördes. Ett begärt genom som inte gick
              att ladda ger en körning om något annat, och den skillnaden är
              precis vad man behöver se för att lita på ett resultat. */}
          {step.requestedGenome ? <span title="Begärt genom">{`begärt: ${step.requestedGenome}`}</span> : null}
          {step.executedGenomes?.length
            ? <span title="Kört genom">{`kört: ${step.executedGenomes.join(', ')}`}</span>
            : null}
          <span title="Tidpunkt">{when(step.at)}</span>
        </div>
      </div>
    </li>
  );
}

/** Ett research-resultat i sin helhet: hypotes, mätning, dom och skäl. */
function ResearchResult({ result }) {
  if (!result) return <EmptyState text="Ingen hypotes har klassificerats ännu" />;
  return (
    <>
      <Row label="Strategi" value={result.strategyId} />
      <Row
        label="Hypotes"
        value={result.hypothesisId ? `${result.hypothesisId} ${result.hypothesisVersion || ''}`.trim() : '–'}
        hint={result.hypothesisHash || null}
      />
      <Row label="Koncept" value={result.concept} hint={result.cycle || null} />
      <Row label="DNA" value={result.dnaHash} />
      <Row label="Research-affärer" value={num(result.researchTrades)} />
      <Row label="Validerings-affärer" value={num(result.validationTrades)} />
      <Row label="Profit factor research" value={dec(result.researchProfitFactor, 3)} />
      <Row label="Profit factor validering" value={dec(result.validationProfitFactor, 3)} />
      <Row label="Netto research" value={usd(result.researchNetPnlUsd)} />
      <Row label="Netto validering" value={usd(result.validationNetPnlUsd)} />
      <Row label="Max drawdown research" value={usd(result.researchMaxDrawdownUsd)} />
      <Row label="Max drawdown validering" value={usd(result.validationMaxDrawdownUsd)} />
      <Row label="Edge retention" value={dec(result.edgeRetention, 3)} />
      <Row
        label="Klassificering"
        value={OUTCOME_LABEL[result.outcome] || result.outcome || '–'}
        hint={result.netEvidenceComplete ? null : 'nettot är ofullständigt i underlaget'}
      />
      <Row label="Skäl" value={result.reason} />
      {result.failed?.length ? (
        <Row label="Föll på" value={result.failed.join(', ')} />
      ) : null}
    </>
  );
}

/**
 * AI:s beslut, och de tre frågor sidan finns för att besvara:
 * vad lärde den sig, vad ändrar den, vad testar den härnäst.
 */
function AiDecision({ decision, trigger }) {
  if (!decision) return <EmptyState text="Inget beslut att visa ännu" />;
  const tone = DECISION_TONE[decision.decision] || 'muted';
  return (
    <>
      <div className={`loop-step loop-step-${tone}`}>
        <div className="loop-step-body">
          <div className="loop-step-head">
            <strong>{DECISION_LABEL[decision.decision] || decision.decision}</strong>
            <span className={`loop-step-status loop-step-status-${tone}`}>{decision.strategyId}</span>
          </div>
          {decision.why ? <p className="loop-step-summary">{decision.why}</p> : null}
        </div>
      </div>

      <Row label="Vad lärde sig AI?" value={decision.learned} />
      <Row label="Vad ändrar AI nästa gång?" value={decision.wants} hint={decision.improvementFocus || null} />
      <Row label="Vad testar den härnäst?" value={decision.nextStep} />
      <Row label="Förälder-DNA" value={decision.parentDnaHash} />
      <Row
        label="Poäng"
        value={decision.score == null ? '–' : dec(decision.score, 1)}
        hint={decision.scoreSource ? `${decision.scoreSource} · tröskel ${trigger ?? decision.improvementTrigger}` : null}
      />
      <Row
        label="Evidensen beslutet vilar på"
        value={decision.evidence ? (OUTCOME_LABEL[decision.evidence.outcome] || decision.evidence.outcome) : 'ingen klassificerad evidens'}
        hint={decision.evidence?.reason || null}
      />
    </>
  );
}

export default function FactoryLoopPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [authRequired, setAuthRequired] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(ENDPOINT, { signal: controller.signal, credentials: 'same-origin' });
      // Ett 401 är inte "inga resultat" — det är "du är utloggad", och det
      // kräver en helt annan handling av den som läser sidan.
      if (res.status === 401 || res.status === 403) {
        setAuthRequired(true);
        throw new Error('Sessionen har gått ut — logga in igen');
      }
      setAuthRequired(false);
      if (!res.ok) throw new Error(`Statuskoden var ${res.status}`);
      const body = await res.json();
      if (body?.ok === false) throw new Error(body.error || 'Backend svarade utan resultat');
      setData(body);
      setError(null);
    } catch (err) {
      // Behåll senast kända svar. En tom sida är ett sämre svar än ett gammalt.
      setError(err.name === 'AbortError' ? 'Tidsgränsen gick ut' : (err.message || 'Kunde inte hämta'));
    } finally {
      clearTimeout(timer);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  const status = data?.status || {};
  const research = data?.research || {};
  const evidence = data?.evidence || {};
  const memory = data?.memory || {};
  const library = data?.library || {};
  const results = data?.researchResults || {};
  const decisions = data?.decisions || {};
  const steps = Array.isArray(data?.steps) ? data.steps : [];

  const kpis = [
    { label: 'Läge', value: STATE_LABEL[status.state] || '–', tone: status.state === 'blocked' ? 'bad' : (status.state === 'running' ? 'info' : 'neutral') },
    { label: 'Experiment', value: num(research.experimentsRun), hint: `${num(memory.validExperiments)} giltiga` },
    { label: 'Hypoteser prövade', value: num(results.total), hint: `${num(results.counts?.HISTORICALLY_VALIDATED_CANDIDATE)} kandidater` },
    { label: 'Vill förbättras', value: num(decisions.summary?.needsImprovement), tone: 'info', hint: `tröskel ${decisions.improvementTriggerScore ?? '–'}` },
  ];

  return (
    <DashboardShell
      title="AI Fabrikens loop"
      subtitle="Vad AI:n gör just nu, och vad den lärde sig senast."
      safety={data}
      kpis={kpis}
    >
      {authRequired ? (
        <div className="dash-card dash-card-bad" role="alert">
          <div className="dash-card-body">
            <strong>Du är utloggad.</strong> Sessionen har gått ut — panelerna nedan är tomma
            därför att svaret nekades, inte därför att fabriken saknar data.{' '}
            <a href="/login">Logga in igen</a>
          </div>
        </div>
      ) : error ? (
        <div className="dash-card dash-card-bad">
          <div className="dash-card-body">
            Kunde inte uppdatera: {error}
            {data ? ' — visar senast kända läge.' : ''}
          </div>
        </div>
      ) : null}

      {loading && !data ? <EmptyState text="Hämtar fabrikens läge…" /> : null}

      {data ? (
        <>
          <ChartCard title="Status" subtitle={status.reason || null}>
            <Row label="Läge" value={STATE_LABEL[status.state] || status.state} />
            <Row label="Nuvarande cykel" value={status.currentRunId} />
            <Row label="Föregående cykel" value={status.lastCompletedRunId} />
            <Row label="Nuvarande strategi" value={status.currentStrategy} />
            <Row label="Generation" value={status.generation == null ? '–' : `gen ${status.generation}`} />
            <Row label="Förälder-genom" value={status.parentGenome} />
            <Row
              label="Barn denna cykel"
              value={status.children?.length ? `${status.children.length} nya genom` : '–'}
              hint={status.children?.length
                ? status.children.map((child) => child.dnaHash.slice(0, 10)).join(', ')
                : null}
            />
            {status.children?.length ? (
              <ul className="loop-outcomes">
                {status.children.map((child) => (
                  <li key={child.dnaHash}>
                    <strong>{child.dnaHash}</strong>
                    <span>{child.generation == null ? '–' : `gen ${child.generation}`}</span>
                    {child.changes ? (
                      <em>
                        {Object.entries(child.changes)
                          .map(([key, value]) => `${key} → ${value}`)
                          .join(', ')}
                      </em>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
            <Row label="Begärt genom" value={status.requestedGenome} />
            <Row label="Pågående steg" value={status.currentAction} />
            <Row label="Senast avslutade steg" value={status.lastCompletedAction} />
            <Row label="Nästa åtgärd" value={status.nextAction} />
            {status.lastError ? <Row label="Senaste fel" value={status.lastError} /> : null}
            {status.blockedReason ? <Row label="Blockerare" value={status.blockedReason} /> : null}
            <Row label="Uppdaterad" value={when(data.generatedAt)} />
          </ChartCard>

          <ChartCard
            title="AI:s beslut"
            subtitle="Vad fabriken tänker göra — ett annat omdöme än evidensklassificeringen"
          >
            <AiDecision decision={decisions.current} trigger={decisions.improvementTriggerScore} />
            {decisions.summary?.counts ? (
              <div className="loop-step-meta" style={{ marginTop: 'var(--s3)' }}>
                {Object.entries(decisions.summary.counts)
                  .filter(([, count]) => count > 0)
                  .map(([key, count]) => (
                    <span key={key}>{`${DECISION_LABEL[key] || key}: ${count}`}</span>
                  ))}
              </div>
            ) : null}
          </ChartCard>

          <ChartCard title="Loopen" subtitle="Sju steg, i den ordning fabriken kör dem">
            {steps.length ? (
              <ol className="loop-steps">
                {steps.map((step, i) => <LoopStep key={step.id} index={i + 1} step={step} />)}
              </ol>
            ) : <EmptyState text="Ingen körning bokförd ännu" />}
          </ChartCard>

          <ChartCard title="Forskningsaktivitet">
            <Row label="Experiment totalt" value={num(research.experimentsRun)} />
            <Row label="Replays körda" value={num(research.replaysCompleted)} hint={research.queuePaused ? 'kön är pausad' : null} />
            <Row label="Historiska dygn" value={num(research.historicalDaysAvailable)} hint={research.dataAccessMode} />
            <Row label="Nuvarande strategi" value={research.currentStrategy} />
            <Row label="Nästa strategi" value={research.nextStrategy} />
          </ChartCard>

          <ChartCard title="Evidens" subtitle={evidence.policyVersion ? `${evidence.policyVersion} · ${evidence.policyStatus}` : null}>
            <Row label="Validerade kandidater" value={num(evidence.outcomes?.HISTORICALLY_VALIDATED_CANDIDATE)} />
            <Row label="Otillräcklig evidens" value={num(evidence.outcomes?.INSUFFICIENT_EVIDENCE)} />
            <Row label="Förkastade" value={num(evidence.outcomes?.REJECTED_BY_HISTORICAL_EVIDENCE)} />
            {Array.isArray(evidence.classified) && evidence.classified.length ? (
              <ul className="loop-outcomes">
                {evidence.classified.map((row) => (
                  <li key={row.strategyId}>
                    <strong>{row.strategyId}</strong>
                    <span>{row.outcome}</span>
                    {row.reason ? <em>{row.reason}</em> : null}
                  </li>
                ))}
              </ul>
            ) : <EmptyState text="Ingen hypotes klassificerades i senaste cykeln" />}
          </ChartCard>

          <ChartCard
            title="Senaste research-resultat"
            subtitle={results.latest?.at ? when(results.latest.at) : null}
          >
            <ResearchResult result={results.latest} />
          </ChartCard>

          <ChartCard
            title="Alla prövade hypoteser"
            subtitle={`${num(results.total)} hypoteser · ${results.policyVersion || ''}`}
          >
            {results.rows?.length ? (
              <ul className="loop-outcomes">
                {results.rows.map((row) => (
                  <li key={row.strategyId}>
                    <strong>{row.strategyId}</strong>
                    <span>{OUTCOME_LABEL[row.outcome] || row.outcome}</span>
                    <em>
                      {`PF ${dec(row.researchProfitFactor, 2)}/${dec(row.validationProfitFactor, 2)}`}
                      {` · netto ${usd(row.researchNetPnlUsd)}/${usd(row.validationNetPnlUsd)}`}
                      {` · ${num(row.researchTrades)}+${num(row.validationTrades)} affärer`}
                    </em>
                  </li>
                ))}
              </ul>
            ) : <EmptyState text="Ingen hypotes har prövats ännu" />}
          </ChartCard>

          <ChartCard title="AI Memory">
            <Row label="Experiment totalt" value={num(memory.totalExperiments)} />
            <Row label="Giltiga experiment" value={num(memory.validExperiments)} />
            <Row label="Uteslutna" value={num(memory.excludedExperiments)} hint="räknas inte som kunskap" />
            <Row label="Dubbletter som hoppades över" value={num(memory.duplicateSkips)} />
            <Row label="Distinkta marknader" value={num(memory.distinctMarkets)} />
            <Row label="Senaste experiment" value={when(memory.latestExperimentAt)} />
            <Row label="Första experiment" value={when(memory.firstExperimentAt)} />
            {memory.eventsByType ? (
              Object.entries(memory.eventsByType).map(([type, count]) => (
                <Row key={type} label={type} value={num(count)} />
              ))
            ) : null}
          </ChartCard>

          <ChartCard title="Strategy Library">
            <Row label="Strategier" value={num(library.strategies)} />
            <Row label="Pensionerade" value={num(library.retired)} />
            <Row label="Händelser i loggen" value={num(library.events)} />
            <Row label="Senaste ändring" value={when(library.latestChangeAt)} />
            <Row
              label="Senaste evidens"
              value={library.latestEvidence
                ? `${library.latestEvidence.strategyId}: ${OUTCOME_LABEL[library.latestEvidence.outcome] || library.latestEvidence.outcome}`
                : '–'}
              hint={library.latestEvidence?.reason || null}
            />
            {library.lifecycleStates && Object.keys(library.lifecycleStates).length ? (
              Object.entries(library.lifecycleStates).map(([stage, count]) => (
                <Row key={stage} label={stage} value={num(count)} />
              ))
            ) : <EmptyState text="Inga livscykelsteg att visa" />}
          </ChartCard>
        </>
      ) : null}
    </DashboardShell>
  );
}
