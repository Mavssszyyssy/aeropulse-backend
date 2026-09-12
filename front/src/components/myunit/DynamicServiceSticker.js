import { useEffect, useState } from "react";
import { CalendarBlank, DeviceMobile, Info, Wrench } from "@phosphor-icons/react";
import { apiRequest } from "../../config/api";
import { customerSystemMessage } from "../../domain/customerLanguage";

const isMongoId = (value) => /^[a-f\d]{24}$/i.test(String(value || ""));
const dateLabel = (value) => value
  ? new Date(value).toLocaleDateString("en-PH", { day: "numeric", month: "long", year: "numeric" })
  : "Not available";
const serviceLabel = (value) => ({ deep_cleaning: "Deep cleaning", regular_cleaning: "Regular cleaning", inspection: "AC inspection", repair: "Repair assessment" })[value] || "Service details needed";

const serviceExplanation = (service) =>
  service === "deep_cleaning"
    ? "Deep cleaning applies when the unit has gone more than one year without cleaning. The entire AC is taken down for a more thorough cleaning."
    : service === "regular_cleaning"
      ? "Regular cleaning applies when the unit was last cleaned within one year."
      : service === "inspection"
        ? "A follow-up inspection was recommended from the technician's completed service report."
        : service === "repair"
          ? "A repair assessment was recommended from the technician's completed service report. Final work is confirmed after inspection."
      : "We need your installation date or last completed cleaning date to suggest the right cleaning service.";

const capacityMessage = (assessment = {}) => {
  const messages = {
    room_size_required: "Add your room size in the Cold Air mobile app to check whether this AC is the right size for your space.",
    capacity_required: "Your AC capacity needs to be confirmed before we can check whether it suits your room.",
    suitable: "This AC appears suitable based on an approximate room-size check. Confirm the sizing with our service team.",
    insufficient: "This AC may be too small for the room size you provided. Ask our service team for advice.",
    higher_than_necessary: "This AC may be larger than needed for the room size you provided. Ask our service team for advice.",
  };
  return messages[assessment.status] || assessment.summary || "";
};

const planLabel = (recommendation = {}) => {
  if (recommendation.predictionSource === "openai") return "AI-assisted plan";
  if (recommendation.patternAnalysis?.source === "system_default") return "6-month starting plan";
  return "Service-history plan";
};

function DynamicServiceSticker({ unit }) {
  const unitId = unit?.ampUnitId || unit?.backendUnitId || unit?.unitId || unit?.id;
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    if (!isMongoId(unitId)) return undefined;
    setLoading(true); setError("");
    apiRequest(`/amp/units/${unitId}/next-service`)
      .then((value) => { if (alive) setResult(value); })
      .catch((err) => { if (alive) setError(err.message || "Unable to load maintenance timing."); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [unitId]);
  if (!isMongoId(unitId)) return null;
  if (loading) return <section className="service-sticker">Checking your recommended service schedule...</section>;
  if (error) return <section className="service-sticker service-sticker-alert">We could not load your service schedule right now. Please try again.</section>;
  const recommendation = result?.recommendation;
  if (!recommendation) return null;
  const roomGuidance = capacityMessage(recommendation.capacityAssessment);
  const recommendationReason = customerSystemMessage(recommendation.recommendationBasis);
  return <section className="service-sticker" aria-label="Recommended service schedule">
    <header className="service-sticker-header">
      <span className="service-sticker-icon" aria-hidden="true"><CalendarBlank size={22} weight="fill" /></span>
      <div className="service-sticker-heading">
        <span className="service-sticker-label">Next recommended service</span>
        <strong className="service-sticker-date">{dateLabel(recommendation.bestServicedBy)}</strong>
      </div>
      <span className="service-sticker-source">{planLabel(recommendation)}</span>
    </header>

    <div className="service-sticker-service">
      <span className="service-sticker-service-icon" aria-hidden="true"><Wrench size={19} weight="bold" /></span>
      <div>
        <span>Recommended service</span>
        <strong>{serviceLabel(recommendation.recommendedService)}</strong>
      </div>
    </div>

    <p className="service-sticker-explanation">{serviceExplanation(recommendation.recommendedService)}</p>

    {recommendationReason ? <details className="service-sticker-reason" onClick={(event) => event.stopPropagation()}>
      <summary>Why this date?</summary>
      <p>{recommendationReason}</p>
    </details> : null}

    {recommendation.dataQuality?.message ? <div className="service-sticker-notice service-sticker-quality" role="status">
      <Info size={18} weight="fill" aria-hidden="true" />
      <div><strong>Record check</strong><p>{customerSystemMessage(recommendation.dataQuality.message)}</p></div>
    </div> : null}

    {roomGuidance ? <div className="service-sticker-notice">
      <Info size={18} weight="fill" aria-hidden="true" />
      <div><strong>Room size guidance</strong><p>{roomGuidance}</p></div>
    </div> : null}

    <footer className="service-sticker-app-note">
      <DeviceMobile size={18} weight="bold" aria-hidden="true" />
      <span>Book this service using your Cold Air mobile account.</span>
    </footer>
  </section>;
}

export default DynamicServiceSticker;
