"use strict";

const modelAliases = require("../config/model-aliases.json");
const log = require("./logger");
const { errMsg } = require("./utils");

function buildModelRecord(id, extras = {}) {
  return {
    id,
    object: "model",
    created: extras.created || Math.floor(Date.now() / 1000),
    owned_by: extras.ownedBy || "accio",
    ...extras.extra
  };
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function getStaticModelIds() {
  return unique(["accio-bridge", ...Object.keys(modelAliases), ...Object.values(modelAliases)]).sort();
}

function getStaticModels() {
  return getStaticModelIds().map((id) => buildModelRecord(id));
}

function flattenGatewayModelEntries(payload) {
  const rawList = Array.isArray(payload)
    ? payload
    : Array.isArray(payload && payload.data)
      ? payload.data
      : Array.isArray(payload && payload.models)
        ? payload.models
        : [];

  const entries = [];

  for (const item of rawList) {
    if (!item || typeof item !== "object") {
      continue;
    }

    if (Array.isArray(item.modelList)) {
      for (const model of item.modelList) {
        if (!model || typeof model !== "object") {
          continue;
        }

        entries.push({
          id: model.id || model.model || model.name || model.modelName || "",
          visible: model.visible !== false,
          provider: item.provider || model.provider || null,
          owned_by: model.owned_by || model.ownedBy || item.provider || "accio",
          raw_id: model.id || model.modelName || model.name || null,
          providerDisplayName: item.providerDisplayName || null,
          multimodal: model.multimodal === true,
          contextWindow: Number(model.contextWindow || 0) || null,
          thinkLevel: model.thinkLevel || null,
          isDefault: model.isDefault === true
        });
      }
      continue;
    }

    entries.push(item);
  }

  return entries;
}

function extractGatewayModels(payload) {
  return flattenGatewayModelEntries(payload)
    .map((item) => {
      if (!item || typeof item !== "object" || item.visible === false) {
        return null;
      }

      const id = String(item.id || item.model || item.name || item.modelName || "").trim();

      if (!id) {
        return null;
      }

      return buildModelRecord(id, {
        ownedBy: item.owned_by || item.ownedBy || item.provider || "accio",
        extra: {
          accio: {
            source: "gateway",
            visible: item.visible !== false,
            provider: item.provider || null,
            raw_id: item.raw_id || item.id || item.modelName || null,
            providerDisplayName: item.providerDisplayName || null,
            multimodal: item.multimodal === true,
            contextWindow: Number(item.contextWindow || 0) || null,
            thinkLevel: item.thinkLevel || null,
            isDefault: item.isDefault === true
          }
        }
      });
    })
    .filter(Boolean);
}

function mergeModels(...groups) {
  const map = new Map();

  for (const group of groups) {
    for (const model of Array.isArray(group) ? group : []) {
      if (!model || !model.id || map.has(model.id)) {
        continue;
      }

      map.set(model.id, model);
    }
  }

  return [...map.values()].sort((a, b) => a.id.localeCompare(b.id));
}

class ModelsRegistry {
  constructor(config, options = {}) {
    this.config = config;
    this.fetchImpl = options.fetchImpl || global.fetch;
    this._cache = null;
    this._cacheAt = 0;
  }

  _isCacheFresh() {
    return this._cache && Date.now() - this._cacheAt < Math.max(0, Number(this.config.modelsCacheTtlMs || 0));
  }

  async _fetchGatewayModels() {
    const res = await this.fetchImpl(`${this.config.baseUrl}/models`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(Math.min(5000, Number(this.config.requestTimeoutMs || 5000)))
    });

    if (!res.ok) {
      throw new Error(`Gateway /models failed: ${res.status} ${res.statusText}`);
    }

    return extractGatewayModels(await res.json());
  }

  async listModels() {
    if (this._isCacheFresh()) {
      return this._cache;
    }

    const source = String(this.config.modelsSource || "gateway").toLowerCase();
    let models = [];

    try {
      models = await this._fetchGatewayModels();
    } catch (error) {
      log.warn("models discovery failed", {
        source,
        error: errMsg(error)
      });
      models = [];
    }

    this._cache = mergeModels(models);
    this._cacheAt = Date.now();
    return this._cache;
  }
}

module.exports = {
  ModelsRegistry,
  buildModelRecord,
  extractGatewayModels,
  getStaticModelIds,
  getStaticModels,
  mergeModels
};
