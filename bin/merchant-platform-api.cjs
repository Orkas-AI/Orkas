'use strict';

// Additive registry behind the existing connector authorization and MCP owners.
const modules = [require('./storefront-admin-api.cjs'), require('./magento-admin-api.cjs'), require('./temu-seller-api.cjs'),
  require('./lazada-seller-api.cjs'), require('./shein-seller-api.cjs'), require('./alibaba-icbu-api.cjs'), require('./aliexpress-seller-api.cjs')];
const resolve = (provider) => {
  const adapter = modules.find((candidate) => candidate.isProvider(provider));
  if (!adapter) throw new Error('Unsupported merchant platform');
  return adapter;
};
module.exports = {
  isProvider: (provider) => modules.some((adapter) => adapter.isProvider(provider)),
  apiBase: (provider, metadata) => resolve(provider).apiBase(provider, metadata),
  actionsFor: (provider) => resolve(provider).actionsFor(provider),
  validateBinding: (config) => resolve(config.provider).validateBinding(config),
  identity: (config) => resolve(config.provider).identity(config),
  execute: (config, name, parameters) => resolve(config.provider).execute(config, name, parameters),
  authorize: (config) => resolve(config.provider).authorize(config),
  authorizeUrl: (config, state) => resolve(config.provider).authorizeUrl(config, state),
};
