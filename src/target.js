'use strict';

// The target folder API. The work is split by concern and re-exported here so callers keep one import:
// - protectedPaths.js: which folders may be a target at all
// - access.js: per-kind permissions (`grant`) and reads that go through them
// - walk.js: listing a tree
// - stamp.js: change stamps and volume checks
const { deviceNamePattern } = require('./windowsNames');
const { resolveTarget, isInside, protectedReason, protectedInfo, TRAILING_DOT_OR_SPACE } = require('./protectedPaths');
const { grant, readRange, fileSizeInside, rejectAmbiguousNames } = require('./access');
const { walk, compareRelative } = require('./walk');
const { fileStamp, volumeFormat, stampVolumeReason } = require('./stamp');

module.exports = { resolveTarget, isInside, readRange, fileSizeInside, fileStamp, volumeFormat, stampVolumeReason, walk, grant, rejectAmbiguousNames, compareRelative, deviceNamePattern, protectedReason, protectedInfo, TRAILING_DOT_OR_SPACE };
