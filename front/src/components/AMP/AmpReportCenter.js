import { useEffect, useMemo, useState } from "react";
import { apiRequest } from "../../config/api";
import { useUser } from "../../context/UserContext";
import { customerSystemMessage } from "../../domain/customerLanguage";
import { exportHtmlToPdfViaPrint } from "../../utils/exporters";
import { serviceLabel, serviceDateLabel as dateLabel } from "../../domain/myunit/serviceHistoryDisplay";

const REPORT_TYPES = [
  { value: "predictive_maintenance", label: "Next service plan", help: "See when service is suggested and why. This does not book a visit." },
  { value: "maintenance_summary", label: "Service history", help: "Review the installation, cleaning and repair work recorded for this AC." },
  { value: "inventory_reliability_analysis", label: "Model and parts history", help: "Review recorded services and parts used for the selected brand at its branch. These are historical counts, not failure predictions.", internalOnly: true },
];
const escapeHtml = (value) => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
const capacityAssessmentLabel = (value) => {
  const normalized = String(value || "").trim().toLowerCase();
  const labels = {
    suitable: "Suitable for the room",
    insufficient: "May be too small for the room",
    higher_than_necessary: "May be larger than needed",
    room_size_required: "Room size needed",
    capacity_required: "Horsepower needed",
  };
  return labels[normalized] || (normalized
    ? normalized.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase())
    : "Not assessed");
};
const basisLabel = (value) => ({
  same_unit: "This AC unit's history",
  same_model: "Same model history", same_brand_type: "Similar model type and brand history",
  same_brand: "Same brand history", system_default: "Provisional system schedule",
})[String(value || "").toLowerCase()] || "Recorded-service basis";
const maintenanceContextItems = (signals = {}) => [
  signals.serviceRequestCount ? `${signals.serviceRequestCount} non-cancelled service request(s) reviewed as context.` : "",
  signals.serviceRequestFrequency?.averageGapDays ? `Average gap between dated service requests: ${signals.serviceRequestFrequency.averageGapDays} days.` : "",
  signals.filterDirtRecordCount ? `${signals.filterDirtRecordCount} filter dirt-related record(s).` : "",
  signals.coilDirtRecordCount ? `${signals.coilDirtRecordCount} coil dirt-related record(s).` : "",
  signals.deepCleaningRecordCount ? `${signals.deepCleaningRecordCount} verified deep-cleaning record(s).` : "",
  signals.coilMaintenanceRecordCount ? `${signals.coilMaintenanceRecordCount} evaporator-coil cleaning record(s), kept as deeper maintenance context.` : "",
  ...(signals.recurringProblems || []).map(item => `Recurring ${item.label}: ${item.count} record(s).`),
  signals.refrigerantIssueRecordCount ? `${signals.refrigerantIssueRecordCount} refrigerant-related record(s), reviewed as context but excluded from cleaning intervals.` : "",
].filter(Boolean);
const reviewStatusLabel = (value) => ({
  ready_for_review: "Service outcome ready to review",
  awaiting_visit: "Awaiting a completed cleaning visit",
  no_matched_visit: "Replaced by a newer plan before a matching visit",
})[value] || "Saved plan";

