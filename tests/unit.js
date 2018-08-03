if (typeof assert === 'undefined') { assert = require('chai').assert }
const inspector =  require('inspector')
//inspector.open(9329, null, true)
const { setDBFolder } = require('..')
const { removeSync } = require('fs-extra')
removeSync('tests/db')
setDBFolder('tests/db')

require('./Persisted')
//require('./Process')
require('./Relation')
require('./Index')
//require('./performance')
