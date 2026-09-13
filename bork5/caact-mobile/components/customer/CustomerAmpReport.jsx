import { useState } from "react";
import { Text, View } from "react-native";
import Button from "../ui/Button";
import DetailRow from "../ui/DetailRow";
import { COLORS, FONT, SPACING } from "../../constants/theme";
import { customerSystemMessage } from "../../services/customerLanguage";

const dateLabel = (value) => {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date.toLocaleDateString("en-PH", { day: "numeric", month: "long", year: "numeric" }) : "Not recorded";
};
const methodLabel = (value) => ({ regular_cleaning: "Regular cleaning", deep_cleaning: "Deep cleaning", inspection: "AC inspection", repair: "Repair assessment" })[value] || "Service details needed";
const body = { color: COLORS.textSecondary, fontSize: FONT.sm, lineHeight: 20, marginTop: SPACING.sm };

export default function CustomerAmpReport({ report, provider }) {
  const summary = ["maintenance_summary", "summary_report"].includes(report?.reportType);
  const [showHistory, setShowHistory] = useState(summary);
  const [showDetails, setShowDetails] = useState(false);
  if (!report) return null;
  const maintenance = report.maintenance || {};
  const pattern = maintenance.patternAnalysis || {};
  const signals = maintenance.maintenanceSignals || {};
  const visitAnalysis = maintenance.latestVisitAnalysis || {};
  const conditionFollowUp = maintenance.conditionBasedFollowUp || null;
  const routine = maintenance.routineMaintenance || {};
  const explanation = customerSystemMessage(String(maintenance.interpretation || "").trim());
  const aiAssisted = provider === "openai" && Boolean(explanation);
  return <View style={{ marginTop: SPACING.md }}>
    <Text accessibilityRole="header" style={{ color: COLORS.text, fontSize: FONT.lg, fontWeight: FONT.bold }}>{summary ? "Your service history" : "Your next service"}</Text>
    <Text style={body}>{conditionFollowUp ? "AI-reviewed technician follow-up" : maintenance.predictionSource === "openai" ? "AI-estimated servicing date" : aiAssisted ? "AI-assisted explanation" : "Based on system records"}</Text>
    {report.explanationWarning ? <Text accessibilityRole="alert" style={body}>{customerSystemMessage(report.explanationWarning)}</Text> : null}
    {!summary ? <>
      <DetailRow label={conditionFollowUp ? "Condition follow-up date" : "Suggested servicing date"} value={dateLabel(maintenance.bestServicedBy)} />
      <DetailRow label="Recommended service" value={methodLabel(maintenance.recommendedService)} />
    </> : <DetailRow label="Last recorded cleaning" value={dateLabel(maintenance.lastCleaningDate)} />}
    <Text style={body}>{explanation || customerSystemMessage(maintenance.recommendationBasis) || "We need more details from completed visits to explain this suggestion."}</Text>
    {visitAnalysis.provider === "openai" ? <View>
      <DetailRow label="Recorded concern" value={visitAnalysis.predictedRisk || "No developing concern was identified from the technician's submitted report."} multiline />
      <DetailRow label="Urgency" value={String(visitAnalysis.severity || "Not assessed").replaceAll("_", " ")} />
      <DetailRow label="Evidence confidence" value={String(visitAnalysis.evidenceConfidence || "Not assessed").replaceAll("_", " ")} />
      {visitAnalysis.affectedComponent && visitAnalysis.affectedComponent !== "not_specified" ? <DetailRow label="Component named in report" value={visitAnalysis.affectedComponent.replaceAll("_", " ")} /> : null}
    </View> : null}
    {conditionFollowUp ? <View>
      <Text accessibilityRole="header" style={[body, { color: COLORS.text, fontWeight: FONT.bold }]}>Routine cleaning plan</Text>
      <DetailRow label="Routine cleaning date" value={dateLabel(routine.bestServicedBy)} />
      <DetailRow label="Routine service" value={methodLabel(routine.recommendedService)} />
      <Text style={body}>The earlier condition follow-up is shown first. It does not erase this separate routine cleaning plan.</Text>
    </View> : null}
    {maintenance.dataQuality?.message ? <Text accessibilityRole="alert" style={[body, { color: COLORS.danger }]}>{customerSystemMessage(maintenance.dataQuality.message)}</Text> : null}
    <Button title={showHistory ? "Hide service history" : "Show service history"} variant="secondary" size="sm" onPress={() => setShowHistory(value => !value)} />
    {showHistory ? <View>
      {(report.serviceHistory || []).map((service, index) => <View key={`${service.date}-${index}`}>
        <DetailRow label={`${service.serviceLabel || service.type || "Service"} · ${dateLabel(service.date)}`} value={[service.findings, service.actionTaken].filter(Boolean).join("\n") || "Detailed service report not recorded"} multiline />
        {service.aiInterpretation?.customerSummary ? <DetailRow label={service.aiInterpretation.provider === "openai" ? "AI follow-up recommendation" : "Follow-up schedule"} value={service.aiInterpretation.customerSummary} multiline /> : null}
        {service.evidence?.eligible === false ? <Text style={[body, { color: COLORS.danger }]}>{customerSystemMessage(service.evidence.reason)}</Text> : null}
      </View>)}
      {!report.serviceHistory?.length ? <Text style={body}>No service history has been recorded.</Text> : null}
    </View> : null}
    <Button title={showDetails ? "Hide report details" : "How was this worked out?"} variant="ghost" size="sm" onPress={() => setShowDetails(value => !value)} />
    {showDetails ? <View>
      {summary ? <DetailRow label={conditionFollowUp ? "Condition follow-up date" : "Suggested servicing date"} value={dateLabel(maintenance.bestServicedBy)} /> : null}
      <DetailRow label="Why this date?" value={customerSystemMessage(conditionFollowUp ? visitAnalysis.customerSummary : maintenance.recommendationBasis) || "Not recorded"} multiline />
      {conditionFollowUp ? <DetailRow label="Why the routine date?" value={customerSystemMessage(routine.recommendationBasis) || "Not recorded"} multiline /> : null}
      <DetailRow label="Pattern used" value={pattern.source === "same_unit" ? "This AC unit's cleaning history" : pattern.source === "system_default" ? "6-month starting schedule" : "Verified similar AC cleaning history"} multiline />
      <DetailRow label="Verified cleaning gaps" value={pattern.intervalsDays?.length ? `${pattern.intervalsDays.join(", ")} days` : "Not enough history yet"} multiline />
      <DetailRow label="Typical gap" value={pattern.averageIntervalDays ? `${pattern.averageIntervalDays} days (arithmetic average)` : "6 months (180 days)"} multiline />
      {signals.serviceRequestCount ? <DetailRow label="Service requests reviewed" value={String(signals.serviceRequestCount)} /> : null}
      {signals.serviceRequestFrequency?.averageGapDays ? <DetailRow label="Typical gap between requests" value={`${signals.serviceRequestFrequency.averageGapDays} days`} /> : null}
      {signals.filterDirtRecordCount || signals.coilDirtRecordCount ? <DetailRow label="Cleaning-related issues" value={`${signals.filterDirtRecordCount || 0} filter and ${signals.coilDirtRecordCount || 0} coil dirt-related record(s)`} multiline /> : null}
      {signals.deepCleaningRecordCount ? <DetailRow label="Deep cleanings recorded" value={String(signals.deepCleaningRecordCount)} /> : null}
      {signals.coilMaintenanceRecordCount ? <DetailRow label="Coil cleanings recorded" value={String(signals.coilMaintenanceRecordCount)} /> : null}
      {signals.refrigerantIssueRecordCount ? <DetailRow label="Not counted as cleaning" value={`${signals.refrigerantIssueRecordCount} refrigerant-related record(s)`} multiline /> : null}
      <DetailRow label="Room size and horsepower" value={maintenance.capacityAssessment?.summary || "Add room size and AC horsepower to see this comparison."} multiline />
      <Text style={body}>AEROPULSE uses the technician’s submitted findings to adjust a condition follow-up after each completed detailed report. It only names concerns and components supported by that report and recorded history. Separately, three verified cleanings create two gaps for the routine cleaning pattern. Until then, verified similar-AC history or the 6-month starting schedule is used. This does not book a visit, guarantee a failure, or approve warranty coverage.</Text>
      <DetailRow label="Report reference" value={report.reportId || "Not recorded"} multiline />
    </View> : null}
    <Text style={body}>No visit has been booked by this report. To request one, open Service Visits in this app.</Text>
    <Text style={body}>Need a PDF? Open My AC Units on the Cold Air website and choose Export PDF.</Text>
  </View>;
}
