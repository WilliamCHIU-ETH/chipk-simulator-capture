'use strict';

const { canonicalCatalogDigest, validateCatalog } = require('./catalog');
const { APPROVED_PRODUCTION_CATALOG_DIGESTS } = require('./trust-store');

const REQUIRED_OPERATIONS = Object.freeze(['screenshot', 'record']);

function assessBuildReadiness(catalogInput, runtimeAdapter) {
  const catalog = validateCatalog(catalogInput);
  const reasons = [];
  if (catalog.classification !== 'production-reviewed') reasons.push('catalog_is_not_production_reviewed');
  if (!catalog.sourceDigest || catalog.sourceDigest !== canonicalCatalogDigest(catalogInput)) {
    reasons.push('catalog_digest_is_missing_or_invalid');
  }
  if (!catalog.sourceDigest || !APPROVED_PRODUCTION_CATALOG_DIGESTS.includes(catalog.sourceDigest)) {
    reasons.push('catalog_digest_not_approved_by_build');
  }
  if (!runtimeAdapter) {
    reasons.push('runtime_adapter_not_shipped');
  } else {
    if (runtimeAdapter.productionReady !== true) reasons.push('runtime_adapter_not_production_ready');
    if (typeof runtimeAdapter.execute !== 'function') reasons.push('runtime_adapter_execute_missing');
    const operations = Array.isArray(runtimeAdapter.operations) ? runtimeAdapter.operations : [];
    for (const operation of REQUIRED_OPERATIONS) {
      if (!operations.includes(operation)) reasons.push(`runtime_adapter_missing_${operation}`);
    }
  }
  return Object.freeze({ productionReady: reasons.length === 0, reasons: Object.freeze(reasons) });
}

function assessRunAuthorization(buildReadiness, context = {}) {
  const reasons = [...buildReadiness.reasons];
  if (context.operatorAuthorized !== true) reasons.push('operator_authorization_missing');
  if (context.dedicatedSimulatorConfirmed !== true) reasons.push('dedicated_simulator_not_confirmed');
  return Object.freeze({ authorized: reasons.length === 0, reasons: Object.freeze(reasons) });
}

module.exports = { assessBuildReadiness, assessRunAuthorization };
