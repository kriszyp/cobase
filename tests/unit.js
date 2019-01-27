if (typeof assert === 'undefined') { assert = require('chai').assert }
const inspector =  require('inspector')
//inspector.open(9329, null, true)
const { configure } = require('..')
const { removeSync } = require('fs-extra')
removeSync('tests/db')
configure({
	dbFolder: 'tests/db'
})

/*require('./Persisted')
require('./Process')
require('./Relation')
require('./Index')
*/require('./performance')
