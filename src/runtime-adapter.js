'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pngSize } = require('../scripts/app-locator');
const {
  buildPlan,
  captureRoute,
  localDate,
  readCatalog,
} = require('../scripts/simulator-capture');
const {
  planRecipe,
  readRecipes,
  recordRecipe,
} = require('../scripts/simulator-record');
const { getProfile, profileCapability, readProfiles } = require('./presentation-profiles');
const { renderPreparedScreenshot } = require('./prepared-state-renderer');
const { validateResult } = require('./contract');

const REQUIRED_RUN_ENV = Object.freeze([
  'CHIPK_SIMULATOR_UDID',
  'CHIPK_CAPTURE_AUTHORIZED',
  'CHIPK_DEDICATED_SIMULATOR_CONFIRMED',
  'CHIPK_VIP_SESSION_CONFIRMED',
]);
const UDID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class RuntimeAdapterError extends Error {
  constructor(code, message, { status = 'failed', retryable = false, evidence = {} } = {}) {
    super(message);
    this.name = 'RuntimeAdapterError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.evidence = evidence;
  }
}

function sha256(filePath, fsImpl = fs) {
  return crypto.createHash('sha256').update(fsImpl.readFileSync(filePath)).digest('hex');
}

function readRunConfiguration(environment = process.env) {
  const missing = REQUIRED_RUN_ENV.filter((name) => !environment[name]);
  if (missing.length > 0) {
    throw new RuntimeAdapterError(
      'RUNTIME_CONFIGURATION_REQUIRED',
      'Provider-local Simulator configuration and run attestations are required.',
      {
        status: 'human_action_required',
        retryable: true,
        evidence: { missingConfiguration: missing },
      },
    );
  }
  if (!UDID_RE.test(environment.CHIPK_SIMULATOR_UDID)) {
    throw new RuntimeAdapterError(
      'INVALID_SIMULATOR_UDID',
      'Provider-local Simulator UDID must identify one exact device.',
      { status: 'human_action_required', retryable: true },
    );
  }
  for (const name of REQUIRED_RUN_ENV.slice(1)) {
    if (environment[name] !== '1') {
      throw new RuntimeAdapterError(
        'RUN_ATTESTATION_REQUIRED',
        'The authorized, dedicated, active-session run attestations must each equal 1.',
        { status: 'human_action_required', retryable: true },
      );
    }
  }
  return Object.freeze({ udid: environment.CHIPK_SIMULATOR_UDID });
}

function requireCallerOutputDirectory(outputDirectory, fsImpl = fs) {
  let metadata;
  try {
    metadata = fsImpl.lstatSync(outputDirectory);
  } catch {
    throw new RuntimeAdapterError(
      'OUTPUT_DIRECTORY_NOT_FOUND',
      'Caller outputDirectory must already exist.',
      { status: 'rejected', retryable: true },
    );
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new RuntimeAdapterError(
      'INVALID_OUTPUT_DIRECTORY',
      'Caller outputDirectory must be a regular non-symbolic-link directory.',
      { status: 'rejected', retryable: false },
    );
  }
  let canonical;
  try {
    canonical = fsImpl.realpathSync(outputDirectory);
  } catch {
    throw new RuntimeAdapterError(
      'INVALID_OUTPUT_DIRECTORY',
      'Caller outputDirectory could not be resolved.',
      { status: 'rejected', retryable: false },
    );
  }
  return canonical;
}

function descriptor({ role, kind, relativePath, filePath, mimeType, media }, fsImpl = fs) {
  return {
    role,
    kind,
    relativePath,
    sha256: sha256(filePath, fsImpl),
    mimeType,
    ...(media ? { media } : {}),
  };
}

function assertFreshOutputPaths(filePaths, fsImpl = fs) {
  for (const filePath of filePaths) {
    try {
      fsImpl.lstatSync(filePath);
      throw new RuntimeAdapterError(
        'OUTPUT_EXISTS',
        'The caller outputDirectory already contains a provider output.',
        { status: 'rejected', retryable: false },
      );
    } catch (error) {
      if (error instanceof RuntimeAdapterError) throw error;
      if (error?.code !== 'ENOENT') {
        throw new RuntimeAdapterError(
          'INVALID_OUTPUT_DESTINATION',
          'A provider output destination could not be inspected safely.',
          { status: 'rejected', retryable: false },
        );
      }
    }
  }
}

