import DynamicServiceSticker from "./DynamicServiceSticker";
import ServiceFollowUp from "./ServiceFollowUp";
import UnitProductVisual from "./UnitProductVisual";
import { formatUnitHorsepower } from "../../domain/myunit/unitDisplay";
import { serviceLabel, serviceDateLabel, serviceDetails, servicePriceLabel } from '../../domain/myunit/serviceHistoryDisplay';

function UnitDetailsModal({ unit, onClose, onEdit, onDelete }) {
  const getStatusClass = () => {
    switch (unit.status) {
      case "Good":
        return "status-good";
      case "Needs Service":
        return "status-needs-service";
      case "Critical":
        return "status-critical";
      default:
        return "";
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="unit-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>AC Details</h3>
          <button className="close-modal" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="modal-body">
          <div className="unit-modal-product">
            <UnitProductVisual unit={unit} size="modal" />
            <h2>
              {unit.brand}
            </h2>
            <p>{unit.productSku || unit.model || "Model not recorded"}</p>
          </div>

          <div className="info-row">
            <span className="info-label">Horsepower</span>
            <span className="info-value">{formatUnitHorsepower(unit)}</span>
          </div>
          <div className="info-row">
            <span className="info-label">Serial Number</span>
            <span className="info-value">{unit.serialNumber}</span>
          </div>
          <div className="info-row">
            <span className="info-label">Installation Date</span>
            <span className="info-value">{unit.installationDate}</span>
          </div>
          <div className="info-row">
            <span className="info-label">Status</span>
            <span className={`unit-status ${getStatusClass()}`}>
              {unit.status}
            </span>
          </div>
          <DynamicServiceSticker unit={unit} />
          {unit.technicianReportSummary && (
            <div className="info-row">
              <span className="info-label">Installation</span>
              <span className="info-value">{unit.technicianReportSummary}</span>
            </div>
          )}
          {unit.installEnvironmentNotes && (
            <div className="info-row">
              <span className="info-label">Installed At</span>
              <span className="info-value">{unit.installEnvironmentNotes}</span>
            </div>
          )}
          {unit.notes && (
            <div className="info-row">
              <span className="info-label">Registration</span>
              <span className="info-value">{unit.notes}</span>
            </div>
          )}

          {(unit.unitHistory || unit.serviceHistory || []).length > 0 && (
            <div style={{ marginTop: "20px" }}>
              <h4>Installation &amp; Service History</h4>
              <div className="history-list">
                {(unit.unitHistory || unit.serviceHistory || []).map((service, idx) => (
                  <div key={idx} className="history-item">
                    <div className="history-date">{serviceDateLabel(service.date)}</div>
                    <div className="history-service">{serviceLabel(service.serviceType)}</div>
                    <div className="history-details">{serviceDetails(service)}</div>
                    <ServiceFollowUp interpretation={service.aiInterpretation} />
                    {servicePriceLabel(service) ? <div className="history-price">{servicePriceLabel(service)}</div> : null}
                    {service.evidence?.eligible === false ? <div className="history-details">{service.evidence.reason}</div> : null}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button className="cancel-btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

export default UnitDetailsModal;
