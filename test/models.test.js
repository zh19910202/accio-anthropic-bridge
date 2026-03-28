"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { ModelsRegistry, extractGatewayModels } = require("../src/models");

test("extractGatewayModels filters invisible entries", () => {
  const models = extractGatewayModels({
    data: [
      { id: "claude-opus-4-6", visible: true },
      { id: "hidden-model", visible: false }
    ]
  });

  assert.equal(models.length, 1);
  assert.equal(models[0].id, "claude-opus-4-6");
});

test("ModelsRegistry hybrid mode merges static and gateway models", async () => {
  const registry = new ModelsRegistry(
    {
      baseUrl: "http://127.0.0.1:4097",
      modelsSource: "hybrid",
      modelsCacheTtlMs: 1000,
      requestTimeoutMs: 1000
    },
    {
      fetchImpl: async () => ({
        ok: true,
        async json() {
          return { data: [{ id: "dynamic-model", visible: true }] };
        }
      })
    }
  );

  const models = await registry.listModels();
  const ids = models.map((model) => model.id);

  assert.ok(ids.includes("dynamic-model"));
  assert.ok(ids.includes("accio-bridge"));
});
