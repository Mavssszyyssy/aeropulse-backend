import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { startLiveRefresh } from "../../services/liveRefresh";
import { customerServiceChoices } from "../../services/customerServiceChoices";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, Linking, Text, View } from "react-native";

import CustomerScreen from "../../components/customer/CustomerScreen";
import CustomerSectionHeader from "../../components/customer/CustomerSectionHeader";
import ServiceRequestPaymentSummary from "../../components/customer/ServiceRequestPaymentSummary";
import BottomSheetSelect from "../../components/ui/BottomSheetSelect";
import Button from "../../components/ui/Button";
import CalendarDatePicker, { getTodayDateKey, isPastCalendarDate } from "../../components/ui/CalendarDatePicker";
import Card from "../../components/ui/Card";
import DetailRow from "../../components/ui/DetailRow";
import EmptyState from "../../components/ui/EmptyState";
import StatusChip from "../../components/ui/StatusChip";
import StickyActionBar from "../../components/ui/StickyActionBar";
import TextField from "../../components/ui/TextField";
import { COLD_AIR_WEBSITE } from "../../constants/company";
import { COLORS, SPACING } from "../../constants/theme";
import { useUserContext } from "../../context/UserContext";
import { getDisplayName } from "../../services/profileService";
import { createWarrantyClaim, fetchServiceCatalog, getStoredToken } from "../../services/api";
import { getCustomerServiceHistory } from "../../services/customerHistoryService";
import { createServiceRequest } from "../../services/serviceRequestStorage";
import { cacheUnitUpdate, getUnitsByUser } from "../../services/unitStorage";
import { canonicalizePhMobile, validatePhone } from "../../utils/authValidation";

const getServiceAddress = (user = {}) => {
  const addresses = Array.isArray(user?.addresses) ? user.addresses : [];
  return addresses.find((item) => item?.isDefault) || addresses[0] || {
    phone: user?.phone || "",
    street: user?.address || "",
    city: user?.municipality || user?.billingAddress?.city || "",
    province: user?.billingAddress?.province || "",
    barangay: user?.submunicipality || user?.billingAddress?.barangay || "",
  };
};

const ACTIVE_REQUEST_STATUSES = new Set(["pending", "submitted", "reviewed", "assigned", "in progress"]);
const ACTIVE_CLAIM_STATUSES = new Set(["submitted", "under_review", "approved"]);

const readableStatus = (value = "") => String(value || "").replace(/_/g, " ");

const getActiveWarrantyClaim = (unit) =>
  (unit?.warranty?.claims || []).find((claim) => ACTIVE_CLAIM_STATUSES.has(String(claim?.status || "").toLowerCase())) || null;

const hasActiveWarranty = (unit) =>
  String(unit?.warrantyStatus || unit?.warranty?.status || "").toLowerCase() === "active";

const formatDate = (value = "") => {
  if (!value) return "Not recorded";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleDateString();
};

