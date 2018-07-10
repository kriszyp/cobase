const { Persisted, Persistable, Index, Reduced } = require('..')
const { removeSync } = require('fs-extra')
const { Test, TestByType, SumOfNumbersByType } = require('./model/Test2')
suite.only('Index', function() {
	this.timeout(2000000)
	suiteSetup(() => {
	//	removeSync('tests/db')
		return Promise.all([
			Test2.ready,
			TestByType.ready,
			SumOfNumbersByType.ready,
		]).then(() => {
			console.log('stores ready')
			var promises = []
			for (let i = 1; i < 11; i++)
				promises.push(Test2.for(i).put({
					isEven: i % 2 == 0,
					number: i,
				}))
			// return TestIndex.whenReadableAfter(Test2)
			return Promise.all(promises)
		})
	})

	test('index', () => {
		return TestByType.for('even').then(value => {
			assert.isTrue(value[0].isEven)
			assert.equal(value.length, 5)
			Test2.for(12).put({isEven: true, number: 12})
			return TestByType.for('even').then(value => {
				assert.isTrue(value[5].isEven)
				assert.equal(value.length, 6)
			})
		})
	})
	test('index-reduce', async () => {
		let value = await SumOfNumbersByType.for('even')
		assert.equal(value, 30)
		assert.isTrue(reduceCalls < 10)

		Test2.remove(4)
		value = await SumOfNumbersByType.for('even')
		assert.equal(value, 26)
		assert.isTrue(reduceCalls < 10)

		Test2.for(8).put({ description: 'changing 8 to 10', isEven: true, number: 10})
		value = await SumOfNumbersByType.for('even')
		assert.equal(value, 28)
		assert.isTrue(reduceCalls < 10)

		Test2.for(12).put({ name: 'twelve', isEven: true, number: 12})
		value = await SumOfNumbersByType.for('even')
		assert.equal(value, 40)
		assert.isTrue(reduceCalls < 13)

		Test2.remove(2)
		value = await SumOfNumbersByType.for('even')
		assert.equal(value, 38)
		assert.isTrue(reduceCalls < 16)

		Test2.remove(6)
		Test2.remove(8)
		Test2.remove(10)
		Test2.remove(12)
		value = await SumOfNumbersByType.for('even')
		assert.equal(value, undefined)
		assert.isTrue(reduceCalls < 16)

		Test2.for(4).put({ name: 'four', isEven: true, number: 4})
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
