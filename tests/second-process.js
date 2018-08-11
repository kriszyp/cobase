const inspector =  require('inspector')
inspector.open(9330, null, true)
const { configure } = require('..')
configure({
	dbFolder: 'tests/db'
})

const { TestProcess, TestProcessByName } = require('./model/TestProcess')
function start() {
	console.log('started second process')
}
process.on('message', (data) => {
	console.log('child got message', data)
	if (data.action == 'put10') {
		TestProcess.for(10).put({ name: 'ten' })
		process.send({ completed: 'put10' })
	}
	if (data.action == 'delete10') {
		TestProcess.for(10).delete()
		process.send({ completed: 'delete10' })
	}
	if (data.action == 'change10') {
		TestProcess.for(10).put({ name: 'change b'})
		process.send({ completed: 'change10' })
	}
})

start()