function rollbackPublishedPaths(filePaths, fsImpl = fs) {
  let cleanupFailed = false;
  for (const filePath of [...filePaths].reverse()) {
    try {
      fsImpl.unlinkSync(filePath);
    } catch (error) {
      if (error?.code !== 'ENOENT') cleanupFailed = true;
    }
  }
  if (cleanupFailed) {
    throw new RuntimeAdapterError(
      'OUTPUT_ROLLBACK_FAILED',
      'Provider output validation failed and exact-bundle cleanup requires operator attention.',
      {
        status: 'human_action_required',
        retryable: false,
        evidence: { publicationState: 'cleanup_required' },
      },
    );
  }
}

function finalizeRuntimeResult(contractVersion, requestId, artifacts, evidence) {
  if (typeof contractVersion === 'string') {
    evidence = artifacts;
    artifacts = requestId;
    requestId = contractVersion;
    contractVersion = 1;
  }
  const result = validateResult({
    contractVersion,
    requestId,
    provider: { id: 'chipk-simulator-capture', toolVersion: 'runtime' },
    status: 'completed',
    artifacts,
    evidence,
    error: null,
  });
  return { artifacts: result.artifacts, evidence: result.evidence };
}

function safeRuntimeFailure(error) {
  if (error instanceof RuntimeAdapterError) return error;
  const code = typeof error?.code === 'string' && /^[a-z0-9_]+$/i.test(error.code)
    ? error.code.toUpperCase()
    : 'RUNTIME_EXECUTION_FAILED';
  const humanCodes = new Set([
    'EXPECTED_TEXT_TIMEOUT',
    'CONTENT_TEXT_TIMEOUT',
    'OCR_UNAVAILABLE',
    'OCR_LANGUAGE_MISSING',
    'SIMULATOR_NOT_FOUND',
    'SIMULATOR_NOT_BOOTED',
    'APP_NOT_INSTALLED',
    'SESSION_PREFLIGHT_EVIDENCE_INCOMPLETE',
  ]);
  const rejectedCodes = new Set([
    'OUTPUT_EXISTS',
    'MISSING_PARAM',
    'ROUTE_NOT_FOUND',
    'RECIPE_NOT_FOUND',
    'RECIPE_ROUTE_MISMATCH',
    'RECIPE_MODE_MISMATCH',
    'STOCK_NOT_FOUND',
    'STOCK_CONFLICT',
    'UNSUPPORTED_PRESENTATION_PROFILE',
    'UNSUPPORTED_PREPARED_TARGET',
  ]);
  if (humanCodes.has(code)) {
    return new RuntimeAdapterError(code, 'Simulator state requires operator attention before retry.', {
      status: 'human_action_required', retryable: true,
    });
  }
  if (rejectedCodes.has(code)) {
    return new RuntimeAdapterError(code, 'The acquisition request was rejected before publication.', {
      status: 'rejected', retryable: code !== 'OUTPUT_EXISTS',
    });
  }
  return new RuntimeAdapterError(code, 'Provider runtime failed without publishing private diagnostics.', {
    status: 'failed', retryable: false,
  });
}

