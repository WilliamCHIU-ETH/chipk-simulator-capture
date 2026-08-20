'use strict';

// Intentionally empty in the source-only branch. Adding a digest is a reviewed build change;
// a runtime caller cannot promote its own catalog by supplying an approval flag.
const APPROVED_PRODUCTION_CATALOG_DIGESTS = Object.freeze([]);

module.exports = { APPROVED_PRODUCTION_CATALOG_DIGESTS };
