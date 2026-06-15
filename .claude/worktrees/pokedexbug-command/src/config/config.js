const fs = require('fs');
const path = require('path');

let fileDefaults = {};
let firestoreOverrides = {};
let firestoreService = null;

function loadFileDefaults() {
  const configPath = path.join(__dirname, '../../config.json');
  fileDefaults = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}

function setFirestoreService(service) {
  firestoreService = service;
}

async function loadFirestoreOverrides() {
  if (!firestoreService) return;
  firestoreOverrides = await firestoreService.getAllConfigOverrides();
}

function getConfig(key) {
  if (key in firestoreOverrides) return firestoreOverrides[key];
  if (key in fileDefaults) return fileDefaults[key];
  return undefined;
}

function getAllConfig() {
  const merged = { ...fileDefaults };
  for (const [key, value] of Object.entries(firestoreOverrides)) {
    merged[key] = value;
  }
  return merged;
}

async function setConfigOverride(key, value, userId) {
  if (!(key in fileDefaults)) throw new Error(`Unknown config key: ${key}`);
  await firestoreService.setConfigOverride(key, value, userId);
  firestoreOverrides[key] = value;
}

async function resetConfigOverride(key) {
  await firestoreService.deleteConfigOverride(key);
  delete firestoreOverrides[key];
}

async function init() {
  loadFileDefaults();
  await loadFirestoreOverrides();
}

module.exports = { init, getConfig, getAllConfig, setConfigOverride, resetConfigOverride, setFirestoreService };