const { Persisted, Cached } = require('..')
const { removeSync } = require('fs-extra')
removeSync('tests/db')
suite('Persisted', () => {
	Persisted.dbFolder = 'tests/db'
	Cached.dbFolder = 'tests/db'
	class Test extends Persisted {

	}
	class TestCached extends Cached.from(Test) {
		transform(test) {
			return {
				upperName: test.name.toUpperCase()
			}
		}
	}
	suiteSetup(() => {
		return Promise.all([
			Test.register({ version: 1 }),
			TestCached.register({ version: 1})
		])
	})

	test('standalone table', () => {
		Test.for(10).put({ name: 'ten' })
		return Test.for(10).then(value => {
			assert.equal(value.name, 'ten')
		})
	})
	test('cached transform', () => {
		return TestCached.for(10).then(value => {
			assert.equal(value.upperName, 'TEN')
		})
	})

	/*
	suiteTeardown(() => {
		console.log('teardown persisted')
		return Promise.all([
			Test.db.close(),
			TestCached.db.close()
		])
	})*/
})
