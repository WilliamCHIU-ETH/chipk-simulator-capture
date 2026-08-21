'use strict';

const { validateRequest, validateResult } = require('./contract');
const { ContractError } = require('./errors');
const { validateCatalog } = require('./catalog');
const { planRequest } = require('./planner');
const { assessBuildReadiness, assessRunAuthorization } = require('./readiness');

const PROVIDER_ID = 'chipk-simulator-capture';

function createResult({ requestId, toolVersion, status, artifacts = {}, evidence = {}, error = null }) {
  return validateResult({
    contractVersion: 1,
    requestId,
    provider: { id: PROVIDER_ID, toolVersion },
    status,
    artifacts,
    evidence,
    error,
  });
}

function createProvider({ catalog, runtimeAdapter = null, toolVersion }) {
  if (typeof toolVersion !== 'string' || !toolVersion.trim()) {
    throw new ContractError('INVALID_PROVIDER', 'toolVersion must be a non-empty string');
  }
  const catalogSnapshot = validateCatalog(catalog);
  const runtimeSnapshot = runtimeAdapter && Object.freeze({
    productionReady: runtimeAdapter.productionReady,
    operations: Array.isArray(runtimeAdapter.operations) ? Object.freeze([...runtimeAdapter.operations]) : [],
    execute: typeof runtimeAdapter.execute === 'function'
      ? runtimeAdapter.execute.bind(runtimeAdapter)
      : null,
  });
  const buildReadiness = assessBuildReadiness(catalogSnapshot, runtimeSnapshot);

  function capabilities() {
    return {
      schemaVersion: 1,
      providerId: PROVIDER_ID,
      toolVersion,
      productionReady: buildReadiness.productionReady,
      operations: buildReadiness.productionReady ? ['screenshot', 'record'] : [],
      planningAvailable: true,
      contracts: {
        request: 'contracts/capture-request.schema.json',
        result: 'contracts/capture-result.schema.json',
      },
      readiness: buildReadiness,
      limitations: buildReadiness.productionReady ? [] : [...buildReadiness.reasons],
    };
  }

  function plan(requestInput) {
    return planRequest(requestInput, catalogSnapshot);
  }

  async function execute(requestInput, context = {}) {
    const request = validateRequest(requestInput);
    const planValue = plan(request);
    const authorization = assessRunAuthorization(buildReadiness, context);
    if (!authorization.authorized) {
      return createResult({
        requestId: request.requestId,
        toolVersion,
        status: 'rejected',
        evidence: { plan: planValue, readiness: buildReadiness, authorization },
        error: {
          code: 'PRODUCTION_NOT_READY',
          message: 'Capture execution is unavailable; use the consumer fallback.',
          retryable: false,
        },
      });
    }

    let runtimeResult;
    try {
      runtimeResult = await runtimeSnapshot.execute({ request, plan: planValue });
    } catch {
      return createResult({
        requestId: request.requestId,
        toolVersion,
        status: 'failed',
        evidence: { plan: planValue, readiness: buildReadiness },
        error: {
          code: 'RUNTIME_ADAPTER_FAILED',
          message: 'Runtime adapter failed without a publishable result.',
          retryable: false,
        },
      });
    }
    try {
      const artifacts = runtimeResult && runtimeResult.artifacts;
      const evidence = runtimeResult && runtimeResult.evidence;
      if (!artifacts || typeof artifacts !== 'object' || Array.isArray(artifacts)
        || !evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
        throw new ContractError('INVALID_RUNTIME_RESULT', 'runtime result must contain object envelopes');
      }
      return createResult({
        requestId: request.requestId,
        toolVersion,
        status: 'completed',
        artifacts,
        evidence: { plan: planValue, readiness: buildReadiness, runtime: evidence },
      });
    } catch {
      return createResult({
        requestId: request.requestId,
        toolVersion,
        status: 'failed',
        evidence: { plan: planValue, readiness: buildReadiness },
        error: {
          code: 'INVALID_RUNTIME_RESULT',
          message: 'Runtime adapter returned an invalid result.',
          retryable: false,
        },
      });
    }
  }

  return Object.freeze({ capabilities, execute, plan });
}

module.exports = { createProvider };
