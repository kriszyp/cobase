const inspector =  require('inspector')
inspector.open(9330, null, true)
const { setDBFolder } = require('..')
setDBFolder('tests/db')

require('./model/TestCached')
console.log('loaded TestCached')
require('./model/CountryCity')
console.log('loaded CountryCity')
require('./model/Test2')
function start() {
	console.log('started updating process')
}

start()
