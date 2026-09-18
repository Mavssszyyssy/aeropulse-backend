import { serviceDateLabel, serviceLabel } from '../../domain/myunit/serviceHistoryDisplay';

const labelForProvider = (provider) => provider === 'openai'
  ? 'AI-reviewed follow-up plan'
  : 'Evidence-based follow-up plan';

const recommendationLabel = (value) => serviceLabel(value || 'inspection');

function PlanRow({ label, children }) {
  if (!children) return null;
  return <div className="history-follow-up-row">
    <strong>{label}</strong>
    <span>{children}</span>
  </div>;
}

function ServiceFollowUp({ interpretation }) {
  if (!interpretation?.customerSummary) return null;
  const structured = Boolean(
    interpretation.overallCondition || interpretation.componentConcern || interpretation.recommendedPart
    || interpretation.recommendedActions?.length || interpretation.whyThisDate,
  );
  if (!structured) {
    return <div className="history-ai-follow-up">
      <strong>{labelForProvider(interpretation.provider)}</strong>
      <span>{interpretation.customerSummary}</span>
    </div>;
  }
  return <section className="history-ai-follow-up history-follow-up-plan" aria-label="Predictive maintenance follow-up plan">
    <strong>{labelForProvider(interpretation.provider)}</strong>
    <PlanRow label="Overall AC performance">{interpretation.overallCondition}</PlanRow>
    <PlanRow label="Recorded component concern">{interpretation.componentConcern || interpretation.problemsFound}</PlanRow>
    <PlanRow label="Recommended part or component">{interpretation.recommendedPart}</PlanRow>
    <PlanRow label="Part and inventory status">{interpretation.inventoryMessage}</PlanRow>
    <PlanRow label="Recommended service">{recommendationLabel(interpretation.recommendedService)}</PlanRow>
    <PlanRow label="Recommended next service date">{serviceDateLabel(interpretation.recommendedFollowUpDate)}</PlanRow>
    <PlanRow label="Why this date">{interpretation.whyThisDate}</PlanRow>
    {interpretation.recommendedActions?.length ? <div className="history-follow-up-actions">
      <strong>Recommended actions</strong>
      <ul>{interpretation.recommendedActions.map((action, index) => <li key={`${action}-${index}`}>{action}</li>)}</ul>
    </div> : null}
    {interpretation.warning ? <span className="history-follow-up-warning">{interpretation.warning}</span> : null}
  </section>;
}

export default ServiceFollowUp;
