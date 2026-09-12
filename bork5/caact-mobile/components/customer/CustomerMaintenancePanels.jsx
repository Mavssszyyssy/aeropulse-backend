import Ionicons from "@expo/vector-icons/Ionicons";
import { Text, View } from "react-native";

import { COLORS, FONT, RADIUS, SPACING } from "../../constants/theme";
import Card from "../ui/Card";
import DetailRow from "../ui/DetailRow";
import StatusChip from "../ui/StatusChip";
import { customerSystemMessage } from "../../services/customerLanguage";

const dateLabel = (value) => value
  ? new Date(value).toLocaleDateString("en-PH", { day: "numeric", month: "long", year: "numeric" })
  : "Installation or cleaning date needed";
const serviceLabel = (value) => ({ deep_cleaning: "Deep cleaning", regular_cleaning: "Regular cleaning", inspection: "AC inspection", repair: "Repair assessment" })[value] || "Service details needed";
const serviceExplanation = (value) => value === "deep_cleaning"
  ? "Deep cleaning applies when the unit has gone more than one year without cleaning. The entire AC is taken down for a more thorough cleaning."
  : value === "regular_cleaning"
    ? "Regular cleaning applies when the unit was last cleaned within one year."
    : value === "inspection"
      ? "A follow-up inspection was recommended from the technician's completed service report."
      : value === "repair"
        ? "A repair assessment was recommended from the technician's completed service report. Final work is confirmed after inspection."
    : "A recorded installation or cleaning date is needed before suggesting a cleaning method.";

const roomSizeMessage = (assessment = {}) => ({
  room_size_required: "Add your room size to check whether this AC is the right size for your space.",
  capacity_required: "Your AC capacity needs to be confirmed before checking its room-size match.",
  suitable: "This AC appears suitable based on an approximate room-size comparison.",
  insufficient: "This AC may be too small for your room. Contact our service team for advice.",
  higher_than_necessary: "This AC may be larger than needed for your room. Contact our service team for advice.",
}[assessment.status] || assessment.summary || "");

export function CustomerRecommendationPanel({ recommendation, maintenance }) {
  if (!recommendation) return null;
  return <Card>
    <View style={{ flexDirection: "row", alignItems: "center", marginBottom: SPACING.md }}>
      <View style={{ width: 52, height: 52, borderRadius: RADIUS.lg, backgroundColor: COLORS.primaryLight, alignItems: "center", justifyContent: "center", marginRight: SPACING.sm }}><Ionicons name="calendar-clear-sharp" size={25} color={COLORS.primary} /></View>
      <View style={{ flex: 1 }}><Text style={{ color: COLORS.textSecondary, fontSize: FONT.sm, fontWeight: FONT.bold }}>SUGGESTED SERVICING DATE</Text><Text style={{ color: COLORS.textPrimary, fontSize: FONT.xl, fontWeight: FONT.black, marginTop: 2 }}>{dateLabel(recommendation.bestServicedBy)}</Text></View>
      <StatusChip label={serviceLabel(recommendation.recommendedService)} color={recommendation.overdue ? COLORS.danger : COLORS.success} />
    </View>
    <Text style={{ color: COLORS.textSecondary, fontSize: FONT.sm, lineHeight: 19 }}>{serviceExplanation(recommendation.recommendedService)}</Text>
    <Text style={{ color: COLORS.textSecondary, fontSize: FONT.sm, lineHeight: 19, marginTop: SPACING.sm }}>{customerSystemMessage(recommendation.recommendationBasis)}</Text>
    {recommendation.dataQuality?.message ? <Text style={{ color: COLORS.danger, fontSize: FONT.sm, marginTop: SPACING.sm }}>{customerSystemMessage(recommendation.dataQuality.message)}</Text> : null}
    {maintenance?.urgency ? <View style={{ alignSelf: "flex-start", marginTop: SPACING.sm }}><StatusChip label={maintenance.urgency} color={maintenance.color} /></View> : null}
    <Text style={{ color: COLORS.textSecondary, fontSize: FONT.sm, marginTop: SPACING.sm }}>This is a suggestion. A visit is only booked after you submit a service request.</Text>
    {roomSizeMessage(recommendation.capacityAssessment || maintenance?.capacityAssessment) ? <DetailRow label="Room and AC Size Match" value={roomSizeMessage(recommendation.capacityAssessment || maintenance?.capacityAssessment)} multiline /> : null}
  </Card>;
}