function createRuntimeAdapter(options = {}) {
  const environment = options.environment || process.env;
  const fsImpl = options.fsImpl || fs;
  const catalog = options.catalog || readCatalog();
  const recipeFile = options.recipeFile || readRecipes(catalog);
  const capture = options.captureRoute || captureRoute;
  const record = options.recordRecipe || recordRecipe;
  const prepareScreenshot = options.prepareScreenshot || renderPreparedScreenshot;
  const profiles = options.profiles || readProfiles();
  const preparedRendererOptions = options.preparedRendererOptions || {};
  const clock = options.now || (() => new Date());

  function plan(request) {
    if (request.contractVersion === 2) {
      let profile;
      try {
        profile = getProfile(profiles, request.presentation.profileId);
      } catch (error) {
        throw new RuntimeAdapterError(
          error.code || 'UNSUPPORTED_PRESENTATION_PROFILE',
          'The requested presentation profile is not supported.',
          { status: 'rejected', retryable: false },
        );
      }
      if (!profile.routeIds.includes(request.target.routeId)
        || !profile.stockIds.includes(request.target.stockId)) {
        throw new RuntimeAdapterError(
          'UNSUPPORTED_PREPARED_TARGET',
          'The requested route and stock are outside the reviewed prepared-video slice.',
          { status: 'rejected', retryable: false },
        );
      }
      const reviewedStock = catalog.stockDirectory?.find((stock) => stock.id === request.target.stockId);
      if (!reviewedStock || (request.target.stockName !== undefined
        && request.target.stockName !== reviewedStock.name)) {
        throw new RuntimeAdapterError(
          'STOCK_CONFLICT',
          'The requested stock identity does not match the reviewed directory.',
          { status: 'rejected', retryable: false },
        );
      }
      const capturePlan = buildPlan(catalog, {
        route: request.target.routeId,
        mode: request.mode,
        scriptDate: request.mode === 'live' ? localDate(clock()) : undefined,
        stockId: request.target.stockId,
        stockName: reviewedStock.name,
      }, clock());
      return Object.freeze({ profile, capturePlan });
    }
    if (request.operation === 'screenshot') {
      if (request.target.recipeId !== undefined) {
        throw new RuntimeAdapterError('UNEXPECTED_RECIPE', 'target.recipeId is only valid for record.', {
          status: 'rejected', retryable: false,
        });
      }
      return buildPlan(catalog, {
        route: request.target.routeId,
        mode: request.mode,
        scriptDate: request.mode === 'live' ? localDate(clock()) : undefined,
        stockId: request.target.stockId,
        stockName: request.target.stockName,
      }, clock());
    }
    if (!request.target.recipeId) {
      throw new RuntimeAdapterError('RECIPE_REQUIRED', 'target.recipeId is required for record.', {
        status: 'rejected', retryable: false,
      });
    }
    const value = planRecipe(catalog, recipeFile, request.target.recipeId);
    if (value.route.id !== request.target.routeId) {
      throw new RuntimeAdapterError('RECIPE_ROUTE_MISMATCH', 'Recipe route does not match target.routeId.', {
        status: 'rejected', retryable: false,
      });
    }
    if (value.mode !== request.mode) {
      throw new RuntimeAdapterError('RECIPE_MODE_MISMATCH', 'Recipe mode does not match request mode.', {
        status: 'rejected', retryable: false,
      });
    }
    const plannedStockId = value.navigation?.parameters?.stockid;
    const plannedStockName = value.navigation?.parameters?.stockname;
    if ((request.target.stockId !== undefined && request.target.stockId !== plannedStockId)
      || (request.target.stockName !== undefined && request.target.stockName !== plannedStockName)) {
      throw new RuntimeAdapterError('RECIPE_TARGET_MISMATCH', 'Recipe stock does not match request target.', {
        status: 'rejected', retryable: false,
      });
    }
    return value;
  }

  async function execute(request) {
    let planValue;
    let publishedPaths = [];
    let stagingDirectory = null;
    try {
      planValue = plan(request);
      const outputDirectory = requireCallerOutputDirectory(request.outputDirectory, fsImpl);
      const runConfiguration = readRunConfiguration(environment);
      if (request.contractVersion === 2) {
        const finalDirectoryName = 'ready-to-place';
        const finalDirectory = path.join(outputDirectory, finalDirectoryName);
        assertFreshOutputPaths([finalDirectory], fsImpl);
        stagingDirectory = fsImpl.mkdtempSync(path.join(outputDirectory, '.chipk-ready-to-place-'));
        const screenshotPath = path.join(stagingDirectory, 'screenshot.png');
        const captureManifestPath = path.join(stagingDirectory, 'capture-manifest.json');
        const preparedVideoPath = path.join(stagingDirectory, 'prepared.mp4');
        const presentationPlanPath = path.join(stagingDirectory, 'presentation-plan.json');
        const preparationManifestPath = path.join(stagingDirectory, 'preparation-manifest.json');

        await capture(catalog, {
          route: request.target.routeId,
          mode: request.mode,
          scriptDate: request.mode === 'live' ? localDate(clock()) : undefined,
          stockId: request.target.stockId,
          stockName: planValue.capturePlan.parameters.stockname,
          udid: runConfiguration.udid,
          confirmVipSession: true,
          requireContentTexts: true,
          output: screenshotPath,
          manifest: captureManifestPath,
        });
        const prepared = await prepareScreenshot({
          request,
          profile: planValue.profile,
          capturePlan: planValue.capturePlan,
          catalogVersion: catalog.catalogVersion,
          screenshot: screenshotPath,
          captureManifest: captureManifestPath,
          preparedVideo: preparedVideoPath,
          presentationPlan: presentationPlanPath,
          preparationManifest: preparationManifestPath,
        }, preparedRendererOptions);
        const image = pngSize(screenshotPath);
        const prefix = `${finalDirectoryName}/`;
        const runtimeResult = finalizeRuntimeResult(
          2,
          request.requestId,
          [
            descriptor({
              role: 'prepared-video', kind: 'video', relativePath: `${prefix}prepared.mp4`,
              filePath: preparedVideoPath, mimeType: 'video/mp4',
              media: {
                codec: prepared.media.codec,
                width: prepared.media.width,
                height: prepared.media.height,
                durationSeconds: prepared.media.durationSeconds,
              },
            }, fsImpl),
            descriptor({
              role: 'screenshot', kind: 'image', relativePath: `${prefix}screenshot.png`,
              filePath: screenshotPath, mimeType: 'image/png',
              media: { width: image.width, height: image.height },
            }, fsImpl),
            descriptor({
              role: 'capture-manifest', kind: 'json',
              relativePath: `${prefix}capture-manifest.json`,
              filePath: captureManifestPath, mimeType: 'application/json',
            }, fsImpl),
            descriptor({
              role: 'presentation-plan', kind: 'json',
              relativePath: `${prefix}presentation-plan.json`,
              filePath: presentationPlanPath, mimeType: 'application/json',
            }, fsImpl),
            descriptor({
              role: 'preparation-manifest', kind: 'json',
              relativePath: `${prefix}preparation-manifest.json`,
              filePath: preparationManifestPath, mimeType: 'application/json',
            }, fsImpl),
          ],
          {
            routeSelection: 'catalog_exact_match',
            navigation: 'expected_texts_verified',
            material: 'ready_to_place',
            catalogVersion: catalog.catalogVersion,
            presentationProfile: {
              id: planValue.profile.id,
              version: planValue.profile.version,
              status: planValue.profile.status,
            },
            publication: 'atomic_directory_rename',
          },
        );
        fsImpl.renameSync(stagingDirectory, finalDirectory);
        stagingDirectory = null;
        return runtimeResult;
      }
      if (request.operation === 'screenshot') {
        const screenshotPath = path.join(outputDirectory, 'screenshot.png');
        const manifestPath = path.join(outputDirectory, 'capture-manifest.json');
        const outputPaths = [screenshotPath, manifestPath];
        assertFreshOutputPaths(outputPaths, fsImpl);
        const result = await capture(catalog, {
          route: request.target.routeId,
          mode: request.mode,
          scriptDate: request.mode === 'live' ? localDate(clock()) : undefined,
          stockId: request.target.stockId,
          stockName: request.target.stockName,
          udid: runConfiguration.udid,
          confirmVipSession: true,
          output: screenshotPath,
          manifest: manifestPath,
        });
        publishedPaths = outputPaths;
        const image = pngSize(screenshotPath);
        return finalizeRuntimeResult(
          1,
          request.requestId,
          [
            descriptor({
              role: 'screenshot', kind: 'image', relativePath: 'screenshot.png',
              filePath: screenshotPath, mimeType: 'image/png',
              media: { width: image.width, height: image.height },
            }, fsImpl),
            descriptor({
              role: 'capture-manifest', kind: 'json', relativePath: 'capture-manifest.json',
              filePath: manifestPath, mimeType: 'application/json',
            }, fsImpl),
          ],
          {
            routeSelection: 'catalog_exact_match',
            navigation: 'expected_texts_verified',
            material: planValue.contentTexts.length > 0
              && result.verification?.contentTexts?.missing?.length === 0
              ? 'captured_content_observed'
              : 'captured_pending_human_review',
            catalogVersion: catalog.catalogVersion,
          },
        );
      }

      const videoPath = path.join(outputDirectory, 'raw.mp4');
      const actionsPath = path.join(outputDirectory, 'actions.json');
      const manifestPath = path.join(outputDirectory, 'recording-manifest.json');
      const outputPaths = [videoPath, actionsPath, manifestPath];
      assertFreshOutputPaths(outputPaths, fsImpl);
      const result = await record(catalog, recipeFile, {
        recipe: request.target.recipeId,
        runner: 'maestro',
        udid: runConfiguration.udid,
        confirmVipSession: true,
        video: videoPath,
        actions: actionsPath,
        manifest: manifestPath,
      });
      publishedPaths = outputPaths;
      const manifest = JSON.parse(fsImpl.readFileSync(manifestPath, 'utf8'));
      const recording = manifest.recording || {};
      return finalizeRuntimeResult(
        1,
        request.requestId,
        [
          descriptor({
            role: 'raw-video', kind: 'video', relativePath: 'raw.mp4',
            filePath: videoPath, mimeType: 'video/mp4',
            media: {
              codec: recording.codec,
              width: recording.width,
              height: recording.height,
              durationSeconds: recording.durationSeconds,
            },
          }, fsImpl),
          descriptor({
            role: 'actions', kind: 'json', relativePath: 'actions.json',
            filePath: actionsPath, mimeType: 'application/json',
          }, fsImpl),
          descriptor({
            role: 'recording-manifest', kind: 'json', relativePath: 'recording-manifest.json',
            filePath: manifestPath, mimeType: 'application/json',
          }, fsImpl),
        ],
        {
          routeSelection: result.route_selection,
          navigation: result.navigation,
          material: result.material,
          catalogVersion: catalog.catalogVersion,
        },
      );
    } catch (error) {
      let failure;
      try {
        if (publishedPaths.length > 0) rollbackPublishedPaths(publishedPaths, fsImpl);
        failure = safeRuntimeFailure(error);
      } catch (rollbackError) {
        failure = safeRuntimeFailure(rollbackError);
      }
      if (planValue) failure.evidence = {
        ...failure.evidence,
        routeSelection: 'catalog_exact_match',
        navigation: 'not_completed',
        material: failure.code === 'OUTPUT_ROLLBACK_FAILED' ? 'cleanup_required' : 'not_published',
        catalogVersion: catalog.catalogVersion,
      };
      throw failure;
    } finally {
      if (stagingDirectory) {
        try {
          fsImpl.rmSync(stagingDirectory, { recursive: true, force: true });
        } catch {
          throw new RuntimeAdapterError(
            'OUTPUT_ROLLBACK_FAILED',
            'Provider staging cleanup requires operator attention.',
            {
              status: 'human_action_required',
              retryable: false,
              evidence: {
                publicationState: 'cleanup_required',
                material: 'cleanup_required',
              },
            },
          );
        }
      }
    }
  }

  return Object.freeze({
    productionReady: true,
    operations: Object.freeze(['screenshot', 'record', 'prepared-video']),
    profileCapabilities: Object.freeze(profiles.profiles.map(profileCapability)),
    catalogVersion: catalog.catalogVersion,
    plan,
    execute,
  });
}

module.exports = {
  REQUIRED_RUN_ENV,
  RuntimeAdapterError,
  assertFreshOutputPaths,
  createRuntimeAdapter,
  finalizeRuntimeResult,
  readRunConfiguration,
  requireCallerOutputDirectory,
  rollbackPublishedPaths,
  safeRuntimeFailure,
};
