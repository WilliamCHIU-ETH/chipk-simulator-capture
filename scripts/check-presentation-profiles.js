#!/usr/bin/env node

'use strict';

const { profileCapability, readProfiles } = require('../src/presentation-profiles');

function main() {
  const profiles = readProfiles();
  process.stdout.write(`${JSON.stringify({
    ok: true,
    schemaVersion: profiles.schemaVersion,
    profiles: profiles.profiles.map(profileCapability),
  }, null, 2)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      error: {
        code: error.code || 'PRESENTATION_PROFILE_CHECK_FAILED',
        message: error.message,
      },
    }, null, 2)}\n`);
    process.exitCode = 1;
  }
}

module.exports = { main };
