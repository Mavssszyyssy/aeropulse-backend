import React, { useState } from "react";
import { Text, TouchableOpacity, View } from "react-native";
import Card from "../ui/Card";
import PagedItems from "../ui/PagedItems";
import { COLORS } from "../../constants/theme";

export default function CompletedServiceReports({ records = [], serviceName, formatDate }) {
  const [expanded, setExpanded] = useState(false);
  if (!records.length) return null;
  return <Card>
    <TouchableOpacity accessibilityRole="button" accessibilityLabel="Completed service reports" accessibilityState={{ expanded }} onPress={() => setExpanded(value => !value)} style={{ flexDirection: "row", gap: 12, alignItems: "center" }}>
      <View style={{ flex: 1 }}><Text style={{ color: COLORS.textPrimary, fontWeight: "700", fontSize: 17 }}>Completed service reports</Text><Text style={{ color: COLORS.textSecondary, fontSize: 13, lineHeight: 19, marginTop: 4 }}>{records.length} {records.length === 1 ? "record" : "records"} · Technician findings and work performed</Text></View>
      <Text style={{ color: COLORS.primary, fontWeight: "600" }}>{expanded ? "Hide ▴" : "View ▾"}</Text>
    </TouchableOpacity>
    {expanded ? <PagedItems label="Completed reports" items={records} controlsPosition="top" renderItem={(service, index) => <View key={service.id || `${service.date}-${index}`} style={{ borderTopWidth: 1, borderColor: COLORS.border, paddingTop: 12, marginTop: 12 }}>
      <Text style={{ color: COLORS.textPrimary, fontWeight: "600", fontSize: 14 }}>{serviceName(service.serviceType)}</Text>
      <Text style={{ color: COLORS.textSecondary, fontSize: 12, marginTop: 3 }}>{formatDate(service.date)}</Text>
      <Text style={{ color: COLORS.textPrimary, lineHeight: 21, fontSize: 14, marginTop: 8 }}>{[service.findings || service.details, service.actionTaken].filter(Boolean).join("\n") || "Findings and actions not recorded"}</Text>
      {service.aiInterpretation?.customerSummary ? <View style={{ backgroundColor: COLORS.primaryLight, borderRadius: 10, padding: 12, marginTop: 10 }}>
        <Text style={{ color: COLORS.primary, fontWeight: "700", fontSize: 13 }}>{service.aiInterpretation.provider === "openai" ? "AI follow-up recommendation" : "Follow-up schedule"}</Text>
        <Text style={{ color: COLORS.textPrimary, lineHeight: 20, fontSize: 13, marginTop: 5 }}>{service.aiInterpretation.customerSummary}</Text>
      </View> : null}
      {service.evidence?.eligible === false ? <Text style={{ color: COLORS.danger, fontSize: 12, marginTop: 6 }}>{service.evidence.reason}</Text> : null}
    </View>} /> : null}
  </Card>;
}
