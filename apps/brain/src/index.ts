// apps/brain — entry point.
//
// `pnpm -F @casperaki/brain dev` runs this via tsx. All work lives in
// bootstrap.ts so test code can build the app without taking a port.

import { startServer } from './bootstrap.js';

startServer();
