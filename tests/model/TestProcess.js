console.log('TestProcess module')
const { Persisted, runInProcess } = require('../..')
Persisted.dbFolder = 'tests/db'
class TestProcess extends Persisted {

}
TestProcess.start()
exports.TestProcess = TestProcess
exports.TestProcessByName = TestProcess.index('name')
exports.TestProcessWithExtra = TextProcess.cacheWith({ extra: 'test' })
