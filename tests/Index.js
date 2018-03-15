const { Persisted, Persistable, Index, Reduced } = require('..')
const { removeSync } = require('fs-extra')
suite.only('Index', () => {
	Persisted.dbFolder = 'tests/db'
	Persistable.dbFolder = 'tests/db'
	class Test2 extends Persisted {

	}
	class TestByType extends Index.from(Test2) {
		static indexBy(test) {
			console.log('indexing test', test)
			return test.isEven ? 'even' : 'odd'
		}
	}
	let reduceCalls = 0
	class SumOfNumbersByType extends Reduced.from(TestByType) {
		reduceBy(a, b) {
			reduceCalls++
			return {
				number: a.number + b.number
			}
		}
		transform(total) {
			return total.number
		}
	}
	SumOfNumbersByType.startingValue = 0
	suiteSetup(() => {
		removeSync('tests/db')
		return Promise.all([
			Test2.register({ version: 1 }),
			TestByType.register({ version: 1 }),
			SumOfNumbersByType.register({ version: 1 }),
		]).then(() => {
			for (let i = 1; i < 11; i++)
				Test2.for(i).put({
					isEven: i % 2 == 0,
					number: i,
				})
			// return TestIndex.whenReadableAfter(Test2)
			return Test2.whenFullyReadable
		})
	})

	test('index', () => {
		return TestByType.for('even').then(value => {
			assert.isTrue(value[0].isEven)
		})
	})
	test('index-reduce', async () => {
		let value = await SumOfNumbersByType.for('even')
		assert.equal(value, 30)
		assert.isTrue(reduceCalls < 10)
		Test2.remove(4)
		await SumOfNumbersByType.whenUpdatedFrom(Test2)
		value = await SumOfNumbersByType.for('even')
		assert.equal(value, 26)
		assert.isTrue(reduceCalls < 10)
	})

	/*
	suiteTeardown(() => {
		return Promise.all([
			Test2.db.close(),
			TestIndex.db.close()
		])
	})*/
})
