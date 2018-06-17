console.log('TestProcess module')
const { Persisted, runInProcess } = require('../..')
Persisted.dbFolder = 'tests/db'
class TestProcess extends Persisted {

}
TestProcess.version = 1
TestProcess = runInProcess(TestProcess, {
	processName: 'process-1',
	module
})
exports.TestProcessByName = TestProcess.index('name')


exports.TestProcess = TestProcess
