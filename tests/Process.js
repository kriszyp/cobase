const { Persisted, createProcess, registerProcesses } = require('..')
const { TestProcess, TestProcessByName } = require('./model/TestProcess')
const { removeSync } = require('fs-extra')
const { fork } = require('child_process')
let childProcess
suite.only('Process', function() {
	this.timeout(2000000)
	Persisted.dbFolder = 'tests/db'
//	Persistable.dbFolder = 'tests/db'
	suiteSetup(() => {
		childProcess = fork('tests/second-process', [], {
			env: process.env,
			execArgv:['--stack-trace-limit=100'],
			stdio: [0, 1, 2, 'ipc'],
		})

		process.on('exit', () => childProcess.kill())
		console.log('created child test process')
	})

	test('run-in-process', () => {
		return sendMessage('put10').then(() =>  {
			return TestProcess.for(10).then(value => {
				console.log('got response')
				assert.equal(value.name, 'ten')
				return TestProcess.instanceIds.then(ids => {
					assert.deepEqual(ids, [10])
					return sendMessage('delete10').then(() => delay(10)).then(() => {
						return TestProcess.for(10).then(value => {
							assert.isUndefined(value)
						})
					})
				})
			})
		})
	})
	test.only('run-in-process with index', () => {
		return sendMessage('put10').then(() => {
			console.log('got response for index of ten')
			TestProcess.for(10).put({ name: 'change a' })
			return sendMessage('change10').then(() => delay(10)).then(() =>
				Promise.all([
					TestProcessByName.for('change a').then(value => {
						assert.equal(value.length, 0)
					}),
					TestProcessByName.for('change b').then(value => {
						assert.equal(value.length, 1)
					})
				])
			)
		})
	})

	suiteTeardown(() => {
		childProcess.kill()
	})
})

function sendMessage(action) {
	childProcess.send({ action })
	return new Promise(resolve => childProcess.on('message', (data) => {
		if (data.completed == action) {
			resolve()
		}
	}))
}
function delay(ms) {
	return new Promise(resolve => setTimeout(resolve, ms))
}