function AmpReportCenter({
  units = [],
  initialUnitId = "",
  onPlanGenerated,
  title = "AC care reports",
  subtitle = "Choose an AC and the information you need. Start with its next service or review past work.",
}) {
  const { user } = useUser();
  const customerCopy = (value) => user?.role === "customer" ? customerSystemMessage(value) : value;
  const reportUnits = useMemo(() => units.filter((unit) => unit?.unitId || unit?.id), [units]);
  const types = useMemo(() => REPORT_TYPES.filter((item) => !item.internalOnly || ["admin", "superadmin", "owner", "manager"].includes(user?.role)), [user?.role]);
  const [reportType, setReportType] = useState("predictive_maintenance");
  const [unitId, setUnitId] = useState(initialUnitId);
  const [report, setReport] = useState(null);
  const [provider, setProvider] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { setReport(null); setProvider(""); setError(""); }, [unitId, reportType]);
  useEffect(() => {
    if (unitId && !reportUnits.some((unit) => String(unit.unitId || unit.id) === unitId)) setUnitId("");
  }, [reportUnits, unitId]);

  const generate = async () => {
    if (!unitId) return setError("Select an installed AC unit first.");
    setLoading(true); setError(""); setReport(null);
    try {
      const result = await apiRequest("/ai/amp-report", { method: "POST", body: JSON.stringify({ reportType, unitId }) });
      const next = result.report;
      // Keep staff analysis and saved evidence intact; simplify the customer view and its PDF only.
      setReport(next && user?.role === "customer" ? {
        ...next,
        explanationWarning: customerCopy(next.explanationWarning),
        maintenance: { ...next.maintenance,
          recommendationBasis: customerCopy(next.maintenance?.recommendationBasis),
          interpretation: customerCopy(next.maintenance?.interpretation),
          dataQuality: { ...next.maintenance?.dataQuality, message: customerCopy(next.maintenance?.dataQuality?.message) },
        },
        serviceHistory: (next.serviceHistory || []).map(item => ({ ...item,
          evidence: item.evidence ? { ...item.evidence, reason: customerCopy(item.evidence.reason) } : item.evidence,
        })),
      } : next || null); setProvider(result.provider || "");
      if (reportType === "predictive_maintenance" && result.report) onPlanGenerated?.(result.report);
    } catch (requestError) { setReport(null); setError(requestError.message || "We could not prepare your report. Please try again."); }
    finally { setLoading(false); }
  };

  const exportPdf = () => {
    if (!report) return;
    const m = report.maintenance || {};
    const pattern = m.patternAnalysis || {};
    const contextItems = maintenanceContextItems(m.maintenanceSignals);
    const historyRows = (report.serviceHistory || []).map((item) => `<tr><td>${escapeHtml(dateLabel(item.date))}</td><td>${escapeHtml(item.serviceLabel || serviceLabel(item.type))}</td><td>${escapeHtml(item.findings || "Not recorded")}${item.evidence?.eligible === false ? `<p>${escapeHtml(item.evidence.reason)}</p>` : ""}${item.aiInterpretation?.customerSummary ? `<p><strong>${item.aiInterpretation.provider === "openai" ? "AI follow-up recommendation" : "Follow-up schedule"}:</strong> ${escapeHtml(item.aiInterpretation.customerSummary)}</p>` : ""}</td><td>${escapeHtml(item.actionTaken || "Not recorded")}</td><td>${escapeHtml((item.partsUsed || []).join(", ") || "None recorded")}</td></tr>`).join("") || '<tr><td colspan="5">No service history has been recorded.</td></tr>';
    const modelRows = (report.aggregateReliability?.modelsByRecordedService || []).map((item) => `<tr><td>${escapeHtml(item.model)}</td><td>${escapeHtml(item.count)}</td></tr>`).join("");
    const html = `
      <div class="summary">
        <div class="summary-item"><strong>${escapeHtml(dateLabel(m.bestServicedBy))}</strong><span>Suggested servicing date</span></div>
        <div class="summary-item"><strong>${escapeHtml(m.recommendedServiceLabel || serviceLabel(m.recommendedService))}</strong><span>Recommended service</span></div>
        <div class="summary-item"><strong>${escapeHtml(capacityAssessmentLabel(m.capacityAssessment?.status))}</strong><span>Room size vs HP</span></div>
      </div>
      <h2>Maintenance recommendation</h2><p>${escapeHtml(m.interpretation || m.recommendationBasis || "")}</p>
      <h2>Pattern analysis</h2><p><strong>Source:</strong> ${escapeHtml(basisLabel(pattern.source || m.historicalBasis?.level))} · <strong>Verified intervals:</strong> ${escapeHtml(pattern.intervalCount ?? m.historicalBasis?.sampleSize ?? 0)} · <strong>Arithmetic average:</strong> ${escapeHtml(pattern.averageIntervalDays ? `${pattern.averageIntervalDays} days` : "6-month baseline")}</p>
      ${pattern.intervalsDays?.length ? `<p><strong>Cleaning gaps:</strong> ${escapeHtml(pattern.intervalsDays.join(", "))} days</p>` : ""}
      ${contextItems.length ? `<ul>${contextItems.map(item => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : ""}
      ${m.dataQuality?.message ? `<p><strong>Record review needed:</strong> ${escapeHtml(m.dataQuality.message)}</p>` : ""}
      <table><tbody>
        <tr><th>AC Unit ID</th><td>${escapeHtml(report.unit?.unitId || "Not recorded")}</td><th>Serial Number</th><td>${escapeHtml(report.unit?.serialNumber || "Not recorded")}</td></tr>
        <tr><th>Brand</th><td>${escapeHtml(report.unit?.brand || "Not recorded")}</td><th>Model</th><td>${escapeHtml(report.unit?.model || "Not recorded")}</td></tr>
        <tr><th>Last Service</th><td>${escapeHtml(dateLabel(m.lastServiceDate))}</td><th>Last Cleaning</th><td>${escapeHtml(dateLabel(m.lastCleaningDate))}</td></tr>
        <tr><th>Room Size</th><td>${escapeHtml(report.unit?.roomSizeSqm ? `${report.unit.roomSizeSqm} m²` : "Not recorded")}</td><th>AC Horsepower</th><td>${escapeHtml(report.unit?.capacityHp ? `${report.unit.capacityHp} HP` : "Not recorded")}</td></tr>
        <tr><th>Warranty Status</th><td>${escapeHtml(String(report.unit?.warrantyStatus || "Not recorded").replaceAll("_", " "))}</td><th>Responsible Branch</th><td>${escapeHtml(report.branch || "Not recorded")}</td></tr>
      </tbody></table>
      <p><strong>Historical basis:</strong> ${escapeHtml(m.recommendationBasis || "")}</p>
      <p><strong>Capacity assessment:</strong> ${escapeHtml(m.capacityAssessment?.summary || "Room size has not been supplied.")}</p>
      <h2>Recorded service history</h2><table><thead><tr><th>Date</th><th>Service</th><th>Findings</th><th>Action</th><th>Parts</th></tr></thead><tbody>${historyRows}</tbody></table>
      ${report.aggregateReliability ? `<h2>Aggregate recorded service analysis</h2><p>${escapeHtml(report.aggregateReliability.note)}</p><p><strong>Scope:</strong> ${escapeHtml(report.aggregateReliability.scope)} · <strong>Units:</strong> ${escapeHtml(report.aggregateReliability.unitCount)} · <strong>Recorded services:</strong> ${escapeHtml(report.aggregateReliability.recordedServiceCount)}</p><table><thead><tr><th>Model</th><th>Recorded services</th></tr></thead><tbody>${modelRows}</tbody></table><h3>Major-component inventory history</h3><ul>${(report.aggregateReliability.partsByRecordedUse || []).map((item) => `<li>${escapeHtml(item.component)} — ${escapeHtml(item.count)} recorded use(s)</li>`).join("") || "<li>No recorded major-component use.</li>"}</ul>` : ""}
      <p class="meta">${escapeHtml(report.note || "")}</p>`;
    exportHtmlToPdfViaPrint({
      title: report.reportLabel || report.title,
      subtitle: `AC: ${report.unit?.brand || ""} ${report.unit?.model || ""} · Serial: ${report.unit?.serialNumber || "Not recorded"}`,
      fileName: report.fileNameBase, html,
      metadata: {
        reportId: report.reportId, branch: report.branch, reportType: report.reportLabel,
        generatedAt: new Date(report.generatedAt).toLocaleString(), systemName: report.systemName, watermark: report.watermark,
        representative: user?.role === "customer" ? "" : user?.name || "AEROPULSE Staff",
        representativeRole: user?.role === "superadmin" ? "Super Admin · Authorized Representative" : "Branch Representative",
      },
    });
  };

  const maintenance = report?.maintenance || {};
  const pattern = maintenance.patternAnalysis || {};
  const signals = maintenance.maintenanceSignals || {};
  const contextItems = maintenanceContextItems(signals);
  const historyFirst = ["maintenance_summary", "summary_report"].includes(report?.reportType || reportType);
  const reportLabel = REPORT_TYPES.find(item => item.value === (report?.reportType || reportType))?.label;
  return (
    <section className="amp-card amp-report-center">
      <div className="amp-card-header"><div><h2>{title}</h2><p className="amp-muted">{subtitle}</p></div>{report ? <button type="button" onClick={exportPdf}>Export PDF</button> : null}</div>
      <div className="amp-report-controls">
        <label>Report type<select disabled={loading} value={reportType} onChange={(event) => setReportType(event.target.value)}>{types.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
        <label>Installed AC unit<select disabled={loading} value={unitId} onChange={(event) => setUnitId(event.target.value)}><option value="">Select a unit</option>{reportUnits.map((unit) => { const value = unit.unitId || unit.id; return <option key={value} value={value}>{user?.role !== "customer" ? `${unit.customerName || "Customer name not recorded"} · ` : ""}{unit.modelName || unit.model || "AC Unit"}{unit.capacityHp ? ` · ${unit.capacityHp} HP` : ""} · {unit.serialNumber || value}</option>; })}</select></label>
        <button type="button" onClick={generate} disabled={loading || !reportUnits.length}>{loading ? "Generating report…" : "Generate report"}</button>
      </div>
      <p className="amp-muted">{types.find(item => item.value === reportType)?.help}</p>
      {!reportUnits.length ? <p className="amp-empty">No installed AC units are available here yet.</p> : null}
      {error ? <p className="amp-error">{error}</p> : null}
      {report ? <div className="amp-report-result">
        <div className="amp-report-meta"><span>Branch: {report.branch}</span><span>{maintenance.predictionSource === "openai" ? "AI-estimated servicing date" : provider === "openai" && maintenance.interpretation ? "AI-assisted explanation" : "Based on system records"}</span></div>
        {report.explanationWarning ? <p role="status" className="amp-muted">{report.explanationWarning}</p> : null}
        <h3>{reportLabel || report.title}</h3>
        {!historyFirst ? <div className="amp-metrics"><article><span>Suggested servicing date</span><strong>{dateLabel(maintenance.bestServicedBy)}</strong></article><article><span>Recommended service</span><strong>{maintenance.recommendedServiceLabel || serviceLabel(maintenance.recommendedService)}</strong></article><article><span>Room and AC size match</span><strong>{capacityAssessmentLabel(maintenance.capacityAssessment?.status)}</strong></article></div> : null}
        <p>{maintenance.interpretation || maintenance.recommendationBasis}</p>
        {maintenance.dataQuality?.message ? <p role="status" className="amp-error">Record review needed: {maintenance.dataQuality.message}</p> : null}
        <p className="amp-muted">Last completed service: {dateLabel(maintenance.lastServiceDate)} · Last recorded cleaning: {dateLabel(maintenance.lastCleaningDate)}</p>
        <details className="amp-details" key={`history-${report.reportId}-${reportType}`} open={historyFirst}>
        <summary>Recorded service history</summary>
        <div className="amp-table-wrap"><table className="amp-table amp-history-table"><thead><tr><th>Date</th><th>Service performed</th><th>Findings and actions</th></tr></thead><tbody>{(report.serviceHistory || []).map((item, index) => <tr key={`${item.date}-${index}`}><td data-label="Date">{dateLabel(item.date)}</td><td data-label="Service performed">{item.serviceLabel || serviceLabel(item.type)}</td><td data-label="Findings and actions">{item.findings || "Findings not recorded"}<br />{item.actionTaken || "Actions not recorded"}{item.evidence?.eligible === false ? <p className="amp-error">{item.evidence.reason}</p> : null}{item.aiInterpretation?.customerSummary ? <p><strong>{item.aiInterpretation.provider === "openai" ? "AI follow-up recommendation" : "Follow-up schedule"}:</strong> {item.aiInterpretation.customerSummary}</p> : null}</td></tr>)}</tbody></table></div>
        {!report.serviceHistory?.length ? <p className="amp-empty">No service history has been recorded.</p> : null}
        </details>
        {report.aggregateReliability ? <details className="amp-details" open><summary>Model and parts history</summary><p>{report.aggregateReliability.scope} · {report.aggregateReliability.unitCount} units · {report.aggregateReliability.recordedServiceCount} recorded services</p><p>{report.aggregateReliability.note}</p><ul>{(report.aggregateReliability.modelsByRecordedService || []).map(item => <li key={item.model}>{item.model}: {item.count} recorded services</li>)}</ul><ul>{(report.aggregateReliability.partsByRecordedUse || []).map(item => <li key={item.component}>{item.component}: {item.count} recorded uses</li>)}</ul></details> : null}
        {report.predictionReview ? <details className="amp-details amp-prediction-review" open={report.predictionReview.entries?.some((entry) => entry.status === "ready_for_review")}>
          <summary>Saved plan and service outcome review</summary>
          <p>{report.predictionReview.note}</p>
          {report.predictionReview.entries?.length ? <div className="amp-table-wrap"><table className="amp-table compact"><thead><tr><th>Saved plan</th><th>Evidence at the time</th><th>Completed service outcome</th></tr></thead><tbody>{report.predictionReview.entries.map((entry) => <tr key={entry.id}><td><strong>{dateLabel(entry.suggestedDate)}</strong><span>{serviceLabel(entry.recommendedService)}</span><span className="amp-review-status">{reviewStatusLabel(entry.status)}</span></td><td><strong>{basisLabel(entry.basisLevel)}</strong><span>{entry.sampleSize} recorded interval{entry.sampleSize === 1 ? "" : "s"} · {entry.comparableUnitCount} comparable unit{entry.comparableUnitCount === 1 ? "" : "s"}</span>{entry.excludedRecordCount ? <span>{entry.excludedRecordCount} incomplete record{entry.excludedRecordCount === 1 ? "" : "s"} excluded</span> : null}</td><td>{entry.outcome ? <><strong>{dateLabel(entry.outcome.serviceDate)} · {entry.outcome.serviceLabel}</strong><span>{entry.outcome.daysFromSuggestedDate === 0 ? "Completed on the suggested date" : `${Math.abs(entry.outcome.daysFromSuggestedDate)} day${Math.abs(entry.outcome.daysFromSuggestedDate) === 1 ? "" : "s"} ${entry.outcome.daysFromSuggestedDate > 0 ? "after" : "before"} the suggested date`}</span><span>Findings: {entry.outcome.findings || "Not recorded"}</span><span>Work: {entry.outcome.actionTaken || "Not recorded"}</span></> : <span>No eligible completed cleaning has been matched to this saved plan.</span>}</td></tr>)}</tbody></table></div> : <p className="amp-empty">No saved plan is available for this unit yet. Generate a Next service plan before the visit to create one.</p>}
        </details> : null}
        {report.predictionReviewWarning ? <p role="status" className="amp-error">{report.predictionReviewWarning}</p> : null}
        <details className="amp-details"><summary>How was this worked out?</summary>
          <p>{maintenance.recommendationBasis}</p>
          {historyFirst ? <p>Suggested servicing date: {dateLabel(maintenance.bestServicedBy)}</p> : null}
          <div className="amp-metrics">
            <article><span>Pattern source</span><strong>{basisLabel(pattern.source || maintenance.historicalBasis?.level)}</strong></article>
            <article><span>Verified intervals used</span><strong>{pattern.intervalCount ?? maintenance.historicalBasis?.sampleSize ?? 0}</strong></article>
            <article><span>Arithmetic average</span><strong>{pattern.averageIntervalDays ? `${pattern.averageIntervalDays} days` : "6-month baseline"}</strong></article>
          </div>
          {pattern.intervalsDays?.length ? <p>Verified cleaning gaps: {pattern.intervalsDays.join(", ")} days. Repairs are not included in this average.</p> : null}
          {contextItems.length ? <ul>{contextItems.map(item => <li key={item}>{item}</li>)}</ul> : <p>No recurring cleaning-related issue has been recorded for this AC.</p>}
          <p>{maintenance.capacityAssessment?.summary}</p>
          <p>Three verified cleanings create two cleaning intervals and allow a unit-specific pattern. Until then, AEROPULSE can use enough verified similar-unit intervals; otherwise it adds exactly 6 months to the latest cleaning or installation. Your saved date appears in My AC Units and reminders. This is a guide, not a booking or a guaranteed breakdown date. It does not change warranty coverage.</p>
          <p className="amp-muted">Report reference: {report.reportId}</p>
        </details>
        <p className="amp-muted">{report.note}</p>
      </div> : null}
    </section>
  );
}

export default AmpReportCenter;
