import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import AmpReportCenter from "./AmpReportCenter";
import ServiceHistory from "../myunit/ServiceHistory";
import { apiRequest } from "../../config/api";
import { exportHtmlToPdfViaPrint } from "../../utils/exporters";

vi.mock("../../config/api", () => ({ apiRequest: vi.fn() }));
vi.mock("../../context/UserContext", () => ({ useUser: () => ({ user: { role: "customer", name: "Customer Person" } }) }));
vi.mock("../../utils/exporters", () => ({ exportHtmlToPdfViaPrint: vi.fn() }));
afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());

it("labels a persisted AI date even when the latest provider attempt fell back, and exports its basis", async () => {
  apiRequest.mockResolvedValue({ provider: "system-fallback", report: {
    reportId: "AI-SAVED", reportType: "predictive_maintenance", branch: "Cavite",
    explanationWarning: "AI is unavailable. Showing the current saved or system recommendation.",
    maintenance: { predictionSource: "openai", bestServicedBy: "2026-05-01", recommendationBasis: "AI-estimated servicing interval: 120 days." },
  } });
  render(<AmpReportCenter units={[{ id: "unit-1", model: "AC" }]} />);
  fireEvent.change(screen.getByLabelText("Installed AC unit"), { target: { value: "unit-1" } });
  fireEvent.click(screen.getByRole("button", { name: "Generate report" }));
  expect(await screen.findByText("AI-estimated servicing date")).toBeVisible();
  expect(screen.getByRole("status")).toHaveTextContent("We could not get a new AI estimate right now");
  fireEvent.click(screen.getByRole("button", { name: "Export PDF" }));
  expect(exportHtmlToPdfViaPrint.mock.calls[0][0].html).toContain("AI-estimated servicing interval: 120 days.");
});

it("shows actual history without crashing or inventing a fee when no price exists", () => {
  render(<ServiceHistory unit={{ brand: "Cold Air", model: "CA-1", serviceHistory: [
    { id: "1", date: "2026-09-05T16:30:00Z", serviceType: "repair", findings: "Control board failed inspection.", actionTaken: "Replaced control board." },
    { id: "2", date: "2026-09-01", serviceType: "installation" },
  ] }} onClose={vi.fn()} />);
  expect(screen.getByText("Repair")).toBeVisible();
  expect(screen.getByText("Installation")).toBeVisible();
  expect(screen.getByText(/Control board failed inspection/)).toHaveTextContent("Replaced control board.");
  expect(screen.getByText(/September 6, 2026/)).toBeVisible();
  expect(screen.queryByText(/₱/)).not.toBeInTheDocument();
});

it("shows the AI follow-up separately from the technician's original service record", () => {
  render(<ServiceHistory unit={{ brand: "Cold Air", model: "CA-1", serviceHistory: [{
    id: "visit-ai", date: "2026-09-12", serviceType: "regular_cleaning",
    findings: "Fan made an unusual noise.", actionTaken: "Cleaned the filter.",
    aiInterpretation: { provider: "openai", customerSummary: "The fan should be inspected within 30 days." },
  }] }} onClose={vi.fn()} />);
  expect(screen.getByText(/Fan made an unusual noise/)).toBeVisible();
  expect(screen.getByText("AI-reviewed follow-up plan")).toBeVisible();
  expect(screen.getByText("The fan should be inspected within 30 days.")).toBeVisible();
});

it("retains evidence warnings in the report/PDF and clears the previous unit's export on selection change", async () => {
  apiRequest.mockResolvedValue({ provider: "rules", report: {
    title: "Next Maintenance Recommendation", reportId: "REPORT-1", branch: "Bulacan", generatedAt: "2026-09-05T12:00:00Z",
    unit: { unitId: "unit-1", model: "CA-1" },
    maintenance: { bestServicedBy: "2027-06-02", recommendationBasis: "Provisional schedule using the configured interval.", dataQuality: { message: "1 incomplete service record is excluded." } },
    serviceHistory: [{ date: "2026-09-05", type: "inspection", findings: "AMP recommended regular cleaning.", evidence: { eligible: false, reason: "Actual technician findings are missing." } }],
  } });
  render(<AmpReportCenter units={[{ id: "unit-1", model: "CA-1" }, { id: "unit-2", model: "CA-2" }]} />);
  expect(screen.queryByRole("option", { name: "Model and parts history" })).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Installed AC unit"), { target: { value: "unit-1" } });
  fireEvent.click(screen.getByRole("button", { name: "Generate report" }));
  await screen.findByRole("button", { name: "Export PDF" });
  fireEvent.click(screen.getByText("Recorded service history"));
  expect(screen.getByText("Inspection")).toBeVisible();
  expect(screen.getByRole("status")).toHaveTextContent("incomplete service record");
  fireEvent.click(screen.getByRole("button", { name: "Export PDF" }));
  const exported = exportHtmlToPdfViaPrint.mock.calls[0][0];
  expect(exported.html).toContain("Actual technician findings are missing.");
  expect(exported.html).toContain("June 2, 2027");
  expect(exported.metadata.representative).toBe("");
  fireEvent.change(screen.getByLabelText("Installed AC unit"), { target: { value: "unit-2" } });
  expect(screen.queryByRole("button", { name: "Export PDF" })).not.toBeInTheDocument();
  expect(screen.queryByText(/Report reference: REPORT-1/)).not.toBeInTheDocument();
});

