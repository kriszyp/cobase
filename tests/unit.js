if (typeof assert === 'undefined') { assert = require('chai').assert }
const inspector =  require('inspector')
inspector.open(9330, null, true)

require('./Persisted')
//require('./Process')
require('./Relation')
require('./Index')
//require('./performance')
