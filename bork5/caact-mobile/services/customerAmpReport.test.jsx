import React from "react";
import { render, screen, fireEvent } from "@testing-library/react-native";
import CustomerAmpReport from "../components/customer/CustomerAmpReport";

const report = {
  reportId: "QA-REPORT", reportType: "predictive_maintenance",
  maintenance: { bestServicedBy: "2027-06-02", recommendedService: "regular_cleaning", recommendationBasis: "Insufficient service history. Default recommended cleaning interval: 6 months (180 days). This baseline is replaced when enough verified cleaning intervals become available.", interpretation: "Your completed visits explain this suggestion.", dataQuality: { message: "One incomplete record is excluded." } },
  serviceHistory: [{ date: "2026-01-01", serviceLabel: "Repair", findings: "Board inspected", actionTaken: "Connection repaired" }],
};
test("AI text is visible on mobile without hiding evidence warnings or claiming a booking", async () => {
  await render(<CustomerAmpReport report={report} provider="openai" />);
  expect(screen.getByText("AI-assisted explanation")).toBeTruthy();
  expect(screen.getByText(report.maintenance.interpretation)).toBeTruthy();
  expect(screen.getByText("One incomplete record is excluded.")).toBeTruthy();
  expect(screen.queryByText(/Board inspected/)).toBeNull();
  expect(screen.getByText(/No visit has been booked/)).toBeTruthy();
  await fireEvent.press(screen.getByText("How was this worked out?"));
  expect(screen.getAllByText(/6 months \(180 days\)/).length).toBeGreaterThan(0);
  await fireEvent.press(screen.getByText("Show service history"));
  expect(screen.getByText(/Board inspected/)).toBeTruthy();
});
test("system fallback is not labeled AI and a history report opens past work first", async () => {
  await render(<CustomerAmpReport report={{ ...report, reportType: "maintenance_summary", maintenance: { ...report.maintenance, interpretation: "" } }} provider="system-fallback" />);
  expect(screen.getByText("Your service history")).toBeTruthy();
  expect(screen.getByText("Based on system records")).toBeTruthy();
  expect(screen.queryByText("AI-assisted explanation")).toBeNull();
  expect(screen.getByText(/6 months \(180 days\)/)).toBeTruthy();
  expect(screen.getByText(/Board inspected/)).toBeTruthy();
});

test("AI outage explains that the usable report is a system fallback", async () => {
  await render(<CustomerAmpReport report={{ ...report, explanationWarning: "AI explanation timed out. Showing the system recommendation." }} provider="system-fallback" />);
  expect(screen.getByText("AI explanation timed out. Showing the system recommendation.")).toBeTruthy();
  expect(screen.queryByText("AI-assisted explanation")).toBeNull();
});

test("an accepted AI date is distinguished from an AI explanation and system fallback", async () => {
  await render(<CustomerAmpReport report={{ ...report, maintenance: { ...report.maintenance, predictionSource: "openai", recommendationBasis: "AI-estimated servicing interval: 150 days.", interpretation: "AI-estimated servicing interval: 150 days." } }} provider="openai" />);
  expect(screen.getByText("AI-estimated servicing date")).toBeTruthy();
  expect(screen.queryByText("AI-assisted explanation")).toBeNull();
  expect(screen.getByText("AI-estimated servicing interval: 150 days.")).toBeTruthy();
});
test("visit analysis can recommend an inspection instead of labeling it cleaning", async () => {
  await render(<CustomerAmpReport report={{ ...report, maintenance: { ...report.maintenance, recommendedService: "inspection" } }} provider="openai" />);
  expect(screen.getByText("Recommended service")).toBeTruthy();
  expect(screen.getByText("AC inspection")).toBeTruthy();
});
