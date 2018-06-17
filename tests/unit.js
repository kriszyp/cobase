if (typeof assert === 'undefined') { assert = require('chai').assert }
const inspector =  require('inspector')
inspector.open(9329, null, true)

require('./Persisted')
require('./Process')
require('./Relation')
require('./Index')
