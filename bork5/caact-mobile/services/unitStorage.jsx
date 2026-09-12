// services/unitStorage.jsx
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as api from "./api";

const STORAGE_KEY = "units_storage_v1";

function safeParse(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch (error) {
    return fallback;
  }
}

function normalizeUnit(unit = {}) {
  const installationEnvironment =
    unit.installationEnvironment || unit.placementType || "";
  const placementArea = unit.placementArea || unit.location || "";

  return {
    id: unit.id || `unit_${Date.now()}_${Math.floor(Math.random() * 100000)}`,
    userId: unit.userId || null,
    productId: unit.productId || "",
    productSku: unit.productSku || unit.sku || "",
    imageUrl: unit.imageUrl || unit.image || "",
    unitName: unit.unitName || "",
    brand: unit.brand || "",
    model: unit.model || "",
    serialNumber: unit.serialNumber || "",
    orderCode: unit.orderCode || "",
    purchaseDate: unit.purchaseDate || "",
    qrUnitId: unit.qrUnitId || "",
    serviceBranch: unit.serviceBranch || "",
    status: unit.status || "Active",
    installationDate: unit.installationDate || "",
    placementArea,
    installationEnvironment,
    usageLevel: unit.usageLevel || "Normal",
    ventilationQuality: unit.ventilationQuality || "Good",
    lastMaintenanceDate: unit.lastMaintenanceDate || "",
    notes: unit.notes || "",
    qrCode: unit.qrCode || "",
    amp: unit.amp || {},
    category: unit.category || "",
    capacityHp: Number(unit.capacityHp || 0),
    roomSizeSqm: unit.roomSizeSqm || null,
    bestServicedBy: unit.bestServicedBy || unit.amp?.bestServicedBy || unit.amp?.nextIdealServiceDate || "",
    recommendedService: unit.recommendedService ?? unit.amp?.recommendedService ?? "",
    dataQuality: unit.dataQuality || unit.amp?.dataQuality || null,
    recommendationBasis: unit.recommendationBasis || unit.amp?.recommendationBasis || "",
    capacityAssessment: unit.capacityAssessment || unit.amp?.capacityAssessment || null,
    lastServiceDate: unit.lastServiceDate || unit.amp?.lastServiceDate || null,
    lastCleaningDate: unit.lastCleaningDate || unit.amp?.lastCleaningDate || null,
    warranty: unit.warranty || {},
    warrantyStatus: unit.warrantyStatus || unit.warranty?.status || "pending_activation",
    warrantyExpirationDate: unit.warrantyExpirationDate || unit.warranty?.expirationDate || "",
    warrantyRecommendation: unit.warrantyRecommendation || "",
    serviceHistory: Array.isArray(unit.serviceHistory) ? unit.serviceHistory : [],
    unitHistory: Array.isArray(unit.unitHistory) ? unit.unitHistory : (Array.isArray(unit.serviceHistory) ? unit.serviceHistory : []),
    latestVisitAnalysis: unit.latestVisitAnalysis || unit.amp?.latestVisitAnalysis || unit.amp?.visitFollowUp || null,
    createdAt: unit.createdAt || "",
    updatedAt: unit.updatedAt || "",
  };
}

function mergeByIdOrSerial(existing = [], incoming = []) {
  const byKey = new Map();
  existing.map(normalizeUnit).forEach((unit) => {
    byKey.set(String(unit.serialNumber || unit.id), unit);
  });
  incoming.map(normalizeUnit).forEach((unit) => {
    byKey.set(String(unit.serialNumber || unit.id), unit);
  });
  return Array.from(byKey.values());
}

export async function getAllUnits() {
  const raw = await AsyncStorage.getItem(STORAGE_KEY);
  const parsed = safeParse(raw, []);
  return Array.isArray(parsed) ? parsed.map(normalizeUnit) : [];
}

export async function saveAllUnits(units = []) {
  const normalized = units.map(normalizeUnit);
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
  return normalized;
}

export async function cacheUnitUpdate(unitId, patch = {}) {
  const units = await getAllUnits();
  const index = units.findIndex((unit) => String(unit.id) === String(unitId));
  if (index < 0) return null;

  const updated = normalizeUnit({
    ...units[index],
    ...patch,
    id: units[index].id,
    userId: patch.userId || units[index].userId,
    updatedAt: new Date().toISOString(),
  });
  const nextUnits = [...units];
  nextUnits[index] = updated;
  await saveAllUnits(nextUnits);
  return updated;
}

export async function getUnitsByUser(userId) {
  try {
    const token = await api.getStoredToken();
    if (token) {
      const result = await api.fetchCustomerAmpUnits(token);
      if (result.success) {
        const backendUnits = result.units.map((unit) => normalizeUnit({ ...unit, userId }));
        const localUnits = await getAllUnits();
        const otherUsers = localUnits.filter(
          (unit) => String(unit.userId || "") !== String(userId || ""),
        );
        // Installed units are created by the technician completion flow.
        // Do not merge stale device-only units back into the customer record.
        await saveAllUnits([...backendUnits, ...otherUsers]);
        return backendUnits;
      }
    }
  } catch {
    // Offline fallback uses local unit cache.
  }

  const units = await getAllUnits();
  return units.filter(
    (unit) => String(unit.userId) === String(userId),
  );
}

export async function addUnit() {
  throw new Error("AC units are added after a verified installation, not from this device.");
}

export async function getUnitByCode(rawValue) {
  try {
    const token = await api.getStoredToken();
    if (token) {
      const result = await api.fetchCustomerAmpUnits(token);
      if (result.success) {
        const localUnits = await getAllUnits();
        await saveAllUnits(mergeByIdOrSerial(localUnits, result.units));
      }
    }
  } catch {
    // Keep local QR lookup available offline.
  }

  const value = String(rawValue || "").trim().toLowerCase();
  if (!value) return null;

  const unitIdMatch = value.match(/unit:([^|]+)/);
  const serialMatch = value.match(/serial:([^|]+)/);
  const lookupValue = String(unitIdMatch?.[1] || serialMatch?.[1] || value).trim().toLowerCase();
  const units = await getAllUnits();

  return (
    units.find((unit) => String(unit.id || "").toLowerCase() === lookupValue) ||
    units.find((unit) => String(unit.serialNumber || "").toLowerCase() === lookupValue) ||
    units.find((unit) => String(unit.unitName || "").toLowerCase() === lookupValue) ||
    null
  );
}

export async function claimUnitForUserByCode(rawValue, userId) {
  void rawValue;
  void userId;
  throw new Error("Unit ownership is confirmed by the technician installation workflow.");
}

export async function updateUnit() {
  throw new Error("AC unit records are managed through the synchronized service workflow.");
}

export async function deleteUnit() {
  throw new Error("AC unit records cannot be removed from this device.");
}
