const { Persisted, createProcess, registerProcesses } = require('..')
const { TestProcess, TestProcessByName } = require('./model/TestProcess')
const { removeSync } = require('fs-extra')
let child
suite.only('Process', function() {
	this.timeout(2000000)
	Persisted.dbFolder = 'tests/db'
//	Persistable.dbFolder = 'tests/db'
	suiteSetup(() => {
		child = createProcess('tests/second-process')
		registerProcesses([child])
	})

	test('run-in-process', () => {
		return sendMessage('put10').then(() =>  {
			return TestProcess.for(10).then(value => {
				console.log('got response')
				assert.equal(value.name, 'ten')
				return TestProcess.instanceIds.then(ids => {
					assert.deepEqual(ids, [10])
					return sendMessage('delete10').then(() => {
						return TestProcess.for(10).then(value => {
							assert.isUndefined(value)
						})
					})
				})
			})
		})
	})
	test('run-in-process with index', () => {
		return sendMessage('put10').then(() =>
			TestProcessByName.for('ten').then(value => {
				console.log('got response for index of ten')
				assert.equal(value[0].name, 'ten')
				TestProcess.for(10).put({ name: 'change a' })
				return sendMessage('change10').then(() =>
					Promise.all([
						TestProcessByName.for('change a').then(value => {
							assert.equal(value.length, 0)
						})
						TestProcessByName.for('change b').then(value => {
							assert.equal(value.length, 1)
						})
					])
				)
			})
		)
	})

	/*
	suiteTeardown(() => {
		return Promise.all([
			Test2.db.close(),
			TestIndex.db.close()
		])
	})*/
})

function sendMessage(action) {
	child.send({ action })
	return new Promise(resolve => child.on('message', (data) => {
		if (data.completed == action) {
			resolve()
		}
	}))
}
