const path = require('path');
const dotenv = require('dotenv');

function loadRuntimeEnv(options = {}) {
  const envPath = options.path || path.join(__dirname, '..', '.env');
  return dotenv.config({
    path: envPath,
    override: options.override ?? true,
    quiet: options.quiet ?? true,
  });
}

module.exports = {
  loadRuntimeEnv,
};
