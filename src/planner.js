'use strict';

const { ContractError } = require('./errors');
const { validateRequest } = require('./contract');
const { validateCatalog } = require('./catalog');

function planRequest(requestInput, catalogInput) {
  const request = validateRequest(requestInput);
  const catalog = validateCatalog(catalogInput);
  const route = catalog.routes.find((item) => item.id === request.target.routeId);
  if (!route) throw new ContractError('UNKNOWN_ROUTE', `unknown route: ${request.target.routeId}`);
  if (!route.operations.includes(request.operation)) {
    throw new ContractError('UNSUPPORTED_OPERATION', `${route.id} does not support ${request.operation}`);
  }

  const missingParams = route.requiredParams.filter((key) => !request.target[key]);
  if (missingParams.length) {
    throw new ContractError('MISSING_PARAMETER', `missing route parameters: ${missingParams.join(', ')}`);
  }

  const url = new URL(catalog.baseUrl);
  for (const [key, value] of Object.entries(route.fixedParams)) url.searchParams.set(key, value);
  for (const key of [...route.requiredParams, ...route.optionalParams]) {
    if (request.target[key]) url.searchParams.set(route.queryParams[key], request.target[key]);
  }

  return Object.freeze({
    schemaVersion: 1,
    requestId: request.requestId,
    operation: request.operation,
    mode: request.mode,
    catalogVersion: catalog.catalogVersion,
    catalogClassification: catalog.classification,
    route: Object.freeze({
      id: route.id,
      resolvedUrl: url.toString(),
      requiredParams: Object.freeze([...route.requiredParams]),
      fixedParams: Object.freeze({ ...route.fixedParams }),
      readinessTexts: Object.freeze([...route.readinessTexts]),
    }),
    outputDirectory: request.outputDirectory,
    verdicts: Object.freeze({
      routeSelection: 'planned',
      navigation: 'not_executed',
      material: 'not_executed',
    }),
  });
}

module.exports = { planRequest };