export default function CustomerServicesScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const { current } = useUserContext();
  const [units, setUnits] = useState([]);
  const [serviceOfferings, setServiceOfferings] = useState([]);
  const [requests, setRequests] = useState([]);
  const [serviceCatalogError, setServiceCatalogError] = useState("");
  const [selectedServiceId, setSelectedServiceId] = useState("");
  const [selectedUnitId, setSelectedUnitId] = useState("");
  const [preferredDate, setPreferredDate] = useState("");
  const [issueDescription, setIssueDescription] = useState("");
  const [notes, setNotes] = useState("");
  const [requestMode, setRequestMode] = useState("service");
  const [dateError, setDateError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [loadingUnits, setLoadingUnits] = useState(true);
  const appliedUnitParam = useRef("");
  const appliedTypeParam = useRef("");
  const requestedUnitId = String(Array.isArray(params.unitId) ? params.unitId[0] || "" : params.unitId || "");

  const loadServiceCatalog = useCallback(async () => {
    const token = await getStoredToken();
    if (!token) return;
    const result = await fetchServiceCatalog(token);
    if (!result.success) {
      setServiceCatalogError(result.error || "Unable to load services.");
      return;
    }
    setServiceCatalogError("");
    const choices = customerServiceChoices(result.offerings || []);
    setServiceOfferings(choices);
    setSelectedServiceId((currentId) => choices.some(item => item.id === currentId) ? currentId : choices[0]?.id || "");
  }, []);

  useFocusEffect(useCallback(() => {
    let active = true;
    setLoadingUnits(true);
    loadServiceCatalog();
    const stop = startLiveRefresh(({ background }) => Promise.allSettled([
      getUnitsByUser(current?.id),
      getCustomerServiceHistory(current?.id),
    ]).then(([unitsResult, historyResult]) => {
      if (!active) return;
      if (unitsResult.status === "fulfilled") {
        const items = unitsResult.value;
        setUnits(items);
        // A background update must not switch the AC being booked.
        if (!background) setSelectedUnitId((currentId) => {
          if (requestedUnitId && items.some((item) => String(item.id) === requestedUnitId)) return requestedUnitId;
          if (currentId && items.some((item) => String(item.id) === String(currentId))) return currentId;
          return items[0]?.id || "";
        });
      }
      if (historyResult.status === "fulfilled") setRequests(historyResult.value.requests || []);
    }).finally(() => {
      if (active) setLoadingUnits(false);
    }));
    return () => { active = false; stop(); };
  }, [current?.id, loadServiceCatalog, requestedUnitId]));

  const selectedService = useMemo(() => serviceOfferings.find((item) => item.id === selectedServiceId) || null, [serviceOfferings, selectedServiceId]);
  const selectedUnit = useMemo(() => units.find((item) => String(item.id) === String(selectedUnitId)) || null, [units, selectedUnitId]);
  const selectedActiveRequest = useMemo(() => requests.find((request) =>
    String(request.unitId || "") === String(selectedUnitId || "") &&
    ACTIVE_REQUEST_STATUSES.has(String(request.status || "").toLowerCase())), [requests, selectedUnitId]);
  const activeWarrantyClaim = useMemo(() => getActiveWarrantyClaim(selectedUnit), [selectedUnit]);
  const warrantyEligible = hasActiveWarranty(selectedUnit) && !activeWarrantyClaim;

  useEffect(() => {
    if (requestedUnitId && appliedUnitParam.current !== String(requestedUnitId) && units.some((item) => String(item.id) === String(requestedUnitId))) {
      setSelectedUnitId(String(requestedUnitId));
      appliedUnitParam.current = String(requestedUnitId);
    }
  }, [requestedUnitId, units]);

  useEffect(() => {
    const rawType = Array.isArray(params.serviceType) ? params.serviceType[0] : params.serviceType;
    const requestedType = String(rawType || "").trim().toLowerCase();
    if (!requestedType || appliedTypeParam.current === requestedType) return;
    if (requestedType === "warranty") {
      setRequestMode("warranty");
      appliedTypeParam.current = requestedType;
      return;
    }
    if (!serviceOfferings.length) return;
    const preferredId = requestedType === "deep_cleaning" ? "cleaning"
      : requestedType === "regular_cleaning" ? "maintenance"
        : requestedType === "inspection" ? "consultation" : requestedType;
    const match = serviceOfferings.find((item) => {
      const values = [item.id, item.title, item.defaultIssueType].map((value) => String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_"));
      return values.includes(requestedType) || values.includes(preferredId);
    });
    if (!match) return;
    appliedTypeParam.current = requestedType;
    setRequestMode("service");
    setSelectedServiceId(match.id);
    setIssueDescription((currentValue) => currentValue || `AMP recommended ${requestedType.replace(/_/g, " ")} for this AC unit.`);
  }, [params.serviceType, serviceOfferings]);

  const selectDate = (value) => {
    setPreferredDate(value);
    setDateError("");
  };

  const handleSubmit = async () => {
    if (requestMode === "service" && !selectedService) return Alert.alert("Required", "Choose a service offering.");
    if (!selectedUnit) return Alert.alert("Required", "Select a registered AC unit first.");
    if (selectedActiveRequest) {
      return Alert.alert("Request already open", "This AC unit already has a service request in progress. You do not need to submit another one.");
    }
    if (activeWarrantyClaim) {
      return Alert.alert("Warranty claim in progress", `Your warranty claim is already ${readableStatus(activeWarrantyClaim.status)}. We will notify you when it changes.`);
    }
    if (!issueDescription.trim()) return Alert.alert("Required", "Describe the request or concern.");

    if (requestMode === "warranty") {
      if (!warrantyEligible) return Alert.alert("Warranty unavailable", "This AC does not currently have active warranty coverage. You can choose a standard service request instead.");
      const token = await getStoredToken();
      if (!token) return Alert.alert("Sign in required", "Please sign in again before submitting warranty support.");
      setSubmitting(true);
      try {
        const result = await createWarrantyClaim(token, selectedUnit.id, {
          issue: issueDescription.trim(),
          notes: notes.trim(),
        });
        if (!result.success) throw new Error(result.error);
        const nextUnit = {
          ...selectedUnit,
          warranty: result.warranty,
          warrantyStatus: result.warranty?.status || "under_review",
        };
        setUnits((items) => items.map((item) => String(item.id) === String(nextUnit.id) ? nextUnit : item));
        await cacheUnitUpdate(nextUnit.id, {
          warranty: nextUnit.warranty,
          warrantyStatus: nextUnit.warrantyStatus,
        }).catch(() => null);
        setIssueDescription("");
        setNotes("");
        Alert.alert("Warranty support submitted", "Your claim is now under review. A service visit will be arranged after approval, so no appointment date is needed yet.");
      } catch (error) {
        Alert.alert("Claim not submitted", error?.message || "Unable to submit warranty support.");
      } finally {
        setSubmitting(false);
      }
      return;
    }

    if (!preferredDate) {
      setDateError("Choose your preferred appointment date.");
      return;
    }
    if (isPastCalendarDate(preferredDate)) {
      setDateError("Please choose today or a future date.");
      return;
    }
    const serviceAddress = getServiceAddress(current);
    const contactPhone = canonicalizePhMobile(serviceAddress.phone || current?.phone || "");
    const contactError = validatePhone(contactPhone);
    if (contactError) {
      return Alert.alert(
        "Valid contact number required",
        `${contactError} Add or update your delivery address before requesting service.`,
        [
          { text: "Cancel", style: "cancel" },
          { text: "Open Settings", onPress: () => router.push("/customer/settings") },
        ],
      );
    }

    setSubmitting(true);
    try {
      const createdRequest = await createServiceRequest({
        userId: current?.id,
        customerName: getDisplayName(current),
        customerEmail: current?.email || "",
        customerPhone: contactPhone,
        unitId: selectedUnit.id,
        unitName: selectedUnit.unitName,
        unitSerialNumber: selectedUnit.serialNumber || "",
        qrCode: selectedUnit.qrCode || "",
        serviceId: selectedService.id,
        serviceType: selectedService.title,
        issueType: selectedService.defaultIssueType,
        issueDescription: issueDescription.trim(),
        preferredDate,
        notes: notes.trim(),
        address: serviceAddress.street || current?.address || selectedUnit.placementArea || "",
        city: serviceAddress.city || current?.municipality || "",
        province: serviceAddress.province || "",
        region: serviceAddress.region || "",
        postalCode: serviceAddress.postalCode || "",
        barangay: serviceAddress.barangay || current?.submunicipality || "",
        landmark: current?.landmark || "",
        plusCode: current?.plusCode || "",
        deliveryInstructions: current?.deliveryInstructions || "",
      });
      setRequests((items) => [createdRequest, ...items.filter((item) => String(item.id) !== String(createdRequest.id))]);
      Alert.alert("Request Submitted", "Your preferred date was recorded. We will notify you once a technician and time slot are assigned.");
      setIssueDescription("");
      setPreferredDate("");
      setNotes("");
    } catch (error) {
      Alert.alert("Request Failed", error?.message || "Unable to create your service request.");
    } finally {
      setSubmitting(false);
    }
  };

  const submitTitle = selectedActiveRequest
    ? "Request Already Open"
    : activeWarrantyClaim
      ? "Warranty Claim in Progress"
      : requestMode === "warranty"
        ? "Submit Warranty Claim"
        : "Submit Service Request";

  return (
    <CustomerScreen title="Service Request" subtitle="Arrange AC cleaning, request a repair, or submit a warranty claim" contentContainerStyle={{ paddingBottom: 116 }} stickyAction={<StickyActionBar><Button title={loadingUnits ? "Loading AC Units..." : submitting ? "Submitting..." : submitTitle} onPress={handleSubmit} loading={submitting} disabled={loadingUnits || submitting || !selectedUnit || (requestMode === "service" ? !selectedService : !warrantyEligible) || Boolean(selectedActiveRequest) || Boolean(activeWarrantyClaim)} /></StickyActionBar>}>
      {loadingUnits ? <Card><View style={{ alignItems: "center", gap: SPACING.sm, paddingVertical: SPACING.lg }}><ActivityIndicator color={COLORS.primary} /><Text style={{ color: COLORS.textSecondary }}>Loading registered AC units and open requests...</Text></View></Card> : null}
      {!loadingUnits && units.length === 0 ? <Card><EmptyState title="Register a unit first" message="Service requests need a registered AC unit. Buy from the website and add your AC unit before booking." action={<Button title="Visit Website" onPress={() => Linking.openURL(COLD_AIR_WEBSITE)} />} /></Card> : null}
      <Card>
        <CustomerSectionHeader title="What do you need?" />
        <BottomSheetSelect label="Request type" value={requestMode === "warranty" ? "Warranty Claim" : "Cleaning or Service"} items={[{ id:"service", title:"Cleaning or Service" }, { id:"warranty", title:"Warranty Claim" }]} getKey={item => item.id} getLabel={item => item.title} onSelect={item => setRequestMode(item.id)} />
        <BottomSheetSelect label="Select AC Unit" value={selectedUnit?.unitName} placeholder="Choose registered AC unit" items={units} itemIcon="snow-sharp" getKey={(item) => String(item.id)} getLabel={(item) => `${item.unitName || "Unnamed AC Unit"} · ${item.serialNumber || "Serial not recorded"}`} onSelect={(unit) => setSelectedUnitId(unit.id)} />
        {requestMode === "service" ? <>
        <BottomSheetSelect label="Service" value={selectedService?.title} placeholder="Choose service" items={serviceOfferings} itemIcon="construct-sharp" getKey={(item) => item.id} getLabel={(item) => item.title} onSelect={(service) => setSelectedServiceId(service.id)} />
        <Text style={{ color: COLORS.textSecondary, lineHeight: 20 }}>{selectedService?.summary}</Text>
        {selectedService?.pricing?.label ? <Text style={{ color: COLORS.primary, fontWeight: "700", marginTop: SPACING.xs }}>Service price: {selectedService.pricing.label}</Text> : null}
        {serviceCatalogError ? <Text style={{ color: COLORS.danger, marginTop: SPACING.xs }}>{serviceCatalogError}</Text> : null}
        {serviceCatalogError ? <Button title="Retry services" variant="secondary" onPress={loadServiceCatalog} /> : null}
        <Text style={{ color: COLORS.textSecondary, lineHeight: 20, marginTop: SPACING.sm }}>Regular and deep cleaning are the two cleaning options. If you are unsure when the AC was last cleaned, describe it below so our team can advise you.</Text>
        </> : <Text style={{ color: COLORS.textSecondary, lineHeight: 20 }}>Describe the fault below. Our team will review your coverage before arranging a visit. Submitting a claim does not mean it has been approved.</Text>}
        <Button title="Browse FAQs" variant="secondary" onPress={() => router.push("/customer/faq")} />
      </Card>
      {selectedUnit ? <Card>
        <CustomerSectionHeader title="Coverage & Request Status" />
        <DetailRow label="Warranty" value={readableStatus(selectedUnit.warrantyStatus || selectedUnit.warranty?.status || "pending activation")} />
        <DetailRow label="Coverage expires" value={formatDate(selectedUnit.warrantyExpirationDate || selectedUnit.warranty?.expirationDate)} />
        {selectedActiveRequest ? <>
          <StatusChip label={selectedActiveRequest.status || "Submitted"} color={COLORS.warning} />
          <Text style={{ color: COLORS.textSecondary, lineHeight: 20, marginTop: SPACING.sm }}>
            {selectedActiveRequest.serviceType || selectedActiveRequest.issueType || "Service"} is already being handled. You can follow updates here and in your notifications.
          </Text>
          <Button
            title="View Request Details"
            variant="secondary"
            onPress={() => router.push({
              pathname: "/customer/units/[id]",
              params: { id: selectedUnit.id, page: "service" },
            })}
          />
        </> : null}
        {activeWarrantyClaim ? <>
          <StatusChip label={`Claim ${readableStatus(activeWarrantyClaim.status)}`} color={COLORS.warning} />
          <Text style={{ color: COLORS.textSecondary, lineHeight: 20, marginTop: SPACING.sm }}>
            {String(activeWarrantyClaim.status).toLowerCase() === "approved"
              ? "Your claim was approved and a service request was created. The branch will notify you when a technician and schedule are assigned."
              : "No duplicate request is needed. Your claim is being reviewed, and you will be notified when its status changes."}
          </Text>
        </> : null}
        {requestMode === "warranty" && !warrantyEligible && !activeWarrantyClaim ? <Text accessibilityRole="alert" style={{ color: COLORS.danger, lineHeight: 20 }}>This AC does not currently have active warranty coverage. Choose Cleaning or Service for a standard request, or contact our team about your coverage.</Text> : null}
      </Card> : null}
      <ServiceRequestPaymentSummary mode={requestMode} service={selectedService} payment={selectedActiveRequest?.servicePayment} />
      <Card>
        <CustomerSectionHeader title={requestMode === "warranty" ? "Warranty Claim Details" : "Visit Details"} />
        {requestMode === "service" ? <CalendarDatePicker label="Preferred Date" value={preferredDate} onChange={selectDate} minimumDate={getTodayDateKey()} required error={dateError} /> : null}
        <TextField label={requestMode === "warranty" ? "AC problem" : "Service Concern"} value={issueDescription} onChangeText={setIssueDescription} placeholder={requestMode === "warranty" ? "Describe the fault you want us to review" : "Tell us about the cleaning or service needed"} multiline style={{ minHeight: 100, textAlignVertical: "top" }} />
        <TextField label="Notes (optional)" value={notes} onChangeText={setNotes} placeholder="Additional site instructions or preferences" multiline style={{ minHeight: 80, textAlignVertical: "top" }} />
      </Card>
    </CustomerScreen>
  );
}
