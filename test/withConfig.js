'use strict';

// Sets the platform values of src/base.js (config.isWindows, config.tar, config.powershell) for one test and puts them back after it (#362).
// Nothing is reloaded, so it replaces the trick of deleting a module from the require cache to get new constants.

const { config } = require('../src/base');

function withConfig(t, overrides) {
  const saved = { ...config };
  Object.assign(config, overrides);
  t.after(() => Object.assign(config, saved));
  return config;
}

module.exports = { withConfig };
