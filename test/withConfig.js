'use strict';

// Sets the platform values of src/base.js (config.isWindows, config.tar, config.powershell) for one test and puts them back after it (#362).
// Nothing is reloaded, so it replaces the trick of deleting a module from the require cache to get new constants.
// It can be called more than once in a test: the values before the first call are the ones that come back.

const { config } = require('../src/base');

const originals = new WeakMap();

function withConfig(t, overrides) {
  if (!originals.has(t)) {
    const saved = { ...config };
    originals.set(t, saved);
    t.after(() => Object.assign(config, saved));
  }
  Object.assign(config, overrides);
  return config;
}

module.exports = { withConfig };
