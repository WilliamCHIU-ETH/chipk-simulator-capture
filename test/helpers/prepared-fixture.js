'use strict';

function fixtureActions() {
  const planned = [
    {
      id: 'fixture-tap',
      type: 'tap',
      execution: { strategy: 'reviewed_coordinate', point: { x: 0.3557, y: 0.9405 } },
      touchPoint: { x: 0.3557, y: 0.9405 },
      zoomFocus: { x: 0.12, y: 0.88, width: 0.5, height: 0.12 },
    },
    {
      id: 'fixture-long-press',
      type: 'tap',
      execution: {
        strategy: 'reviewed_coordinate',
        point: { x: 0.8209, y: 0.492 },
        longPress: true,
      },
      touchPoint: { x: 0.8209, y: 0.492 },
      zoomFocus: { x: 0.52, y: 0.34, width: 0.42, height: 0.34 },
    },
    {
      id: 'fixture-swipe',
      type: 'swipe',
      touchPath: {
        start: { x: 0.8209, y: 0.492 },
        end: { x: 0.2736, y: 0.492 },
      },
      zoomFocus: { x: 0.05, y: 0.34, width: 0.9, height: 0.42 },
    },
    {
      id: 'fixture-result-assert',
      type: 'assert',
      selectors: [{ kind: 'text', value: 'fixture-result' }],
      zoomFocus: { x: 0.04, y: 0.58, width: 0.92, height: 0.35 },
    },
    {
      id: 'fixture-result-hold',
      type: 'hold',
      durationMs: 2500,
      zoomFocus: { x: 0.04, y: 0.52, width: 0.92, height: 0.44 },
    },
  ];
  const timings = [
    [200, 600, 'fixture-tap'],
    [1800, 4800, 'fixture-long-press'],
    [5800, 7000, 'fixture-swipe'],
    [7200, 7600, 'fixture-result-assert'],
    [8000, 12000, 'fixture-result-hold'],
  ];
  return {
    schemaVersion: 1,
    recipe: { id: 'fixture.generic-interaction', version: 1, sha256: 'a'.repeat(64) },
    routeId: 'chipk.fixture.route',
    recording: {
      encodedDurationMs: 12000,
      anchorSemantics: 'fixture_process_boundary_not_first_video_frame',
      timelineCalibration: {
        method: 'fixture_end_alignment',
        precision: 'fixture_not_frame_exact',
      },
    },
    timing: {
      observedComplete: true,
      missingObservedEventIds: [],
      observedSemantics: 'fixture_observed_timing_not_physical_touch_samples',
    },
    planned,
    observed: timings.map(([startedOffsetMs, completedOffsetMs, id]) => ({
      id,
      status: 'passed',
      startedOffsetMs,
      completedOffsetMs,
      timingSource: 'synthetic_fixture',
      precision: 'fixture_only',
    })),
  };
}

const media = Object.freeze({
  codec: 'h264', width: 1206, height: 2622, durationSeconds: 12, fps: 30,
});

module.exports = { fixtureActions, media };
