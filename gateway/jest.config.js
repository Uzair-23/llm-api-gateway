const { createDefaultPreset } = require("ts-jest");
const path = require("path");

const tsJestTransformCfg = createDefaultPreset().transform;
// Resolve the ts-jest transformer by absolute path so Jest can find it even
// though rootDir is the repo root (ts-jest lives in gateway/node_modules).
const tsJestModulePath = path.resolve(__dirname, "node_modules", "ts-jest");
const tsJestTransform = {
  "^.+\\.tsx?$": [tsJestModulePath, {
    tsconfig: path.resolve(__dirname, '..', 'tsconfig.json'),
    diagnostics: false,
  }],
};

/** @type {import("jest").Config} **/
module.exports = {
  testEnvironment: 'node',
  rootDir: '../',
  roots: ['<rootDir>/tests', '<rootDir>/gateway/src'],
  testMatch: ['<rootDir>/tests/**/*.test.ts'],
  setupFiles: ['<rootDir>/tests/jest.setup.ts'],
  transform: tsJestTransform,
  moduleFileExtensions: ['ts', 'js', 'json'],
  maxWorkers: 1,
  // Resolve modules from the gateway's node_modules (where deps are installed).
  moduleDirectories: ['node_modules', '<rootDir>/gateway/node_modules'],
};