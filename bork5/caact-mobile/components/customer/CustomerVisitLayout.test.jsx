import React from "react";
import { Text } from "react-native";
import { render, screen, fireEvent } from "@testing-library/react-native";
import CustomerRequestTimeline from "./CustomerRequestTimeline";
import CompletedServiceReports from "./CompletedServiceReports";
import PagedItems from "../ui/PagedItems";

const events = Array.from({ length: 7 }, (_, i) => ({ id: `${i}`, title: `Event ${i}`, timestamp: `2026-09-0${i + 1}T10:00:00Z`, description: `Detail ${i}` }));
test("only the visit has a pager; older activity is revealed without a second pager", async () => {
  await render(<PagedItems controlsPosition="top" label="Service visits" items={["Visit A", "Visit B"]} pageSize={1} renderItem={visit => <React.Fragment key={visit}><Text>{visit}</Text><CustomerRequestTimeline events={events} formatDateTime={value => value} /></React.Fragment>} />);
  expect(screen.getAllByText("Next")).toHaveLength(1);
  expect(screen.getByText("Event 6")).toBeTruthy();
  expect(screen.queryByText("Event 3")).toBeNull();
  await fireEvent.press(screen.getByText("Show earlier updates (4)"));
  expect(screen.getByText("Event 3")).toBeTruthy();
  await fireEvent.press(screen.getByText("Show earlier updates (1)"));
  expect(screen.getByText("Event 0")).toBeTruthy();
  await fireEvent.press(screen.getByLabelText("Service visits: Next page"));
  expect(screen.getByText("Visit B")).toBeTruthy();
  expect(screen.queryByText("Visit A")).toBeNull();
  expect(screen.queryByText("Event 0")).toBeNull();
  expect(screen.getByText("Show earlier updates (4)")).toBeTruthy();
});
test("completed reports are separate, collapsed initially, and all remain reachable", async () => {
  await render(<CompletedServiceReports records={Array.from({ length: 4 }, (_, i) => ({ id: `${i}`, findings: `Finding ${i}`, actionTaken: `Work ${i}`, date: "2026-09-09", serviceType: "Cleaning" }))} serviceName={v => v} formatDate={v => v} />);
  expect(screen.queryByText(/Finding 0/)).toBeNull();
  await fireEvent.press(screen.getByLabelText("Completed service reports"));
  expect(screen.getByText(/Finding 0/)).toBeTruthy();
  await fireEvent.press(screen.getByLabelText("Completed reports: Next page"));
  expect(screen.getByText(/Finding 3/)).toBeTruthy();
  await fireEvent.press(screen.getByLabelText("Completed service reports"));
  expect(screen.queryByText(/Finding 3/)).toBeNull();
});
test("completed reports keep the technician record separate from the AI follow-up", async () => {
  await render(<CompletedServiceReports records={[{
    id: "visit-ai", findings: "Fan made an unusual noise.", actionTaken: "Cleaned the filter.", date: "2026-09-12", serviceType: "Cleaning",
    aiInterpretation: { provider: "openai", customerSummary: "The fan should be inspected within 30 days." },
  }]} serviceName={v => v} formatDate={v => v} />);
  await fireEvent.press(screen.getByLabelText("Completed service reports"));
  expect(screen.getByText(/Fan made an unusual noise/)).toBeTruthy();
  expect(screen.getByText("AI follow-up recommendation")).toBeTruthy();
  expect(screen.getByText("The fan should be inspected within 30 days.")).toBeTruthy();
});
