// The chord fitter now lives in packages/arrangement (src/hum/chord-fit.ts), where the brain uses it for
// "hum to song". This file re-exports it for the evaluation scripts here.
export * from '../../../../packages/arrangement/dist/hum/chord-fit.js';
