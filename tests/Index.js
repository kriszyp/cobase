const { Persisted, Persistable, Index, Reduced } = require('..')
const { removeSync } = require('fs-extra')
suite('Index', () => {
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
			return total ? total.number : 0
		}
	}
	SumOfNumbersByType.startingValue = 0
	suiteSetup(() => {
	//	removeSync('tests/db')
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

		Test2.for(8).put({ description: 'changing 8 to 10', isEven: true, number: 10})
		await SumOfNumbersByType.whenUpdatedFrom(Test2)
		value = await SumOfNumbersByType.for('even')
		assert.equal(value, 28)
		assert.isTrue(reduceCalls < 10)

		Test2.for(12).put({ name: 'twelve', isEven: true, number: 12})
		await SumOfNumbersByType.whenUpdatedFrom(Test2)
		value = await SumOfNumbersByType.for('even')
		assert.equal(value, 40)
		assert.isTrue(reduceCalls < 13)

		Test2.remove(2)
		await SumOfNumbersByType.whenUpdatedFrom(Test2)
		value = await SumOfNumbersByType.for('even')
		assert.equal(value, 38)
		assert.isTrue(reduceCalls < 16)

		Test2.remove(6)
		Test2.remove(8)
		Test2.remove(10)
		Test2.remove(12)
		await SumOfNumbersByType.whenUpdatedFrom(Test2)
		value = await SumOfNumbersByType.for('even')
		assert.equal(value, 0)
		assert.isTrue(reduceCalls < 16)

		Test2.for(4).put({ name: 'four', isEven: true, number: 4})
		await SumOfNumbersByType.whenUpdatedFrom(Test2)
		value = await SumOfNumbersByType.for('even')
		assert.equal(value, 4)
		assert.isTrue(reduceCalls < 18)

	})

	/*
	suiteTeardown(() => {
		return Promise.all([
			Test2.db.close(),
			TestIndex.db.close()
		])
	})*/
})
