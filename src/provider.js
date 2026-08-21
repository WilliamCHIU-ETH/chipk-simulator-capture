'use strict';

const { validateRequest, validateResult } = require('./contract');
const { RuntimeAdapterError } = require('./runtime-adapter');

const PROVIDER_ID = 'chipk-simulator-capture';

function createResult({ requestId, toolVersion, status, artifacts = [], evidence = {}, error = null }) {
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

function requiredRoles(operation) {
  return operation === 'screenshot'
    ? ['screenshot', 'capture-manifest']
    : ['raw-video', 'actions', 'recording-manifest'];
}

function validateCompletedArtifacts(operation, artifacts) {
  const roles = artifacts.map((artifact) => artifact.role).sort();
  const expected = requiredRoles(operation).sort();
  if (roles.length !== expected.length || roles.some((role, index) => role !== expected[index])) {
    throw new Error('runtime artifact bundle is incomplete');
  }
}

function createProvider({ runtimeAdapter, toolVersion }) {
  if (typeof toolVersion !== 'string' || !toolVersion.trim()) {
    throw new TypeError('toolVersion must be a non-empty string');
  }
  if (!runtimeAdapter || runtimeAdapter.productionReady !== true
    || typeof runtimeAdapter.execute !== 'function'
    || !Array.isArray(runtimeAdapter.operations)) {
    throw new TypeError('runtimeAdapter must ship an executable production boundary');
  }
  const operations = [...runtimeAdapter.operations];
  if (!['screenshot', 'record'].every((operation) => operations.includes(operation))) {
    throw new TypeError('runtimeAdapter must support screenshot and record');
  }

  function capabilities() {
    return {
      schemaVersion: 1,
      providerId: PROVIDER_ID,
      toolVersion,
      productionReady: true,
      operations: ['screenshot', 'record'],
      planningAvailable: true,
      executionCommand: 'chipk-capture acquire --request <absolute-json-file> --json',
      contracts: {
        request: 'contracts/capture-request.schema.json',
        result: 'contracts/capture-result.schema.json',
      },
      catalogVersion: runtimeAdapter.catalogVersion,
      runtimeConfiguration: {
        source: 'provider-local-environment',
        probedPerRequest: true,
      },
    };
  }

  async function acquire(requestInput) {
    const request = validateRequest(requestInput);
    try {
      const runtimeResult = await runtimeAdapter.execute(request);
      if (!runtimeResult || !Array.isArray(runtimeResult.artifacts)
        || !runtimeResult.evidence || typeof runtimeResult.evidence !== 'object') {
        throw new Error('invalid runtime result');
      }
      validateCompletedArtifacts(request.operation, runtimeResult.artifacts);
      return createResult({
        requestId: request.requestId,
        toolVersion,
        status: 'completed',
        artifacts: runtimeResult.artifacts,
        evidence: runtimeResult.evidence,
      });
    } catch (error) {
      if (error instanceof RuntimeAdapterError) {
        return createResult({
          requestId: request.requestId,
          toolVersion,
          status: error.status,
          evidence: error.evidence || {},
          error: {
            code: error.code,
            message: error.message,
            retryable: error.retryable,
          },
        });
      }
      return createResult({
        requestId: request.requestId,
        toolVersion,
        status: 'failed',
        error: {
          code: 'INVALID_RUNTIME_RESULT',
          message: 'Runtime adapter failed without a publishable result.',
          retryable: false,
        },
      });
    }
  }

  return Object.freeze({ acquire, capabilities });
}

module.exports = { createProvider, createResult, validateCompletedArtifacts };
