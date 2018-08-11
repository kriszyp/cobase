console.log('TestProcess module')
const { Persisted, runInProcess } = require('../..')
Persisted.dbFolder = 'tests/db'
class TestProcess extends Persisted {

}
TestProcess.start()
exports.TestProcess = TestProcess
exports.TestProcessWithExtra = TestProcess.cacheWith({ extra: 'test' })
exports.TestProcessByName = exports.TestProcessWithExtra.index('name')
