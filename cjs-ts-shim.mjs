// Runs in the MAIN thread (via --import) so it can patch Node's CJS module
// system before any application code executes. This lets the handful of
// dynamic `require('../data/whatever')` calls in the original Showdown
// source (written expecting tsc's compiled .js output) resolve to the
// actual .ts source files we're running directly via --experimental-strip-types.
import Module from 'node:module';

Module._extensions['.ts'] = Module._extensions['.js'];
