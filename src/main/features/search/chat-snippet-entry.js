'use strict';

// Workers need the same TypeScript loader in source and packaged builds.
require('tsx/cjs');
require('./chat-snippet-worker');
