'use strict';

// Workers need their own TypeScript hook in source and packaged ASAR builds.
require('tsx/cjs');
require('./conversation-history-worker');