it("shows AI explanation, keeps the system basis available, and opens history first for a history report", async () => {
  apiRequest.mockResolvedValue({ provider: "openai", report: {
    reportId: "AI-REPORT", reportType: "maintenance_summary", branch: "Bulacan",
    maintenance: { interpretation: "Your recorded visits help explain this plan.", recommendationBasis: "6-month starting schedule." },
    serviceHistory: [{ date: "2026-01-01", type: "repair", findings: "Board inspected", actionTaken: "Connection repaired" }],
  } });
  render(<AmpReportCenter units={[{ id: "unit-1", model: "AC" }]} />);
  fireEvent.change(screen.getByLabelText("Report type"), { target: { value: "maintenance_summary" } });
  fireEvent.change(screen.getByLabelText("Installed AC unit"), { target: { value: "unit-1" } });
  fireEvent.click(screen.getByRole("button", { name: "Generate report" }));
  expect(await screen.findByText("AI-assisted explanation")).toBeVisible();
  expect(screen.getByText("Your recorded visits help explain this plan.")).toBeVisible();
  expect(screen.getByText("Repair")).toBeVisible();
  expect(screen.getByText("6-month starting schedule.")).not.toBeVisible();
  fireEvent.click(screen.getByText("How was this worked out?"));
  expect(screen.getByText("6-month starting schedule.")).toBeVisible();
});

it("shows saved plans with technician outcomes as review evidence, never as an AI accuracy score", async () => {
  apiRequest.mockResolvedValue({ provider: "rules", report: {
    reportId: "REVIEW-1", reportType: "predictive_maintenance", branch: "Bulacan",
    maintenance: { bestServicedBy: "2026-06-30", recommendedService: "regular_cleaning", recommendationBasis: "Based on completed records." },
    serviceHistory: [], predictionReview: {
      note: "Review technician findings before judging usefulness.",
      entries: [{ id: "plan-1", suggestedDate: "2026-06-30", recommendedService: "regular_cleaning", basisLevel: "same_model", sampleSize: 4, comparableUnitCount: 3, excludedRecordCount: 1, status: "ready_for_review", outcome: { serviceDate: "2026-07-03", serviceLabel: "Regular cleaning", daysFromSuggestedDate: 3, findings: "Dust buildup found on the coil.", actionTaken: "Cleaned coil and flushed drain." } }],
    },
  } });
  render(<AmpReportCenter units={[{ id: "unit-1", model: "AC" }]} />);
  fireEvent.change(screen.getByLabelText("Installed AC unit"), { target: { value: "unit-1" } });
  fireEvent.click(screen.getByRole("button", { name: "Generate report" }));
  expect(await screen.findByText("Saved plan and service outcome review")).toBeVisible();
  expect(screen.getByText("Service outcome ready to review")).toBeVisible();
  expect(screen.getByText(/3 days after the suggested date/)).toBeVisible();
  expect(screen.getByText(/Dust buildup found on the coil/)).toBeVisible();
  expect(screen.queryByText(/accuracy/i)).not.toBeInTheDocument();
});

it("separates a condition-based AI follow-up from the routine cleaning plan", async () => {
  apiRequest.mockResolvedValue({ provider: "openai", report: {
    reportId: "CONDITION-1", reportType: "predictive_maintenance", branch: "Cavite",
    maintenance: {
      predictionSource: "openai", bestServicedBy: "2026-09-18", recommendedService: "repair",
      recommendationBasis: "Condition follow-up based on the completed report.",
      latestVisitAnalysis: { provider: "openai", severity: "urgent", predictedRisk: "The report indicates a possible developing component-wear risk involving the fan motor.", affectedComponent: "fan_motor", evidenceConfidence: "high", customerSummary: "The fan motor needs an earlier assessment." },
      conditionBasedFollowUp: { provider: "openai", recommendationMode: "condition_based" },
      routineMaintenance: { bestServicedBy: "2027-03-13", recommendedService: "regular_cleaning", intervalDays: 180, recommendationBasis: "6-month routine cleaning schedule." },
    }, serviceHistory: [],
  } });
  render(<AmpReportCenter units={[{ id: "unit-1", model: "AC" }]} />);
  fireEvent.change(screen.getByLabelText("Installed AC unit"), { target: { value: "unit-1" } });
  fireEvent.click(screen.getByRole("button", { name: "Generate report" }));
  expect(await screen.findByText("AI-reviewed technician follow-up")).toBeVisible();
  expect(screen.getByText("Condition follow-up date")).toBeVisible();
  expect(screen.getByText(/possible developing component-wear risk/)).toBeVisible();
  expect(screen.getByText("Urgent")).toBeVisible();
  expect(screen.getByText("High")).toBeVisible();
  expect(screen.getByText("Fan Motor")).toBeVisible();
  expect(screen.getByText("Separate routine cleaning plan")).toBeVisible();
  expect(screen.getByText("March 13, 2027")).toBeVisible();
});
