"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { discoverAccioAppPath, discoverAccioAppVersion } = require("../src/discovery");

test("discoverAccioAppPath returns explicit existing path", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "accio-app-discovery-"));
  const appPath = path.join(tempDir, "Accio.app");
  fs.mkdirSync(appPath);

  assert.equal(discoverAccioAppPath(appPath), appPath);
});

test("discoverAccioAppVersion reads CFBundleShortVersionString from mac bundle plist", () => {
  if (process.platform !== "darwin") {
    return;
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "accio-app-version-"));
  const appPath = path.join(tempDir, "Accio.app");
  const contentsPath = path.join(appPath, "Contents");
  fs.mkdirSync(contentsPath, { recursive: true });
  fs.writeFileSync(
    path.join(contentsPath, "Info.plist"),
    [
      "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
      "<plist version=\"1.0\">",
      "<dict>",
      "  <key>CFBundleShortVersionString</key>",
      "  <string>0.4.6</string>",
      "</dict>",
      "</plist>"
    ].join("\n")
  );
  assert.equal(discoverAccioAppVersion(appPath), "0.4.6");
});
