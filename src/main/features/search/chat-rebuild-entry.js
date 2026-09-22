'use strict';

// Same source/packaged TypeScript loader as bootstrap.cjs. Keep the entry JS:
// workers do not inherit the main thread's require hooks.
require('tsx/cjs');
require('./chat-rebuild-worker');
